from __future__ import annotations

import importlib.util
import json
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


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
        self.assertTrue(health["pairing_required"])
        self.assertTrue(Path(health["pairing_token_path"]).exists())

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
            self.assertFalse(initial["has_api_key"])
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

    def test_pdf_ingest_preserves_page_chunks_and_original_pdf(self) -> None:
        if not server.BUNDLED_PYTHON.exists() and not server.PDF_WORKER.exists():
            self.skipTest("PDF worker runtime is unavailable")

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
        self.assertEqual(len(response["risks"]), 1)
        self.assertEqual(len(response["strategy_ideas"]), 1)
        self.assertEqual(len(response["tasks"]), 1)

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
        self.request(f"/v1/sources/{source_id}/status", {"status": "reviewed"}, method="POST")
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

        result = self.request(
            f"/v1/sources/{source_id}/extract-knowledge",
            {"mode": "mock", "max_claims": 3},
            method="POST",
        )
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
