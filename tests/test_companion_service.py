from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "companion_service" / "server.py"

spec = importlib.util.spec_from_file_location("qc_companion_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(server)


def make_text_pdf(path: Path, pages: list[str]) -> None:
    objects: list[bytes] = []

    def add_object(body: str) -> None:
        objects.append(body.encode("latin-1"))

    kids = " ".join(f"{4 + index * 2} 0 R" for index in range(len(pages)))
    add_object("<< /Type /Catalog /Pages 2 0 R >>")
    add_object(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>")
    add_object("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for index, text in enumerate(pages):
        page_number = 4 + index * 2
        content_number = page_number + 1
        add_object(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_number} 0 R >>"
        )
        safe_text = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({safe_text}) Tj ET"
        add_object(f"<< /Length {len(stream.encode('latin-1'))} >>\nstream\n{stream}\nendstream")

    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_number, body in enumerate(objects, start=1):
        offsets.append(len(data))
        data.extend(f"{object_number} 0 obj\n".encode("latin-1"))
        data.extend(body)
        data.extend(b"\nendobj\n")

    xref_offset = len(data)
    data.extend(f"xref\n0 {len(objects) + 1}\n".encode("latin-1"))
    data.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        data.extend(f"{offset:010d} 00000 n \n".encode("latin-1"))
    data.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode("latin-1")
    )
    path.write_bytes(data)


class CompanionServiceCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="qc-smart-reader-test-")
        self.data_dir = Path(self.temp_dir.name)
        self.store = server.Store(self.data_dir)
        self.start_service()

    def start_service(self) -> None:
        class QuietHandler(server.RequestHandler):
            store = self.store

            def log_message(self, fmt: str, *args: object) -> None:
                return None

        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.stop_service()
        self.temp_dir.cleanup()

    def stop_service(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def restart_service(self) -> None:
        self.stop_service()
        self.store = server.Store(self.data_dir)
        self.start_service()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def request(
        self,
        path: str,
        payload: dict | None = None,
        method: str = "GET",
        *,
        token: bool = True,
        headers: dict | None = None,
    ) -> dict:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request_headers = {"content-type": "application/json", **(headers or {})}
        if token and path.startswith("/v1"):
            request_headers["x-qc-pairing-token"] = self.store.pairing_token()
        req = urllib.request.Request(
            self.base_url + path,
            data=body,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                data = response.read()
        except urllib.error.HTTPError as error:
            data = error.read()
            error.close()
            raise AssertionError(f"HTTP {error.code}: {data.decode('utf-8', errors='replace')}") from error
        return json.loads(data.decode("utf-8"))

    def db_rows(self, query: str, params: tuple = ()) -> list[sqlite3.Row]:
        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        db.row_factory = sqlite3.Row
        try:
            return db.execute(query, params).fetchall()
        finally:
            db.close()

    def test_pairing_token_required_and_cors_allowlist(self) -> None:
        health = self.request("/health", token=False)
        self.assertEqual(health["version"], "0.9.2")
        self.assertEqual(health["service_version"], "0.9.2")
        self.assertEqual(health["api_version"], 1)
        self.assertEqual(health["schema_version"], 1)
        self.assertEqual(health["min_extension_version"], "0.9.0")
        self.assertTrue(health["pairing_required"])
        self.assertTrue(Path(health["pairing_token_path"]).exists())
        self.assertEqual(self.db_rows("PRAGMA user_version")[0][0], 1)
        self.assertEqual(
            list((self.data_dir / "state").glob("*.pre-schema-v*.bak")),
            [],
            "a fresh database must not create a migration backup",
        )

        with self.assertRaisesRegex(AssertionError, "HTTP 401"):
            self.request("/v1/projects", token=False)
        with self.assertRaisesRegex(AssertionError, "HTTP 403"):
            self.request("/v1/projects", token=False, headers={"x-qc-pairing-token": "wrong-token"})

        allowed = urllib.request.Request(
            self.base_url + "/v1/projects",
            method="OPTIONS",
            headers={
                "origin": "chrome-extension://abcdefghijklmnop",
                "access-control-request-method": "GET",
                "access-control-request-headers": "content-type,x-qc-pairing-token",
            },
        )
        with urllib.request.urlopen(allowed, timeout=30) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop")
            self.assertIn("x-qc-pairing-token", response.headers.get("access-control-allow-headers", ""))
            self.assertEqual(response.headers.get("cache-control"), "no-store")
            self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")

        denied = urllib.request.Request(
            self.base_url + "/v1/projects",
            method="OPTIONS",
            headers={
                "origin": "https://example.com",
                "access-control-request-method": "GET",
            },
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(denied, timeout=30)
        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_sensitive_state_repairs_permissions_and_refuses_symlink_or_corrupt_credentials(self) -> None:
        state_dir = self.data_dir / "state"
        database_path = state_dir / "qc_smart_reader.sqlite3"
        token_path = state_dir / "pairing_token.txt"
        self.assertEqual(stat.S_IMODE(state_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(database_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o600)

        model_path = state_dir / "model_settings.json"
        self.store.write_model_settings(self.store.default_model_settings())
        self.assertEqual(stat.S_IMODE(model_path.stat().st_mode), 0o600)
        model_path.chmod(0o644)
        self.store.read_model_settings(include_secret=True)
        self.assertEqual(stat.S_IMODE(model_path.stat().st_mode), 0o600)

        model_path.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "corrupted"):
            self.store.read_model_settings()

        model_path.unlink()
        outside = self.data_dir.parent / "outside-model-settings.json"
        outside.write_text("{}", encoding="utf-8")
        model_path.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "non-symlink"):
            self.store.read_model_settings()

        token_path.unlink()
        token_path.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "non-symlink"):
            self.store.pairing_token()

    def test_cli_refuses_network_bind_without_explicit_opt_in(self) -> None:
        with mock.patch.object(server.sys, "argv", ["server.py", "--host", "0.0.0.0"]):
            with self.assertRaises(SystemExit) as context:
                server.parse_args()
        self.assertEqual(context.exception.code, 2)

        with mock.patch.object(
            server.sys,
            "argv",
            ["server.py", "--host", "0.0.0.0", "--allow-non-loopback"],
        ):
            args = server.parse_args()
        self.assertEqual(args.host, "0.0.0.0")
        self.assertTrue(args.allow_non_loopback)

    def test_request_json_reader_rejects_invalid_lengths_and_encoding(self) -> None:
        handler = object.__new__(server.RequestHandler)
        handler.headers = {"content-length": "-1"}
        handler.rfile = io.BytesIO(b"{}")
        with self.assertRaisesRegex(ValueError, "non-negative"):
            handler.read_json_body()

        handler.headers = {"content-length": "not-a-number"}
        with self.assertRaisesRegex(ValueError, "non-negative"):
            handler.read_json_body()

        handler.headers = {"content-length": "1"}
        handler.rfile = io.BytesIO(b"\xff")
        with self.assertRaisesRegex(ValueError, "invalid JSON"):
            handler.read_json_body()

        handler.headers = {"content-length": "2"}
        handler.rfile = io.BytesIO(b"[]")
        with self.assertRaisesRegex(ValueError, "must be an object"):
            handler.read_json_body()

        handler.command = "GET"
        handler.path = "/v1/search?query=private%20research"
        handler.client_address = ("127.0.0.1", 12345)
        with mock.patch("builtins.print") as print_mock:
            handler.log_message('"%s" %s %s', "GET /v1/search?query=private%20research HTTP/1.1", "200", "-")
        rendered = str(print_mock.call_args.args[0])
        self.assertIn("GET /v1/search 200", rendered)
        self.assertNotIn("private", rendered)

    def test_legacy_database_upgrade_is_backed_up_once_and_preserves_data(self) -> None:
        legacy_dir = self.data_dir / "schema-version-upgrade-store"
        state_dir = legacy_dir / "state"
        state_dir.mkdir(parents=True)
        legacy_db_path = state_dir / "qc_smart_reader.sqlite3"
        db = sqlite3.connect(legacy_db_path)
        try:
            db.executescript(
                """
                PRAGMA user_version=0;
                CREATE TABLE legacy_records (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL
                );
                INSERT INTO legacy_records(id, payload)
                VALUES ('legacy-row', '必须原样保留');
                """
            )
            db.commit()
        finally:
            db.close()

        upgraded = server.Store(legacy_dir)
        backup_path = upgraded.schema_backup_path(server.SCHEMA_VERSION)
        self.assertTrue(backup_path.is_file())
        self.assertEqual(backup_path.stat().st_uid, os.getuid())
        self.assertEqual(backup_path.stat().st_mode & 0o777, 0o600)

        db = sqlite3.connect(legacy_db_path)
        try:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(
                db.execute(
                    "SELECT payload FROM legacy_records WHERE id = 'legacy-row'"
                ).fetchone()[0],
                "必须原样保留",
            )
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            db.close()

        backup_db = sqlite3.connect(backup_path)
        try:
            self.assertEqual(backup_db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(
                backup_db.execute(
                    "SELECT payload FROM legacy_records WHERE id = 'legacy-row'"
                ).fetchone()[0],
                "必须原样保留",
            )
            self.assertEqual(backup_db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            backup_db.close()

        first_backup_identity = (
            backup_path.stat().st_dev,
            backup_path.stat().st_ino,
            backup_path.stat().st_mtime_ns,
        )
        server.Store(legacy_dir)
        self.assertEqual(
            [path.resolve() for path in state_dir.glob("*.pre-schema-v*.bak")],
            [backup_path.resolve()],
        )
        self.assertEqual(
            (
                backup_path.stat().st_dev,
                backup_path.stat().st_ino,
                backup_path.stat().st_mtime_ns,
            ),
            first_backup_identity,
            "reopening the upgraded database must not replace its versioned backup",
        )

    def test_failed_legacy_upgrade_keeps_verified_restore_backup(self) -> None:
        legacy_dir = self.data_dir / "failed-schema-upgrade-store"
        state_dir = legacy_dir / "state"
        state_dir.mkdir(parents=True)
        legacy_db_path = state_dir / "qc_smart_reader.sqlite3"
        db = sqlite3.connect(legacy_db_path)
        try:
            db.executescript(
                """
                PRAGMA user_version=0;
                CREATE TABLE legacy_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                INSERT INTO legacy_records VALUES ('keep-me', 'original');
                """
            )
            db.commit()
        finally:
            db.close()

        backup_path = legacy_db_path.with_name(
            f"{legacy_db_path.name}.pre-schema-v{server.SCHEMA_VERSION}.bak"
        )
        with mock.patch.object(
            server.Store,
            "create_schema",
            side_effect=sqlite3.OperationalError("forced migration failure"),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"verified pre-upgrade backup remains.*restore.*forced migration failure",
            ):
                server.Store(legacy_dir)

        self.assertTrue(backup_path.is_file())
        backup_db = sqlite3.connect(backup_path)
        try:
            self.assertEqual(backup_db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(
                backup_db.execute("SELECT payload FROM legacy_records WHERE id = 'keep-me'").fetchone()[0],
                "original",
            )
        finally:
            backup_db.close()

    def test_model_settings_store_key_server_side_and_proxy_chat(self) -> None:
        captured: dict = {}

        class FakeModelHandler(server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("content-length") or "0")
                body = self.rfile.read(length)
                captured["path"] = self.path
                captured["authorization"] = self.headers.get("authorization")
                captured["payload"] = json.loads(body.decode("utf-8"))
                response = json.dumps(
                    {"choices": [{"message": {"content": "service model ok"}}]},
                    ensure_ascii=False,
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, fmt: str, *args: object) -> None:
                return None

        model_httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
        model_port = model_httpd.server_address[1]
        model_thread = threading.Thread(target=model_httpd.serve_forever, daemon=True)
        model_thread.start()
        try:
            initial = self.request("/v1/model-settings")["settings"]
            self.assertEqual(initial["provider"], "mock")
            self.assertFalse(initial["has_api_key"])
            self.assertTrue(initial["ready"])
            self.assertEqual(initial["route"], "mock")
            self.assertNotIn("api_key", initial)

            saved = self.request(
                "/v1/model-settings",
                {
                    "provider": "openai",
                    "base_url": f"http://127.0.0.1:{model_port}/v1",
                    "api_key": "test-key-side",
                    "model": "fake-model",
                    "temperature": 0.1,
                },
                method="POST",
            )["settings"]
            self.assertTrue(saved["has_api_key"])
            self.assertTrue(saved["ready"])
            self.assertEqual(saved["route"], "provider")
            self.assertNotIn("api_key", saved)
            self.assertEqual(saved["api_key_hint"], "...side")

            public = self.request("/v1/model-settings")["settings"]
            self.assertTrue(public["has_api_key"])
            self.assertNotIn("api_key", public)

            chat = self.request("/v1/llm/chat", {"prompt": "hello from service"}, method="POST")
            self.assertEqual(chat["answer"], "service model ok")
            self.assertEqual(captured["path"], "/v1/chat/completions")
            self.assertEqual(captured["authorization"], "Bearer test-key-side")
            self.assertEqual(captured["payload"]["model"], "fake-model")
            self.assertEqual(captured["payload"]["messages"][-1]["content"], "hello from service")

            runs = self.db_rows("SELECT * FROM agent_runs")
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["agent_id"], "service_llm_chat")
            self.assertEqual(runs[0]["model"], "fake-model")
            self.assertEqual(runs[0]["status"], "success")
            self.assertNotIn("test-key-side", runs[0]["input_json"])
        finally:
            model_httpd.shutdown()
            model_httpd.server_close()
            model_thread.join(timeout=5)

    def test_mock_provider_is_explicit_and_never_calls_an_external_model(self) -> None:
        settings = self.request(
            "/v1/model-settings",
            {
                "provider": "mock",
                # Retained credentials from a previously configured provider
                # must not make the local mock route externally callable.
                "base_url": "https://api.example.com/v1",
                "api_key": "must-not-be-used",
                "model": "previous-model",
            },
            method="POST",
        )["settings"]
        self.assertEqual(settings["provider"], "mock")
        self.assertTrue(settings["ready"])
        self.assertEqual(settings["route"], "mock")
        private = self.store.read_model_settings(include_secret=True)
        self.assertFalse(self.store.model_settings_ready(private))

        with mock.patch.object(self.store, "call_openai_compatible") as openai_call, mock.patch.object(
            self.store, "call_anthropic"
        ) as anthropic_call, mock.patch.object(self.store, "call_codex_cli") as codex_call:
            with self.assertRaisesRegex(ValueError, "mock provider cannot call an external model"):
                self.store.call_model_with_messages(private, [{"role": "user", "content": "stay local"}])
            with self.assertRaisesRegex(AssertionError, "mock provider does not support chat"):
                self.request("/v1/llm/chat", {"prompt": "do not send this"}, method="POST")
            openai_call.assert_not_called()
            anthropic_call.assert_not_called()
            codex_call.assert_not_called()

    def test_legacy_providerless_model_settings_remain_openai_compatible(self) -> None:
        self.store.model_settings_path.write_text(
            json.dumps(
                {
                    "base_url": "https://api.example.com/v1",
                    "api_key": "legacy-key",
                    "model": "legacy-model",
                }
            ),
            encoding="utf-8",
        )
        self.store.model_settings_path.chmod(0o600)

        private = self.store.read_model_settings(include_secret=True)
        self.assertEqual(private["provider"], "openai")
        self.assertTrue(self.store.model_settings_ready(private))
        public = self.store.read_model_settings()
        self.assertEqual(public["provider"], "openai")
        self.assertTrue(public["ready"])
        self.assertEqual(public["route"], "provider")
        self.assertNotIn("api_key", public)

    def test_model_transport_refuses_redirects_and_insecure_remote_endpoints(self) -> None:
        target_requests: list[dict] = []

        class TargetHandler(server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                target_requests.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()

            def log_message(self, _fmt: str, *_args: object) -> None:
                return None

        target_httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        target_port = target_httpd.server_address[1]
        target_thread = threading.Thread(target=target_httpd.serve_forever, daemon=True)
        target_thread.start()

        class RedirectHandler(server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.send_response(307)
                self.send_header("location", f"http://127.0.0.1:{target_port}/steal")
                self.end_headers()

            def log_message(self, _fmt: str, *_args: object) -> None:
                return None

        redirect_httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        redirect_port = redirect_httpd.server_address[1]
        redirect_thread = threading.Thread(target=redirect_httpd.serve_forever, daemon=True)
        redirect_thread.start()
        try:
            with self.assertRaisesRegex(ValueError, "redirects are refused"):
                self.store.post_model_json(
                    f"http://127.0.0.1:{redirect_port}/v1/chat/completions",
                    {"model": "fixture"},
                    {"authorization": "Bearer must-not-cross", "content-type": "application/json"},
                )
            self.assertEqual(target_requests, [], "model credentials reached a redirect destination")
        finally:
            redirect_httpd.shutdown()
            redirect_httpd.server_close()
            redirect_thread.join(timeout=5)
            target_httpd.shutdown()
            target_httpd.server_close()
            target_thread.join(timeout=5)

        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            self.store.join_model_url("http://api.example.com/v1", "chat/completions")
        with self.assertRaisesRegex(ValueError, "credentials"):
            self.store.join_model_url("https://user:secret@api.example.com/v1", "chat/completions")
        self.assertEqual(
            self.store.join_model_url("http://localhost:11434/v1", "chat/completions"),
            "http://localhost:11434/v1/chat/completions",
        )

    def test_model_http_errors_close_unreliable_response_bodies_without_masking_status(self) -> None:
        redirect_body = mock.Mock()
        redirect_body.read.side_effect = AssertionError("redirect bodies must never be read")
        redirect_error = urllib.error.HTTPError(
            "http://127.0.0.1/model",
            307,
            "Temporary Redirect",
            {},
            redirect_body,
        )
        redirect_opener = mock.Mock()
        redirect_opener.open.side_effect = redirect_error
        with mock.patch.object(server.urllib.request, "build_opener", return_value=redirect_opener):
            with self.assertRaisesRegex(ValueError, "model HTTP 307: redirects are refused"):
                self.store.post_model_json(
                    "http://127.0.0.1/model",
                    {"model": "fixture"},
                    {"authorization": "Bearer must-not-cross"},
                )
        redirect_body.read.assert_not_called()
        redirect_body.close.assert_called_once_with()

        failed_body = mock.Mock()
        failed_body.read.side_effect = ConnectionResetError(54, "connection reset")
        failed_error = urllib.error.HTTPError(
            "http://127.0.0.1/model",
            503,
            "Unavailable",
            {},
            failed_body,
        )
        failed_opener = mock.Mock()
        failed_opener.open.side_effect = failed_error
        with mock.patch.object(server.urllib.request, "build_opener", return_value=failed_opener):
            with self.assertRaisesRegex(ValueError, "model HTTP 503: the error response body could not be read"):
                self.store.post_model_json(
                    "http://127.0.0.1/model",
                    {"model": "fixture"},
                    {"authorization": "Bearer fixture"},
                )
        failed_body.close.assert_called_once_with()

    def test_capture_writes_vault_chunks_and_search(self) -> None:
        text = "\n\n".join(
            [
                "# Forum Strategy Note",
                "Factor rotation signal and evidence chain.",
                "Risk check: crowding, drawdown, liquidity.",
                "This capture contains enough detail to count as a normal source rather than a low-text review item.",
                "It names the strategy premise, evidence chain, operational risk, and follow-up validation notes.",
            ]
        )
        response = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://bbs.quantclass.cn/thread/fixture",
                    "title": "Fixture Forum Strategy",
                    "site": "quantclass",
                    "author": "fixture-author",
                    "captured_at": "2026-06-27T00:00:00+00:00",
                },
                "content": {
                    "text": text,
                    "markdown": text,
                    "attachments": [
                        {
                            "href": "https://cdn.quantclass.cn/files/upper-shadow.zip?utm_source=forum",
                            "text": "附件：upper-shadow.zip",
                            "context": "main post attachment",
                            "floor": "1",
                        }
                    ],
                    "blocks": [
                        {
                            "type": "post",
                            "floor": "1",
                            "text": "main post attachment context",
                            "attachments": [
                                {
                                    "href": "https://cdn.quantclass.cn/files/upper-shadow.zip?utm_source=forum#download",
                                    "text": "附件：upper-shadow.zip",
                                }
                            ],
                        }
                    ],
                    "next_pages": ["https://bbs.quantclass.cn/thread/fixture?page=2&utm_source=forum"],
                },
                "browser": {"tab_id": 1, "window_id": 2},
            },
            method="POST",
        )

        source = response["source"]
        self.assertEqual(source["kind"], "thread")
        self.assertEqual(source["status"], "needs_review")
        self.assertFalse(response["duplicate"])
        self.assertTrue(response["chunks"][0]["id"].startswith("chk_"))
        self.assertEqual(len(response["attachments"]), 1)
        self.assertEqual(response["attachments"][0]["filename"], "upper-shadow.zip")
        self.assertEqual(response["attachments"][0]["status"], "linked")
        self.assertTrue(Path(source["raw_path"]).exists())
        self.assertTrue(Path(source["markdown_path"]).exists())
        self.assertTrue((self.data_dir / "vault" / "AGENTS.md").exists())
        self.assertIn("Fixture Forum Strategy", (self.data_dir / "vault" / "index.md").read_text())

        chunks = self.db_rows("SELECT * FROM chunks ORDER BY chunk_index")
        self.assertEqual(len(chunks), 1)
        self.assertIn("Factor rotation", chunks[0]["text"])
        attachments = self.db_rows("SELECT * FROM source_attachments WHERE source_id = ?", (source["id"],))
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0]["filename"], "upper-shadow.zip")
        self.assertEqual(attachments[0]["floor"], "1")
        self.assertEqual(attachments[0]["status"], "linked")
        self.assertEqual(attachments[0]["downloaded_path"], "")

        search = self.request("/v1/search", {"query": "liquidity", "limit": 10}, method="POST")
        self.assertTrue(search["chunks"])
        self.assertEqual(search["chunks"][0]["source_id"], source["id"])

        duplicate = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://mirror.example/thread", "title": "Duplicate"},
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["source"]["id"], source["id"])
        self.assertEqual(duplicate["attachments"][0]["filename"], "upper-shadow.zip")

        note = self.request(
            "/v1/notes",
            {
                "source_id": source["id"],
                "title": "Fixture Forum Strategy Note",
                "question": "What matters?",
                "answer": "Factor rotation needs risk checks.",
                "excerpt": "Factor rotation signal and evidence chain.",
                "tags": ["risk-check", "factor-rotation"],
            },
            method="POST",
        )["note"]
        note_search = self.request("/v1/search", {"query": "risk-check", "limit": 10}, method="POST")
        self.assertEqual(note_search["notes"][0]["id"], note["id"])
        self.assertIn("risk-check", note_search["notes"][0]["tags"])

        detail = self.request(f"/v1/sources/{source['id']}")["source"]
        self.assertIn("Factor rotation signal", detail["text"])
        self.assertEqual(detail["chunks"][0]["id"], response["chunks"][0]["id"])
        self.assertIn("Factor rotation", detail["chunks"][0]["snippet"])
        self.assertEqual(detail["attachments"][0]["retry_error"], "")
        self.assertEqual(detail["attachments"][0]["context"], "main post attachment")
        self.assertTrue(detail["quality_flags"]["pagination_needed"])
        self.assertTrue(detail["quality_flags"]["attachment_missing"])
        self.assertEqual(detail["quality_flags"]["next_pages"][0], "https://bbs.quantclass.cn/thread/fixture?page=2&utm_source=forum")
        self.assertEqual(detail["notes"][0]["id"], note["id"])
        self.assertTrue(detail["documents"][0]["markdown_path"].endswith(".md"))

        reviewed = self.request(f"/v1/sources/{source['id']}/status", {"status": "reviewed"}, method="POST")["source"]
        self.assertEqual(reviewed["status"], "reviewed")
        reviewed_list = self.request("/v1/sources?status=reviewed&limit=10")["sources"]
        self.assertEqual(reviewed_list[0]["id"], source["id"])
        self.assertIn("- Status: reviewed", Path(reviewed["markdown_path"]).read_text())
        with self.assertRaises(AssertionError):
            self.request(f"/v1/sources/{source['id']}/status", {"status": "not-a-status"}, method="POST")
        export = self.request("/v1/export?format=json")
        self.assertEqual(export["counts"]["source_attachments"], 1)
        package = json.loads(export["content"])
        exported_source = next(item for item in package["sources"] if item["id"] == source["id"])
        self.assertEqual(exported_source["attachments"][0]["filename"], "upper-shadow.zip")
        markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Source Attachments", markdown_export["content"])
        self.assertIn("upper-shadow.zip", markdown_export["content"])

    def test_capture_returns_success_with_warning_when_post_commit_index_rebuild_fails(self) -> None:
        payload = {
            "source": {
                "kind": "page",
                "url": "https://example.com/post-commit-warning",
                "title": "Post-commit warning fixture",
            },
            "content": {
                "markdown": (
                    "A complete source capture that must remain committed even when the "
                    "rebuildable Vault index cannot be refreshed."
                )
            },
        }
        with mock.patch.object(
            self.store,
            "rebuild_index",
            side_effect=OSError("simulated index write failure"),
        ):
            result = self.store.capture(payload)

        self.assertTrue(result["ok"])
        self.assertFalse(result["duplicate"])
        self.assertEqual(
            [warning["code"] for warning in result["warnings"]],
            ["capture_index_rebuild_failed"],
        )
        self.assertFalse(result["warnings"][0]["retry_capture"])
        self.assertIn("Capture committed", result["warnings"][0]["message"])
        source_rows = self.db_rows("SELECT * FROM sources WHERE id = ?", (result["source"]["id"],))
        document_rows = self.db_rows(
            "SELECT * FROM documents WHERE source_id = ?",
            (result["source"]["id"],),
        )
        self.assertEqual(len(source_rows), 1)
        self.assertEqual(len(document_rows), 1)
        self.assertTrue(Path(result["source"]["raw_path"]).is_file())
        self.assertTrue(Path(result["source"]["markdown_path"]).is_file())

    def test_canonical_urls_dedupe_jobs_capture_plans_and_record_source_aliases(self) -> None:
        tracked_url = "https://www.Example.com:443/thread/1?utm_source=news&b=2&a=1#section"
        clean_variant = "https://example.com/thread/1?a=1&b=2&utm_medium=email"
        canonical = "https://example.com/thread/1?a=1&b=2"

        plans = self.request(
            "/v1/capture-plans",
            {
                "status": "approved",
                "items": [
                    {"url": tracked_url, "title": "Tracked URL"},
                    {"url": clean_variant, "title": "Clean URL"},
                ],
            },
            method="POST",
        )["plans"]
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["canonical_url"], canonical)
        self.assertEqual(plans[0]["metadata"]["original_url"], clean_variant)
        self.assertEqual(plans[0]["metadata"]["original_urls"], [tracked_url, clean_variant])

        enqueued = self.request("/v1/capture-plans/enqueue-approved", {}, method="POST")
        self.assertEqual(len(enqueued["job"]["items"]), 1)
        self.assertEqual(enqueued["job"]["items"][0]["input"]["canonical_url"], canonical)

        job = self.request(
            "/v1/jobs/read",
            {"items": [{"url": tracked_url}, {"url": clean_variant}]},
            method="POST",
        )["job"]
        self.assertEqual(len(job["items"]), 1)
        self.assertEqual(job["items"][0]["input"]["canonical_url"], canonical)

        text = "Canonical duplicate source body with enough evidence text for alias tracking."
        first = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": tracked_url,
                    "title": "Tracked Source",
                    "captured_at": "2026-06-27T00:00:00+00:00",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        self.assertFalse(first["duplicate"])
        self.assertEqual(first["source"]["canonical_url"], canonical)
        self.assertEqual(first["source"]["alias_urls"][0]["url"], tracked_url)
        self.assertEqual(first["source"]["alias_records"][0]["url"], tracked_url)
        self.assertEqual(first["source"]["versions"][0]["version_index"], 1)
        self.assertTrue(first["source"]["versions"][0]["is_current"])

        duplicate = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": clean_variant,
                    "title": "Clean Source",
                    "captured_at": "2026-06-27T00:05:00+00:00",
                },
                "content": {
                    "text": text,
                    "markdown": text,
                    "attachments": [
                        {
                            "url": "https://example.com/thread/1/files/factor.zip?utm_source=mail",
                            "filename": "factor.zip",
                            "context": "duplicate capture added the attachment",
                        }
                    ],
                },
                "browser": {},
            },
            method="POST",
        )
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["source"]["id"], first["source"]["id"])
        self.assertEqual(duplicate["source"]["canonical_url"], canonical)
        self.assertEqual({item["url"] for item in duplicate["source"]["alias_urls"]}, {tracked_url, clean_variant})
        self.assertEqual({item["url"] for item in duplicate["source"]["alias_records"]}, {tracked_url, clean_variant})
        self.assertEqual(len(duplicate["source"]["versions"]), 1)
        self.assertEqual(duplicate["duplicate_attachments_merged"], 1)
        self.assertEqual(duplicate["attachments"][0]["filename"], "factor.zip")

        changed_text = "Canonical duplicate source body changed after an edit, with enough evidence text for version tracking."
        second_version = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": clean_variant,
                    "title": "Clean Source Edited",
                    "captured_at": "2026-06-27T00:10:00+00:00",
                },
                "content": {"text": changed_text, "markdown": changed_text},
                "browser": {},
            },
            method="POST",
        )
        self.assertFalse(second_version["duplicate"])
        self.assertNotEqual(second_version["source"]["id"], first["source"]["id"])
        self.assertEqual(second_version["source"]["canonical_url"], canonical)
        self.assertEqual([item["version_index"] for item in second_version["source"]["versions"]], [1, 2])
        self.assertEqual(second_version["source"]["versions"][-1]["source_id"], second_version["source"]["id"])
        self.assertTrue(second_version["source"]["versions"][-1]["is_current"])

        first_detail = self.request(f"/v1/sources/{first['source']['id']}")["source"]
        self.assertEqual([item["version_index"] for item in first_detail["versions"]], [1, 2])
        self.assertFalse(first_detail["versions"][0]["is_current"])

        export = self.request("/v1/export?format=json")
        package = json.loads(export["content"])
        exported_first = next(item for item in package["sources"] if item["id"] == first["source"]["id"])
        self.assertEqual({item["url"] for item in exported_first["alias_records"]}, {tracked_url, clean_variant})
        self.assertEqual([item["version_index"] for item in exported_first["versions"]], [1, 2])

    def test_project_scoped_sources_notes_search_and_export(self) -> None:
        projects = self.request("/v1/projects")
        self.assertTrue(any(project["id"] == "default" for project in projects["projects"]))

        project = self.request("/v1/projects", {"name": "抱团股研究"}, method="POST")["project"]
        self.assertTrue(project["id"].startswith("proj_"))

        default_capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/default", "title": "Default Inbox Source"},
                "content": {"text": "Default inbox liquidity note.", "markdown": "Default inbox liquidity note."},
                "browser": {},
            },
            method="POST",
        )
        project_capture = self.request(
            "/v1/captures",
            {
                "project_id": project["id"],
                "source": {"kind": "thread", "url": "https://example.com/project", "title": "Project Scoped Source"},
                "content": {
                    "text": "Project alpha evidence chain. " * 40,
                    "markdown": "Project alpha evidence chain. " * 40,
                },
                "browser": {},
            },
            method="POST",
        )

        self.assertEqual(default_capture["source"]["project_id"], "default")
        self.assertEqual(project_capture["source"]["project_id"], project["id"])
        self.assertEqual(project_capture["source"]["status"], "new")
        project_source_id = project_capture["source"]["id"]

        dashboard = self.request(f"/v1/projects/{project['id']}/dashboard")["dashboard"]
        self.assertEqual([stage["id"] for stage in dashboard["stages"]], ["collect", "screen", "research", "deliver", "strategy"])
        self.assertEqual(dashboard["project"]["id"], project["id"])
        self.assertEqual(dashboard["metrics"]["source_count"], 1)
        self.assertEqual(dashboard["metrics"]["screened_source_count"], 0)
        collect_stage = next(stage for stage in dashboard["stages"] if stage["id"] == "collect")
        screen_stage = next(stage for stage in dashboard["stages"] if stage["id"] == "screen")
        self.assertEqual(collect_stage["current"], 1)
        self.assertEqual(collect_stage["target"], 100)
        self.assertFalse(dashboard["metrics"]["project_brief_complete"])
        self.assertIn("项目 brief/rubric 不完整", "\n".join(collect_stage["blockers"]))
        self.assertEqual(screen_stage["status"], "in_progress")

        brief = self.request(
            f"/v1/projects/{project['id']}/brief",
            {
                "research_question": "抱团股是否仍有可交易的结构性机会？",
                "target_output": "研究报告、PPT 大纲、视频脚本和策略任务单。",
                "inclusion_rules": ["论坛策略复盘", "含可验证信号或数据口径"],
                "exclusion_rules": ["纯情绪发泄", "没有来源或参数的口号"],
                "evidence_threshold": "关键结论至少 2 个来源，或 1 个高质量原文引用。",
                "review_policy": "先审 source，再审 claim；冲突观点不得直接进入 final。",
                "strategy_scope": "A 股，日频到周频，偏中短周期轮动。",
            },
            method="POST",
        )["brief"]
        self.assertTrue(brief["complete"])
        self.assertTrue(Path(brief["markdown_path"]).exists())
        self.assertIn("抱团股是否仍有可交易", Path(brief["markdown_path"]).read_text())

        plans = self.request(
            "/v1/capture-plans",
            {
                "project_id": project["id"],
                "urls": ["https://example.com/project/thread-a", "https://example.com/project/thread-b"],
                "source_type": "thread",
                "priority": 2,
                "reason": "论坛里和抱团股策略直接相关的长帖。",
            },
            method="POST",
        )["plans"]
        self.assertEqual(len(plans), 2)
        self.assertEqual(plans[0]["status"], "candidate")
        self.assertTrue(Path(plans[0]["markdown_path"]).exists())

        approved_plan = self.request(
            f"/v1/capture-plans/{plans[0]['id']}/status",
            {"status": "approved", "reviewer": "unit-test", "screen_reason": "matches rubric"},
            method="POST",
        )["plan"]
        self.assertEqual(approved_plan["status"], "approved")
        self.assertEqual(approved_plan["reviewer"], "unit-test")
        self.request(
            f"/v1/capture-plans/{plans[1]['id']}/status",
            {"status": "rejected", "screen_reason": "too broad"},
            method="POST",
        )
        queued = self.request(
            "/v1/capture-plans/enqueue-approved",
            {"project_id": project["id"]},
            method="POST",
        )
        self.assertEqual(len(queued["plans"]), 1)
        self.assertEqual(queued["plans"][0]["status"], "queued")
        self.assertEqual(queued["job"]["input"]["items"][0]["capture_plan_id"], plans[0]["id"])
        queued_item = queued["job"]["items"][0]
        self.request(
            f"/v1/jobs/{queued['job']['id']}/items/{queued_item['id']}/status",
            {"status": "success", "source_id": project_source_id},
            method="POST",
        )
        captured_plan = self.request(f"/v1/capture-plans/{plans[0]['id']}")["plan"]
        self.assertEqual(captured_plan["status"], "captured")
        self.assertEqual(captured_plan["source_id"], project_source_id)

        default_sources = self.request("/v1/sources?project_id=default&limit=20")["sources"]
        project_sources = self.request(f"/v1/sources?project_id={project['id']}&limit=20")["sources"]
        self.assertEqual([item["id"] for item in default_sources], [default_capture["source"]["id"]])
        self.assertEqual([item["id"] for item in project_sources], [project_source_id])

        default_search = self.request("/v1/search", {"query": "alpha", "project_id": "default"}, method="POST")
        project_search = self.request("/v1/search", {"query": "alpha", "project_id": project["id"]}, method="POST")
        self.assertFalse(default_search["chunks"])
        self.assertEqual(project_search["chunks"][0]["source_id"], project_source_id)

        note = self.request(
            "/v1/notes",
            {
                "project_id": project["id"],
                "source_id": project_source_id,
                "title": "Project Note",
                "question": "What matters?",
                "answer": "The project source matters.",
                "excerpt": "Project alpha evidence chain.",
            },
            method="POST",
        )["note"]
        self.assertEqual(note["project_id"], project["id"])
        self.assertFalse(self.request("/v1/notes?project_id=default")["notes"])
        self.assertEqual(self.request(f"/v1/notes?project_id={project['id']}")["notes"][0]["id"], note["id"])

        self.request(f"/v1/sources/{project_source_id}/status", {"status": "reviewed"}, method="POST")
        screened_dashboard = self.request(f"/v1/projects/{project['id']}/dashboard")["dashboard"]
        screen_stage = next(stage for stage in screened_dashboard["stages"] if stage["id"] == "screen")
        self.assertEqual(screen_stage["current"], 1)
        self.assertEqual(screen_stage["status"], "ready")

        low_quality_capture = self.request(
            "/v1/captures",
            {
                "project_id": project["id"],
                "source": {"kind": "thread", "url": "https://example.com/project/low", "title": "Low Quality Source"},
                "content": {
                    "text": "tiny",
                    "markdown": "tiny",
                    "stats": {
                        "lowText": True,
                        "quality": 80,
                        "truncation": {
                            "comments": {"total": 130, "kept": 119, "limit": 119, "truncated": True},
                        },
                    },
                },
                "browser": {},
            },
            method="POST",
        )
        low_quality_source_id = low_quality_capture["source"]["id"]
        self.assertEqual(low_quality_capture["source"]["status"], "needs_review")
        self.assertIn("- Status: needs_review", Path(low_quality_capture["source"]["markdown_path"]).read_text())
        needs_review_sources = self.request(f"/v1/sources?project_id={project['id']}&status=needs_review&limit=10")["sources"]
        self.assertEqual([item["id"] for item in needs_review_sources], [low_quality_source_id])
        low_quality_detail = self.request(f"/v1/sources/{low_quality_source_id}")["source"]
        self.assertEqual(low_quality_detail["status"], "needs_review")
        self.assertTrue(low_quality_detail["quality_flags"]["truncated"])
        self.assertEqual(low_quality_detail["quality_flags"]["truncation"]["comments"]["total"], 130)
        self.assertLess(low_quality_detail["extraction_quality"], 80)
        self.request(f"/v1/sources/{low_quality_source_id}/status", {"status": "reviewed"}, method="POST")
        quality_dashboard = self.request(f"/v1/projects/{project['id']}/dashboard")["dashboard"]
        quality_screen_stage = next(stage for stage in quality_dashboard["stages"] if stage["id"] == "screen")
        self.assertEqual(quality_screen_stage["status"], "in_progress")
        self.assertEqual(quality_dashboard["metrics"]["source_quality_blocker_count"], 1)
        self.assertEqual(quality_dashboard["metrics"]["source_quality_issue_counts"]["truncated"], 1)
        self.assertIn("抽取质量问题", "\n".join(quality_screen_stage["blockers"]))
        self.request(f"/v1/sources/{low_quality_source_id}/status", {"status": "rejected"}, method="POST")

        attachment_capture = self.request(
            "/v1/captures",
            {
                "project_id": project["id"],
                "source": {"kind": "thread", "url": "https://example.com/project/attachment", "title": "Attachment Source"},
                "content": {
                    "text": "Attachment source with enough text and context for a real review. " * 20,
                    "markdown": "Attachment source with enough text and context for a real review. " * 20,
                    "attachments": [{"href": "https://example.com/files/model.zip", "text": "model.zip"}],
                },
                "browser": {},
            },
            method="POST",
        )
        attachment_source_id = attachment_capture["source"]["id"]
        self.assertEqual(attachment_capture["source"]["status"], "needs_review")
        self.assertTrue(attachment_capture["source"]["quality_flags"]["attachment_missing"])
        attachment_dashboard = self.request(f"/v1/projects/{project['id']}/dashboard")["dashboard"]
        attachment_screen_stage = next(stage for stage in attachment_dashboard["stages"] if stage["id"] == "screen")
        self.assertEqual(attachment_dashboard["metrics"]["source_quality_issue_counts"]["attachment_missing"], 1)
        self.assertIn("attachment_missing=1", "\n".join(attachment_screen_stage["blockers"]))
        self.request(f"/v1/sources/{attachment_source_id}/status", {"status": "rejected"}, method="POST")

        quality_accepted_dashboard = self.request(f"/v1/projects/{project['id']}/dashboard")["dashboard"]
        quality_accepted_screen = next(stage for stage in quality_accepted_dashboard["stages"] if stage["id"] == "screen")
        self.assertEqual(quality_accepted_screen["status"], "ready")

        confirmed_dashboard = self.request(
            f"/v1/projects/{project['id']}/stages/collect/confirm",
            {"reviewer": "unit-test", "note": "Fixture risk accepted below 100 sources."},
            method="POST",
        )["dashboard"]
        confirmed_collect = next(stage for stage in confirmed_dashboard["stages"] if stage["id"] == "collect")
        self.assertTrue(confirmed_collect["confirmed"])
        self.assertEqual(confirmed_collect["status"], "confirmed")
        self.assertEqual(confirmed_collect["reviewer"], "unit-test")

        export = self.request(f"/v1/export?format=json&project_id={project['id']}")
        package = json.loads(export["content"])
        self.assertEqual(package["project_id"], project["id"])
        self.assertEqual(package["project_dashboard"]["project"]["id"], project["id"])
        self.assertTrue(package["project_brief"]["complete"])
        self.assertEqual(len(package["capture_plans"]), 2)
        exported_collect = next(stage for stage in package["project_dashboard"]["stages"] if stage["id"] == "collect")
        self.assertTrue(exported_collect["confirmed"])
        self.assertEqual({item["id"] for item in package["sources"]}, {project_source_id, low_quality_source_id, attachment_source_id})
        self.assertEqual([item["id"] for item in package["notes"]], [note["id"]])

        doctor = self.request(f"/v1/vault/doctor?project_id={project['id']}&write_report=1")["doctor"]
        self.assertTrue(doctor["ok"])
        self.assertTrue(Path(doctor["markdown_path"]).exists())
        self.assertGreater(doctor["counts"]["files_checked"], 0)
        self.assertGreater(doctor["counts"]["references_checked"], 0)

        Path(note["markdown_path"]).unlink()
        broken_doctor = self.request(f"/v1/vault/doctor?project_id={project['id']}")["doctor"]
        self.assertFalse(broken_doctor["ok"])
        self.assertTrue(
            any(
                issue["code"] == "missing_file"
                and issue["table"] == "notes"
                and issue["record_id"] == note["id"]
                for issue in broken_doctor["issues"]
            )
        )

    def test_cross_project_mutations_are_rejected_and_doctor_reports_legacy_links(self) -> None:
        other_project = self.request(
            "/v1/projects",
            {"name": "Cross-project boundary"},
            method="POST",
        )["project"]
        default_text = "Default-project evidence must never be linked into another project. " * 12
        other_text = "The isolated project owns a separate source and evidence namespace. " * 12
        default_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/project-boundary-default",
                    "title": "Default boundary source",
                },
                "content": {"text": default_text, "markdown": default_text},
                "browser": {},
            },
            method="POST",
        )
        other_capture = self.request(
            "/v1/captures",
            {
                "project_id": other_project["id"],
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/project-boundary-other",
                    "title": "Other boundary source",
                },
                "content": {"text": other_text, "markdown": other_text},
                "browser": {},
            },
            method="POST",
        )
        default_source_id = default_capture["source"]["id"]
        default_chunk_id = default_capture["chunks"][0]["id"]
        other_source_id = other_capture["source"]["id"]

        default_knowledge = self.request(
            "/v1/knowledge/records",
            {
                "source_id": default_source_id,
                "claims": [
                    {
                        "id": "default-boundary-claim",
                        "text": "Default-project evidence must never be linked into another project.",
                        "evidence": [
                            {
                                "source_id": default_source_id,
                                "chunk_id": default_chunk_id,
                                "quote": "Default-project evidence must never be linked into another project.",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        default_claim_id = default_knowledge["claims"][0]["id"]

        for path, payload in (
            (
                "/v1/notes",
                {
                    "project_id": other_project["id"],
                    "source_id": default_source_id,
                    "title": "Blocked cross-project note",
                },
            ),
            (
                "/v1/deliverables",
                {
                    "project_id": other_project["id"],
                    "source_ids": [default_source_id],
                    "kind": "report",
                    "title": "Blocked cross-project deliverable",
                },
            ),
            (
                "/v1/knowledge/records",
                {
                    "project_id": other_project["id"],
                    "source_id": default_source_id,
                    "claims": [{"text": "This write must be rejected."}],
                },
            ),
            (
                "/v1/knowledge/records",
                {
                    "project_id": other_project["id"],
                    "source_id": other_source_id,
                    "claims": [
                        {
                            "text": "Cross-project citation must be rejected.",
                            "evidence": [
                                {
                                    "source_id": default_source_id,
                                    "chunk_id": default_chunk_id,
                                    "quote": "Default-project evidence must never be linked into another project.",
                                }
                            ],
                        }
                    ],
                },
            ),
            (
                "/v1/knowledge/records",
                {
                    "project_id": other_project["id"],
                    "source_id": other_source_id,
                    "assumptions": [
                        {"text": "Cross-project claim reference", "claim_id": default_claim_id}
                    ],
                },
            ),
        ):
            with self.assertRaisesRegex(
                AssertionError,
                r"(?s)HTTP 400:.*does not belong to project_id",
            ):
                self.request(path, payload, method="POST")

        legacy_note_id = "note_legacy_cross_project"
        legacy_note_path = self.data_dir / "vault" / "wiki" / "analyses" / f"{legacy_note_id}.md"
        legacy_note_path.write_text(
            f"---\nid: {legacy_note_id}\nproject_id: {other_project['id']}\n---\n\n# Legacy\n",
            encoding="utf-8",
        )
        with self.store.connect() as db:
            db.execute(
                """
                INSERT INTO notes(
                  id, project_id, source_id, title, summary, tags_json, question,
                  answer, excerpt, markdown_path, created_at, updated_at
                ) VALUES (?, ?, ?, ?, '', '[]', '', '', '', ?, ?, ?)
                """,
                (
                    legacy_note_id,
                    other_project["id"],
                    default_source_id,
                    "Legacy cross-project note",
                    str(legacy_note_path),
                    "2026-08-14T00:00:00+00:00",
                    "2026-08-14T00:00:00+00:00",
                ),
            )
            db.execute(
                """
                INSERT INTO assumptions(
                  id, project_id, source_id, claim_id, text, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending_validation', ?, ?)
                """,
                (
                    "asm_legacy_cross_project",
                    other_project["id"],
                    other_source_id,
                    default_claim_id,
                    "Legacy cross-project claim reference",
                    "2026-08-14T00:00:00+00:00",
                    "2026-08-14T00:00:00+00:00",
                ),
            )
            db.commit()

        doctor = self.request("/v1/vault/doctor?project_id=all")["doctor"]
        self.assertFalse(doctor["ok"])
        cross_project_issue = next(
            issue
            for issue in doctor["issues"]
            if issue["code"] == "cross_project_reference"
            and issue["table"] == "notes"
            and issue["record_id"] == legacy_note_id
            and issue["field"] == "source_id"
        )
        self.assertIn(default_source_id, cross_project_issue["message"])
        self.assertIn(other_project["id"], cross_project_issue["message"])
        self.assertTrue(
            any(
                issue["code"] == "cross_project_reference"
                and issue["table"] == "assumptions"
                and issue["record_id"] == "asm_legacy_cross_project"
                and issue["field"] == "claim_id"
                for issue in doctor["issues"]
            )
        )
        scoped_doctor = self.request(
            f"/v1/vault/doctor?project_id={other_project['id']}"
        )["doctor"]
        self.assertTrue(
            any(
                issue["code"] == "cross_project_reference"
                and issue["record_id"] == legacy_note_id
                for issue in scoped_doctor["issues"]
            )
        )
        self.assertFalse(
            any(
                issue["code"] == "missing_reference"
                and issue["record_id"] == legacy_note_id
                and issue["field"] == "source_id"
                for issue in scoped_doctor["issues"]
            )
        )

    def test_youtube_auto_transcript_prefers_manual_json3_and_parses_segments(self) -> None:
        video_id = "abc123xyz01"
        manual_track = "https://subs.example/manual.json3"
        automatic_track = "https://subs.example/automatic.json3"
        metadata = {
            "id": video_id,
            "title": "Automatic Transcript Fixture",
            "channel": "Fixture Channel",
            "upload_date": "20260801",
            "duration": 12.5,
            "subtitles": {
                "zh-Hans": [
                    {"ext": "vtt", "url": "https://subs.example/manual.vtt"},
                    {"ext": "json3", "url": manual_track},
                ]
            },
            "automatic_captions": {
                "zh-Hans": [{"ext": "json3", "url": automatic_track}]
            },
        }
        subtitle = {
            "events": [
                {
                    "tStartMs": 0,
                    "dDurationMs": 1000,
                    "segs": [{"utf8": "你好"}, {"utf8": " 世界"}],
                },
                {
                    "tStartMs": 1000,
                    "dDurationMs": 1000,
                    "segs": [{"utf8": "你好 世界"}],
                },
                {
                    "tStartMs": 2000,
                    "dDurationMs": 1500,
                    "segs": [{"utf8": "第二句字幕"}],
                },
            ]
        }

        run_result = mock.Mock(
            returncode=0,
            stdout=json.dumps(metadata),
            stderr="",
        )
        with mock.patch.object(server.shutil, "which", return_value="/opt/homebrew/bin/yt-dlp"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=run_result,
        ) as run_mock, mock.patch.object(
            self.store,
            "download_public_resource",
            return_value=json.dumps(subtitle, ensure_ascii=False).encode("utf-8"),
        ) as download_mock:
            result = self.store.ingest_youtube_transcript(
                {
                    "url": f"https://youtu.be/{video_id}?si=tracking",
                    "language": "zh-Hans",
                }
            )

        canonical_url = f"https://www.youtube.com/watch?v={video_id}"
        run_mock.assert_called_once_with(
            [
                "/opt/homebrew/bin/yt-dlp",
                "--dump-single-json",
                "--skip-download",
                "--no-playlist",
                "--no-warnings",
                "--ignore-config",
                "--no-cookies",
                "--no-cookies-from-browser",
                canonical_url,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=server.YOUTUBE_METADATA_TIMEOUT_SECONDS,
        )
        download_mock.assert_called_once_with(
            manual_track,
            max_bytes=server.MAX_YOUTUBE_SUBTITLE_BYTES,
            timeout_seconds=server.YOUTUBE_SUBTITLE_TIMEOUT_SECONDS,
            accept="application/json,text/json;q=0.9,*/*;q=0.1",
            label="subtitle track",
        )
        self.assertEqual(result["youtube"]["source"], "manual")
        self.assertEqual(result["youtube"]["caption_source"], "manual")
        self.assertEqual(result["youtube"]["language"], "zh-Hans")
        self.assertEqual(result["youtube"]["url"], canonical_url)
        self.assertEqual(result["youtube"]["segments"], 2)
        self.assertEqual(result["source"]["title"], "Automatic Transcript Fixture")
        self.assertEqual(result["source"]["author"], "Fixture Channel")
        self.assertEqual(result["source"]["published_at"], "2026-08-01")

    def test_youtube_auto_transcript_uses_language_fallback_and_metadata(self) -> None:
        video_id = "ZYX987abc12"
        chosen_track = "https://subs.example/zh-hant.json3"
        metadata = {
            "title": "Fallback Fixture",
            "uploader": "Fallback Uploader",
            "duration": 7,
            "subtitles": {},
            "automatic_captions": {
                "en": [{"ext": "json3", "url": "https://subs.example/en.json3"}],
                "zh-Hant": [{"ext": "json3", "url": chosen_track}],
            },
        }
        subtitle = {
            "events": [
                {"tStartMs": 250, "dDurationMs": 750, "segs": [{"utf8": "自動字幕"}]}
            ]
        }

        with mock.patch.object(server.shutil, "which", return_value="/usr/local/bin/yt-dlp"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=mock.Mock(returncode=0, stdout=json.dumps(metadata), stderr=""),
        ), mock.patch.object(
            self.store,
            "download_public_resource",
            return_value=json.dumps(subtitle, ensure_ascii=False).encode("utf-8"),
        ) as download_mock:
            result = self.store.ingest_youtube_transcript(
                {
                    "url": f"https://www.youtube.com/shorts/{video_id}",
                    "language": "fr",
                }
            )

        self.assertEqual(download_mock.call_args.args[0], chosen_track)
        self.assertEqual(result["youtube"]["source"], "automatic")
        self.assertEqual(result["youtube"]["caption_source"], "automatic")
        self.assertEqual(result["youtube"]["language"], "zh-Hant")
        self.assertEqual(result["youtube"]["duration"], 7)
        self.assertEqual(result["source"]["author"], "Fallback Uploader")

    def test_youtube_language_preference_accepts_comma_separated_values(self) -> None:
        self.assertEqual(
            self.store.youtube_language_order("zh-Hans,en,zh-Hans"),
            ["zh-Hans", "en", "zh-Hant", "zh"],
        )

    def test_youtube_auto_transcript_reports_actionable_failures(self) -> None:
        video_id = "abc123xyz01"
        url = f"https://www.youtube.com/watch?v={video_id}"
        with mock.patch.object(server.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "yt-dlp.*paste.*transcript"):
                self.store.ingest_youtube_transcript({"url": url})

        no_subtitles = mock.Mock(
            returncode=0,
            stdout=json.dumps({"subtitles": {}, "automatic_captions": {}}),
            stderr="",
        )
        with mock.patch.object(server.shutil, "which", return_value="/usr/bin/yt-dlp"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=no_subtitles,
        ), mock.patch.object(self.store, "download_public_resource") as download_mock:
            with self.assertRaisesRegex(ValueError, "No public subtitles.*paste.*transcript"):
                self.store.ingest_youtube_transcript({"url": url})
            download_mock.assert_not_called()

        available = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "subtitles": {"en": [{"ext": "json3", "url": "https://subs.example/en.json3"}]},
                    "automatic_captions": {},
                }
            ),
            stderr="",
        )
        with mock.patch.object(server.shutil, "which", return_value="/usr/bin/yt-dlp"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=available,
        ), mock.patch.object(
            self.store,
            "download_public_resource",
            side_effect=ValueError("subtitle track network request failed"),
        ):
            with self.assertRaisesRegex(ValueError, "download.*subtitle.*paste.*transcript"):
                self.store.ingest_youtube_transcript({"url": url})

    def test_youtube_auto_transcript_rejects_noncanonical_video_urls(self) -> None:
        video_id = "abc123xyz01"
        with mock.patch.object(server.shutil, "which") as which_mock:
            with self.assertRaisesRegex(ValueError, "valid YouTube URL"):
                self.store.ingest_youtube_transcript(
                    {"url": f"https://notyoutube.com/watch?v={video_id}"}
                )
            with self.assertRaisesRegex(ValueError, "valid YouTube URL"):
                self.store.ingest_youtube_transcript(
                    {"url": "https://www.youtube.com/watch?v=too-short"}
                )
            which_mock.assert_not_called()

    def test_youtube_subtitle_download_rejects_private_metadata_target(self) -> None:
        video_id = "abc123xyz01"
        metadata = {
            "subtitles": {
                "en": [{"ext": "json3", "url": "http://127.0.0.1/private-captions"}]
            },
            "automatic_captions": {},
        }
        with mock.patch.object(server.shutil, "which", return_value="/usr/bin/yt-dlp"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=mock.Mock(returncode=0, stdout=json.dumps(metadata), stderr=""),
        ), mock.patch.object(server.socket, "create_connection") as connect_mock:
            with self.assertRaisesRegex(ValueError, "non-public network address"):
                self.store.ingest_youtube_transcript(
                    {"url": f"https://www.youtube.com/watch?v={video_id}"}
                )
        connect_mock.assert_not_called()

    def test_capture_quality_flags_youtube_learning_and_claim_review(self) -> None:
        youtube = self.request(
            "/v1/youtube/transcripts",
            {
                "url": "https://www.youtube.com/watch?v=abc123xyz",
                "title": "Transformer API Study Video",
                "channel": "Study Channel",
                "language": "zh-CN",
                "segments": [
                    {"start": 0, "duration": 8, "text": "Transformer 模型需要把输入切成 token 并建立上下文。"},
                    {"start": 8, "duration": 10, "text": "API 产品化时要记录证据、成本和失败模式。"},
                    {"start": 18, "duration": 12, "text": "复习时应该先闭卷回忆，再核对字幕时间戳。"},
                ],
            },
            method="POST",
        )
        source = youtube["source"]
        self.assertEqual(source["kind"], "video")
        self.assertEqual(source["site"], "youtube")
        self.assertEqual(youtube["youtube"]["video_id"], "abc123xyz")
        self.assertEqual(youtube["youtube"]["caption_source"], "manual")
        self.assertEqual(youtube["youtube"]["language"], "zh-CN")
        self.assertGreaterEqual(source["extraction_quality"], 70)
        self.assertTrue(source["quality_flags"]["timestamped"])

        chunks = self.db_rows("SELECT text, timestamp_start, timestamp_end FROM chunks ORDER BY chunk_index")
        self.assertEqual(chunks[0]["timestamp_start"], 0)
        self.assertEqual(chunks[0]["timestamp_end"], 30)
        self.assertIn("[00:08]", chunks[0]["text"])

        detail = self.request(f"/v1/sources/{source['id']}")["source"]
        self.assertEqual(detail["chunks"][0]["timestamp_start"], 0)
        self.assertEqual(detail["quality_flags"]["timestamped"], True)

        chunk_id = self.db_rows("SELECT id FROM chunks LIMIT 1")[0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source["id"],
                "claims": [
                    {
                        "id": "yt-claim",
                        "text": "API 产品化时要记录证据、成本和失败模式。",
                        "evidence": [
                            {
                                "source_id": source["id"],
                                "chunk_id": chunk_id,
                                "quote": "API 产品化时要记录证据、成本和失败模式。",
                                "timestamp": "00:08",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        claim_id = records["claims"][0]["id"]
        evidence_id = records["evidence"][0]["id"]
        review_queue = self.request("/v1/claims/review-queue?status=extracted&project_id=default")
        queued_claim = next(item for item in review_queue["claims"] if item["id"] == claim_id)
        self.assertEqual(queued_claim["evidence_count"], 1)
        self.assertEqual(queued_claim["valid_evidence_count"], 1)
        self.assertIn("API 产品化时要记录证据", queued_claim["evidence"][0]["chunk_context"])
        self.assertEqual(queued_claim["evidence"][0]["source_title"], "Transformer API Study Video")

        reviewed_evidence = self.request(
            f"/v1/evidence/{evidence_id}/review",
            {"status": "reviewed", "reviewer": "unit-test", "review_note": "quote appears in chunk"},
            method="POST",
        )["evidence"]
        self.assertEqual(reviewed_evidence["status"], "reviewed")
        self.assertEqual(reviewed_evidence["reviewer"], "unit-test")
        self.assertIn("API 产品化时要记录证据", reviewed_evidence["chunk_context"])

        reviewed = self.request(
            f"/v1/claims/{claim_id}/review",
            {"status": "reviewed", "reviewer": "unit-test", "review_note": "timestamp quote checked"},
            method="POST",
        )["claim"]
        self.assertEqual(reviewed["status"], "reviewed")
        self.assertEqual(reviewed["reviewer"], "unit-test")
        self.assertEqual(reviewed["evidence"][0]["timestamp"], "00:08")
        self.assertEqual(reviewed["valid_evidence_count"], 1)
        self.assertTrue(any(event["event_type"] == "review" for event in reviewed["events"]))
        review_events = self.request(f"/v1/claims/{claim_id}/events")["events"]
        review_event = next(event for event in review_events if event["event_type"] == "review")
        self.assertEqual(review_event["metadata"]["previous_status"], "extracted")
        self.assertEqual(review_event["metadata"]["next_status"], "reviewed")
        self.assertEqual(review_event["metadata"]["valid_evidence_ids"], [evidence_id])

        learning = self.request(
            f"/v1/sources/{source['id']}/learning-pack",
            {"max_items": 4},
            method="POST",
        )
        self.assertTrue(Path(learning["markdown_path"]).exists())
        self.assertGreaterEqual(learning["counts"]["retrieval_question"], 1)
        self.assertGreaterEqual(learning["counts"]["anki_card"], 1)
        self.assertIn("Track2_从零搭建大模型", learning["course_links"])

        listed_learning = self.request(f"/v1/learning/items?source_id={source['id']}&limit=50")["items"]
        self.assertEqual(len(listed_learning), len(learning["items"]))
        self.assertTrue(any(item["kind"] == "feynman_prompt" for item in listed_learning))

        self.request(f"/v1/sources/{source['id']}/status", {"status": "reviewed"}, method="POST")
        final = self.request(
            "/v1/deliverables",
            {
                "kind": "report",
                "title": "Reviewed YouTube Learning Report",
                "status": "final",
                "source_ids": [source["id"]],
                "claims": [
                    {
                        "claim_id": claim_id,
                        "text": "API 产品化时要记录证据、成本和失败模式。",
                        "citations": [
                            {
                                "source_id": source["id"],
                                "chunk_id": chunk_id,
                                "quote": "API 产品化时要记录证据、成本和失败模式。",
                                "timestamp": "00:08",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )["deliverable"]
        self.assertTrue(final["ready_gate"]["passed"])
        self.assertIn("time:00:08", final["markdown"])

        export = self.request("/v1/export?format=json")
        self.assertEqual(export["counts"]["learning_items"], len(learning["items"]))
        package = json.loads(export["content"])
        self.assertEqual(len(package["learning"]), len(learning["items"]))

        rejected_evidence = self.request(
            f"/v1/evidence/{evidence_id}/review",
            {"status": "rejected", "reviewer": "unit-test", "rejection_reason": "wrong timestamp"},
            method="POST",
        )["evidence"]
        self.assertEqual(rejected_evidence["status"], "rejected")
        self.assertEqual(rejected_evidence["review_note"], "wrong timestamp")
        invalidated_claim = self.request(f"/v1/claims/{claim_id}")["claim"]
        self.assertEqual(invalidated_claim["status"], "pending_validation")
        self.assertEqual(invalidated_claim["valid_evidence_count"], 0)
        with self.assertRaisesRegex(AssertionError, "valid source/chunk/quote evidence"):
            self.request(
                f"/v1/claims/{claim_id}/review",
                {"status": "reviewed", "reviewer": "unit-test"},
                method="POST",
            )
        batch = self.request(
            "/v1/claims/review-batch",
            {
                "claim_ids": [claim_id, "claim_missing"],
                "status": "rejected",
                "reviewer": "unit-test",
                "rejection_reason": "evidence rejected",
            },
            method="POST",
        )
        self.assertEqual(batch["success_count"], 1)
        self.assertEqual(batch["error_count"], 1)
        self.assertEqual(batch["claims"][0]["rejection_reason"], "evidence rejected")

    def test_legacy_index_columns_migrate_before_indexes_are_created(self) -> None:
        legacy_dir = self.data_dir / "legacy-index-columns-store"
        state_dir = legacy_dir / "state"
        state_dir.mkdir(parents=True)
        legacy_db_path = state_dir / "qc_smart_reader.sqlite3"
        db = sqlite3.connect(legacy_db_path)
        try:
            db.executescript(
                """
                CREATE TABLE jobs (
                  id TEXT PRIMARY KEY,
                  type TEXT NOT NULL,
                  status TEXT NOT NULL,
                  progress REAL NOT NULL DEFAULT 0,
                  input_json TEXT NOT NULL,
                  error TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE job_items (
                  id TEXT PRIMARY KEY,
                  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                  item_index INTEGER NOT NULL,
                  kind TEXT NOT NULL DEFAULT 'url',
                  url TEXT,
                  title TEXT,
                  status TEXT NOT NULL,
                  error TEXT,
                  attempts INTEGER NOT NULL DEFAULT 0,
                  source_id TEXT,
                  input_json TEXT NOT NULL DEFAULT '{}',
                  result_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  started_at TEXT,
                  completed_at TEXT
                );

                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  vault_path TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE capture_plans (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL,
                  url TEXT NOT NULL,
                  title TEXT,
                  source_type TEXT NOT NULL DEFAULT 'url',
                  reason TEXT NOT NULL DEFAULT '',
                  priority INTEGER NOT NULL DEFAULT 3,
                  status TEXT NOT NULL DEFAULT 'candidate',
                  screen_reason TEXT,
                  reviewer TEXT,
                  job_id TEXT,
                  source_id TEXT,
                  metadata_json TEXT NOT NULL DEFAULT '{}',
                  markdown_path TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  approved_at TEXT,
                  queued_at TEXT,
                  captured_at TEXT
                );

                CREATE TABLE sources (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  site TEXT NOT NULL,
                  url TEXT,
                  title TEXT NOT NULL,
                  author TEXT,
                  published_at TEXT,
                  captured_at TEXT NOT NULL,
                  content_hash TEXT NOT NULL,
                  raw_path TEXT NOT NULL,
                  markdown_path TEXT NOT NULL,
                  text_length INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE notes (
                  id TEXT PRIMARY KEY,
                  source_id TEXT,
                  title TEXT NOT NULL,
                  summary TEXT,
                  tags_json TEXT NOT NULL DEFAULT '[]',
                  question TEXT,
                  answer TEXT,
                  excerpt TEXT,
                  markdown_path TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                INSERT INTO projects(id, name, vault_path, created_at, updated_at)
                VALUES ('default', 'Legacy Inbox', '/tmp/legacy-vault',
                        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                INSERT INTO capture_plans(
                  id, project_id, url, title, source_type, status, metadata_json,
                  markdown_path, created_at, updated_at
                ) VALUES (
                  'plan_legacy', 'default', 'https://example.com/plan#fragment', 'Legacy plan',
                  'url', 'approved', '{}', 'legacy-plan.md',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                );
                INSERT INTO sources(
                  id, project_id, kind, site, url, title, captured_at, content_hash,
                  raw_path, markdown_path, text_length, created_at, updated_at
                ) VALUES (
                  'src_legacy', 'default', 'article', 'example',
                  'https://example.com/source#fragment', 'Legacy source',
                  '2026-01-01T00:00:00Z', 'legacy-hash', 'raw.txt', 'source.md', 42,
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                );
                INSERT INTO notes(
                  id, source_id, title, summary, tags_json, markdown_path, created_at, updated_at
                ) VALUES (
                  'note_legacy', 'src_legacy', 'Legacy note', 'Preserve me', '[]',
                  'note.md', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                );

                INSERT INTO jobs(id, type, status, progress, input_json, error, created_at, updated_at)
                VALUES ('job_legacy', 'read', 'failed', 0.5, '{}', 'legacy failure',
                        '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z');
                INSERT INTO job_items(
                  id, job_id, item_index, kind, url, title, status, error, attempts,
                  source_id, input_json, result_json, created_at, updated_at, started_at, completed_at
                ) VALUES (
                  'item_legacy', 'job_legacy', 0, 'url', 'https://example.com/legacy',
                  'Legacy item', 'failed', 'legacy item failure', 2, NULL, '{}', '{}',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z',
                  '2026-01-01T00:00:10Z', '2026-01-01T00:01:00Z'
                );
                """
            )
            db.commit()
        finally:
            db.close()

        server.Store(legacy_dir)
        server.Store(legacy_dir)

        db = sqlite3.connect(legacy_db_path)
        db.row_factory = sqlite3.Row
        try:
            columns = {
                table: {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
                for table in ("job_items", "sources", "capture_plans", "notes")
            }
            legacy_item = db.execute(
                "SELECT * FROM job_items WHERE id = 'item_legacy'"
            ).fetchone()
            legacy_source = db.execute(
                "SELECT * FROM sources WHERE id = 'src_legacy'"
            ).fetchone()
            legacy_plan = db.execute(
                "SELECT * FROM capture_plans WHERE id = 'plan_legacy'"
            ).fetchone()
            legacy_note = db.execute(
                "SELECT * FROM notes WHERE id = 'note_legacy'"
            ).fetchone()
            indexes = {
                table: {row["name"] for row in db.execute(f"PRAGMA index_list({table})")}
                for table in ("job_items", "sources", "capture_plans", "notes")
            }
            foreign_key_errors = db.execute("PRAGMA foreign_key_check").fetchall()
        finally:
            db.close()

        self.assertTrue(
            {
                "hidden",
                "cleared_at",
                "lease_owner",
                "lease_expires_at",
                "heartbeat_at",
                "error_category",
            }.issubset(columns["job_items"])
        )
        self.assertIn("canonical_url", columns["sources"])
        self.assertIn("canonical_url", columns["capture_plans"])
        self.assertIn("project_id", columns["notes"])
        self.assertEqual(legacy_item["job_id"], "job_legacy")
        self.assertEqual(legacy_item["status"], "failed")
        self.assertEqual(legacy_item["error"], "legacy item failure")
        self.assertEqual(legacy_item["attempts"], 2)
        self.assertEqual(legacy_item["hidden"], 0)
        self.assertEqual(legacy_item["error_category"], "")
        self.assertEqual(legacy_source["title"], "Legacy source")
        self.assertEqual(legacy_source["canonical_url"], "https://example.com/source")
        self.assertEqual(legacy_plan["status"], "approved")
        self.assertEqual(legacy_plan["canonical_url"], "https://example.com/plan")
        self.assertEqual(legacy_note["summary"], "Preserve me")
        self.assertEqual(legacy_note["project_id"], "default")
        self.assertIn("idx_job_items_lease", indexes["job_items"])
        self.assertIn("idx_job_items_error_category", indexes["job_items"])
        self.assertIn("idx_sources_project_canonical", indexes["sources"])
        self.assertIn("idx_capture_plans_project_canonical", indexes["capture_plans"])
        self.assertIn("idx_notes_project_created", indexes["notes"])
        self.assertEqual(foreign_key_errors, [])

    def test_job_lifecycle_recovery_retry_pause_cancel_and_clear(self) -> None:
        columns = {row["name"] for row in self.db_rows("PRAGMA table_info(job_items)")}
        self.assertIn("error_category", columns)

        job = self.request(
            "/v1/jobs/read",
            {
                "items": [
                    {"id": "a", "url": "https://example.com/a"},
                    {"id": "b", "url": "https://example.com/b"},
                    {"id": "dup", "url": "https://example.com/a#fragment"},
                    {"id": "c", "url": "https://example.com/c"},
                    {"id": "d", "url": "https://example.com/d"},
                    {"id": "e", "url": "https://example.com/e"},
                ],
                "source": "unittest",
            },
            method="POST",
        )["job"]
        self.assertEqual(len(job["items"]), 5)
        first, second, third, fourth, fifth = job["items"]

        self.assertEqual(self.request(f"/v1/jobs/{job['id']}/pause", {}, method="POST")["job"]["status"], "paused")
        self.assertEqual(self.request(f"/v1/jobs/{job['id']}/resume", {}, method="POST")["job"]["status"], "accepted")

        self.request(f"/v1/jobs/{job['id']}/items/{first['id']}/status", {"status": "running"}, method="POST")
        time.sleep(1.1)
        recovered = self.request(f"/v1/jobs/{job['id']}/recover", {"max_age_seconds": 1}, method="POST")["job"]
        self.assertEqual(recovered["items"][0]["status"], "failed")
        self.assertIn("stuck running", recovered["items"][0]["error"])
        self.assertEqual(recovered["items"][0]["error_category"], "stuck_running")
        self.assertEqual(recovered["failure_category_counts"], {"stuck_running": 1})

        retried = self.request(f"/v1/jobs/{job['id']}/items/{first['id']}/retry", {}, method="POST")["job"]
        self.assertEqual(retried["items"][0]["status"], "pending")
        self.assertEqual(retried["items"][0]["error_category"], "")

        self.request(
            f"/v1/jobs/{job['id']}/items/{first['id']}/status",
            {"status": "success", "source_id": "src_fixture_a"},
            method="POST",
        )
        self.request(
            f"/v1/jobs/{job['id']}/items/{second['id']}/status",
            {"status": "failed", "error": "page timeout"},
            method="POST",
        )
        failed_with_categories = self.request(
            f"/v1/jobs/{job['id']}/items/{third['id']}/status",
            {"status": "failed", "error": "login required", "error_category": "auth_required"},
            method="POST",
        )["job"]
        self.request(
            f"/v1/jobs/{job['id']}/items/{fourth['id']}/status",
            {"status": "failed", "error": "pagination needed before extraction"},
            method="POST",
        )
        failed_with_categories = self.request(
            f"/v1/jobs/{job['id']}/items/{fifth['id']}/status",
            {"status": "failed", "error": "attachment download missing"},
            method="POST",
        )["job"]
        self.assertEqual(failed_with_categories["items"][1]["error_category"], "page_timeout")
        self.assertEqual(failed_with_categories["items"][2]["error_category"], "auth_required")
        self.assertEqual(failed_with_categories["items"][3]["error_category"], "pagination_needed")
        self.assertEqual(failed_with_categories["items"][4]["error_category"], "attachment_missing")
        self.assertEqual(
            failed_with_categories["failure_category_counts"],
            {"attachment_missing": 1, "auth_required": 1, "page_timeout": 1, "pagination_needed": 1},
        )

        retry_failed = self.request(f"/v1/jobs/{job['id']}/retry-failed", {}, method="POST")["job"]
        statuses = {item["url"]: item["status"] for item in retry_failed["items"]}
        self.assertEqual(statuses["https://example.com/b"], "pending")
        categories = {item["url"]: item["error_category"] for item in retry_failed["items"]}
        self.assertEqual(categories["https://example.com/b"], "")
        self.assertEqual(categories["https://example.com/c"], "")
        self.assertEqual(categories["https://example.com/d"], "")
        self.assertEqual(categories["https://example.com/e"], "")

        cleared = self.request(f"/v1/jobs/{job['id']}/clear-completed", {}, method="POST")["job"]
        self.assertNotIn("https://example.com/a", {item["url"] for item in cleared["items"]})
        hidden = self.db_rows("SELECT hidden, cleared_at FROM job_items WHERE url = ?", ("https://example.com/a",))[0]
        self.assertEqual(hidden["hidden"], 1)
        self.assertIsNotNone(hidden["cleared_at"])

        canceled = self.request(f"/v1/jobs/{job['id']}/cancel", {}, method="POST")["job"]
        self.assertEqual(canceled["status"], "canceled")
        self.assertTrue(all(item["status"] == "canceled" for item in canceled["items"]))
        self.assertTrue(all(item["error_category"] == "" for item in canceled["items"]))

        events = self.request(f"/v1/jobs/{job['id']}/events")["events"]
        event_types = {event["event_type"] for event in events}
        self.assertIn("item_recovered", event_types)
        self.assertIn("item_retry", event_types)
        self.assertIn("job_canceled", event_types)
        self.assertIn("item_cleared", event_types)
        category_events = {
            event["data"].get("error_category")
            for event in events
            if event["event_type"] == "item_status" and event["data"].get("error_category")
        }
        self.assertEqual(category_events, {"attachment_missing", "auth_required", "page_timeout", "pagination_needed"})

    def test_100_url_job_dedupes_recovers_retries_pauses_and_resumes(self) -> None:
        success_urls = [f"https://example.com/batch/success-{index:02d}" for index in range(70)]
        failed_urls = [f"https://example.com/batch/fail-{index:02d}" for index in range(10)]
        slow_urls = [f"https://example.com/batch/slow-{index:02d}" for index in range(10)]
        duplicate_urls = [f"{success_urls[index]}#duplicate" for index in range(10)]
        raw_items = [{"id": f"raw-{index:03d}", "url": url} for index, url in enumerate(success_urls + failed_urls + slow_urls + duplicate_urls)]
        self.assertEqual(len(raw_items), 100)

        job = self.request(
            "/v1/jobs/read",
            {"items": raw_items, "source": "100-url-fixture"},
            method="POST",
        )["job"]
        job_id = job["id"]
        self.assertEqual(len(job["items"]), 90)
        self.assertEqual(job["input"]["item_count"], 90)
        self.assertEqual(len(job["input"]["items"]), 90)
        self.assertEqual(len({item["input"]["canonical_url"] for item in job["items"]}), 90)

        by_url = {item["url"]: item for item in job["items"]}
        for index, url in enumerate(success_urls):
            self.request(
                f"/v1/jobs/{job_id}/items/{by_url[url]['id']}/status",
                {"status": "success", "source_id": f"src_batch_success_{index:02d}"},
                method="POST",
            )
        for index, url in enumerate(failed_urls):
            message = "page timeout" if index < 5 else "login required"
            self.request(
                f"/v1/jobs/{job_id}/items/{by_url[url]['id']}/status",
                {"status": "failed", "error": message},
                method="POST",
            )
        for url in slow_urls:
            self.request(
                f"/v1/jobs/{job_id}/items/{by_url[url]['id']}/status",
                {"status": "running"},
                method="POST",
            )

        old_timestamp = "2000-01-01T00:00:00+00:00"
        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        try:
            db.execute(
                """
                UPDATE job_items
                SET started_at = ?, updated_at = ?
                WHERE job_id = ? AND status = 'running'
                """,
                (old_timestamp, old_timestamp, job_id),
            )
            db.commit()
        finally:
            db.close()

        recovered = self.request(f"/v1/jobs/{job_id}/recover", {"max_age_seconds": 1}, method="POST")["job"]
        status_counts = {status: sum(1 for item in recovered["items"] if item["status"] == status) for status in {"success", "failed", "pending", "running"}}
        self.assertEqual(status_counts, {"success": 70, "failed": 20, "pending": 0, "running": 0})
        self.assertEqual(
            recovered["failure_category_counts"],
            {"auth_required": 5, "page_timeout": 5, "stuck_running": 10},
        )
        self.assertEqual(recovered["status"], "completed_with_errors")
        self.assertEqual(recovered["progress"], 1)

        retried = self.request(f"/v1/jobs/{job_id}/retry-failed", {}, method="POST")["job"]
        self.assertEqual(sum(1 for item in retried["items"] if item["status"] == "pending"), 20)
        self.assertEqual(sum(1 for item in retried["items"] if item["status"] == "success"), 70)
        self.assertEqual(retried["failure_category_counts"], {})

        paused = self.request(f"/v1/jobs/{job_id}/pause", {}, method="POST")["job"]
        self.assertEqual(paused["status"], "paused")
        blocked_claim = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "batch-worker"},
            method="POST",
        )
        self.assertIsNone(blocked_claim["item"])
        self.assertEqual(blocked_claim["reason"], "paused")

        self.request(f"/v1/jobs/{job_id}/resume", {}, method="POST")
        retried_count = 0
        while True:
            claim = self.request(
                f"/v1/jobs/{job_id}/claim-next",
                {"executor_id": "batch-worker", "lease_seconds": 60},
                method="POST",
            )
            item = claim.get("item")
            if not item:
                self.assertEqual(claim["reason"], "empty")
                break
            retried_count += 1
            self.request(
                f"/v1/jobs/{job_id}/items/{item['id']}/status",
                {"status": "success", "executor_id": "batch-worker", "source_id": f"src_batch_retry_{retried_count:02d}"},
                method="POST",
            )
        self.assertEqual(retried_count, 20)

        completed = self.request(f"/v1/jobs/{job_id}")["job"]
        self.assertEqual(completed["status"], "success")
        self.assertEqual(completed["progress"], 1)
        self.assertEqual(sum(1 for item in completed["items"] if item["status"] == "success"), 90)
        self.assertEqual(completed["failure_category_counts"], {})

        events = self.request(f"/v1/jobs/{job_id}/events?limit=1000")["events"]
        event_types = [event["event_type"] for event in events]
        self.assertIn("job_recover", event_types)
        self.assertIn("job_retry_failed", event_types)
        self.assertIn("job_paused", event_types)
        self.assertIn("job_resumed", event_types)
        self.assertEqual(sum(1 for event in events if event["event_type"] == "item_retry"), 20)
        self.assertEqual(sum(1 for event in events if event["event_type"] == "item_recovered"), 10)

    def test_service_restart_at_item_30_recovers_and_resumes_100_url_job(self) -> None:
        urls = [f"https://example.com/restart/{index:03d}" for index in range(100)]
        job = self.request(
            "/v1/jobs/read",
            {"items": [{"id": f"restart-{index:03d}", "url": url} for index, url in enumerate(urls)], "source": "restart-fixture"},
            method="POST",
        )["job"]
        job_id = job["id"]
        self.assertEqual(len(job["items"]), 100)
        by_url = {item["url"]: item for item in job["items"]}

        for index, url in enumerate(urls[:30]):
            self.request(
                f"/v1/jobs/{job_id}/items/{by_url[url]['id']}/status",
                {"status": "success", "source_id": f"src_restart_done_{index:03d}"},
                method="POST",
            )
        for url in urls[30:35]:
            self.request(
                f"/v1/jobs/{job_id}/items/{by_url[url]['id']}/status",
                {"status": "running"},
                method="POST",
            )

        old_timestamp = "2000-01-01T00:00:00+00:00"
        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        try:
            db.execute(
                """
                UPDATE job_items
                SET started_at = ?, updated_at = ?
                WHERE job_id = ? AND status = 'running'
                """,
                (old_timestamp, old_timestamp, job_id),
            )
            db.commit()
        finally:
            db.close()

        before_restart_port = self.port
        self.restart_service()
        self.assertNotEqual(self.port, before_restart_port)
        restarted_job = self.request(f"/v1/jobs/{job_id}")["job"]
        self.assertEqual(sum(1 for item in restarted_job["items"] if item["status"] == "success"), 30)
        self.assertEqual(sum(1 for item in restarted_job["items"] if item["status"] == "running"), 5)
        self.assertEqual(sum(1 for item in restarted_job["items"] if item["status"] == "pending"), 65)

        recovered = self.request(f"/v1/jobs/{job_id}/recover", {"max_age_seconds": 1}, method="POST")["job"]
        self.assertEqual(sum(1 for item in recovered["items"] if item["status"] == "success"), 30)
        self.assertEqual(sum(1 for item in recovered["items"] if item["status"] == "failed"), 5)
        self.assertEqual(sum(1 for item in recovered["items"] if item["status"] == "pending"), 65)
        self.assertEqual(recovered["failure_category_counts"], {"stuck_running": 5})

        retried = self.request(f"/v1/jobs/{job_id}/retry-failed", {}, method="POST")["job"]
        self.assertEqual(sum(1 for item in retried["items"] if item["status"] == "pending"), 70)
        self.assertEqual(sum(1 for item in retried["items"] if item["status"] == "success"), 30)
        self.assertEqual(retried["failure_category_counts"], {})

        self.request(f"/v1/jobs/{job_id}/resume", {}, method="POST")
        completed_after_restart = 0
        while True:
            claim = self.request(
                f"/v1/jobs/{job_id}/claim-next",
                {"executor_id": "restart-worker", "lease_seconds": 60},
                method="POST",
            )
            item = claim.get("item")
            if not item:
                self.assertEqual(claim["reason"], "empty")
                break
            completed_after_restart += 1
            self.request(
                f"/v1/jobs/{job_id}/items/{item['id']}/status",
                {
                    "status": "success",
                    "executor_id": "restart-worker",
                    "source_id": f"src_restart_resumed_{completed_after_restart:03d}",
                },
                method="POST",
            )
        self.assertEqual(completed_after_restart, 70)

        completed = self.request(f"/v1/jobs/{job_id}")["job"]
        self.assertEqual(completed["status"], "success")
        self.assertEqual(completed["progress"], 1)
        self.assertEqual(sum(1 for item in completed["items"] if item["status"] == "success"), 100)

        events = self.request(f"/v1/jobs/{job_id}/events?limit=1200")["events"]
        event_types = [event["event_type"] for event in events]
        self.assertIn("job_recover", event_types)
        self.assertIn("job_retry_failed", event_types)
        self.assertIn("job_resumed", event_types)
        self.assertEqual(sum(1 for event in events if event["event_type"] == "item_recovered"), 5)
        self.assertEqual(sum(1 for event in events if event["event_type"] == "item_retry"), 5)

    def test_job_item_pagination_checkpoint_is_persisted_and_audited(self) -> None:
        job = self.request(
            "/v1/jobs/read",
            {"items": [{"id": "page-1", "url": "https://example.com/thread/1"}]},
            method="POST",
        )["job"]
        item = job["items"][0]
        checkpoint = {
            "status": "pagination_needed",
            "source_id": "src_checkpoint",
            "source_url": "https://example.com/thread/1",
            "source_title": "Thread Page 1",
            "job_id": job["id"],
            "job_item_id": item["id"],
            "next_pages": ["https://example.com/thread/1?page=2"],
            "next_page_count": 1,
            "captured_at": "2026-06-28T01:02:03+00:00",
            "profile": "quantclass-bbs",
        }
        updated = self.request(
            f"/v1/jobs/{job['id']}/items/{item['id']}/status",
            {
                "status": "success",
                "source_id": "src_checkpoint",
                "result": {
                    "source_id": "src_checkpoint",
                    "next_pages": ["https://example.com/thread/1?page=2"],
                    "pagination_checkpoint": checkpoint,
                },
            },
            method="POST",
        )["job"]
        stored_item = updated["items"][0]
        self.assertEqual(stored_item["result"]["pagination_checkpoint"]["source_id"], "src_checkpoint")
        self.assertEqual(
            stored_item["result"]["pagination_checkpoint"]["next_pages"],
            ["https://example.com/thread/1?page=2"],
        )

        events = self.request(f"/v1/jobs/{job['id']}/events")["events"]
        checkpoint_events = [event for event in events if event["event_type"] == "item_checkpoint"]
        self.assertEqual(len(checkpoint_events), 1)
        self.assertEqual(checkpoint_events[0]["item_id"], item["id"])
        self.assertEqual(checkpoint_events[0]["data"]["source_id"], "src_checkpoint")
        self.assertEqual(checkpoint_events[0]["data"]["next_page_count"], 1)
        self.assertEqual(checkpoint_events[0]["data"]["next_pages"][0], "https://example.com/thread/1?page=2")

    def test_job_pipeline_events_record_quality_gate_and_review_queue(self) -> None:
        normal_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/job-normal",
                    "title": "Job Normal Source",
                    "site": "example",
                },
                "content": {
                    "text": "Normal job source with enough evidence and context for extraction. " * 20,
                    "markdown": "Normal job source with enough evidence and context for extraction. " * 20,
                },
                "browser": {},
            },
            method="POST",
        )
        low_quality_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/job-low",
                    "title": "Job Low Quality Source",
                    "site": "example",
                },
                "content": {
                    "text": "tiny",
                    "markdown": "tiny",
                    "stats": {"lowText": True},
                },
                "browser": {},
            },
            method="POST",
        )
        attachment_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/job-attachment",
                    "title": "Job Attachment Source",
                    "site": "example",
                },
                "content": {
                    "text": "Attachment job source with enough evidence and context for extraction. " * 20,
                    "markdown": "Attachment job source with enough evidence and context for extraction. " * 20,
                    "attachments": [{"href": "https://example.com/files/research.zip", "text": "research.zip"}],
                },
                "browser": {},
            },
            method="POST",
        )
        self.assertEqual(normal_capture["source"]["status"], "new")
        self.assertEqual(low_quality_capture["source"]["status"], "needs_review")
        self.assertEqual(attachment_capture["source"]["status"], "needs_review")
        self.assertTrue(attachment_capture["source"]["quality_flags"]["attachment_missing"])

        job = self.request(
            "/v1/jobs/read",
            {
                "items": [
                    {"id": "normal", "url": "https://example.com/job-normal"},
                    {"id": "low", "url": "https://example.com/job-low"},
                    {"id": "attachment", "url": "https://example.com/job-attachment"},
                ],
                "source": "pipeline-test",
            },
            method="POST",
        )["job"]
        normal_item, low_item, attachment_item = job["items"]
        self.request(
            f"/v1/jobs/{job['id']}/items/{normal_item['id']}/status",
            {"status": "success", "source_id": normal_capture["source"]["id"]},
            method="POST",
        )
        self.request(
            f"/v1/jobs/{job['id']}/items/{low_item['id']}/status",
            {"status": "success", "source_id": low_quality_capture["source"]["id"]},
            method="POST",
        )
        self.request(
            f"/v1/jobs/{job['id']}/items/{attachment_item['id']}/status",
            {"status": "success", "source_id": attachment_capture["source"]["id"]},
            method="POST",
        )

        events = self.request(f"/v1/jobs/{job['id']}/events")["events"]
        normal_events = [event for event in events if event.get("item_id") == normal_item["id"]]
        low_events = [event for event in events if event.get("item_id") == low_item["id"]]
        attachment_events = [event for event in events if event.get("item_id") == attachment_item["id"]]
        self.assertIn("item_capture", {event["event_type"] for event in normal_events})
        self.assertIn("item_quality_gate", {event["event_type"] for event in normal_events})
        self.assertIn("item_extract", {event["event_type"] for event in normal_events})
        self.assertNotIn("item_review_queue", {event["event_type"] for event in normal_events})
        normal_gate = next(event for event in normal_events if event["event_type"] == "item_quality_gate")
        self.assertEqual(normal_gate["data"]["gate_status"], "passed")
        normal_extract = next(event for event in normal_events if event["event_type"] == "item_extract")
        self.assertEqual(normal_extract["data"]["phase_status"], "pending")

        self.assertIn("item_capture", {event["event_type"] for event in low_events})
        self.assertIn("item_quality_gate", {event["event_type"] for event in low_events})
        self.assertIn("item_review_queue", {event["event_type"] for event in low_events})
        self.assertNotIn("item_extract", {event["event_type"] for event in low_events})
        low_gate = next(event for event in low_events if event["event_type"] == "item_quality_gate")
        self.assertEqual(low_gate["data"]["gate_status"], "needs_review")
        self.assertIn("low_text", low_gate["data"]["quality_reasons"])
        low_review = next(event for event in low_events if event["event_type"] == "item_review_queue")
        self.assertEqual(low_review["data"]["queue_status"], "needs_review")

        self.assertIn("item_quality_gate", {event["event_type"] for event in attachment_events})
        self.assertIn("item_review_queue", {event["event_type"] for event in attachment_events})
        self.assertNotIn("item_extract", {event["event_type"] for event in attachment_events})
        attachment_gate = next(event for event in attachment_events if event["event_type"] == "item_quality_gate")
        self.assertEqual(attachment_gate["data"]["gate_status"], "needs_review")
        self.assertIn("attachment_missing", attachment_gate["data"]["quality_reasons"])

        refreshed_job = self.request(f"/v1/jobs/{job['id']}")["job"]
        self.assertEqual(refreshed_job["quality_gate_counts"]["total"], 3)
        self.assertEqual(refreshed_job["quality_gate_counts"]["passed"], 1)
        self.assertEqual(refreshed_job["quality_gate_counts"]["needs_review"], 2)
        self.assertEqual(refreshed_job["quality_gate_counts"]["reason_counts"]["low_text"], 1)
        self.assertEqual(refreshed_job["quality_gate_counts"]["reason_counts"]["attachment_missing"], 1)
        job_summary = self.request("/v1/jobs?limit=5")["jobs"][0]
        self.assertEqual(job_summary["id"], job["id"])
        self.assertEqual(job_summary["quality_gate_counts"]["needs_review"], 2)

    def test_job_item_lease_claim_heartbeat_and_pause_enforcement(self) -> None:
        job = self.request(
            "/v1/jobs/read",
            {
                "items": [
                    {"id": "lease-a", "url": "https://example.com/lease-a"},
                    {"id": "lease-b", "url": "https://example.com/lease-b"},
                ],
                "source": "lease-test",
            },
            method="POST",
        )["job"]
        job_id = job["id"]

        first_claim = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "worker-a", "lease_seconds": 60},
            method="POST",
        )
        first = first_claim["item"]
        self.assertEqual(first["url"], "https://example.com/lease-a")
        self.assertEqual(first["status"], "running")
        self.assertEqual(first["attempts"], 1)
        self.assertEqual(first["lease_owner"], "worker-a")
        self.assertTrue(first["lease_expires_at"])

        reused = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "worker-a", "lease_seconds": 60},
            method="POST",
        )
        self.assertTrue(reused["reused"])
        self.assertEqual(reused["item"]["id"], first["id"])

        heartbeat = self.request(
            f"/v1/jobs/{job_id}/items/{first['id']}/heartbeat",
            {"executor_id": "worker-a", "lease_seconds": 120},
            method="POST",
        )
        self.assertEqual(heartbeat["item"]["lease_owner"], "worker-a")
        self.assertTrue(heartbeat["item"]["heartbeat_at"])

        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        try:
            db.execute(
                "UPDATE job_items SET started_at = ?, updated_at = ? WHERE id = ?",
                ("2000-01-01T00:00:00+00:00", "2000-01-01T00:00:00+00:00", first["id"]),
            )
            db.commit()
        finally:
            db.close()
        active_recover = self.request(f"/v1/jobs/{job_id}/recover", {"max_age_seconds": 1}, method="POST")["job"]
        active_first = next(item for item in active_recover["items"] if item["id"] == first["id"])
        self.assertEqual(active_first["status"], "running")
        self.assertEqual(active_first["lease_owner"], "worker-a")

        with self.assertRaisesRegex(AssertionError, "executor_id"):
            self.request(
                f"/v1/jobs/{job_id}/items/{first['id']}/status",
                {"status": "success", "executor_id": "worker-b"},
                method="POST",
            )

        completed = self.request(
            f"/v1/jobs/{job_id}/items/{first['id']}/status",
            {"status": "success", "executor_id": "worker-a", "source_id": "src_lease_a"},
            method="POST",
        )["job"]
        completed_first = next(item for item in completed["items"] if item["id"] == first["id"])
        self.assertEqual(completed_first["status"], "success")
        self.assertEqual(completed_first["lease_owner"], "")

        paused = self.request(f"/v1/jobs/{job_id}/pause", {}, method="POST")["job"]
        self.assertEqual(paused["status"], "paused")
        blocked = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "worker-a"},
            method="POST",
        )
        self.assertIsNone(blocked["item"])
        self.assertEqual(blocked["reason"], "paused")

        self.request(f"/v1/jobs/{job_id}/resume", {}, method="POST")
        second_claim = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "worker-a"},
            method="POST",
        )
        self.assertEqual(second_claim["item"]["url"], "https://example.com/lease-b")

        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        try:
            db.execute(
                "UPDATE job_items SET lease_expires_at = ? WHERE id = ?",
                ("2000-01-01T00:00:00+00:00", second_claim["item"]["id"]),
            )
            db.commit()
        finally:
            db.close()
        reclaimed = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "worker-b"},
            method="POST",
        )
        self.assertEqual(reclaimed["item"]["id"], second_claim["item"]["id"])
        self.assertEqual(reclaimed["item"]["lease_owner"], "worker-b")
        self.assertEqual(reclaimed["item"]["attempts"], 2)

        canceled = self.request(f"/v1/jobs/{job_id}/cancel", {}, method="POST")["job"]
        canceled_second = next(item for item in canceled["items"] if item["id"] == second_claim["item"]["id"])
        self.assertEqual(canceled_second["status"], "canceled")
        self.assertEqual(canceled_second["lease_owner"], "")

        ignored_after_cancel = self.request(
            f"/v1/jobs/{job_id}/items/{second_claim['item']['id']}/status",
            {"status": "success", "source_id": "source-after-cancel"},
            method="POST",
        )["job"]
        ignored_second = next(item for item in ignored_after_cancel["items"] if item["id"] == second_claim["item"]["id"])
        self.assertEqual(ignored_after_cancel["status"], "canceled")
        self.assertEqual(ignored_second["status"], "canceled")
        self.assertEqual(ignored_second["source_id"], "")

        events = self.request(f"/v1/jobs/{job_id}/events")["events"]
        event_types = [event["event_type"] for event in events]
        self.assertIn("item_claimed", event_types)
        self.assertIn("item_heartbeat", event_types)
        self.assertIn("item_status_ignored", event_types)

    def test_three_concurrent_workers_claim_distinct_job_items(self) -> None:
        job = self.request(
            "/v1/jobs/read",
            {
                "items": [
                    {"id": f"concurrent-claim-{index}", "url": f"https://example.com/concurrent-claim-{index}"}
                    for index in range(3)
                ],
                "source": "concurrent-claim-test",
            },
            method="POST",
        )["job"]
        job_id = job["id"]
        select_barrier = threading.Barrier(3)
        selected_threads: set[int] = set()
        selected_threads_lock = threading.Lock()
        real_connect = sqlite3.connect

        class PrefetchedCursor:
            def __init__(self, row: sqlite3.Row):
                self.row = row

            def fetchone(self) -> sqlite3.Row:
                return self.row

        class ClaimBarrierConnection(sqlite3.Connection):
            def execute(self, sql: str, parameters=()):
                cursor = super().execute(sql, parameters)
                normalized_sql = " ".join(sql.split())
                if (
                    "FROM job_items" in normalized_sql
                    and "status = 'pending'" in normalized_sql
                    and "ORDER BY CASE WHEN status = 'pending'" in normalized_sql
                ):
                    row = cursor.fetchone()
                    if row is not None:
                        thread_id = threading.get_ident()
                        with selected_threads_lock:
                            should_wait = thread_id not in selected_threads
                            selected_threads.add(thread_id)
                        if should_wait:
                            select_barrier.wait(timeout=10)
                    return PrefetchedCursor(row)
                return cursor

        def barrier_connect(*args, **kwargs):
            return real_connect(*args, **kwargs, factory=ClaimBarrierConnection)

        def claim(worker_index: int) -> dict:
            return self.request(
                f"/v1/jobs/{job_id}/claim-next",
                {"executor_id": f"concurrent-worker-{worker_index}", "lease_seconds": 60},
                method="POST",
            )["item"]

        with mock.patch.object(server.sqlite3, "connect", side_effect=barrier_connect):
            with ThreadPoolExecutor(max_workers=3) as executor:
                claimed = list(executor.map(claim, range(3)))

        self.assertEqual(len({item["id"] for item in claimed}), 3)
        self.assertEqual(
            {item["lease_owner"] for item in claimed},
            {f"concurrent-worker-{index}" for index in range(3)},
        )
        rows = self.db_rows(
            "SELECT id, status, attempts, lease_owner FROM job_items WHERE job_id = ? ORDER BY item_index",
            (job_id,),
        )
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["status"] == "running" for row in rows))
        self.assertTrue(all(row["attempts"] == 1 for row in rows))
        self.assertEqual(len({row["lease_owner"] for row in rows}), 3)
        events = self.request(f"/v1/jobs/{job_id}/events")["events"]
        self.assertEqual(sum(event["event_type"] == "item_claimed" for event in events), 3)

    def test_cancel_wins_when_late_success_read_precedes_cancel_commit(self) -> None:
        job = self.request(
            "/v1/jobs/read",
            {
                "items": [{"id": "cancel-race", "url": "https://example.com/cancel-race"}],
                "source": "cancel-race-test",
            },
            method="POST",
        )["job"]
        job_id = job["id"]
        claimed = self.request(
            f"/v1/jobs/{job_id}/claim-next",
            {"executor_id": "late-worker", "lease_seconds": 60},
            method="POST",
        )["item"]
        read_barrier = threading.Barrier(2)
        resume_barrier = threading.Barrier(2)
        block_lock = threading.Lock()
        blocked = False
        real_connect = sqlite3.connect

        class PrefetchedCursor:
            def __init__(self, row: sqlite3.Row):
                self.row = row

            def fetchone(self) -> sqlite3.Row:
                return self.row

        class StatusBarrierConnection(sqlite3.Connection):
            def execute(self, sql: str, parameters=()):
                nonlocal blocked
                cursor = super().execute(sql, parameters)
                normalized_sql = " ".join(sql.split())
                if normalized_sql == "SELECT * FROM job_items WHERE job_id = ? AND id = ?":
                    row = cursor.fetchone()
                    with block_lock:
                        should_wait = not blocked
                        blocked = True
                    if should_wait:
                        read_barrier.wait(timeout=10)
                        resume_barrier.wait(timeout=10)
                    return PrefetchedCursor(row)
                return cursor

        def barrier_connect(*args, **kwargs):
            return real_connect(*args, **kwargs, factory=StatusBarrierConnection)

        def report_late_success() -> dict:
            return self.request(
                f"/v1/jobs/{job_id}/items/{claimed['id']}/status",
                {
                    "status": "success",
                    "executor_id": "late-worker",
                    "source_id": "source-after-concurrent-cancel",
                },
                method="POST",
            )["job"]

        with mock.patch.object(server.sqlite3, "connect", side_effect=barrier_connect):
            with ThreadPoolExecutor(max_workers=1) as executor:
                late_success = executor.submit(report_late_success)
                read_barrier.wait(timeout=10)
                canceled = self.request(f"/v1/jobs/{job_id}/cancel", {}, method="POST")["job"]
                resume_barrier.wait(timeout=10)
                late_result = late_success.result(timeout=10)

        canceled_item = next(item for item in canceled["items"] if item["id"] == claimed["id"])
        late_item = next(item for item in late_result["items"] if item["id"] == claimed["id"])
        persisted_item = self.request(f"/v1/jobs/{job_id}")["job"]["items"][0]
        for item in (canceled_item, late_item, persisted_item):
            self.assertEqual(item["status"], "canceled")
            self.assertEqual(item["source_id"], "")
            self.assertEqual(item["lease_owner"], "")
        self.assertEqual(late_result["status"], "canceled")
        events = self.request(f"/v1/jobs/{job_id}/events")["events"]
        ignored = [event for event in events if event["event_type"] == "item_status_ignored"]
        self.assertEqual(len(ignored), 1)
        self.assertEqual(ignored[0]["data"]["attempted_status"], "success")
        self.assertEqual(ignored[0]["data"]["reason"], "item already canceled")

    def test_pdf_worker_uses_only_the_companion_interpreter(self) -> None:
        self.assertFalse(hasattr(server, "BUNDLED_PYTHON"))
        self.assertFalse(hasattr(server, "BUNDLED_SITE_PACKAGES"))
        pdf_path = self.data_dir / "runtime-fixture.pdf"
        make_text_pdf(pdf_path, ["Locked runtime fixture"])
        fake_home = self.data_dir / "fake-home"
        fake_python = (
            fake_home
            / ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
        )
        marker = self.data_dir / "ambient-runtime-was-called"
        fake_python.parent.mkdir(parents=True)
        fake_python.write_text(
            f"#!/bin/sh\ntouch {marker!s}\nexit 99\n",
            encoding="utf-8",
        )
        fake_python.chmod(0o755)

        def controlled_run(argv, **kwargs):
            self.assertEqual(argv[0], sys.executable)
            self.assertEqual(Path(argv[1]), server.PDF_WORKER)
            self.assertEqual(Path(argv[2]), pdf_path)
            self.assertIn("--max-page-text-bytes", argv)
            self.assertIn("--max-total-text-bytes", argv)
            self.assertIn("--max-output-bytes", argv)
            kwargs["stdout"].write(
                json.dumps(
                    {
                        "title": "Locked runtime fixture",
                        "metadata": {},
                        "pages": [{"page": 1, "text": "Locked runtime fixture"}],
                    }
                ).encode("utf-8")
            )
            kwargs["stdout"].flush()
            return server.subprocess.CompletedProcess(
                argv,
                0,
            )

        with mock.patch.dict(os.environ, {"HOME": str(fake_home)}), mock.patch.object(
            server.subprocess,
            "run",
            side_effect=controlled_run,
        ):
            extracted = self.store.extract_pdf(pdf_path)
        self.assertEqual(extracted["pages"][0]["text"], "Locked runtime fixture")
        self.assertFalse(marker.exists())

    def test_pdf_worker_rejects_text_expansion_and_parent_bounds_output(self) -> None:
        expanded_pdf = self.data_dir / "expanded.pdf"
        make_text_pdf(expanded_pdf, ["A" * 4096])
        with mock.patch.object(server, "MAX_PDF_PAGE_TEXT_BYTES", 512), mock.patch.object(
            server,
            "MAX_PDF_TOTAL_TEXT_BYTES",
            1024,
        ):
            with self.assertRaisesRegex(ValueError, "per-page text safety limit"):
                self.store.extract_pdf(expanded_pdf)

        noisy_worker = self.data_dir / "noisy_pdf_worker.py"
        noisy_worker.write_text(
            "import sys\nsys.stdout.buffer.write(b\"x\" * 2048)\n",
            encoding="utf-8",
        )
        with mock.patch.object(server, "PDF_WORKER", noisy_worker), mock.patch.object(
            server,
            "MAX_PDF_WORKER_OUTPUT_BYTES",
            1024,
        ):
            with self.assertRaisesRegex(ValueError, "worker output exceeded"):
                self.store.extract_pdf(expanded_pdf)

    def test_pdf_ingest_preserves_page_chunks_and_original_pdf(self) -> None:
        if importlib.util.find_spec("pypdf") is None:
            self.skipTest("locked pypdf is not installed in the current test interpreter")

        pdf_path = self.data_dir / "fixture.pdf"
        make_text_pdf(
            pdf_path,
            [
                "QC Smart Reader PDF page one research question method data "
                "evidence citation page chunk integration test " * 3,
                "QC Smart Reader PDF page two conclusion risk action "
                "strategy task validation test " * 3,
            ],
        )

        response = self.request(
            "/v1/pdfs/extract",
            {"path": str(pdf_path), "title": "Fixture PDF Paper"},
            method="POST",
        )
        self.assertEqual(response["source"]["kind"], "pdf")
        self.assertEqual(response["pdf"]["pages"], 2)
        self.assertFalse(response["pdf"]["low_text"])
        self.assertTrue(Path(response["pdf"]["path"]).exists())
        self.assertTrue(str(response["pdf"]["path"]).endswith(".pdf"))

        chunks = self.db_rows(
            """
            SELECT chunk_index, page_start, page_end, text
            FROM chunks
            ORDER BY chunk_index
            """
        )
        self.assertEqual([(row["page_start"], row["page_end"]) for row in chunks], [(1, 1), (2, 2)])
        self.assertIn("research question", chunks[0]["text"])
        self.assertIn("strategy task", chunks[1]["text"])

        papers = list((self.data_dir / "vault" / "原始资料" / "papers").glob("*.pdf"))
        self.assertEqual(len(papers), 1)

    def test_remote_pdf_copy_failure_does_not_commit_source_or_delete_only_copy(self) -> None:
        downloaded = self.data_dir / "downloaded-once.pdf"
        downloaded.write_bytes(b"%PDF-1.4\nremote fixture")
        extracted = {
            "title": "One-shot remote PDF",
            "metadata": {"author": "", "created": ""},
            "pages": [{"page": 1, "text": "recoverable extracted text " * 20}],
        }
        with mock.patch.object(
            self.store,
            "resolve_pdf_input",
            return_value=(downloaded, "https://example.invalid/one-shot.pdf", downloaded),
        ), mock.patch.object(self.store, "extract_pdf", return_value=extracted), mock.patch.object(
            self.store,
            "copy_pdf_to_vault",
            side_effect=OSError("simulated artifact write failure"),
        ):
            with self.assertRaisesRegex(ValueError, "retained"):
                self.store.ingest_pdf({"url": "https://example.invalid/one-shot.pdf", "ocr": False})

        self.assertTrue(downloaded.exists())
        self.assertEqual(self.db_rows("SELECT * FROM sources"), [])
        self.assertEqual(self.db_rows("SELECT * FROM documents"), [])

    def test_binary_distinct_pdfs_with_same_text_keep_distinct_mapped_artifacts(self) -> None:
        first_pdf = self.data_dir / "same-text-a.pdf"
        second_pdf = self.data_dir / "same-text-b.pdf"
        make_text_pdf(first_pdf, ["Same visible source evidence text."])
        second_pdf.write_bytes(first_pdf.read_bytes() + b"\n%different immutable binary\n")
        first_hash = hashlib.sha256(first_pdf.read_bytes()).hexdigest()
        second_hash = hashlib.sha256(second_pdf.read_bytes()).hexdigest()
        self.assertNotEqual(first_hash, second_hash)

        first = self.store.ingest_pdf(
            {"path": str(first_pdf), "title": "First PDF", "ocr": False}
        )
        second = self.store.ingest_pdf(
            {"path": str(second_pdf), "title": "Second PDF", "ocr": False}
        )

        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["source"]["id"], second["source"]["id"])
        self.assertTrue(first["pdf"]["artifact_id"])
        self.assertTrue(second["pdf"]["artifact_id"])
        self.assertNotEqual(first["pdf"]["artifact_id"], second["pdf"]["artifact_id"])
        self.assertEqual(first["pdf"]["raw_sha256"], first_hash)
        self.assertEqual(second["pdf"]["raw_sha256"], second_hash)
        artifacts = self.db_rows(
            "SELECT * FROM source_attachments WHERE source_id = ? ORDER BY created_at, id",
            (first["source"]["id"],),
        )
        self.assertEqual(len(artifacts), 2)
        metadata = [json.loads(row["metadata_json"]) for row in artifacts]
        self.assertEqual({item["raw_sha256"] for item in metadata}, {first_hash, second_hash})
        saved_paths = [Path(row["downloaded_path"]) for row in artifacts]
        paths_by_hash = {
            hashlib.sha256(path.read_bytes()).hexdigest(): path
            for path in saved_paths
        }
        self.assertEqual(set(paths_by_hash), {first_hash, second_hash})
        self.assertEqual(Path(first["pdf"]["path"]), paths_by_hash[first_hash])
        self.assertEqual(Path(second["pdf"]["path"]), paths_by_hash[second_hash])

    def test_concurrent_first_pdf_ingest_serializes_and_preserves_first_source_files(self) -> None:
        first_pdf = self.data_dir / "concurrent-a.pdf"
        second_pdf = self.data_dir / "concurrent-b.pdf"
        first_pdf.write_bytes(b"%PDF-1.4\n% concurrent binary a\n")
        second_pdf.write_bytes(b"%PDF-1.4\n% concurrent binary b\n")
        first_hash = hashlib.sha256(first_pdf.read_bytes()).hexdigest()
        second_hash = hashlib.sha256(second_pdf.read_bytes()).hexdigest()
        extracted = {
            "title": "Concurrent shared title",
            "metadata": {"author": "", "created": ""},
            "pages": [
                {
                    "page": 1,
                    "text": "Concurrent identical extracted PDF evidence text " * 12,
                }
            ],
        }
        transaction_barrier = threading.Barrier(2)
        real_connect = sqlite3.connect

        class PrefetchedCursor:
            def __init__(self, row: sqlite3.Row | None):
                self.row = row

            def fetchone(self) -> sqlite3.Row | None:
                return self.row

        class CaptureBarrierConnection(sqlite3.Connection):
            capture_transaction_started = False

            def execute(self, sql: str, parameters=()):
                normalized_sql = " ".join(sql.split())
                if normalized_sql == "BEGIN IMMEDIATE":
                    transaction_barrier.wait(timeout=10)
                    self.capture_transaction_started = True
                    return super().execute(sql, parameters)
                cursor = super().execute(sql, parameters)
                if (
                    normalized_sql
                    == "SELECT * FROM sources WHERE project_id = ? AND content_hash = ?"
                    and not self.capture_transaction_started
                ):
                    row = cursor.fetchone()
                    transaction_barrier.wait(timeout=10)
                    return PrefetchedCursor(row)
                return cursor

        def barrier_connect(*args, **kwargs):
            return real_connect(*args, **kwargs, factory=CaptureBarrierConnection)

        def ingest(path: Path) -> dict:
            return self.store.ingest_pdf(
                {
                    "path": str(path),
                    "title": "Concurrent shared title",
                    "ocr": False,
                }
            )

        with mock.patch.object(self.store, "extract_pdf", return_value=extracted), mock.patch.object(
            server.sqlite3,
            "connect",
            side_effect=barrier_connect,
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(ingest, (first_pdf, second_pdf)))

        self.assertEqual(sorted(result["duplicate"] for result in results), [False, True])
        self.assertEqual({result["source"]["id"] for result in results}, {results[0]["source"]["id"]})
        winner_index = next(index for index, result in enumerate(results) if not result["duplicate"])
        winner_url = (first_pdf, second_pdf)[winner_index].resolve().as_uri()
        loser_url = (first_pdf, second_pdf)[1 - winner_index].resolve().as_uri()
        source = results[winner_index]["source"]
        self.assertEqual(source["url"], winner_url)
        source_files = [Path(source["raw_path"]), Path(source["markdown_path"])]
        for source_file in source_files:
            persisted = source_file.read_text(encoding="utf-8")
            self.assertIn(winner_url, persisted)
            self.assertNotIn(loser_url, persisted)

        attachments = self.db_rows(
            "SELECT metadata_json, downloaded_path FROM source_attachments WHERE source_id = ?",
            (source["id"],),
        )
        self.assertEqual(len(attachments), 2)
        self.assertEqual(
            {json.loads(row["metadata_json"])["raw_sha256"] for row in attachments},
            {first_hash, second_hash},
        )
        self.assertTrue(all(Path(row["downloaded_path"]).is_file() for row in attachments))

    def test_pdf_low_text_uses_ocr_and_only_replaces_more_complete_pages(self) -> None:
        pdf_path = self.data_dir / "scanned-fixture.pdf"
        pdf_path.write_bytes(b"%PDF-1.4\n% scanned fixture")
        extracted = {
            "title": "Scanned Fixture",
            "metadata": {"author": "", "created": ""},
            "pages": [
                {"page": 1, "text": ""},
                {"page": 2, "text": "Existing page text is more complete."},
            ],
        }
        recognized = "OCR recovered searchable text from the scanned first page. " * 8
        ocr_result = {
            "engine": "macos-pdfkit-vision",
            "pages": [
                {"page": 1, "text": recognized},
                {"page": 2, "text": "short"},
            ],
        }
        copied_path = self.data_dir / "copied.pdf"
        with mock.patch.object(self.store, "extract_pdf", return_value=extracted), mock.patch.object(
            self.store,
            "run_pdf_ocr",
            return_value=ocr_result,
        ) as ocr_mock, mock.patch.object(
            self.store,
            "capture",
            return_value={"source": {"id": "source-pdf-ocr"}},
        ) as capture_mock, mock.patch.object(
            self.store,
            "copy_pdf_to_vault",
            return_value=copied_path,
        ):
            result = self.store.ingest_pdf({"path": str(pdf_path)})

        ocr_mock.assert_called_once_with(pdf_path.resolve())
        stats = capture_mock.call_args.args[0]["content"]["stats"]
        pages = capture_mock.call_args.args[0]["content"]["pages"]
        self.assertEqual(pages[0]["text"], recognized.strip())
        self.assertEqual(pages[1]["text"], "Existing page text is more complete.")
        self.assertEqual(stats["profile"], "pdf-pypdf+macos-vision-ocr")
        self.assertFalse(stats["lowText"])
        self.assertEqual(stats["ocr"]["pages_replaced"], 1)
        self.assertTrue(result["pdf"]["ocr"]["attempted"])
        self.assertTrue(result["pdf"]["ocr"]["applied"])
        self.assertEqual(result["pdf"]["ocr"]["reason"], "applied")
        self.assertEqual(result["pdf"]["ocr"]["engine"], "macos-pdfkit-vision")
        self.assertEqual(result["pdf"]["profile"], stats["profile"])

    def test_pdf_ocr_failure_falls_back_without_failing_import(self) -> None:
        pdf_path = self.data_dir / "ocr-failure.pdf"
        pdf_path.write_bytes(b"%PDF-1.4\n% scanned fixture")
        extracted = {
            "title": "OCR Failure Fixture",
            "metadata": {"author": "", "created": ""},
            "pages": [{"page": 1, "text": ""}],
        }
        with mock.patch.object(self.store, "extract_pdf", return_value=extracted), mock.patch.object(
            self.store,
            "run_pdf_ocr",
            side_effect=ValueError("Vision worker timed out after 180 seconds"),
        ), mock.patch.object(
            self.store,
            "capture",
            return_value={"source": {"id": "source-pdf-ocr-failure"}},
        ) as capture_mock, mock.patch.object(
            self.store,
            "copy_pdf_to_vault",
            return_value=self.data_dir / "copied-failure.pdf",
        ):
            result = self.store.ingest_pdf({"path": str(pdf_path)})

        stats = capture_mock.call_args.args[0]["content"]["stats"]
        self.assertEqual(stats["profile"], "pdf-pypdf")
        self.assertTrue(stats["lowText"])
        self.assertTrue(stats["ocr"]["attempted"])
        self.assertFalse(stats["ocr"]["applied"])
        self.assertEqual(stats["ocr"]["reason"], "failed")
        self.assertIn("timed out", stats["ocr"]["error"])
        self.assertEqual(result["pdf"]["ocr"], stats["ocr"])

    def test_pdf_ocr_can_be_disabled_and_skips_text_pdfs(self) -> None:
        pdf_path = self.data_dir / "ocr-skip.pdf"
        pdf_path.write_bytes(b"%PDF-1.4\n% fixture")
        low_text = {
            "title": "Disabled OCR",
            "metadata": {"author": "", "created": ""},
            "pages": [{"page": 1, "text": ""}],
        }
        enough_text = {
            "title": "Text PDF",
            "metadata": {"author": "", "created": ""},
            "pages": [{"page": 1, "text": "normal text layer " * 30}],
        }
        with mock.patch.object(self.store, "run_pdf_ocr") as ocr_mock, mock.patch.object(
            self.store,
            "capture",
            side_effect=[
                {"source": {"id": "source-disabled"}},
                {"source": {"id": "source-text"}},
            ],
        ) as capture_mock, mock.patch.object(
            self.store,
            "copy_pdf_to_vault",
            side_effect=[self.data_dir / "disabled.pdf", self.data_dir / "text.pdf"],
        ), mock.patch.object(
            self.store,
            "extract_pdf",
            side_effect=[low_text, enough_text],
        ):
            disabled = self.store.ingest_pdf({"path": str(pdf_path), "ocr": False})
            text_result = self.store.ingest_pdf({"path": str(pdf_path)})

        ocr_mock.assert_not_called()
        disabled_stats = capture_mock.call_args_list[0].args[0]["content"]["stats"]
        text_stats = capture_mock.call_args_list[1].args[0]["content"]["stats"]
        self.assertFalse(disabled["pdf"]["ocr"]["attempted"])
        self.assertEqual(disabled["pdf"]["ocr"]["reason"], "disabled")
        self.assertEqual(disabled["pdf"]["ocr"]["error"], "")
        self.assertFalse(text_result["pdf"]["ocr"]["attempted"])
        self.assertEqual(text_result["pdf"]["ocr"]["reason"], "not_needed")
        self.assertEqual(text_result["pdf"]["ocr"]["error"], "")
        self.assertEqual(disabled_stats["profile"], "pdf-pypdf")
        self.assertEqual(text_stats["profile"], "pdf-pypdf")

    def test_pdf_ocr_runner_uses_safe_argv_and_reports_stderr(self) -> None:
        pdf_path = self.data_dir / "unsafe name; still argv.pdf"
        pdf_path.write_bytes(b"%PDF-1.4\n% fixture")
        success = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "engine": "macos-pdfkit-vision",
                    "pages": [{"page": 1, "text": "recognized"}],
                }
            ),
            stderr="diagnostic",
        )
        with mock.patch.object(server.shutil, "which", return_value="/usr/bin/swift"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=success,
        ) as run_mock:
            result = self.store.run_pdf_ocr(pdf_path)

        self.assertEqual(result["pages"][0]["text"], "recognized")
        run_mock.assert_called_once_with(
            ["/usr/bin/swift", str(server.PDF_OCR_WORKER), str(pdf_path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=server.PDF_OCR_TIMEOUT_SECONDS,
        )

        failure = mock.Mock(returncode=2, stdout="", stderr="Vision framework failed")
        with mock.patch.object(server.shutil, "which", return_value="/usr/bin/swift"), mock.patch.object(
            server.subprocess,
            "run",
            return_value=failure,
        ):
            with self.assertRaisesRegex(ValueError, "Vision framework failed"):
                self.store.run_pdf_ocr(pdf_path)

    def test_local_pdf_import_enforces_canonical_allowed_roots_and_pdf_content(self) -> None:
        allowed_pdf = self.data_dir / "allowed.pdf"
        make_text_pdf(allowed_pdf, ["Allowed local PDF"])
        resolved, source_url, cleanup = self.store.resolve_pdf_input({"path": str(allowed_pdf)})
        self.assertEqual(resolved, allowed_pdf.resolve())
        self.assertEqual(source_url, allowed_pdf.resolve().as_uri())
        self.assertIsNone(cleanup)

        not_pdf = self.data_dir / "not-really.pdf"
        not_pdf.write_text("plain text", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "valid PDF"):
            self.store.resolve_pdf_input({"path": str(not_pdf)})

        with tempfile.TemporaryDirectory(prefix="qc-pdf-outside-") as outside_name:
            outside_dir = Path(outside_name)
            outside_pdf = outside_dir / "outside.pdf"
            make_text_pdf(outside_pdf, ["Outside default roots"])

            with self.assertRaisesRegex(ValueError, "allowed import folder"):
                self.store.resolve_pdf_input({"path": str(outside_pdf)})

            symlink_path = self.data_dir / "symlink-escape.pdf"
            symlink_path.symlink_to(outside_pdf)
            with self.assertRaisesRegex(ValueError, "allowed import folder"):
                self.store.resolve_pdf_input({"path": str(symlink_path)})

            custom_store = server.Store(
                self.data_dir / "custom-store",
                allowed_pdf_dirs=[outside_dir],
            )
            custom_resolved, _, _ = custom_store.resolve_pdf_input({"path": str(outside_pdf)})
            self.assertEqual(custom_resolved, outside_pdf.resolve())

        with self.assertRaisesRegex(ValueError, "either path or url"):
            self.store.resolve_pdf_input(
                {"path": str(allowed_pdf), "url": "https://example.com/also.pdf"}
            )

    def test_remote_pdf_rejects_non_public_dns_answers(self) -> None:
        blocked_addresses = {
            "loopback": "127.0.0.1",
            "private": "10.20.30.40",
            "link_local": "169.254.10.20",
            "multicast": "224.0.0.1",
            "reserved": "240.0.0.1",
            "unspecified": "0.0.0.0",
            "ipv6_loopback": "::1",
            "ipv6_private": "fd00::1",
            "ipv6_link_local": "fe80::1",
        }
        for label, address in blocked_addresses.items():
            family = server.socket.AF_INET6 if ":" in address else server.socket.AF_INET
            sockaddr = (address, 443, 0, 0) if family == server.socket.AF_INET6 else (address, 443)
            answer = [(family, server.socket.SOCK_STREAM, 6, "", sockaddr)]
            with self.subTest(label=label), mock.patch.object(
                server.socket,
                "getaddrinfo",
                return_value=answer,
            ):
                with self.assertRaisesRegex(ValueError, "non-public network address"):
                    server.resolve_public_resource_endpoints("blocked.example", 443)

    def test_remote_pdf_pins_validated_address_against_dns_rebinding(self) -> None:
        public_answer = [
            (
                server.socket.AF_INET,
                server.socket.SOCK_STREAM,
                6,
                "",
                ("8.8.8.8", 80),
            )
        ]
        private_answer = [
            (
                server.socket.AF_INET,
                server.socket.SOCK_STREAM,
                6,
                "",
                ("127.0.0.1", 80),
            )
        ]
        response = mock.Mock(
            status=200,
            headers={"content-type": "application/pdf"},
        )
        response.read.return_value = b"%PDF-1.7\nfixture"
        connection = mock.Mock()
        connection.getresponse.return_value = response

        with mock.patch.object(
            server.socket,
            "getaddrinfo",
            side_effect=[public_answer, private_answer],
        ) as resolve_mock, mock.patch.object(
            server,
            "_PinnedHTTPConnection",
            return_value=connection,
        ) as connection_type:
            data = self.store.download_remote_pdf(
                "http://public.example/report.pdf?download=1"
            )

        self.assertEqual(data, b"%PDF-1.7\nfixture")
        self.assertEqual(resolve_mock.call_count, 1, "the transport must not resolve the hostname again")
        connection_type.assert_called_once_with(
            "public.example",
            80,
            "8.8.8.8",
            timeout=server.PDF_DOWNLOAD_TIMEOUT_SECONDS,
        )
        request_args = connection.request.call_args
        self.assertEqual(request_args.args[:2], ("GET", "/report.pdf?download=1"))
        self.assertEqual(request_args.kwargs["headers"]["host"], "public.example")
        connection.close.assert_called_once_with()

    def test_remote_pdf_redirect_is_revalidated_before_following(self) -> None:
        public_answer = [
            (
                server.socket.AF_INET,
                server.socket.SOCK_STREAM,
                6,
                "",
                ("8.8.8.8", 80),
            )
        ]
        private_answer = [
            (
                server.socket.AF_INET,
                server.socket.SOCK_STREAM,
                6,
                "",
                ("127.0.0.1", 80),
            )
        ]
        redirect = mock.Mock(
            status=302,
            headers={"location": "http://private.example/internal.pdf"},
        )
        connection = mock.Mock()
        connection.getresponse.return_value = redirect

        with mock.patch.object(
            server.socket,
            "getaddrinfo",
            side_effect=[public_answer, private_answer],
        ) as resolve_mock, mock.patch.object(
            server,
            "_PinnedHTTPConnection",
            return_value=connection,
        ) as connection_type:
            with self.assertRaisesRegex(ValueError, "non-public network address"):
                self.store.download_remote_pdf("http://public.example/start.pdf")

        self.assertEqual(resolve_mock.call_count, 2)
        self.assertEqual(connection_type.call_count, 1, "a blocked redirect target must never be contacted")
        connection.close.assert_called_once_with()

    def test_remote_pdf_rejects_unsafe_url_forms_and_non_pdf_response(self) -> None:
        for url in (
            "file:///etc/passwd",
            "ftp://example.com/report.pdf",
            "https://user:secret@example.com/report.pdf",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.store.resolve_pdf_input({"url": url})

        public_answer = [
            (
                server.socket.AF_INET,
                server.socket.SOCK_STREAM,
                6,
                "",
                ("8.8.8.8", 443),
            )
        ]
        response = mock.Mock(
            status=200,
            headers={"content-type": "application/pdf"},
        )
        response.read.return_value = b"<html>not a PDF</html>"
        connection = mock.Mock()
        connection.getresponse.return_value = response
        with mock.patch.object(
            server.socket,
            "getaddrinfo",
            return_value=public_answer,
        ), mock.patch.object(
            server,
            "_PinnedHTTPSConnection",
            return_value=connection,
        ):
            with self.assertRaisesRegex(ValueError, "valid PDF"):
                self.store.download_remote_pdf("https://public.example/not-pdf")

    def test_remote_pdf_download_failure_closes_fd_and_removes_temp_file(self) -> None:
        real_mkstemp = tempfile.mkstemp
        created: dict[str, object] = {}

        def tracked_mkstemp(*args, **kwargs):
            kwargs["dir"] = self.data_dir
            fd, path = real_mkstemp(*args, **kwargs)
            created.update({"fd": fd, "path": path})
            return fd, path

        with mock.patch.object(server.tempfile, "mkstemp", side_effect=tracked_mkstemp), mock.patch.object(
            self.store,
            "download_remote_pdf",
            side_effect=ValueError("remote PDF network request failed; check the URL and connection"),
        ):
            with self.assertRaisesRegex(ValueError, "check the URL"):
                self.store.resolve_pdf_input({"url": "https://example.com/unavailable.pdf"})

        fd = int(created["fd"])
        temp_path = Path(str(created["path"]))
        with self.assertRaises(OSError):
            os.fstat(fd)
        self.assertFalse(temp_path.exists())

    def test_deliverables_write_templates_and_mark_uncited_claims(self) -> None:
        text = "\n\n".join(
            [
                "# Evidence Bound Research",
                "Durable research claims need source references and chunk quotes.",
                "A strategy handoff should include hypothesis, data, metrics, risk checks, and acceptance.",
            ]
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/evidence-thread",
                    "title": "Evidence Thread",
                    "site": "hacker-news",
                    "captured_at": "2026-06-27T00:00:00+00:00",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = self.db_rows("SELECT id FROM chunks LIMIT 1")[0]["id"]
        claims = [
            {
                "text": "Durable research claims need source references and chunk quotes.",
                "citations": [
                    {
                        "source_id": source_id,
                        "chunk_id": chunk_id,
                        "quote": "Durable research claims need source references and chunk quotes.",
                        "url": "https://example.com/evidence-thread",
                    }
                ],
            },
            {"text": "This unsupported conclusion still needs manual validation."},
        ]

        expected_headings = {
            "report": ["## 证据矩阵", "待验证：This unsupported conclusion"],
            "ppt_outline": ["## Slide 1:", "## 关键结论引用"],
            "video_script": ["## 开场", "## 关键结论"],
            "strategy_task_brief": ["## 策略假设", "## 验收标准"],
        }

        created_ids = []
        for kind, headings in expected_headings.items():
            result = self.request(
                "/v1/deliverables",
                {
                    "kind": kind,
                    "title": f"{kind} fixture",
                    "source_ids": [source_id],
                    "background": "A fixture-backed deliverable.",
                    "claims": claims,
                    "strategy": {
                        "hypothesis": "Evidence-bound ideas are safer to implement.",
                        "input_data": ["forum posts", "PDF papers"],
                        "signal": "reviewed claim density",
                        "backtest_window": "2024-2026",
                        "metrics": ["hit rate", "drawdown"],
                        "risk_checks": ["overfitting", "liquidity"],
                        "implementation_steps": ["ingest", "extract", "backtest"],
                        "acceptance": ["all final claims have citations or 待验证"],
                    },
                },
                method="POST",
            )["deliverable"]
            created_ids.append(result["id"])
            self.assertEqual(result["kind"], kind)
            self.assertEqual(result["status"], "draft")
            self.assertEqual(result["unsupported_claims"], 1)
            self.assertFalse(result["ready_gate"]["passed"])
            self.assertFalse(result["ready_gate"]["can_finalize"])
            issue_codes = {issue["code"] for issue in result["ready_gate"]["issues"]}
            self.assertIn("unsupported_claims", issue_codes)
            self.assertIn("unreviewed_sources", issue_codes)
            self.assertEqual(result["source_ids"], [source_id])
            self.assertTrue(Path(result["markdown_path"]).exists())
            self.assertIn(f"source:{source_id}", result["markdown"])
            self.assertIn(f"chunk:{chunk_id}", result["markdown"])
            self.assertIn("## Ready Gate", result["markdown"])
            self.assertIn("- Status: BLOCKED", result["markdown"])
            for heading in headings:
                self.assertIn(heading, result["markdown"])

        rows = self.db_rows("SELECT kind, unsupported_claims, status FROM deliverables ORDER BY created_at")
        self.assertEqual(len(rows), 4)
        self.assertEqual({row["kind"] for row in rows}, set(expected_headings))
        self.assertEqual({row["unsupported_claims"] for row in rows}, {1})
        self.assertEqual({row["status"] for row in rows}, {"draft"})

        listing = self.request("/v1/deliverables?limit=10")["deliverables"]
        self.assertEqual(len(listing), 4)
        self.assertTrue(all("ready_gate" in item for item in listing))
        detail = self.request(f"/v1/deliverables/{created_ids[0]}")["deliverable"]
        self.assertIn("待验证", detail["markdown"])
        self.assertFalse(detail["ready_gate"]["passed"])

        with self.assertRaisesRegex(AssertionError, "Ready Gate"):
            self.request(
                "/v1/deliverables",
                {
                    "kind": "report",
                    "title": "Blocked final",
                    "status": "final",
                    "source_ids": [source_id],
                    "claims": claims,
                },
                method="POST",
            )

        self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
        knowledge = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": claims[0]["text"],
                        "evidence": claims[0]["citations"],
                    }
                ],
            },
            method="POST",
        )
        stored_claim = knowledge["claims"][0]
        claim_bound_payload = {
            "kind": "report",
            "title": "Claim gated final",
            "status": "final",
            "source_ids": [source_id],
            "claims": [{**claims[0], "id": stored_claim["id"]}],
        }
        with self.assertRaisesRegex(AssertionError, "Ready Gate"):
            self.request("/v1/deliverables", claim_bound_payload, method="POST")
        reviewed_claim = self.request(
            f"/v1/claims/{stored_claim['id']}/review",
            {"status": "reviewed", "reviewer": "unit-test", "review_note": "quote checked"},
            method="POST",
        )["claim"]
        self.assertEqual(reviewed_claim["status"], "reviewed")
        final = self.request(
            "/v1/deliverables",
            claim_bound_payload,
            method="POST",
        )["deliverable"]
        self.assertEqual(final["status"], "final")
        self.assertTrue(final["ready_gate"]["passed"])
        self.assertTrue(final["ready_gate"]["can_finalize"])
        self.assertEqual(final["ready_gate"]["issue_count"], 0)
        self.assertIn("ready_gate_passed: true", final["markdown"])
        self.assertIn("## Evidence Appendix", final["markdown"])
        self.assertIn(f"- Source id: `{source_id}`", final["markdown"])
        self.assertIn(f"- Chunk id: `{chunk_id}`", final["markdown"])
        self.assertIn("Durable research claims need source references and chunk quotes.", final["markdown"])
        self.assertIn("- Status: PASSED", final["markdown"])

        index_text = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Deliverables", index_text)
        self.assertIn("wiki/deliverables", index_text)

    def test_export_reads_companion_sources_notes_and_deliverables(self) -> None:
        text = "Export package source text with evidence chain and strategy task handoff."
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "page",
                    "url": "https://example.com/export",
                    "title": "Export Source",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        note = self.request(
            "/v1/notes",
            {
                "source_id": source_id,
                "title": "Export Note",
                "question": "What matters?",
                "answer": "The export should include companion notes.",
                "excerpt": "Export package source text",
            },
            method="POST",
        )["note"]
        deliverable = self.request(
            "/v1/deliverables",
            {
                "kind": "report",
                "title": "Export Report",
                "source_ids": [source_id],
                "claims": [
                    {
                        "text": "Export package source text with evidence chain.",
                        "citations": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Export package source text with evidence chain",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )["deliverable"]

        json_export = self.request("/v1/export?format=json")
        self.assertEqual(json_export["counts"]["sources"], 1)
        self.assertEqual(json_export["counts"]["notes"], 1)
        self.assertEqual(json_export["counts"]["deliverables"], 1)
        package = json.loads(json_export["content"])
        self.assertEqual(package["sources"][0]["id"], source_id)
        self.assertEqual(package["notes"][0]["id"], note["id"])
        self.assertEqual(package["deliverables"][0]["id"], deliverable["id"])
        self.assertIn("Export Source", package["sources"][0]["markdown"])

        markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("# QC Smart Reader Export", markdown_export["content"])
        self.assertIn("Export Note", markdown_export["content"])
        self.assertIn("Export Report", markdown_export["content"])
        self.assertIn(f"source:{source_id}", markdown_export["content"])

    def test_structured_knowledge_records_validate_evidence_and_write_vault(self) -> None:
        text = (
            "Evidence-bound claims should cite source chunks before becoming durable conclusions. "
            "Factor rotation is a strategy idea that still needs risk checks and validation tasks."
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/structured",
                    "title": "Structured Knowledge Source",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        response = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "entities": [
                    {"name": "Factor rotation", "kind": "strategy", "description": "A rotation strategy concept."},
                    {"name": "Risk checks", "kind": "method"},
                ],
                "claims": [
                    {
                        "id": "supported-claim",
                        "text": "Evidence-bound claims should cite source chunks before becoming durable conclusions.",
                        "status": "reviewed",
                        "confidence": 0.8,
                        "reasoning_chain": "source quote -> claim -> durable conclusion",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Evidence-bound claims should cite source chunks",
                                "url": "https://example.com/structured",
                            }
                        ],
                    },
                    {
                        "id": "unsupported-claim",
                        "text": "This unsupported claim should not become a durable conclusion.",
                        "status": "reviewed",
                    },
                    {
                        "id": "bad-quote",
                        "text": "A fake quote should be treated as pending validation.",
                        "status": "reviewed",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "this quote is not in the chunk",
                            }
                        ],
                    },
                ],
                "relations": [
                    {
                        "subject": "Factor rotation",
                        "predicate": "requires",
                        "object": "Risk checks",
                        "claim_id": "supported-claim",
                    }
                ],
                "assumptions": [{"text": "The market regime is stable enough to compare rotations.", "claim_id": "supported-claim"}],
                "risks": [{"text": "Overfitting the rotation rule.", "severity": "high", "claim_id": "supported-claim"}],
                "strategy_ideas": [{"title": "Factor rotation validation", "thesis": "Test reviewed claim density.", "claim_id": "supported-claim"}],
                "tasks": [{"title": "Backtest factor rotation", "acceptance": "Report source-linked metrics.", "claim_id": "supported-claim"}],
            },
            method="POST",
        )

        self.assertEqual(len(response["entities"]), 2)
        self.assertEqual(len(response["claims"]), 3)
        statuses = {claim["text"]: claim["status"] for claim in response["claims"]}
        self.assertEqual(
            statuses["Evidence-bound claims should cite source chunks before becoming durable conclusions."],
            "extracted",
        )
        self.assertEqual(statuses["This unsupported claim should not become a durable conclusion."], "pending_validation")
        self.assertEqual(statuses["A fake quote should be treated as pending validation."], "pending_validation")
        self.assertEqual(len(response["evidence"]), 1)
        self.assertEqual(response["evidence"][0]["chunk_id"], chunk_id)
        self.assertEqual(len(response["relations"]), 1)
        self.assertFalse(response["relations"][0]["reused"])
        self.assertEqual(response["assumptions"][0]["source_id"], source_id)
        self.assertFalse(response["assumptions"][0]["reused"])
        self.assertEqual(len(response["risks"]), 1)
        self.assertFalse(response["risks"][0]["reused"])
        self.assertEqual(len(response["strategy_ideas"]), 1)
        self.assertFalse(response["strategy_ideas"][0]["reused"])
        self.assertEqual(len(response["tasks"]), 1)
        self.assertFalse(response["tasks"][0]["reused"])

        self.assertEqual(len(self.db_rows("SELECT * FROM entities")), 2)
        self.assertEqual(len(self.db_rows("SELECT * FROM claims")), 3)
        self.assertEqual(len(self.db_rows("SELECT * FROM evidence")), 1)
        self.assertEqual(len(self.db_rows("SELECT * FROM relations")), 1)
        self.assertEqual(len(self.db_rows("SELECT * FROM assumptions")), 1)
        self.assertEqual(len(self.db_rows("SELECT * FROM risks")), 1)
        self.assertEqual(len(self.db_rows("SELECT * FROM strategy_ideas")), 1)
        self.assertEqual(len(self.db_rows("SELECT * FROM tasks")), 1)

        listing = self.request("/v1/knowledge/records?limit=10")
        self.assertEqual(len(listing["claims"]), 3)
        self.assertEqual(len(listing["entities"]), 2)
        self.assertEqual(listing["assumptions"][0]["source_id"], source_id)
        claims_by_text = {claim["text"]: claim for claim in listing["claims"]}
        self.assertEqual(
            claims_by_text["Evidence-bound claims should cite source chunks before becoming durable conclusions."]["evidence_count"],
            1,
        )
        unsupported_claim = claims_by_text["This unsupported claim should not become a durable conclusion."]
        self.assertEqual(unsupported_claim["evidence_count"], 0)
        with self.assertRaisesRegex(AssertionError, "without valid source/chunk/quote evidence"):
            self.request(
                f"/v1/claims/{unsupported_claim['id']}/review",
                {"status": "reviewed", "reviewer": "unit-test"},
                method="POST",
            )
        rejected = self.request(
            f"/v1/claims/{unsupported_claim['id']}/review",
            {"status": "rejected", "reviewer": "unit-test", "review_note": "missing exact quote"},
            method="POST",
        )["claim"]
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(rejected["review_note"], "missing exact quote")
        self.assertEqual(rejected["evidence_count"], 0)
        entity_files = list((self.data_dir / "vault" / "wiki" / "entities").glob("*.md"))
        self.assertTrue(entity_files)
        self.assertIn("Factor rotation", "\n".join(path.read_text(encoding="utf-8") for path in entity_files))
        analysis_files = list((self.data_dir / "vault" / "wiki" / "analyses").glob("*structured-knowledge*.md"))
        self.assertTrue(analysis_files)
        self.assertIn("pending_validation", analysis_files[0].read_text(encoding="utf-8"))
        self.assertIn(f"source_id: {source_id}", analysis_files[0].read_text(encoding="utf-8"))
        exported = json.loads(self.request("/v1/export?format=json")["content"])
        self.assertEqual(exported["knowledge"]["assumptions"][0]["source_id"], source_id)
        index_text = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Entities", index_text)
        self.assertIn("## Claims", index_text)
        self.assertIn("Factor rotation", index_text)

    def test_claim_and_evidence_reviews_recheck_current_chunk_quotes(self) -> None:
        source_text = (
            "Durable evidence quote must survive source edits. "
            "Replacement quote is acceptable after revalidation."
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {"url": "https://example.com/recheck", "title": "Evidence Recheck"},
                "content": {"text": source_text, "markdown": source_text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": "Evidence-bound conclusions need live quote validation.",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Durable evidence quote must survive source edits.",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        claim_id = records["claims"][0]["id"]
        evidence_id = records["evidence"][0]["id"]

        reviewed_evidence = self.request(
            f"/v1/evidence/{evidence_id}/review",
            {"status": "reviewed", "reviewer": "unit-test"},
            method="POST",
        )["evidence"]
        self.assertTrue(reviewed_evidence["citation_valid"])
        reviewed_claim = self.request(
            f"/v1/claims/{claim_id}/review",
            {"status": "reviewed", "reviewer": "unit-test"},
            method="POST",
        )["claim"]
        self.assertEqual(reviewed_claim["status"], "reviewed")
        self.assertEqual(reviewed_claim["valid_evidence_count"], 1)

        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        try:
            db.execute(
                "UPDATE chunks SET text = ? WHERE id = ?",
                ("The source was rewritten. Replacement quote is acceptable after revalidation.", chunk_id),
            )
            db.commit()
        finally:
            db.close()

        stale_claim = self.request(f"/v1/claims/{claim_id}")["claim"]
        self.assertEqual(stale_claim["valid_evidence_count"], 0)
        self.assertFalse(stale_claim["evidence"][0]["citation_valid"])
        listing = self.request("/v1/knowledge/records?limit=10")
        listed_claim = next(item for item in listing["claims"] if item["id"] == claim_id)
        listed_evidence = next(item for item in listing["evidence"] if item["id"] == evidence_id)
        self.assertEqual(listed_claim["valid_evidence_count"], 0)
        self.assertFalse(listed_evidence["citation_valid"])
        invalid_queue = self.request(
            f"/v1/claims/review-queue?status=reviewed&quote_validity=invalid&source_id={source_id}&evidence_strength=supporting"
        )
        self.assertEqual([item["id"] for item in invalid_queue["claims"]], [claim_id])

        with self.assertRaisesRegex(AssertionError, "valid source/chunk/quote evidence"):
            self.request(
                f"/v1/claims/{claim_id}/review",
                {"status": "reviewed", "reviewer": "unit-test"},
                method="POST",
            )
        downgraded_claim = self.request(f"/v1/claims/{claim_id}")["claim"]
        self.assertEqual(downgraded_claim["status"], "pending_validation")
        self.assertEqual(downgraded_claim["evidence"][0]["status"], "pending_validation")
        failed_events = self.request(f"/v1/claims/{claim_id}/events")["events"]
        failed_event = next(event for event in failed_events if event["event_type"] == "review_revalidation_failed")
        self.assertEqual(failed_event["metadata"]["previous_status"], "reviewed")
        self.assertEqual(failed_event["metadata"]["next_status"], "pending_validation")
        self.assertEqual(failed_event["metadata"]["invalid_reviewed_evidence_ids"], [evidence_id])
        needs_quote_queue = self.request(
            f"/v1/claims/review-queue?status=pending_validation&quote_validity=needs_quote&source_id={source_id}"
        )
        self.assertEqual([item["id"] for item in needs_quote_queue["claims"]], [claim_id])

        with self.assertRaisesRegex(AssertionError, "valid source/chunk/quote evidence"):
            self.request(
                f"/v1/evidence/{evidence_id}/review",
                {"status": "reviewed", "reviewer": "unit-test"},
                method="POST",
            )

        repaired_evidence = self.request(
            f"/v1/evidence/{evidence_id}/review",
            {
                "status": "reviewed",
                "reviewer": "unit-test",
                "quote": "Replacement quote is acceptable after revalidation.",
            },
            method="POST",
        )["evidence"]
        self.assertTrue(repaired_evidence["citation_valid"])
        self.assertEqual(repaired_evidence["status"], "reviewed")
        repaired_claim = self.request(
            f"/v1/claims/{claim_id}/review",
            {"status": "reviewed", "reviewer": "unit-test"},
            method="POST",
        )["claim"]
        self.assertEqual(repaired_claim["status"], "reviewed")
        self.assertEqual(repaired_claim["valid_evidence_count"], 1)
        valid_queue = self.request(f"/v1/claims/review-queue?status=reviewed&quote_validity=valid&source_id={source_id}")
        self.assertEqual([item["id"] for item in valid_queue["claims"]], [claim_id])

    def test_new_canonical_source_version_marks_old_reviewed_lineage_stale(self) -> None:
        url = "https://example.com/versioned-source"
        original_text = "Canonical source v1 supports a reviewed topic package."
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": url, "title": "Versioned Source", "site": "example"},
                "content": {"text": original_text, "markdown": original_text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": "Canonical source v1 supports a reviewed topic package.",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Canonical source v1 supports a reviewed topic package.",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        claim_id = records["claims"][0]["id"]
        evidence_id = records["evidence"][0]["id"]
        self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
        self.request(
            f"/v1/evidence/{evidence_id}/review",
            {"status": "reviewed", "reviewer": "unit-test"},
            method="POST",
        )
        self.request(f"/v1/claims/{claim_id}/review", {"status": "reviewed", "reviewer": "unit-test"}, method="POST")
        topic = self.request(
            "/v1/topic-packages",
            {"title": "Versioned Source Topic", "claim_ids": [claim_id], "status": "reviewed"},
            method="POST",
        )["topic_package"]
        self.assertFalse(topic["stale"])
        topic_queue = self.request(f"/v1/claims/review-queue?status=reviewed&topic_package_id={topic['id']}&quote_validity=valid")
        self.assertEqual([item["id"] for item in topic_queue["claims"]], [claim_id])

        replacement_text = (
            "Canonical source v2 changes the evidence base for the same canonical URL. "
            "The updated version adds enough body text to pass the source quality gate before "
            "structured extraction runs, so the re-extraction flow can advance the source into "
            "the extracted state while still preserving the old version for diff review. "
            "This extra material represents a realistic edited forum post with new explanation, "
            "revised assumptions, additional examples, and follow-up implementation notes."
        )
        replacement_capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": url, "title": "Versioned Source Updated", "site": "example"},
                "content": {"text": replacement_text, "markdown": replacement_text},
                "browser": {},
            },
            method="POST",
        )
        replacement_source_id = replacement_capture["source"]["id"]
        self.assertNotEqual(replacement_source_id, source_id)
        superseded_evidence = self.request(f"/v1/evidence/{evidence_id}")["evidence"]
        self.assertTrue(superseded_evidence["citation_valid"])
        self.assertEqual(superseded_evidence["status"], "pending_validation")
        self.assertIn(source_id, superseded_evidence["review_note"])
        self.assertIn(replacement_source_id, superseded_evidence["review_note"])
        superseded_claim = self.request(f"/v1/claims/{claim_id}")["claim"]
        self.assertEqual(superseded_claim["status"], "pending_validation")
        self.assertFalse(superseded_claim["reviewed_at"])
        self.assertIn(
            "claim_revalidation_required",
            [event["event_type"] for event in superseded_claim["events"]],
        )
        stale_topic = self.request(f"/v1/topic-packages/{topic['id']}")["topic_package"]
        self.assertTrue(stale_topic["stale"])
        self.assertIn(source_id, stale_topic["stale_reason"])
        self.assertIn(replacement_source_id, stale_topic["stale_reason"])

        diff = self.request(f"/v1/sources/{replacement_source_id}/diff")["diff"]
        self.assertTrue(diff["has_compare"])
        self.assertTrue(diff["changed"])
        self.assertEqual(diff["compare_source_id"], source_id)
        self.assertIn("Canonical source v1", diff["old_excerpt"])
        self.assertIn("Canonical source v2", diff["new_excerpt"])
        self.assertIn(source_id, diff["unified_diff"])
        self.assertIn(replacement_source_id, diff["unified_diff"])

        reextract = self.request(
            f"/v1/sources/{replacement_source_id}/reextract",
            {"mode": "mock", "max_claims": 2, "reason": "unit-test reextract"},
            method="POST",
        )
        self.assertTrue(reextract["ok"])
        self.assertEqual(reextract["job"]["type"], "reextract")
        self.assertEqual(reextract["job"]["items"][0]["status"], "success")
        self.assertEqual(reextract["result"]["agent_run"]["job_id"], reextract["job"]["id"])
        self.assertGreaterEqual(len(reextract["result"]["records"]["claims"]), 1)
        self.assertEqual(reextract["result"]["source"]["status"], "extracted")
        item_result = reextract["job"]["items"][0]["result"]
        self.assertEqual(item_result["source_id"], replacement_source_id)
        self.assertEqual(item_result["agent_run_id"], reextract["result"]["agent_run"]["id"])
        self.assertGreaterEqual(item_result["record_counts"]["claims"], 1)
        events = self.request(f"/v1/jobs/{reextract['job']['id']}/events")["events"]
        self.assertIn("item_reextract_completed", [item["event_type"] for item in events])

    def test_canonical_replacement_keeps_claim_reviewed_with_other_current_reviewed_evidence(self) -> None:
        old_text = "The versioned source supports a shared reviewed conclusion with exact evidence. " * 10
        old_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/multi-source-versioned",
                    "title": "Versioned support",
                    "site": "example",
                },
                "content": {"text": old_text, "markdown": old_text},
                "browser": {},
            },
            method="POST",
        )
        other_text = "An independent source also supports the shared reviewed conclusion with exact evidence. " * 10
        other_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.net/independent-support",
                    "title": "Independent support",
                    "site": "example",
                },
                "content": {"text": other_text, "markdown": other_text},
                "browser": {},
            },
            method="POST",
        )
        old_source_id = old_capture["source"]["id"]
        other_source_id = other_capture["source"]["id"]
        old_records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": old_source_id,
                "claims": [
                    {
                        "text": "The shared conclusion has two independent supports.",
                        "evidence": [
                            {
                                "source_id": old_source_id,
                                "chunk_id": old_capture["chunks"][0]["id"],
                                "quote": "versioned source supports a shared reviewed conclusion",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        other_records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": other_source_id,
                "claims": [
                    {
                        "text": "Independent support for the shared conclusion.",
                        "evidence": [
                            {
                                "source_id": other_source_id,
                                "chunk_id": other_capture["chunks"][0]["id"],
                                "quote": "independent source also supports the shared reviewed conclusion",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        target_claim_id = old_records["claims"][0]["id"]
        old_evidence_id = old_records["evidence"][0]["id"]
        other_claim_id = other_records["claims"][0]["id"]
        other_evidence_id = other_records["evidence"][0]["id"]
        for evidence_id in (old_evidence_id, other_evidence_id):
            self.request(f"/v1/evidence/{evidence_id}/review", {"status": "reviewed"}, method="POST")
        self.request(
            "/v1/claims/merge",
            {"target_claim_id": target_claim_id, "claim_ids": [target_claim_id, other_claim_id]},
            method="POST",
        )
        self.request(f"/v1/claims/{target_claim_id}/review", {"status": "reviewed"}, method="POST")
        self.request(f"/v1/sources/{old_source_id}/status", {"status": "reviewed"}, method="POST")

        replacement_text = "The newer canonical version changes its conclusion and requires a fresh review. " * 10
        self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/multi-source-versioned",
                    "title": "Versioned support updated",
                    "site": "example",
                },
                "content": {"text": replacement_text, "markdown": replacement_text},
                "browser": {},
            },
            method="POST",
        )

        self.assertEqual(self.request(f"/v1/evidence/{old_evidence_id}")["evidence"]["status"], "pending_validation")
        self.assertEqual(self.request(f"/v1/evidence/{other_evidence_id}")["evidence"]["status"], "reviewed")
        self.assertEqual(self.request(f"/v1/claims/{target_claim_id}")["claim"]["status"], "reviewed")

    def test_same_source_reextract_reuses_claims_and_evidence_without_losing_review(self) -> None:
        text = (
            "Factor rotation needs exact evidence before a reviewed conclusion is durable. "
            "Risk controls require drawdown checks and out-of-sample validation before live use. "
        ) * 12
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/idempotent-reextract",
                    "title": "Idempotent re-extraction",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        initial = self.request(
            f"/v1/sources/{source_id}/extract-knowledge",
            {"mode": "mock", "max_claims": 2},
            method="POST",
        )
        initial_records = initial["records"]
        structured_keys = ("relations", "assumptions", "risks", "strategy_ideas", "tasks")
        for key in structured_keys:
            self.assertTrue(initial_records[key], f"mock fixture should produce {key}")
            self.assertTrue(any(record["reused"] is False for record in initial_records[key]))
            self.assertTrue(all(isinstance(record["reused"], bool) for record in initial_records[key]))
        initial_ids = {
            key: {record["id"] for record in initial_records[key]}
            for key in ("entities", "claims", "evidence", *structured_keys)
        }
        claim_id = initial_records["claims"][0]["id"]
        evidence_id = initial_records["evidence"][0]["id"]
        self.request(
            f"/v1/evidence/{evidence_id}/review",
            {"status": "reviewed", "reviewer": "unit-test", "review_note": "verified once"},
            method="POST",
        )
        reviewed_claim = self.request(
            f"/v1/claims/{claim_id}/review",
            {"status": "reviewed", "reviewer": "unit-test", "review_note": "keep this review"},
            method="POST",
        )["claim"]
        preserved_statuses = {
            "relations": "reviewed",
            "assumptions": "rejected",
            "risks": "mitigated",
            "strategy_ideas": "reviewed",
            "tasks": "done",
        }
        db = sqlite3.connect(self.data_dir / "state" / "qc_smart_reader.sqlite3")
        try:
            db.execute("UPDATE entities SET status = 'reviewed'")
            for table, status in preserved_statuses.items():
                db.execute(f"UPDATE {table} SET status = ? WHERE source_id = ?", (status, source_id))
            db.commit()
        finally:
            db.close()
        counted_tables = ("claims", "evidence", *structured_keys)
        before_counts = {
            table: self.db_rows(
                f"SELECT COUNT(*) AS count FROM {table} WHERE source_id = ?",
                (source_id,),
            )[0]["count"]
            for table in counted_tables
        }
        analyses_dir = self.data_dir / "vault" / "wiki" / "analyses"
        analysis_files_before = sorted(analyses_dir.glob("*structured-knowledge*.md"))
        self.assertEqual(len(analysis_files_before), 1)

        reextract = self.request(
            f"/v1/sources/{source_id}/reextract",
            {"mode": "mock", "max_claims": 2, "reason": "idempotency check"},
            method="POST",
        )

        after_counts = {
            table: self.db_rows(
                f"SELECT COUNT(*) AS count FROM {table} WHERE source_id = ?",
                (source_id,),
            )[0]["count"]
            for table in counted_tables
        }
        self.assertEqual(after_counts, before_counts)
        reextracted_records = reextract["result"]["records"]
        self.assertEqual(reextracted_records["claims"][0]["id"], claim_id)
        self.assertEqual(reextracted_records["evidence"][0]["id"], evidence_id)
        for key in ("claims", "evidence", *structured_keys):
            self.assertEqual({record["id"] for record in reextracted_records[key]}, initial_ids[key])
            self.assertTrue(all(record["reused"] is True for record in reextracted_records[key]))
        self.assertEqual({record["id"] for record in reextracted_records["entities"]}, initial_ids["entities"])
        self.assertTrue(all(record["reused"] is True for record in reextracted_records["entities"]))
        self.assertEqual({record["status"] for record in reextracted_records["entities"]}, {"reviewed"})
        for table, status in preserved_statuses.items():
            rows = self.db_rows(f"SELECT id, status FROM {table} WHERE source_id = ?", (source_id,))
            self.assertEqual({row["status"] for row in rows}, {status})
            self.assertEqual({record["status"] for record in reextracted_records[table]}, {status})
        analysis_files_after = sorted(analyses_dir.glob("*structured-knowledge*.md"))
        self.assertEqual(analysis_files_after, analysis_files_before)
        preserved = self.request(f"/v1/claims/{claim_id}")["claim"]
        self.assertEqual(preserved["status"], "reviewed")
        self.assertEqual(preserved["reviewer"], "unit-test")
        self.assertEqual(preserved["review_note"], "keep this review")
        self.assertEqual(preserved["reviewed_at"], reviewed_claim["reviewed_at"])

        other_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/idempotent-reextract-other",
                    "title": "Other structured source",
                    "site": "example",
                },
                "content": {
                    "text": "A different immutable source needs its own stable structured analysis page. " * 8,
                    "markdown": "A different immutable source needs its own stable structured analysis page. " * 8,
                },
                "browser": {},
            },
            method="POST",
        )
        other_source_id = other_capture["source"]["id"]
        self.request(
            "/v1/knowledge/records",
            {
                "source_id": other_source_id,
                "tasks": [{"title": "Review the other immutable source"}],
            },
            method="POST",
        )
        source_scoped_analyses = sorted(analyses_dir.glob("*structured-knowledge*.md"))
        self.assertEqual(len(source_scoped_analyses), 2)
        self.assertIn(analysis_files_before[0], source_scoped_analyses)
        combined_analyses = "\n".join(path.read_text(encoding="utf-8") for path in source_scoped_analyses)
        self.assertIn(f"source_id: {source_id}", combined_analyses)
        self.assertIn(f"source_id: {other_source_id}", combined_analyses)

    def test_concurrent_same_source_knowledge_writes_reuse_all_structured_records(self) -> None:
        text = "Concurrent extraction must keep one durable claim and one exact evidence quote. " * 12
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/concurrent-extraction",
                    "title": "Concurrent extraction",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        payload = {
            "source_id": source_id,
            "entities": [
                {"name": "Concurrent source", "kind": "source"},
                {"name": "Durable record", "kind": "concept"},
            ],
            "claims": [
                {
                    "id": "concurrent-claim",
                    "text": "Concurrent extraction must keep one durable claim.",
                    "evidence": [
                        {
                            "source_id": source_id,
                            "chunk_id": capture["chunks"][0]["id"],
                            "quote": "Concurrent extraction must keep one durable claim",
                        }
                    ],
                }
            ],
            "relations": [
                {
                    "subject": "Concurrent source",
                    "predicate": "  SUPPORTS  ",
                    "object": "Durable record",
                    "claim_id": "concurrent-claim",
                }
            ],
            "assumptions": [
                {"text": " Concurrent inputs remain immutable. ", "claim_id": "concurrent-claim"}
            ],
            "risks": [
                {"text": " Duplicate writes hide review state. ", "severity": "HIGH", "claim_id": "concurrent-claim"}
            ],
            "strategy_ideas": [
                {
                    "title": " Serialized source upsert ",
                    "thesis": "Reuse equivalent source records.",
                    "claim_id": "concurrent-claim",
                }
            ],
            "tasks": [
                {
                    "title": " Verify record counts ",
                    "acceptance": "Every structured table contains one source row.",
                    "claim_id": "concurrent-claim",
                }
            ],
        }

        def write_variant(index: int) -> dict:
            variant = json.loads(json.dumps(payload))
            if index % 2:
                variant["relations"][0]["predicate"] = "supports"
                variant["assumptions"][0]["text"] = "concurrent   inputs remain immutable."
                variant["risks"][0]["text"] = "duplicate writes hide review state."
                variant["risks"][0]["severity"] = "high"
                variant["strategy_ideas"][0]["title"] = "serialized source upsert"
                variant["strategy_ideas"][0]["thesis"] = "reuse  equivalent source records."
                variant["tasks"][0]["title"] = "verify record counts"
                variant["tasks"][0]["acceptance"] = "every structured table contains one source row."
            return self.store.create_knowledge_records(variant)

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(write_variant, range(4)))

        for key in ("claims", "evidence", "relations", "assumptions", "risks", "strategy_ideas", "tasks"):
            self.assertEqual(len({result[key][0]["id"] for result in results}), 1)
            self.assertEqual(sum(1 for result in results if result[key][0]["reused"] is False), 1)
            self.assertEqual(
                self.db_rows(
                    f"SELECT COUNT(*) AS count FROM {key} WHERE source_id = ?",
                    (source_id,),
                )[0]["count"],
                1,
            )
        analysis_files = list(
            (self.data_dir / "vault" / "wiki" / "analyses").glob("*structured-knowledge*.md")
        )
        self.assertEqual(len(analysis_files), 1)

    def test_assumptions_source_id_migration_is_repeat_safe(self) -> None:
        legacy_dir = self.data_dir / "legacy-assumptions-store"
        legacy_store = server.Store(legacy_dir)
        capture = legacy_store.capture(
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/legacy-assumption",
                    "title": "Legacy assumption source",
                    "site": "example",
                },
                "content": {
                    "text": "A legacy source-linked assumption should be backfilled through its claim. " * 8,
                    "markdown": "A legacy source-linked assumption should be backfilled through its claim. " * 8,
                },
                "browser": {},
            }
        )
        source_id = capture["source"]["id"]
        claim_id = legacy_store.create_knowledge_records(
            {
                "source_id": source_id,
                "claims": [{"text": "The legacy assumption has a source-linked claim."}],
            }
        )["claims"][0]["id"]
        legacy_db_path = legacy_store.db_path
        db = sqlite3.connect(legacy_db_path)
        try:
            db.execute("DROP TABLE assumptions")
            db.execute(
                """
                CREATE TABLE assumptions (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL,
                  claim_id TEXT,
                  text TEXT NOT NULL,
                  status TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                )
                """
            )
            db.execute(
                """
                INSERT INTO assumptions(id, project_id, claim_id, text, status, created_at, updated_at)
                VALUES ('asm_legacy', 'default', ?, 'Legacy assumption', 'reviewed', '2026-01-01', '2026-01-01')
                """,
                (claim_id,),
            )
            db.commit()
        finally:
            db.close()

        server.Store(legacy_dir)
        reopened = server.Store(legacy_dir)
        reused = reopened.create_knowledge_records(
            {
                "source_id": source_id,
                "assumptions": [
                    {
                        "text": " legacy   assumption ",
                        "claim_id": claim_id,
                        "status": "pending_validation",
                    }
                ],
            }
        )["assumptions"][0]

        db = sqlite3.connect(legacy_db_path)
        db.row_factory = sqlite3.Row
        try:
            columns = [row["name"] for row in db.execute("PRAGMA table_info(assumptions)").fetchall()]
            foreign_keys = db.execute("PRAGMA foreign_key_list(assumptions)").fetchall()
            legacy = db.execute("SELECT * FROM assumptions WHERE id = 'asm_legacy'").fetchone()
        finally:
            db.close()
        self.assertEqual(columns.count("source_id"), 1)
        self.assertTrue(
            any(row["from"] == "source_id" and row["table"] == "sources" for row in foreign_keys)
        )
        self.assertEqual(legacy["source_id"], source_id)
        self.assertEqual(legacy["status"], "reviewed")
        self.assertEqual(reused["id"], "asm_legacy")
        self.assertTrue(reused["reused"])
        self.assertEqual(reused["status"], "reviewed")

    def test_reextract_audits_invalid_reviewed_evidence_before_reusing_claim(self) -> None:
        text = (
            "A source claim needs a current exact quote before it can remain reviewed. "
            "The audit must demote stale evidence and require claim revalidation. "
        ) * 12
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/reextract-audit",
                    "title": "Re-extraction audit",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        initial = self.request(
            f"/v1/sources/{source_id}/extract-knowledge",
            {"mode": "mock", "max_claims": 1},
            method="POST",
        )
        claim_id = initial["records"]["claims"][0]["id"]
        evidence_id = initial["records"]["evidence"][0]["id"]
        self.request(f"/v1/evidence/{evidence_id}/review", {"status": "reviewed"}, method="POST")
        self.request(f"/v1/claims/{claim_id}/review", {"status": "reviewed"}, method="POST")
        with self.store.connect() as db:
            db.execute("UPDATE evidence SET quote = ? WHERE id = ?", ("quote that is no longer in the chunk", evidence_id))
            db.commit()

        reextract = self.request(
            f"/v1/sources/{source_id}/reextract",
            {"mode": "mock", "max_claims": 1, "reason": "audit invalid quote"},
            method="POST",
        )

        stale_evidence = self.request(f"/v1/evidence/{evidence_id}")["evidence"]
        stale_claim = self.request(f"/v1/claims/{claim_id}")["claim"]
        self.assertEqual(stale_evidence["status"], "pending_validation")
        self.assertEqual(stale_claim["status"], "pending_validation")
        self.assertIn("claim_revalidation_required", [event["event_type"] for event in stale_claim["events"]])
        self.assertEqual(reextract["evidence_audit"]["invalid_reviewed_evidence_count"], 1)

    def test_merge_claims_archives_duplicates_and_moves_evidence_and_links(self) -> None:
        text = (
            "Canonical factor claim is supported by the primary source quote. "
            "Duplicate factor wording is supported by a second source quote."
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/merge-claims", "title": "Merge Claims", "site": "example"},
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "id": "canonical",
                        "text": "Factor claim should be treated as the canonical version.",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Canonical factor claim is supported by the primary source quote.",
                            }
                        ],
                    },
                    {
                        "id": "duplicate",
                        "text": "Duplicate factor wording says the same thing.",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Duplicate factor wording is supported by a second source quote.",
                            }
                        ],
                    },
                ],
                "risks": [{"text": "Duplicate claim risk should follow the canonical claim.", "claim_id": "duplicate"}],
                "tasks": [{"title": "Validate duplicate claim merge", "claim_id": "duplicate"}],
            },
            method="POST",
        )
        target_claim_id = records["claims"][0]["id"]
        duplicate_claim_id = records["claims"][1]["id"]
        topic = self.request(
            "/v1/topic-packages",
            {"title": "Merge Claims Topic", "claim_ids": [target_claim_id, duplicate_claim_id], "status": "reviewed"},
            method="POST",
        )["topic_package"]
        self.assertFalse(topic["stale"])

        merge = self.request(
            "/v1/claims/merge",
            {
                "target_claim_id": target_claim_id,
                "claim_ids": [target_claim_id, duplicate_claim_id],
                "reviewer": "unit-test",
                "review_note": "same claim, keep canonical wording",
                "reason": "duplicate claim",
            },
            method="POST",
        )
        self.assertEqual(merge["target_claim_id"], target_claim_id)
        self.assertEqual(merge["merged_claim_ids"], [duplicate_claim_id])
        self.assertEqual(merge["moved_evidence_count"], 1)
        self.assertEqual(merge["updated_related_counts"]["risks"], 1)
        self.assertEqual(merge["updated_related_counts"]["tasks"], 1)
        self.assertEqual(merge["target_claim"]["evidence_count"], 2)
        self.assertEqual(merge["target_claim"]["valid_evidence_count"], 2)
        self.assertEqual(merge["merged_claims"][0]["status"], "archived")
        self.assertEqual(merge["merged_claims"][0]["reviewer"], "unit-test")
        self.assertIn(target_claim_id, merge["merged_claims"][0]["rejection_reason"])

        evidence_claim_ids = [row["claim_id"] for row in self.db_rows("SELECT claim_id FROM evidence ORDER BY id")]
        self.assertEqual(evidence_claim_ids, [target_claim_id, target_claim_id])
        self.assertEqual(self.db_rows("SELECT claim_id FROM risks")[0]["claim_id"], target_claim_id)
        self.assertEqual(self.db_rows("SELECT claim_id FROM tasks")[0]["claim_id"], target_claim_id)
        stale_topic = self.request(f"/v1/topic-packages/{topic['id']}")["topic_package"]
        self.assertTrue(stale_topic["stale"])
        self.assertIn(duplicate_claim_id, stale_topic["stale_reason"])

    def test_split_claim_archives_source_clones_evidence_and_records_events(self) -> None:
        text = (
            "Broad factor claim mentions signal timing and risk control in one sentence. "
            "Signal timing is supported by the first source quote. "
            "Risk control is supported by the second source quote."
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/split-claim", "title": "Split Claim", "site": "example"},
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": "Broad factor claim bundles signal timing and risk control.",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Signal timing is supported by the first source quote.",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        source_claim_id = records["claims"][0]["id"]
        original_evidence_id = records["evidence"][0]["id"]
        topic = self.request(
            "/v1/topic-packages",
            {"title": "Split Claim Topic", "claim_ids": [source_claim_id], "status": "reviewed"},
            method="POST",
        )["topic_package"]
        self.assertFalse(topic["stale"])

        split = self.request(
            "/v1/claims/split",
            {
                "claim_id": source_claim_id,
                "splits": [
                    {"text": "Signal timing needs separate validation."},
                    {"text": "Risk control needs separate validation."},
                ],
                "reviewer": "unit-test",
                "review_note": "broad claim split into two narrower checks",
                "reason": "over-broad claim",
                "clone_evidence": True,
            },
            method="POST",
        )
        self.assertEqual(split["source_claim_id"], source_claim_id)
        self.assertEqual(len(split["split_claim_ids"]), 2)
        self.assertEqual(split["cloned_evidence_count"], 2)
        self.assertEqual(split["source_claim"]["status"], "archived")
        self.assertEqual(split["source_claim"]["reviewer"], "unit-test")
        self.assertIn("over-broad claim", split["source_claim"]["rejection_reason"])
        for child in split["split_claims"]:
            self.assertEqual(child["status"], "pending_validation")
            self.assertEqual(child["source_id"], source_id)
            self.assertEqual(child["evidence_count"], 1)
            self.assertEqual(child["valid_evidence_count"], 1)
            self.assertEqual(child["evidence"][0]["status"], "pending_validation")
            self.assertTrue(child["evidence"][0]["citation_valid"])
            self.assertIn(original_evidence_id, child["evidence"][0]["review_note"])

        evidence_claim_ids = [row["claim_id"] for row in self.db_rows("SELECT claim_id FROM evidence ORDER BY created_at, id")]
        self.assertEqual(evidence_claim_ids.count(source_claim_id), 1)
        for claim_id in split["split_claim_ids"]:
            self.assertEqual(evidence_claim_ids.count(claim_id), 1)

        event_rows = self.db_rows(
            """
            SELECT event_type, claim_id, related_claim_ids_json, metadata_json
            FROM claim_events
            WHERE claim_id IN (?, ?, ?)
            ORDER BY event_type, claim_id
            """,
            (source_claim_id, *split["split_claim_ids"]),
        )
        self.assertEqual([row["event_type"] for row in event_rows].count("split_source"), 1)
        self.assertEqual([row["event_type"] for row in event_rows].count("split_child"), 2)
        source_event = next(row for row in event_rows if row["event_type"] == "split_source")
        self.assertEqual(json.loads(source_event["related_claim_ids_json"]), split["split_claim_ids"])
        self.assertEqual(json.loads(source_event["metadata_json"])["cloned_evidence_count"], 2)

        stale_topic = self.request(f"/v1/topic-packages/{topic['id']}")["topic_package"]
        self.assertTrue(stale_topic["stale"])
        self.assertIn(source_claim_id, stale_topic["stale_reason"])

        doctor = self.request("/v1/vault/doctor")["doctor"]
        self.assertTrue(doctor["ok"])
        json_export = self.request("/v1/export?format=json")
        self.assertEqual(json_export["counts"]["claim_events"], 3)
        package = json.loads(json_export["content"])
        self.assertEqual(len(package["claim_events"]), 3)
        markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("### Claim Events", markdown_export["content"])
        self.assertIn("split_source", markdown_export["content"])

    def test_topic_package_groups_claims_evidence_and_exports_vault_page(self) -> None:
        primary_text = (
            "Factor rotation signal improves regime selection when multiple reviewed sources agree. "
            "Risk checks should confirm drawdown and liquidity before implementation."
        )
        counter_text = (
            "Factor rotation signal improves regime selection when multiple reviewed sources agree. "
            "Liquidity shocks can contradict the factor rotation signal in crowded markets."
        )
        first_capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/topic-a", "title": "Topic Source A", "site": "example"},
                "content": {"text": primary_text, "markdown": primary_text},
                "browser": {},
            },
            method="POST",
        )
        second_capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/topic-b", "title": "Topic Source B", "site": "example"},
                "content": {"text": counter_text, "markdown": counter_text},
                "browser": {},
            },
            method="POST",
        )
        first_source_id = first_capture["source"]["id"]
        second_source_id = second_capture["source"]["id"]
        first_chunk_id = first_capture["chunks"][0]["id"]
        second_chunk_id = second_capture["chunks"][0]["id"]

        first_records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": first_source_id,
                "claims": [
                    {
                        "text": "Factor rotation signal improves regime selection when multiple reviewed sources agree.",
                        "evidence": [
                            {
                                "source_id": first_source_id,
                                "chunk_id": first_chunk_id,
                                "quote": "Factor rotation signal improves regime selection when multiple reviewed sources agree.",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        second_records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": second_source_id,
                "claims": [
                    {
                        "text": "Factor rotation signal improves regime selection when multiple reviewed sources agree.",
                        "evidence": [
                            {
                                "source_id": second_source_id,
                                "chunk_id": second_chunk_id,
                                "quote": "Factor rotation signal improves regime selection when multiple reviewed sources agree.",
                            }
                        ],
                    },
                    {
                        "text": "Liquidity shocks can contradict the factor rotation signal in crowded markets.",
                        "evidence": [
                            {
                                "source_id": second_source_id,
                                "chunk_id": second_chunk_id,
                                "quote": "Liquidity shocks can contradict the factor rotation signal in crowded markets.",
                                "strength": "contradicting",
                            }
                        ],
                    },
                ],
            },
            method="POST",
        )
        claim_ids = [first_records["claims"][0]["id"], second_records["claims"][0]["id"], second_records["claims"][1]["id"]]
        for source_id in (first_source_id, second_source_id):
            self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
        for claim_id in claim_ids:
            self.request(f"/v1/claims/{claim_id}/review", {"status": "reviewed", "reviewer": "unit-test"}, method="POST")

        topic = self.request(
            "/v1/topic-packages",
            {
                "title": "Factor Rotation Evidence Package",
                "claim_ids": claim_ids,
                "canonical_claim_id": claim_ids[0],
            },
            method="POST",
        )["topic_package"]

        self.assertEqual(topic["canonical_claim_id"], claim_ids[0])
        self.assertEqual(topic["claim_ids"], claim_ids)
        self.assertEqual(topic["duplicate_claim_ids"], [claim_ids[1]])
        self.assertEqual(len(topic["supporting_evidence_ids"]), 2)
        self.assertEqual(len(topic["contradicting_evidence_ids"]), 1)
        self.assertEqual(topic["evidence_strength"], "conflicted")
        self.assertEqual(topic["review_status"], "needs_review")
        self.assertFalse(topic["stale"])
        self.assertTrue(Path(topic["markdown_path"]).exists())
        self.assertIn("## Contradicting Evidence", topic["markdown"])
        self.assertIn("Resolve 1 contradicting evidence", topic["markdown"])

        listing = self.request("/v1/topic-packages?limit=10")["topic_packages"]
        self.assertEqual([item["id"] for item in listing], [topic["id"]])
        detail = self.request(f"/v1/topic-packages/{topic['id']}")["topic_package"]
        self.assertIn("Factor Rotation Evidence Package", detail["markdown"])

        json_export = self.request("/v1/export?format=json")
        self.assertEqual(json_export["counts"]["topic_packages"], 1)
        package = json.loads(json_export["content"])
        self.assertEqual(package["topic_packages"][0]["id"], topic["id"])
        markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Topic Packages", markdown_export["content"])
        self.assertIn("Factor Rotation Evidence Package", markdown_export["content"])
        index_text = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Topics", index_text)
        self.assertIn("Factor Rotation Evidence Package", index_text)

    def test_deliverables_can_be_generated_from_reviewed_topic_package(self) -> None:
        text = (
            "Reviewed topic package claims should become final deliverables only when source, claim, "
            "and topic review gates all pass."
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/topic-deliverable", "title": "Topic Deliverable Source", "site": "example"},
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": "Reviewed topic package claims should become final deliverables only when source, claim, and topic review gates all pass.",
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": "Reviewed topic package claims should become final deliverables only when source, claim, and topic review gates all pass.",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        claim_id = records["claims"][0]["id"]
        self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
        self.request(f"/v1/claims/{claim_id}/review", {"status": "reviewed", "reviewer": "unit-test"}, method="POST")

        draft_topic = self.request(
            "/v1/topic-packages",
            {"title": "Draft Topic Package", "claim_ids": [claim_id]},
            method="POST",
        )["topic_package"]
        self.assertEqual(draft_topic["review_status"], "reviewed")
        with self.assertRaisesRegex(AssertionError, "Ready Gate"):
            self.request(
                "/v1/deliverables",
                {
                    "kind": "report",
                    "title": "Draft topic blocked",
                    "status": "final",
                    "topic_package_ids": [draft_topic["id"]],
                },
                method="POST",
            )

        topic = self.request(
            "/v1/topic-packages",
            {"title": "Reviewed Topic Package", "claim_ids": [claim_id], "status": "reviewed"},
            method="POST",
        )["topic_package"]
        self.assertEqual(topic["review_status"], "reviewed")
        self.assertEqual(topic["evidence_strength"], "medium")

        strict_strategy = {
            "hypothesis": "Reviewed topic claims can be converted into a long-shadow timing strategy only after costs, drawdown, and out-of-sample gates pass.",
            "input_data": [
                "Universe: tradable A-share equities with daily calendar membership snapshots.",
                "Frequency and fields: daily OHLCV fields including open, high, low, close, volume, and amount.",
                "Adjustment: corporate action adjusted prices with split, dividend, and suspension handling.",
                "Missing-data policy: missing or suspended bars are excluded and logged before signal calculation.",
                "Availability timing: all fields are point-in-time/as-of data available after market close with one-bar lag.",
            ],
            "signal": (
                "Logic/formula: count long upper shadows over a 20-day rolling window, rank recurrence by stock, "
                "and open short/underweight direction on the next daily rebalance; parameters are 20-day lookback "
                "and 70th percentile threshold; failure modes include crowded exits, drawdown spikes, and low liquidity."
            ),
            "backtest_window": "2018-01-01 to 2025-12-31, with 2024-2025 reserved as out-of-sample review.",
            "metrics": ["annualized return", "excess return", "max drawdown", "turnover", "capacity after costs"],
            "risk_checks": ["data leakage", "overfitting", "liquidity", "transaction costs", "regime dependence"],
            "implementation_steps": ["build point-in-time data loader", "implement signal fixture", "run cost-aware backtest"],
            "acceptance": ["positive out-of-sample excess return after costs", "max drawdown below 15%"],
        }
        deliverables = {}
        for kind in ("report", "ppt_outline", "video_script", "strategy_task_brief"):
            payload = {
                "kind": kind,
                "title": f"{kind} from topic",
                "status": "final",
                "topic_package_ids": [topic["id"]],
            }
            if kind == "strategy_task_brief":
                payload["strategy"] = strict_strategy
            deliverable = self.request(
                "/v1/deliverables",
                payload,
                method="POST",
            )["deliverable"]
            deliverables[kind] = deliverable
            self.assertEqual(deliverable["status"], "final")
            self.assertEqual(deliverable["unsupported_claims"], 0)
            self.assertTrue(deliverable["ready_gate"]["passed"])
            self.assertEqual(deliverable["ready_gate"]["topic_package_count"], 1)
            self.assertEqual(deliverable["source_ids"], [source_id])
            self.assertEqual(deliverable["input"]["topic_package_ids"], [topic["id"]])
            self.assertIn("## 专题包", deliverable["markdown"])
            self.assertIn(topic["id"], deliverable["markdown"])
            self.assertIn(f"source:{source_id}", deliverable["markdown"])
            self.assertIn(f"chunk:{chunk_id}", deliverable["markdown"])
            self.assertIn("## Evidence Appendix", deliverable["markdown"])
            self.assertIn(f"- Source id: `{source_id}`", deliverable["markdown"])
            self.assertIn(f"- Chunk id: `{chunk_id}`", deliverable["markdown"])
            self.assertIn("Reviewed topic package claims should become final deliverables only when source, claim, and topic review gates all pass.", deliverable["markdown"])
            self.assertIn("ready_gate_passed: true", deliverable["markdown"])

        stale_source = self.request(f"/v1/sources/{source_id}/status", {"status": "rejected"}, method="POST")["source"]
        self.assertEqual(stale_source["status"], "rejected")
        stale_topic = self.request(f"/v1/topic-packages/{topic['id']}")["topic_package"]
        self.assertTrue(stale_topic["stale"])
        self.assertIn(source_id, stale_topic["stale_reason"])
        self.assertIn("## Stale Topic Notice", stale_topic["markdown"])
        stale_deliverable = self.request(f"/v1/deliverables/{deliverables['report']['id']}")["deliverable"]
        self.assertTrue(stale_deliverable["stale"])
        self.assertIn("## Stale Deliverable Notice", stale_deliverable["markdown"])
        with self.assertRaisesRegex(AssertionError, "Ready Gate"):
            self.request(
                "/v1/deliverables",
                {
                    "kind": "report",
                    "title": "Stale topic blocked",
                    "status": "final",
                    "topic_package_ids": [topic["id"]],
                },
                method="POST",
            )
        with self.assertRaisesRegex(AssertionError, "non-stale"):
            self.request(
                "/v1/strategy-handoffs",
                {"deliverable_id": deliverables["strategy_task_brief"]["id"]},
                method="POST",
            )
        dashboard = self.request("/v1/projects/default/dashboard")["dashboard"]
        self.assertGreaterEqual(dashboard["metrics"]["stale_topic_package_count"], 1)
        self.assertGreaterEqual(dashboard["metrics"]["stale_deliverable_count"], 4)
        deliver_stage = next(stage for stage in dashboard["stages"] if stage["id"] == "deliver")
        self.assertEqual(deliver_stage["status"], "in_progress")
        self.assertIn("stale", "\n".join(deliver_stage["blockers"]))

    def test_final_strategy_task_brief_requires_specific_strategy_fields(self) -> None:
        text = "Final strategy briefs require a concrete data contract, signal rule, risk gate, and acceptance plan."
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/strict-strategy", "title": "Strict Strategy Source", "site": "example"},
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": text,
                        "evidence": [{"source_id": source_id, "chunk_id": chunk_id, "quote": text}],
                    }
                ],
            },
            method="POST",
        )
        claim_id = records["claims"][0]["id"]
        self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
        self.request(f"/v1/claims/{claim_id}/review", {"status": "reviewed", "reviewer": "unit-test"}, method="POST")
        topic = self.request(
            "/v1/topic-packages",
            {"title": "Strict Strategy Topic", "claim_ids": [claim_id], "status": "reviewed"},
            method="POST",
        )["topic_package"]

        draft = self.request(
            "/v1/deliverables",
            {
                "kind": "strategy_task_brief",
                "title": "Vague Strategy Draft",
                "status": "draft",
                "topic_package_ids": [topic["id"]],
                "strategy": {"hypothesis": "待定义策略假设。", "signal": "待定义信号。"},
            },
            method="POST",
        )["deliverable"]
        issue_codes = {issue["code"] for issue in draft["ready_gate"]["issues"]}
        self.assertIn("strategy_brief_incomplete", issue_codes)
        self.assertIn("strategy_brief_weak_data_contract", issue_codes)
        self.assertIn("strategy_brief_weak_signal", issue_codes)
        self.assertFalse(draft["ready_gate"]["can_finalize"])
        self.assertGreaterEqual(draft["ready_gate"]["non_waivable_issue_count"], 1)
        self.assertIn("Non-waivable issues:", draft["markdown"])

        with self.assertRaisesRegex(AssertionError, "Ready Gate"):
            self.request(
                "/v1/deliverables",
                {
                    "kind": "strategy_task_brief",
                    "title": "Risk Accepted But Vague Strategy",
                    "status": "final",
                    "topic_package_ids": [topic["id"]],
                    "manual_risk_acceptance": {"reason": "I accept the research risk", "reviewer": "unit-test"},
                    "strategy": {"hypothesis": "TBD", "signal": "TBD"},
                },
                method="POST",
            )

    def test_strategy_handoff_requires_final_strategy_brief_and_exports_traceability(self) -> None:
        text = (
            "A long shadow factor should be backtested with explicit data contracts, signal rules, "
            "cost assumptions, drawdown checks, and out-of-sample acceptance criteria."
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": "https://example.com/strategy-handoff", "title": "Strategy Handoff Source", "site": "example"},
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        records = self.request(
            "/v1/knowledge/records",
            {
                "source_id": source_id,
                "claims": [
                    {
                        "text": text,
                        "evidence": [
                            {
                                "source_id": source_id,
                                "chunk_id": chunk_id,
                                "quote": text,
                                "strength": "supporting",
                            }
                        ],
                    }
                ],
            },
            method="POST",
        )
        claim_id = records["claims"][0]["id"]
        evidence_id = records["evidence"][0]["id"]
        self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
        self.request(f"/v1/claims/{claim_id}/review", {"status": "reviewed", "reviewer": "unit-test"}, method="POST")
        topic = self.request(
            "/v1/topic-packages",
            {"title": "Long Shadow Strategy Topic", "claim_ids": [claim_id], "status": "reviewed"},
            method="POST",
        )["topic_package"]

        draft = self.request(
            "/v1/deliverables",
            {
                "kind": "strategy_task_brief",
                "title": "Draft Strategy Brief",
                "status": "draft",
                "topic_package_ids": [topic["id"]],
            },
            method="POST",
        )["deliverable"]
        with self.assertRaisesRegex(AssertionError, "final strategy_task_brief"):
            self.request("/v1/strategy-handoffs", {"deliverable_id": draft["id"]}, method="POST")

        strategy = {
            "hypothesis": "Long shadow patterns can identify crowded exits when costs and drawdown gates stay acceptable.",
            "input_data": [
                "Universe: tradable A-share equities from a point-in-time membership file.",
                "Frequency and fields: daily OHLCV fields, close price, amount, and volume.",
                "Adjustment: adjusted prices handle corporate action, split, and dividend events.",
                "Missing-data policy: missing bars, NaN values, and suspended sessions are excluded before ranking.",
                "Availability timing: all fields are point-in-time/as-of data available after market close with one daily lag.",
            ],
            "signal": (
                "Logic/formula: count long upper shadows over a 20-day rolling window, rank by recurrence score, "
                "and sell/underweight the negative direction names on weekly rebalance; parameters are 20-day window "
                "and 70th percentile threshold; failure modes include crowded exits, max drawdown spikes, and low liquidity."
            ),
            "backtest_window": "2018-01-01 to 2025-12-31 with 2024-2025 out-of-sample review.",
            "metrics": ["annualized return", "max drawdown", "turnover", "capacity", "hit rate"],
            "risk_checks": ["data leakage", "transaction costs", "liquidity", "regime dependence"],
            "implementation_steps": ["load point-in-time universe", "implement signal fixtures", "run cost-aware backtest"],
            "acceptance": ["Positive out-of-sample excess return after costs", "Max drawdown below 15%"],
        }
        deliverable = self.request(
            "/v1/deliverables",
            {
                "kind": "strategy_task_brief",
                "title": "Long Shadow Strategy Brief",
                "status": "final",
                "topic_package_ids": [topic["id"]],
                "strategy": strategy,
            },
            method="POST",
        )["deliverable"]
        handoff = self.request(
            "/v1/strategy-handoffs",
            {
                "deliverable_id": deliverable["id"],
                "workspace_path": "/tmp/example-strategy-workspace",
            },
            method="POST",
        )["strategy_handoff"]

        self.assertEqual(handoff["deliverable_id"], deliverable["id"])
        self.assertEqual(handoff["status"], "drafted")
        self.assertEqual(handoff["topic_package_ids"], [topic["id"]])
        self.assertEqual(handoff["claim_ids"], [claim_id])
        self.assertEqual(handoff["evidence_ids"], [evidence_id])
        self.assertTrue(Path(handoff["markdown_path"]).exists())
        self.assertIn("## Data Contract", handoff["markdown"])
        self.assertIn("## Backtest Plan", handoff["markdown"])
        self.assertIn("## Implementation Tickets", handoff["markdown"])
        self.assertIn("## Review Checklist", handoff["markdown"])
        self.assertIn("## Acceptance Criteria", handoff["markdown"])
        self.assertIn(f"`{topic['id']}`", handoff["markdown"])
        self.assertIn(f"`{claim_id}`", handoff["markdown"])
        self.assertIn(f"`{evidence_id}`", handoff["markdown"])
        self.assertIn(f"- Source id: `{source_id}`", handoff["markdown"])
        self.assertIn(f"- Chunk id: `{chunk_id}`", handoff["markdown"])

        listed = self.request("/v1/strategy-handoffs")["strategy_handoffs"]
        self.assertEqual(listed[0]["id"], handoff["id"])
        detail = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertIn("Long Shadow Strategy Brief Handoff", detail["title"])
        retry_handoff = self.request(
            "/v1/strategy-handoffs",
            {"deliverable_id": deliverable["id"]},
            method="POST",
        )["strategy_handoff"]
        self.assertEqual(retry_handoff["id"], handoff["id"])

        json_export = self.request("/v1/export?format=json")
        self.assertEqual(json_export["counts"]["strategy_handoffs"], 1)
        package = json.loads(json_export["content"])
        self.assertEqual(package["strategy_handoffs"][0]["id"], handoff["id"])
        markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Strategy Handoffs", markdown_export["content"])
        self.assertIn("Long Shadow Strategy Brief Handoff", markdown_export["content"])
        index_text = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Strategy Handoffs", index_text)
        self.assertIn("Long Shadow Strategy Brief Handoff", index_text)

        tickets = self.request(
            "/v1/strategy-tickets",
            {"handoff_id": handoff["id"], "owner": "engineer-a"},
            method="POST",
        )["strategy_tickets"]
        self.assertEqual(len(tickets), 6)
        self.assertEqual(
            {ticket["kind"] for ticket in tickets},
            {"data_ingestion", "signal_code", "portfolio_backtest", "risk_controls", "backtest_report", "monitoring"},
        )
        self.assertTrue(all(ticket["claim_ids"] == [claim_id] for ticket in tickets))
        self.assertTrue(all(evidence_id in ticket["evidence_ids"] for ticket in tickets))
        self.assertTrue(all(Path(ticket["markdown_path"]).exists() for ticket in tickets))
        self.assertIn("## Acceptance Criteria", tickets[0]["markdown"])
        self.assertIn("engineer-a", tickets[0]["owner"])
        implementing_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(implementing_handoff["status"], "implementing")

        listed_tickets = self.request("/v1/strategy-tickets")["strategy_tickets"]
        self.assertEqual(len(listed_tickets), 6)
        ticket_detail = self.request(f"/v1/strategy-tickets/{tickets[0]['id']}")["strategy_ticket"]
        self.assertIn("Data ingestion", ticket_detail["markdown"])
        ticket_export = self.request("/v1/export?format=json")
        self.assertEqual(ticket_export["counts"]["strategy_tickets"], 6)
        ticket_package = json.loads(ticket_export["content"])
        self.assertEqual(len(ticket_package["strategy_tickets"]), 6)
        ticket_markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Strategy Tickets", ticket_markdown_export["content"])
        ticket_index = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Strategy Tickets", ticket_index)
        self.assertIn(tickets[0]["id"], ticket_index)

        retry_tickets = self.request(
            "/v1/strategy-tickets",
            {"handoff_id": handoff["id"], "owner": "engineer-a"},
            method="POST",
        )["strategy_tickets"]
        self.assertEqual({ticket["id"] for ticket in retry_tickets}, {ticket["id"] for ticket in tickets})
        self.assertEqual(self.request("/v1/export?format=json")["counts"]["strategy_tickets"], 6)

        with self.assertRaisesRegex(AssertionError, "strategy ticket status"):
            self.request(
                "/v1/strategy-tickets",
                {
                    "handoff_id": handoff["id"],
                    "tickets": [
                        {
                            "kind": "manual_review",
                            "title": "Manual review",
                            "objective": "Run an implementation review before coding.",
                            "status": "todo",
                        }
                    ],
                },
                method="POST",
            )
        with self.assertRaisesRegex(AssertionError, "kind must be unique"):
            self.request(
                "/v1/strategy-tickets",
                {
                    "handoff_id": handoff["id"],
                    "tickets": [
                        {"kind": "manual_review", "objective": "Review one implementation path."},
                        {"kind": "manual_review", "objective": "Review another implementation path."},
                    ],
                },
                method="POST",
            )

        progress_ticket = self.request(
            f"/v1/strategy-tickets/{tickets[0]['id']}/status",
            {"status": "in-progress", "owner": "engineer-b"},
            method="POST",
        )["strategy_ticket"]
        self.assertEqual(progress_ticket["status"], "in-progress")
        self.assertEqual(progress_ticket["owner"], "engineer-b")
        self.assertIn("status: in-progress", progress_ticket["markdown"])
        self.assertIn('owner: "engineer-b"', progress_ticket["markdown"])
        still_implementing = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(still_implementing["status"], "implementing")

        for ticket in tickets:
            updated_ticket = self.request(
                f"/v1/strategy-tickets/{ticket['id']}/status",
                {"status": "done"},
                method="POST",
            )["strategy_ticket"]
            self.assertEqual(updated_ticket["status"], "done")
        done_ticket = self.request(f"/v1/strategy-tickets/{tickets[0]['id']}")["strategy_ticket"]
        self.assertIn("status: done", done_ticket["markdown"])
        implemented_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(implemented_handoff["status"], "implemented")
        post_done_retry_tickets = self.request(
            "/v1/strategy-tickets",
            {"handoff_id": handoff["id"], "owner": "engineer-a"},
            method="POST",
        )["strategy_tickets"]
        self.assertEqual({ticket["id"] for ticket in post_done_retry_tickets}, {ticket["id"] for ticket in tickets})
        self.assertEqual(self.request("/v1/export?format=json")["counts"]["strategy_tickets"], 6)
        implemented_after_retry = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(implemented_after_retry["status"], "implemented")

        with self.assertRaisesRegex(AssertionError, "paper/live-ready backtest result requires"):
            self.request(
                "/v1/backtest-results",
                {
                    "handoff_id": handoff["id"],
                    "outcome": "supported",
                    "status": "paper-ready",
                    "period": "2018-2025",
                    "universe": "A-share daily tradable universe",
                    "metrics": {"annualized_return": "12%"},
                },
                method="POST",
            )

        backtest = self.request(
            "/v1/backtest-results",
            {
                "handoff_id": handoff["id"],
                "outcome": "falsified",
                "status": "reviewed",
                "period": "2018-01-01 to 2025-12-31",
                "universe": "A-share daily tradable universe",
                "benchmark": "CSI 300",
                "metrics": {"annualized_return": "-3.2%", "max_drawdown": "-22%", "excess_return": "-6.1%"},
                "costs": {"commission_bps": 3, "slippage_bps": 8},
                "slippage": "8 bps per trade",
                "max_drawdown": "-22%",
                "turnover": "9.5x annualized",
                "capacity": "Too low after liquidity filter",
                "artifacts": [{"kind": "notebook", "path": "/tmp/long-shadow-backtest.ipynb", "title": "Backtest notebook"}],
                "failure_notes": "Out-of-sample return is negative after costs and drawdown exceeds acceptance.",
            },
            method="POST",
        )["backtest_result"]

        self.assertEqual(backtest["handoff_id"], handoff["id"])
        self.assertEqual(backtest["outcome"], "falsified")
        self.assertEqual(backtest["status"], "reviewed")
        self.assertEqual(backtest["claim_ids"], [claim_id])
        self.assertTrue(backtest["risk_ids"])
        self.assertTrue(Path(backtest["markdown_path"]).exists())
        self.assertIn("## Metrics", backtest["markdown"])
        self.assertIn("## Knowledge Links", backtest["markdown"])
        self.assertIn("Out-of-sample return is negative", backtest["markdown"])
        refreshed_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(refreshed_handoff["status"], "rejected")

        knowledge_after_backtest = self.request("/v1/knowledge/records?limit=50")
        self.assertTrue(any(risk["id"] in backtest["risk_ids"] for risk in knowledge_after_backtest["risks"]))
        self.assertTrue(any("Backtest falsified" in risk["text"] for risk in knowledge_after_backtest["risks"]))

        listed_backtests = self.request("/v1/backtest-results")["backtest_results"]
        self.assertEqual(listed_backtests[0]["id"], backtest["id"])
        detail_backtest = self.request(f"/v1/backtest-results/{backtest['id']}")["backtest_result"]
        self.assertIn("Backtest notebook", detail_backtest["markdown"])

        json_export = self.request("/v1/export?format=json")
        self.assertEqual(json_export["counts"]["backtest_results"], 1)
        self.assertEqual(json_export["counts"]["strategy_tickets"], 6)
        package = json.loads(json_export["content"])
        self.assertEqual(package["backtest_results"][0]["id"], backtest["id"])
        markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Backtest Results", markdown_export["content"])
        self.assertIn(backtest["id"], markdown_export["content"])
        index_text = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Backtest Results", index_text)
        self.assertIn(backtest["id"], index_text)

        ready_payload = {
            "handoff_id": handoff["id"],
            "outcome": "supported",
            "status": "paper-ready",
            "period": "2018-01-01 to 2025-12-31 with 2024-2025 out-of-sample",
            "universe": "A-share daily tradable universe",
            "benchmark": "CSI 300",
            "metrics": {"annualized_return": "12.4%", "out_of_sample_return": "5.1%", "max_drawdown": "-9%"},
            "costs": {"commission_bps": 3, "slippage_bps": 8},
            "slippage": "8 bps per trade",
            "max_drawdown": "-9%",
            "turnover": "2.2x annualized",
            "capacity": "Passes liquidity filter for target capital",
            "artifacts": [{"kind": "report", "path": "/tmp/supported-backtest.md", "title": "Supported backtest report"}],
        }
        with self.assertRaisesRegex(AssertionError, "requires a passed strategy review"):
            self.request("/v1/backtest-results", ready_payload, method="POST")

        supported_backtest = self.request(
            "/v1/backtest-results",
            {**ready_payload, "status": "reviewed"},
            method="POST",
        )["backtest_result"]
        self.assertEqual(supported_backtest["status"], "reviewed")

        passing_paper_checklist = {
            "data_leakage": {"passed": True, "note": "Point-in-time data and one-bar lag checked."},
            "out_of_sample_result": {"passed": True, "note": "2024-2025 out-of-sample return remains positive after costs."},
            "costs_included": True,
            "drawdown_bounded": True,
            "turnover_feasible": True,
            "liquidity_capacity_checked": True,
        }
        needs_review = self.request(
            "/v1/strategy-reviews",
            {
                "backtest_result_id": supported_backtest["id"],
                "gate": "paper-ready",
                "reviewer": "unit-test",
                "status": "needs-review",
                "checklist": passing_paper_checklist,
            },
            method="POST",
        )["strategy_review"]
        self.assertEqual(needs_review["status"], "needs-review")
        pre_paper_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(pre_paper_handoff["status"], "backtested")

        explicit_failed = self.request(
            "/v1/strategy-reviews",
            {
                "backtest_result_id": supported_backtest["id"],
                "gate": "paper-ready",
                "reviewer": "unit-test",
                "status": "failed",
                "checklist": passing_paper_checklist,
            },
            method="POST",
        )["strategy_review"]
        self.assertEqual(explicit_failed["status"], "failed")
        still_pre_paper_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(still_pre_paper_handoff["status"], "backtested")

        paper_review = self.request(
            "/v1/strategy-reviews",
            {
                "backtest_result_id": supported_backtest["id"],
                "gate": "paper-ready",
                "reviewer": "unit-test",
                "note": "Paper-ready checklist reviewed from backtest report.",
                "checklist": passing_paper_checklist,
                "artifacts": [{"kind": "memo", "path": "/tmp/paper-ready-review.md", "title": "Paper review memo"}],
            },
            method="POST",
        )["strategy_review"]
        self.assertEqual(paper_review["status"], "passed")
        self.assertEqual(paper_review["gate"], "paper-ready")
        self.assertFalse(paper_review["issues"])
        self.assertIn("paper-ready checklist", paper_review["markdown"].lower())
        paper_backtest = self.request(f"/v1/backtest-results/{supported_backtest['id']}")["backtest_result"]
        self.assertEqual(paper_backtest["status"], "paper-ready")
        paper_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(paper_handoff["status"], "paper-ready")

        failed_live_review = self.request(
            "/v1/strategy-reviews",
            {
                "backtest_result_id": supported_backtest["id"],
                "gate": "live-ready",
                "reviewer": "unit-test",
                "checklist": {
                    "monitoring_plan": True,
                    "kill_switch": True,
                    "max_exposure": True,
                    "operational_failure_plan": True,
                    "manual_reviewer_approval": True,
                },
            },
            method="POST",
        )["strategy_review"]
        self.assertEqual(failed_live_review["status"], "failed")
        self.assertTrue(any(issue["item"] == "paper_trading_record" for issue in failed_live_review["issues"]))
        not_live_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(not_live_handoff["status"], "paper-ready")

        live_review = self.request(
            "/v1/strategy-reviews",
            {
                "backtest_result_id": supported_backtest["id"],
                "gate": "live-ready",
                "reviewer": "unit-test",
                "checklist": {
                    "paper_trading_record": {"passed": True, "note": "30-session paper record attached."},
                    "monitoring_plan": True,
                    "kill_switch": True,
                    "max_exposure": True,
                    "operational_failure_plan": True,
                    "manual_reviewer_approval": True,
                },
                "artifacts": [{"kind": "paper-trading-report", "path": "/tmp/paper-trading.md", "title": "Paper trading report"}],
            },
            method="POST",
        )["strategy_review"]
        self.assertEqual(live_review["status"], "passed")
        live_handoff = self.request(f"/v1/strategy-handoffs/{handoff['id']}")["strategy_handoff"]
        self.assertEqual(live_handoff["status"], "live-ready")
        live_backtest = self.request(f"/v1/backtest-results/{supported_backtest['id']}")["backtest_result"]
        self.assertEqual(live_backtest["status"], "live-ready")

        reviews = self.request("/v1/strategy-reviews")["strategy_reviews"]
        self.assertEqual(len(reviews), 5)
        review_detail = self.request(f"/v1/strategy-reviews/{paper_review['id']}")["strategy_review"]
        self.assertIn("Paper review memo", review_detail["markdown"])
        review_export = self.request("/v1/export?format=json")
        self.assertEqual(review_export["counts"]["strategy_reviews"], 5)
        self.assertEqual(review_export["counts"]["strategy_tickets"], 6)
        review_package = json.loads(review_export["content"])
        self.assertEqual(len(review_package["strategy_reviews"]), 5)
        review_markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Strategy Reviews", review_markdown_export["content"])
        review_index = (self.data_dir / "vault" / "index.md").read_text(encoding="utf-8")
        self.assertIn("## Strategy Reviews", review_index)
        self.assertIn(live_review["id"], review_index)

        lineage = self.request(
            "/v1/lineage/rebuild",
            {"project_id": "default"},
            method="POST",
        )["lineage"]
        self.assertGreater(lineage["edge_count"], 0)
        lineage_response = self.request("/v1/lineage?project_id=default&limit=5000")
        self.assertEqual(lineage_response["summary"]["edge_count"], lineage["edge_count"])
        edge_pairs = {
            (
                edge["upstream_type"],
                edge["upstream_id"],
                edge["downstream_type"],
                edge["downstream_id"],
                edge["relation"],
            )
            for edge in lineage_response["lineage_edges"]
        }
        self.assertIn(("source", source_id, "document", capture["document_id"], "has_document"), edge_pairs)
        self.assertIn(("document", capture["document_id"], "chunk", chunk_id, "has_chunk"), edge_pairs)
        self.assertIn(("source", source_id, "claim", claim_id, "claims_from_source"), edge_pairs)
        self.assertIn(("chunk", chunk_id, "evidence", evidence_id, "evidence_from_chunk"), edge_pairs)
        self.assertIn(("evidence", evidence_id, "claim", claim_id, "supporting"), edge_pairs)
        self.assertIn(("claim", claim_id, "topic_package", topic["id"], "included_claim"), edge_pairs)
        self.assertIn(("topic_package", topic["id"], "deliverable", deliverable["id"], "deliverable_topic"), edge_pairs)
        self.assertIn(("deliverable", deliverable["id"], "strategy_handoff", handoff["id"], "handoff_from_deliverable"), edge_pairs)
        self.assertIn(("strategy_handoff", handoff["id"], "strategy_ticket", tickets[0]["id"], "ticket_from_handoff"), edge_pairs)
        self.assertIn(("strategy_handoff", handoff["id"], "backtest_result", supported_backtest["id"], "backtest_from_handoff"), edge_pairs)
        self.assertIn(("backtest_result", supported_backtest["id"], "strategy_review", paper_review["id"], "review_backtest"), edge_pairs)

        lineage_export = self.request("/v1/export?format=json")
        self.assertEqual(lineage_export["counts"]["lineage_edges"], lineage["edge_count"])
        lineage_package = json.loads(lineage_export["content"])
        self.assertEqual(lineage_package["lineage_summary"]["edge_count"], lineage["edge_count"])
        lineage_markdown_export = self.request("/v1/export?format=markdown")
        self.assertIn("## Lineage", lineage_markdown_export["content"])
        self.assertIn("handoff_from_deliverable", lineage_markdown_export["content"])

    def test_mock_extract_knowledge_from_source_records_agent_run(self) -> None:
        text = "\n\n".join(
            [
                "# Mock Extractor Source",
                "Factor rotation strategy claims should cite source chunks before they become durable conclusions.",
                "Backtest tasks must define input data, metrics, risk checks, and validation windows.",
                "A drawdown risk appears when the signal is overfit to one market regime.",
            ]
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/mock-extractor",
                    "title": "Mock Extractor Source",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]

        with mock.patch.object(self.store, "provider_extract_structured_payload") as provider_extract:
            result = self.request(
                f"/v1/sources/{source_id}/extract-knowledge",
                {"mode": "auto", "max_claims": 3},
                method="POST",
            )
            provider_extract.assert_not_called()
        self.assertEqual(result["agent_run"]["agent_id"], "mock_structured_extractor")
        self.assertEqual(result["agent_run"]["status"], "success")
        self.assertEqual(result["source"]["status"], "extracted")
        self.assertEqual(self.request(f"/v1/sources/{source_id}")["source"]["status"], "extracted")
        records = result["records"]
        self.assertGreaterEqual(len(records["claims"]), 2)
        self.assertTrue(all(claim["status"] == "extracted" for claim in records["claims"]))
        self.assertEqual(len(records["evidence"]), len(records["claims"]))
        self.assertTrue(records["entities"])
        self.assertTrue(records["tasks"])
        self.assertTrue(records["strategy_ideas"])
        self.assertTrue(records["risks"])

        needs_review_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/mock-extractor-low",
                    "title": "Mock Extractor Low Quality Source",
                    "site": "example",
                },
                "content": {
                    "text": "tiny",
                    "markdown": "tiny",
                    "stats": {"lowText": True},
                },
                "browser": {},
            },
            method="POST",
        )
        needs_review_source_id = needs_review_capture["source"]["id"]
        self.assertEqual(needs_review_capture["source"]["status"], "needs_review")
        needs_review_result = self.request(
            f"/v1/sources/{needs_review_source_id}/extract-knowledge",
            {"mode": "mock", "max_claims": 1},
            method="POST",
        )
        self.assertEqual(needs_review_result["source"]["status"], "needs_review")
        self.assertEqual(self.request(f"/v1/sources/{needs_review_source_id}")["source"]["status"], "needs_review")

        agent_runs = self.db_rows("SELECT * FROM agent_runs")
        self.assertEqual(len(agent_runs), 2)
        self.assertEqual(agent_runs[0]["model"], "mock-structured-v1")
        self.assertIn("mock-structured-v1", agent_runs[0]["input_json"])
        mock_run_input = json.loads(agent_runs[0]["input_json"])
        self.assertEqual(mock_run_input["mode"], "auto")
        self.assertEqual(mock_run_input["effective_mode"], "mock")
        self.assertEqual(mock_run_input["provider"], "mock")
        self.assertEqual(mock_run_input["schema_version"], "structured-knowledge-v1")
        self.assertEqual(mock_run_input["prompt_version"], "mock-structured-v1")
        self.assertGreater(mock_run_input["estimated_tokens"], 0)
        self.assertEqual(mock_run_input["actual_total_tokens"], 0)
        self.assertEqual(mock_run_input["estimated_cost_usd"], 0)
        self.assertEqual(mock_run_input["cost_source"], "mock")
        self.assertGreaterEqual(len(self.db_rows("SELECT * FROM claims")), len(records["claims"]))
        self.assertEqual(len(self.db_rows("SELECT * FROM evidence")), len(records["claims"]))

        listing = self.request("/v1/knowledge/records?limit=20")
        self.assertGreaterEqual(len(listing["claims"]), 2)
        export = self.request("/v1/export?format=json")
        package = json.loads(export["content"])
        self.assertGreaterEqual(len(package["knowledge"]["claims"]), 2)
        self.assertEqual(export["counts"]["claims"], len(package["knowledge"]["claims"]))

    def test_provider_extract_knowledge_records_valid_citations_and_repairs_json(self) -> None:
        text = "\n\n".join(
            [
                "# Provider Extractor Source",
                "Provider extraction claim says factor rotation strategy must cite exact source chunks before durable use.",
                "Risk controls should check drawdown before any live strategy task is accepted.",
            ]
        )
        capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/provider-extractor",
                    "title": "Provider Extractor Source",
                    "site": "example",
                },
                "content": {"text": text, "markdown": text},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        chunk_id = capture["chunks"][0]["id"]
        other_capture = self.request(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/provider-other-source",
                    "title": "Provider Other Source",
                    "site": "example",
                },
                "content": {
                    "text": "Other source quote that should not be accepted by a single-source provider extraction.",
                    "markdown": "Other source quote that should not be accepted by a single-source provider extraction.",
                },
                "browser": {},
            },
            method="POST",
        )
        other_source_id = other_capture["source"]["id"]
        other_chunk_id = other_capture["chunks"][0]["id"]
        captured: dict = {"payloads": []}

        class FakeModelHandler(server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("content-length") or "0")
                body = self.rfile.read(length)
                captured["path"] = self.path
                captured["authorization"] = self.headers.get("authorization")
                payload = json.loads(body.decode("utf-8"))
                captured["payloads"].append(payload)
                if len(captured["payloads"]) == 1:
                    content = "not valid json"
                    usage = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
                else:
                    content = json.dumps(
                        {
                            "entities": [
                                {"name": "Factor rotation strategy", "kind": "strategy", "description": "Provider extracted entity."}
                            ],
                            "claims": [
                                {
                                    "id": "provider-claim-1",
                                    "text": "Factor rotation strategy must cite exact source chunks before durable use.",
                                    "confidence": 0.82,
                                    "reasoning_chain": "exact quote -> claim -> reviewable knowledge",
                                    "evidence": [
                                        {
                                            "source_id": source_id,
                                            "chunk_id": chunk_id,
                                            "quote": "factor rotation strategy must cite exact source chunks",
                                            "url": "https://example.com/provider-extractor",
                                        }
                                    ],
                                },
                                {
                                    "id": "provider-bad-claim",
                                    "text": "A source-only provider citation must stay pending.",
                                    "confidence": 0.4,
                                    "evidence": [{"source_id": source_id}],
                                },
                                {
                                    "id": "provider-fake-quote",
                                    "text": "A provider fake quote must stay pending.",
                                    "confidence": 0.3,
                                    "evidence": [
                                        {
                                            "source_id": source_id,
                                            "chunk_id": chunk_id,
                                            "quote": "this exact quote is not present in the source chunk",
                                        }
                                    ],
                                },
                                {
                                    "id": "provider-cross-source",
                                    "text": "A provider cross-source chunk citation must stay pending.",
                                    "confidence": 0.3,
                                    "evidence": [
                                        {
                                            "source_id": other_source_id,
                                            "chunk_id": other_chunk_id,
                                            "quote": "Other source quote that should not be accepted",
                                        }
                                    ],
                                },
                                {
                                    "id": "provider-missing-evidence",
                                    "text": "A provider claim with no evidence must stay pending.",
                                    "confidence": 0.2,
                                },
                                {
                                    "id": "provider-over-limit-one",
                                    "text": "This over-limit provider claim must be ignored.",
                                    "confidence": 0.9,
                                    "evidence": [
                                        {
                                            "source_id": source_id,
                                            "chunk_id": chunk_id,
                                            "quote": "Risk controls should check drawdown",
                                        }
                                    ],
                                },
                                {
                                    "id": "provider-over-limit-two",
                                    "text": "This second over-limit provider claim must be ignored.",
                                    "confidence": 0.9,
                                },
                            ],
                            "relations": [
                                {
                                    "subject": "Factor rotation strategy",
                                    "predicate": "requires",
                                    "object": "exact source chunks",
                                    "claim_id": "provider-claim-1",
                                }
                            ],
                            "risks": [{"text": "Drawdown checks are required before live use.", "severity": "medium", "claim_id": "provider-claim-1"}],
                            "strategy_ideas": [
                                {
                                    "title": "Provider factor rotation validation",
                                    "thesis": "Promote only exact-quote claims into strategy experiments.",
                                    "claim_id": "provider-claim-1",
                                }
                            ],
                            "tasks": [
                                {
                                    "title": "Validate provider extracted claim",
                                    "acceptance": "The accepted claim keeps source_id, chunk_id, and exact quote evidence.",
                                    "claim_id": "provider-claim-1",
                                }
                            ],
                        },
                        ensure_ascii=False,
                    )
                    usage = {"prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40}
                response = json.dumps({"choices": [{"message": {"content": content}}], "usage": usage}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, fmt: str, *args: object) -> None:
                return None

        model_httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
        model_port = model_httpd.server_address[1]
        model_thread = threading.Thread(target=model_httpd.serve_forever, daemon=True)
        model_thread.start()
        try:
            self.request(
                "/v1/model-settings",
                {
                    "provider": "openai",
                    "base_url": f"http://127.0.0.1:{model_port}/v1",
                    "api_key": "test-provider-extract-key",
                    "model": "fake-structured-model",
                    "temperature": 0.0,
                    "input_cost_per_1m": 1.0,
                    "output_cost_per_1m": 2.0,
                },
                method="POST",
            )
            result = self.request(
                f"/v1/sources/{source_id}/extract-knowledge",
                {"mode": "provider", "max_claims": 5},
                method="POST",
            )
        finally:
            model_httpd.shutdown()
            model_httpd.server_close()
            model_thread.join(timeout=5)

        self.assertEqual(captured["path"], "/v1/chat/completions")
        self.assertEqual(captured["authorization"], "Bearer test-provider-extract-key")
        self.assertEqual(len(captured["payloads"]), 2)
        self.assertEqual(captured["payloads"][0]["model"], "fake-structured-model")
        self.assertIn("Provider Extractor Source", captured["payloads"][0]["messages"][-1]["content"])
        self.assertEqual(result["agent_run"]["agent_id"], "provider_structured_extractor")
        self.assertEqual(result["agent_run"]["model"], "fake-structured-model")
        self.assertTrue(result["agent_run"]["input"]["repair_attempted"])
        self.assertEqual(result["agent_run"]["input"]["schema_version"], "structured-knowledge-v1")
        self.assertEqual(result["agent_run"]["input"]["provider_call_count"], 2)
        self.assertEqual(result["agent_run"]["input"]["actual_prompt_tokens"], 130)
        self.assertEqual(result["agent_run"]["input"]["actual_completion_tokens"], 30)
        self.assertEqual(result["agent_run"]["input"]["actual_total_tokens"], 160)
        self.assertEqual(result["agent_run"]["input"]["provider_usage"]["total_tokens"], 160)
        self.assertAlmostEqual(result["agent_run"]["input"]["estimated_cost_usd"], 0.00019)
        self.assertEqual(result["agent_run"]["input"]["cost_source"], "model_settings_per_1m_tokens")
        self.assertGreaterEqual(result["agent_run"]["input"]["latency_ms"], 0)
        self.assertEqual(result["source"]["status"], "extracted")

        records = result["records"]
        self.assertEqual(len(records["claims"]), 5)
        statuses = {claim["text"]: claim["status"] for claim in records["claims"]}
        self.assertEqual(statuses["Factor rotation strategy must cite exact source chunks before durable use."], "extracted")
        self.assertEqual(statuses["A source-only provider citation must stay pending."], "pending_validation")
        self.assertEqual(statuses["A provider fake quote must stay pending."], "pending_validation")
        self.assertEqual(statuses["A provider cross-source chunk citation must stay pending."], "pending_validation")
        self.assertEqual(statuses["A provider claim with no evidence must stay pending."], "pending_validation")
        self.assertNotIn("This over-limit provider claim must be ignored.", statuses)
        self.assertNotIn("This second over-limit provider claim must be ignored.", statuses)
        self.assertEqual(len(records["evidence"]), 1)
        self.assertEqual(records["evidence"][0]["source_id"], source_id)
        self.assertEqual(records["evidence"][0]["chunk_id"], chunk_id)
        self.assertEqual(records["evidence"][0]["quote"], "factor rotation strategy must cite exact source chunks")
        self.assertTrue(records["entities"])
        self.assertTrue(records["relations"])
        self.assertTrue(records["risks"])
        self.assertTrue(records["strategy_ideas"])
        self.assertTrue(records["tasks"])

        agent_runs = self.db_rows("SELECT * FROM agent_runs")
        self.assertEqual(len(agent_runs), 1)
        self.assertEqual(agent_runs[0]["agent_id"], "provider_structured_extractor")
        self.assertEqual(agent_runs[0]["status"], "success")
        self.assertNotIn("test-provider-extract-key", agent_runs[0]["input_json"])


if __name__ == "__main__":
    unittest.main()
