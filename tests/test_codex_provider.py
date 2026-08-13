"""Tests for the Codex CLI provider.

The Codex CLI is a local binary carrying its own ChatGPT-plan auth, so these
tests stand in a fake executable that speaks the same contract the real one
does: read the prompt from stdin, write the final message to the path given by
--output-last-message, stream progress to stderr.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "companion_service" / "server.py"

spec = importlib.util.spec_from_file_location("qc_companion_server_codex", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(server)


SOURCE_TEXT = "\n\n".join(
    [
        "# Codex Provider Source",
        "Factor rotation strategy must cite exact source chunks before durable use.",
        "Risk controls should check drawdown before any live strategy task is accepted.",
    ]
)

FAKE_CODEX_TEMPLATE = '''#!/usr/bin/env python3
import json
import os
import sys

argv = sys.argv[1:]
prompt = sys.stdin.read()

log_path = os.environ.get("FAKE_CODEX_LOG")
if log_path:
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({{"argv": argv, "prompt_chars": len(prompt)}}) + "\\n")

sys.stderr.write("fake codex: thinking\\n")

mode = {mode!r}
if mode == "always_fail":
    sys.stderr.write("fake codex: something went wrong\\n")
    raise SystemExit(3)
if mode == "needs_git_flag" and "--skip-git-repo-check" not in argv:
    sys.stderr.write("We recommend running codex inside a git repository.\\n")
    raise SystemExit(1)

answer = {answer!r}

output_path = ""
for index, item in enumerate(argv):
    if item in ("--output-last-message", "-o") and index + 1 < len(argv):
        output_path = argv[index + 1]

if output_path:
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(answer)
else:
    sys.stdout.write(answer)

if mode == "fail_with_output":
    sys.stderr.write("fake codex: failed after writing a partial answer\\n")
    raise SystemExit(4)
'''


class CodexResponsesContractStub(server.BaseHTTPRequestHandler):
    """Minimal local Responses API stub for inspecting a real Codex request."""

    requests: list[dict] = []

    def log_message(self, fmt: str, *args: object) -> None:
        return None

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        try:
            length = int(self.headers.get("content-length") or "0")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self.send_error(400, "invalid JSON")
            return
        type(self).requests.append({"path": self.path, "payload": payload})

        response_id = "resp_qc_contract"
        message = {
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "msg_qc_contract",
                "content": [{"type": "output_text", "text": "contract ok"}],
            },
        }
        events = [
            {"type": "response.created", "response": {"id": response_id}},
            message,
            {
                "type": "response.completed",
                "response": {
                    "id": response_id,
                    "usage": {
                        "input_tokens": 0,
                        "input_tokens_details": None,
                        "output_tokens": 0,
                        "output_tokens_details": None,
                        "total_tokens": 0,
                    },
                },
            },
        ]
        body = "".join(
            f"event: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"
            for event in events
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def structured_answer(source_id: str, chunk_id: str) -> str:
    payload = {
        "entities": [
            {"name": "Factor rotation strategy", "kind": "strategy", "description": "Codex extracted entity."}
        ],
        "claims": [
            {
                "id": "codex-claim-1",
                "text": "Factor rotation strategy must cite exact source chunks before durable use.",
                "confidence": 0.8,
                "reasoning_chain": "quote -> claim -> reviewable knowledge",
                "evidence": [
                    {
                        "source_id": source_id,
                        "chunk_id": chunk_id,
                        "quote": "Factor rotation strategy must cite exact source chunks",
                    }
                ],
            },
            {
                "id": "codex-claim-2",
                "text": "Drawdown checks gate live strategy tasks.",
                "confidence": 0.6,
                "evidence": [
                    {
                        "source_id": source_id,
                        "chunk_id": chunk_id,
                        "quote": "Risk controls should check drawdown",
                    }
                ],
            },
        ],
        "risks": [{"text": "Drawdown checks are required before live use.", "severity": "medium"}],
        "tasks": [{"text": "Re-run the backtest on an out-of-sample window."}],
    }
    # Real Codex output is chatty; the parser has to survive prose and fences.
    return "Here is the structured extraction:\n\n```json\n" + json.dumps(payload, ensure_ascii=False) + "\n```\n"


class CodexProviderCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="qc-codex-test-")
        self.data_dir = Path(self.temp_dir.name)
        self.store = server.Store(self.data_dir)
        self.log_path = self.data_dir / "fake_codex.log"
        os.environ["FAKE_CODEX_LOG"] = str(self.log_path)

        class QuietHandler(server.RequestHandler):
            store = self.store

            def log_message(self, fmt: str, *args: object) -> None:
                return None

        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        os.environ.pop("FAKE_CODEX_LOG", None)
        self.temp_dir.cleanup()

    # -- helpers -------------------------------------------------------
    def write_fake_codex(self, answer: str, mode: str = "ok") -> Path:
        path = self.data_dir / f"fake_codex_{mode}.py"
        path.write_text(FAKE_CODEX_TEMPLATE.format(answer=answer, mode=mode), encoding="utf-8")
        path.chmod(0o755)
        return path

    def request(self, path: str, payload: dict | None = None, method: str = "GET") -> dict:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json"}
        if path.startswith("/v1"):
            headers["x-qc-pairing-token"] = self.store.pairing_token()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            error.close()
            raise AssertionError(f"HTTP {error.code}: {detail}") from error

    def capture_source(self, url: str = "https://example.com/codex-provider") -> tuple[str, str]:
        capture = self.request(
            "/v1/captures",
            {
                "source": {"kind": "thread", "url": url, "title": "Codex Provider Source", "site": "example"},
                "content": {"text": SOURCE_TEXT, "markdown": SOURCE_TEXT},
                "browser": {},
            },
            method="POST",
        )
        return capture["source"]["id"], capture["chunks"][0]["id"]

    def logged_runs(self) -> list[dict]:
        if not self.log_path.is_file():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    # -- tests ---------------------------------------------------------
    def test_codex_settings_need_no_api_key_and_extraction_produces_cited_claims(self) -> None:
        source_id, chunk_id = self.capture_source()
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id))

        settings = self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": [str(fake)], "model": "", "base_url": "", "api_key": ""},
            method="POST",
        )["settings"]
        self.assertEqual(settings["provider"], "codex")
        self.assertEqual(settings["model"], "")
        self.assertEqual(settings["base_url"], "")
        self.assertFalse(settings["has_api_key"])

        stored = self.store.read_model_settings(include_secret=True)
        self.assertEqual(stored["model"], "")
        self.assertEqual(stored["base_url"], "")
        self.assertTrue(
            self.store.model_settings_ready(stored),
            "codex provider should be considered ready without an API key",
        )

        # mode=auto must pick the provider path, not the mock fallback.
        result = self.request(
            f"/v1/sources/{source_id}/extract-knowledge",
            {"mode": "auto", "max_claims": 5},
            method="POST",
        )
        self.assertEqual(result["agent_run"]["agent_id"], "provider_structured_extractor")
        self.assertEqual(result["agent_run"]["status"], "success")

        claims = result["records"]["claims"]
        evidence = result["records"]["evidence"]
        self.assertEqual(len(claims), 2)
        self.assertEqual(len(evidence), 2)
        for row in evidence:
            self.assertEqual(row["source_id"], source_id)
            self.assertEqual(row["chunk_id"], chunk_id)
            self.assertIn(row["quote"], SOURCE_TEXT)

        runs = self.logged_runs()
        self.assertEqual(len(runs), 1)
        self.assertIn("--output-last-message", runs[0]["argv"])
        self.assertIn("--ephemeral", runs[0]["argv"])
        self.assertNotIn("--sandbox", runs[0]["argv"])
        self.assertIn("--strict-config", runs[0]["argv"])
        self.assertIn("--ignore-user-config", runs[0]["argv"])
        self.assertIn("--ignore-rules", runs[0]["argv"])
        disabled_features = [
            runs[0]["argv"][index + 1]
            for index, item in enumerate(runs[0]["argv"][:-1])
            if item == "--disable"
        ]
        self.assertIn("shell_tool", disabled_features)
        self.assertIn("multi_agent", disabled_features)
        self.assertNotIn("web_search", disabled_features)
        config_values = [
            runs[0]["argv"][index + 1]
            for index, item in enumerate(runs[0]["argv"][:-1])
            if item in {"-c", "--config"}
        ]
        self.assertIn('shell_environment_policy.inherit="none"', config_values)
        self.assertIn('web_search="disabled"', config_values)
        self.assertIn("agents.enabled=false", config_values)
        self.assertIn('default_permissions="qc_document"', config_values)
        self.assertIn(
            'permissions.qc_document.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
            config_values,
        )
        self.assertNotIn("--model", runs[0]["argv"])
        self.assertEqual(runs[0]["argv"][-1], "-")
        self.assertGreater(runs[0]["prompt_chars"], 0)

    def test_codex_custom_security_options_are_not_duplicated(self) -> None:
        source_id, chunk_id = self.capture_source("https://example.com/codex-custom-security")
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id))
        custom_command = [
            str(fake),
            "--ignore-user-config",
            "--ignore-rules",
            "--disable",
            "shell_tool",
            "--disable",
            "multi_agent",
            "--config",
            'shell_environment_policy.inherit="none"',
            "--config",
            'web_search="disabled"',
            "--config",
            "agents.enabled=false",
        ]
        self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": custom_command, "model": ""},
            method="POST",
        )
        self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "provider"}, method="POST")

        argv = self.logged_runs()[0]["argv"]
        self.assertEqual(argv.count("--ignore-user-config"), 1)
        self.assertEqual(argv.count("--ignore-rules"), 1)
        self.assertEqual(argv.count("shell_tool"), 1)
        self.assertEqual(argv.count("multi_agent"), 1)
        self.assertEqual(argv.count('web_search="disabled"'), 1)
        self.assertEqual(argv.count('shell_environment_policy.inherit="none"'), 1)
        self.assertEqual(argv.count("agents.enabled=false"), 1)

    def test_codex_rejects_or_overrides_unsafe_custom_tool_options(self) -> None:
        source_id, chunk_id = self.capture_source("https://example.com/codex-unsafe-options")
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id))

        for unsafe_option, expected in (
            (["--sandbox", "danger-full-access"], "cannot override the isolated document permission profile"),
            (["--search"], "safe document analysis"),
            (["--enable", "shell_tool"], "cannot enable shell_tool"),
            (["--enable=multi_agent"], "safe document analysis"),
            (["--cd", str(self.data_dir)], "safe document analysis"),
            (["--config", "tools.view_image=true"], "cannot override the isolated document permission profile"),
            (["--config=default_permissions=untrusted"], "cannot override the isolated document permission profile"),
        ):
            with self.subTest(option=unsafe_option):
                self.request(
                    "/v1/model-settings",
                    {"provider": "codex", "codex_command": [str(fake), *unsafe_option], "model": ""},
                    method="POST",
                )
                with self.assertRaisesRegex(AssertionError, "HTTP 400"):
                    self.request(
                        f"/v1/sources/{source_id}/extract-knowledge",
                        {"mode": "provider"},
                        method="POST",
                    )

        self.request(
            "/v1/model-settings",
            {
                "provider": "codex",
                "codex_command": [
                    str(fake),
                    "--config",
                    "agents.enabled=true",
                    "--config",
                    'web_search="live"',
                ],
                "model": "",
            },
            method="POST",
        )
        self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "provider"}, method="POST")
        argv = self.logged_runs()[-1]["argv"]
        self.assertGreater(argv.index("agents.enabled=false"), argv.index("agents.enabled=true"))
        self.assertGreater(argv.index('web_search="disabled"'), argv.index('web_search="live"'))

    def test_codex_passes_model_flag_only_when_a_model_is_configured(self) -> None:
        source_id, chunk_id = self.capture_source()
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id))
        self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": [str(fake)], "model": "gpt-5-codex"},
            method="POST",
        )
        self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "provider"}, method="POST")
        argv = self.logged_runs()[0]["argv"]
        self.assertIn("--model", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "gpt-5-codex")

    def test_codex_retries_once_when_the_cli_demands_a_git_repo(self) -> None:
        source_id, chunk_id = self.capture_source()
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id), mode="needs_git_flag")
        self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": [str(fake)], "model": ""},
            method="POST",
        )
        result = self.request(
            f"/v1/sources/{source_id}/extract-knowledge",
            {"mode": "provider", "max_claims": 5},
            method="POST",
        )
        self.assertEqual(result["agent_run"]["status"], "success")
        runs = self.logged_runs()
        self.assertEqual(len(runs), 2, "the first attempt should be retried with --skip-git-repo-check")
        self.assertNotIn("--skip-git-repo-check", runs[0]["argv"])
        self.assertIn("--skip-git-repo-check", runs[1]["argv"])

    def test_codex_failure_surfaces_stderr_instead_of_hanging(self) -> None:
        source_id, chunk_id = self.capture_source()
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id), mode="always_fail")
        self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": [str(fake)], "model": ""},
            method="POST",
        )
        with self.assertRaises(AssertionError) as caught:
            self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "provider"}, method="POST")
        message = str(caught.exception)
        self.assertIn("codex CLI exited with code 3", message)
        self.assertIn("something went wrong", message)

    def test_codex_nonzero_exit_is_failure_even_if_a_partial_output_was_written(self) -> None:
        source_id, chunk_id = self.capture_source()
        fake = self.write_fake_codex(structured_answer(source_id, chunk_id), mode="fail_with_output")
        self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": [str(fake)], "model": "", "base_url": ""},
            method="POST",
        )

        with self.assertRaises(AssertionError) as caught:
            self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "provider"}, method="POST")
        message = str(caught.exception)
        self.assertIn("codex CLI exited with code 4", message)
        self.assertIn("failed after writing a partial answer", message)

    def test_missing_codex_binary_is_reported_and_auto_mode_falls_back_to_mock(self) -> None:
        source_id, _ = self.capture_source()
        missing = self.data_dir / "no-such-codex"
        self.request(
            "/v1/model-settings",
            {"provider": "codex", "codex_command": [str(missing)], "model": ""},
            method="POST",
        )
        stored = self.store.read_model_settings(include_secret=True)
        self.assertFalse(self.store.model_settings_ready(stored))

        with self.assertRaises(AssertionError) as caught:
            self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "provider"}, method="POST")
        self.assertIn("required for provider extraction", str(caught.exception))

        fallback = self.request(f"/v1/sources/{source_id}/extract-knowledge", {"mode": "auto"}, method="POST")
        self.assertEqual(fallback["agent_run"]["agent_id"], "mock_structured_extractor")

    def test_model_settings_rejects_unknown_provider_and_bad_timeout(self) -> None:
        with self.assertRaises(AssertionError) as unknown:
            self.request("/v1/model-settings", {"provider": "gemini"}, method="POST")
        self.assertIn("provider must be openai, anthropic, or codex", str(unknown.exception))

        with self.assertRaises(AssertionError) as timeout:
            self.request("/v1/model-settings", {"provider": "codex", "codex_timeout_seconds": 5}, method="POST")
        self.assertIn("codex_timeout_seconds must be between 10 and 3600", str(timeout.exception))


class RealCodexContractCase(unittest.TestCase):
    def test_real_codex_cli_uses_restricted_filesystem_and_no_shell_or_delegation_tools(self) -> None:
        codex = shutil.which("codex")
        if not codex:
            self.skipTest("codex CLI is not installed")
        completed = server.subprocess.run(
            [codex, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        match = server.re.search(r"codex-cli\s+(\d+)\.(\d+)\.(\d+)", completed.stdout)
        if not match:
            self.skipTest("codex CLI version could not be determined")

        CodexResponsesContractStub.requests = []
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), CodexResponsesContractStub)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            port = httpd.server_address[1]
            settings = {
                "provider": "codex",
                "codex_command": [
                    codex,
                    "exec",
                    "--skip-git-repo-check",
                    "--disable",
                    "enable_request_compression",
                    "-c",
                    "model_provider=qc_contract",
                    "-c",
                    (
                        "model_providers.qc_contract="
                        f"{{name='QC contract stub',base_url='http://127.0.0.1:{port}/v1',"
                        "wire_api='responses'}"
                    ),
                ],
                "model": "gpt-5-codex",
                "codex_timeout_seconds": 30,
            }
            with tempfile.TemporaryDirectory(prefix="qc-real-codex-contract-") as temp_dir:
                store = server.Store(Path(temp_dir))
                answer, _raw = store.call_codex_cli(settings, "Return the fixed stub response.", None)

            self.assertEqual(answer, "contract ok")
            self.assertEqual(len(CodexResponsesContractStub.requests), 1)
            request = CodexResponsesContractStub.requests[0]
            self.assertEqual(request["path"], "/v1/responses")

            tools = request["payload"].get("tools") or []
            names: set[str] = set()

            def collect_names(items: list) -> None:
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    name = str(item.get("name") or "").strip().lower()
                    if name:
                        names.add(name)
                    children = item.get("tools")
                    if isinstance(children, list):
                        collect_names(children)

            collect_names(tools)
            for item in request["payload"].get("input") or []:
                if not isinstance(item, dict) or item.get("type") != "additional_tools":
                    continue
                names.update(str(name).strip().lower() for name in item.get("tool_names") or [])
            forbidden_exact = {
                "exec",
                "exec_command",
                "unified_exec",
                "write_stdin",
                "shell",
                "shell_command",
                "spawn_agent",
                "multi_agent",
                "multi_agent_v1",
                "multi_agent_v2",
            }
            self.assertTrue(
                forbidden_exact.isdisjoint(names),
                f"unsafe tools advertised by real Codex CLI: {sorted(forbidden_exact & names)}",
            )
            self.assertFalse(
                any("multi_agent" in name or name.startswith("spawn_agent") for name in names),
                f"delegation tools advertised by real Codex CLI: {sorted(names)}",
            )

            request_text: list[str] = []

            def collect_text(value: object) -> None:
                if isinstance(value, str):
                    request_text.append(value)
                elif isinstance(value, dict):
                    for child in value.values():
                        collect_text(child)
                elif isinstance(value, list):
                    for child in value:
                        collect_text(child)

            collect_text(request["payload"])
            combined_text = "\n".join(request_text)
            self.assertIn('<permission_profile type="managed">', combined_text)
            self.assertIn('<file_system type="restricted">', combined_text)
            self.assertNotIn(
                str(Path.home()),
                combined_text,
                "real Codex request exposed the caller home outside the isolated scratch profile",
            )
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
