#!/usr/bin/env python3
"""End-to-end smoke test for the QC Smart Reader companion service.

Runs the whole evidence chain against a throwaway vault, with no model provider
and no browser involved:

    capture -> chunks -> mock structured extraction -> claims + evidence
            -> topic package -> deliverable -> vault doctor -> lineage rebuild

Use it to answer "is my install actually working?" in about ten seconds.

    python3 scripts/smoke_e2e.py                 # start a temp service, tear it down
    python3 scripts/smoke_e2e.py --keep          # keep the temp vault for inspection
    python3 scripts/smoke_e2e.py --base-url http://127.0.0.1:37621 --token <token>

Exit code is 0 only if every step passed.
"""

from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "companion_service" / "server.py"

PASS = "  ok  "
FAIL = " FAIL "

SAMPLE_TEXT = "\n\n".join(
    [
        "# 上影线因子的证据链样例",
        "Factor rotation claims should cite source chunks before they become durable conclusions.",
        "Backtest tasks must define input data, metrics, risk checks, and validation windows.",
        "A drawdown risk appears when the signal is overfit to a single market regime.",
        "回撤控制需要明确的仓位上限、换手率限制,以及在样本外窗口重复验证的流程。",
    ]
)


class SmokeError(RuntimeError):
    pass


class Client:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def call(self, path: str, payload: dict | None = None, method: str = "GET") -> dict:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.token:
            headers["x-qc-pairing-token"] = self.token
        request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SmokeError(f"HTTP {error.code} on {method} {path}: {detail}") from error
        except urllib.error.URLError as error:
            raise SmokeError(f"cannot reach {self.base_url}{path}: {error}") from error


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_health(base_url: str, process: subprocess.Popen | None, timeout: float = 25.0) -> dict:
    deadline = time.time() + timeout
    last_error = ""
    while time.time() < deadline:
        if process is not None and process.poll() is not None:
            output = (process.stdout.read() if process.stdout else "") or ""
            raise SmokeError(f"service exited during startup (code {process.returncode}):\n{output}")
        try:
            with urllib.request.urlopen(base_url + "/health", timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - startup polling
            last_error = str(error)
            time.sleep(0.4)
    raise SmokeError(f"service did not become healthy at {base_url}: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="", help="test an already-running service instead of starting one")
    parser.add_argument("--token", default="", help="pairing token for --base-url")
    parser.add_argument("--keep", action="store_true", help="keep the temporary vault directory")
    args = parser.parse_args()

    process: subprocess.Popen | None = None
    data_dir: Path | None = None
    steps: list[tuple[str, bool, str]] = []

    def record(name: str, detail: str = "") -> None:
        steps.append((name, True, detail))
        print(f"[{PASS}] {name}" + (f" — {detail}" if detail else ""), flush=True)

    try:
        if args.base_url:
            base_url = args.base_url.rstrip("/")
            health = wait_for_health(base_url, None)
            token = args.token
            if not token:
                token_path = Path(health.get("pairing_token_path", ""))
                if token_path.is_file():
                    token = token_path.read_text(encoding="utf-8").strip()
            if not token:
                raise SmokeError("no pairing token: pass --token")
        else:
            data_dir = Path(tempfile.mkdtemp(prefix="qc-smoke-"))
            port = free_port()
            base_url = f"http://127.0.0.1:{port}"
            process = subprocess.Popen(
                [sys.executable, str(SERVER), "--port", str(port), "--data-dir", str(data_dir)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            health = wait_for_health(base_url, process)
            token = (data_dir / "state" / "pairing_token.txt").read_text(encoding="utf-8").strip()

        record("service healthy", f"v{health.get('version')} vault={health.get('vault_dir')}")

        client = Client(base_url, token)

        # 1. capture -------------------------------------------------------
        capture = client.call(
            "/v1/captures",
            {
                "source": {
                    "kind": "thread",
                    "url": "https://example.com/qc-smoke-e2e",
                    "title": "QC Smart Reader smoke source",
                    "site": "example",
                },
                "content": {"text": SAMPLE_TEXT, "markdown": SAMPLE_TEXT},
                "browser": {},
            },
            method="POST",
        )
        source_id = capture["source"]["id"]
        record("capture stored", f"source={source_id} chunks={len(capture.get('chunks') or [])}")

        # 2. structured extraction (no provider needed) ---------------------
        extraction = client.call(
            f"/v1/sources/{source_id}/extract-knowledge",
            {"mode": "mock", "max_claims": 3},
            method="POST",
        )
        records = extraction["records"]
        claims = records["claims"]
        evidence = records["evidence"]
        if not claims:
            raise SmokeError("extraction produced no claims")
        if len(evidence) < len(claims):
            raise SmokeError("some claims have no evidence row")
        record(
            "mock extraction",
            f"claims={len(claims)} evidence={len(evidence)} entities={len(records.get('entities') or [])} "
            f"status={extraction['source']['status']}",
        )

        # 3. every claim must carry a quote that still matches the chunk -----
        evidence_by_claim: dict[str, dict] = {}
        for row in evidence:
            evidence_by_claim.setdefault(row["claim_id"], row)
        missing = [claim["id"] for claim in claims if claim["id"] not in evidence_by_claim]
        if missing:
            raise SmokeError(f"claims without evidence: {missing}")
        record("every claim is quote-backed", f"{len(evidence_by_claim)}/{len(claims)}")

        # 4. topic package ---------------------------------------------------
        topic = client.call(
            "/v1/topic-packages",
            {
                "title": "Smoke topic package",
                "claim_ids": [claim["id"] for claim in claims],
                "status": "draft",
            },
            method="POST",
        )["topic_package"]
        record("topic package", f"id={topic['id']} stale={topic.get('stale')}")

        # 5. deliverable -----------------------------------------------------
        deliverable_claims = []
        for claim in claims:
            row = evidence_by_claim[claim["id"]]
            deliverable_claims.append(
                {
                    "claim_id": claim["id"],
                    "text": claim.get("text") or claim.get("statement") or "",
                    "citations": [
                        {
                            "source_id": row.get("source_id") or source_id,
                            "chunk_id": row.get("chunk_id"),
                            "quote": row.get("quote"),
                        }
                    ],
                }
            )
        deliverable = client.call(
            "/v1/deliverables",
            {
                "kind": "report",
                "title": "Smoke research report",
                "source_ids": [source_id],
                "background": "Generated by scripts/smoke_e2e.py",
                "claims": deliverable_claims,
            },
            method="POST",
        )["deliverable"]
        unsupported = deliverable.get("unsupported_claims")
        markdown_path = deliverable.get("markdown_path") or ""
        if unsupported:
            raise SmokeError(f"{unsupported} claim(s) landed in the report without a valid citation")
        if not markdown_path or not Path(markdown_path).is_file():
            raise SmokeError(f"deliverable markdown was not written: {markdown_path!r}")
        record("deliverable rendered", f"unsupported_claims=0 -> {Path(markdown_path).name}")

        # 6. vault doctor ----------------------------------------------------
        doctor = client.call("/v1/vault/doctor")["doctor"]
        counts = doctor.get("counts") or {}
        issues = doctor.get("issues") or []
        errors = [issue for issue in issues if issue.get("severity") == "error"]
        if errors:
            raise SmokeError(f"vault doctor found errors: {json.dumps(errors, ensure_ascii=False)[:400]}")
        record(
            "vault doctor clean",
            f"files={counts.get('files_checked')} refs={counts.get('references_checked')} "
            f"errors={counts.get('errors')} warnings={counts.get('warnings')}",
        )

        # 7. lineage ---------------------------------------------------------
        lineage = client.call("/v1/lineage/rebuild", {}, method="POST")["lineage"]
        edge_count = lineage.get("edge_count") or 0
        if not edge_count:
            raise SmokeError("lineage rebuild produced no edges")
        relations = (lineage.get("summary") or {}).get("by_relation") or {}
        for required in ("claims_from_source", "evidence_from_chunk", "deliverable_citation"):
            if required not in relations:
                raise SmokeError(f"lineage is missing the {required} edge type: {sorted(relations)}")
        record("lineage rebuilt", f"edges={edge_count} relations={len(relations)}")

        # 8. the vault is real files on disk ---------------------------------
        vault_dir = Path(health["vault_dir"])
        written = sorted(p.relative_to(vault_dir).as_posix() for p in vault_dir.rglob("*.md"))
        if len(written) < 5:
            raise SmokeError(f"vault looks empty: {written}")
        record("vault written", f"{len(written)} markdown files")

        print("\nAll steps passed. The evidence chain works end to end.")
        if data_dir and args.keep:
            print(f"Temp vault kept at: {data_dir}")
        return 0

    except SmokeError as error:
        print(f"\n[{FAIL}] {error}\n", file=sys.stderr)
        return 1
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        if data_dir is not None and not args.keep:
            shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
