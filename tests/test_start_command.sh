#!/bin/bash

set -euo pipefail

PYTHON="${QC_TEST_PYTHON:-/usr/bin/python3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
START_COMMAND="$ROOT/start.command"
TEST_DIR_RAW="$(mktemp -d "${TMPDIR:-/tmp}/qc-start-command.XXXXXX")"
TEST_DIR="$(cd "$TEST_DIR_RAW" && pwd -P)"
FIXTURE_PIDS=""
VALID_TOKEN='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-'

[ "${#VALID_TOKEN}" -eq 43 ] || {
  printf '[FAIL] test token must match secrets.token_urlsafe(32) length\n' >&2
  exit 1
}

cleanup() {
  for pid in $FIXTURE_PIDS; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
    find "$TEST_DIR" -depth -delete
  fi
}
trap cleanup EXIT INT TERM

fail_test() {
  printf '[FAIL] %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  file="$1"
  expected="$2"
  grep -F "$expected" "$file" >/dev/null || fail_test "Expected '$expected' in $file"
}

assert_not_contains() {
  file="$1"
  unexpected="$2"
  if grep -F "$unexpected" "$file" >/dev/null; then
    fail_test "Did not expect '$unexpected' in $file"
  fi
}

free_port() {
  "$PYTHON" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

wait_for_health() {
  port="$1"
  for _ in $(seq 1 50); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

make_layout() {
  label="$1"
  token="$2"
  mode="$3"
  LAYOUT_DATA="$TEST_DIR/$label-data"
  LAYOUT_VAULT="$LAYOUT_DATA/vault"
  LAYOUT_TOKEN="$LAYOUT_DATA/state/pairing_token.txt"
  mkdir -p "$LAYOUT_VAULT" "$LAYOUT_DATA/state"
  printf '%s\n' "$token" >"$LAYOUT_TOKEN"
  chmod "$mode" "$LAYOUT_TOKEN"
}

start_health_fixture() {
  port="$1"
  app="$2"
  data_dir="$3"
  token_path="$4"
  vault_dir="$5"
  expected_token="$6"
  auth_status="${7:-200}"
  api_version="${8:-1}"
  capabilities="${9:-selection_first_evidence_v1}"
  QC_FIXTURE_PORT="$port" QC_FIXTURE_APP="$app" QC_FIXTURE_TOKEN_PATH="$token_path" \
    QC_FIXTURE_DATA_DIR="$data_dir" QC_FIXTURE_VAULT_DIR="$vault_dir" \
    QC_FIXTURE_EXPECTED_TOKEN="$expected_token" QC_FIXTURE_AUTH_STATUS="$auth_status" \
    QC_FIXTURE_API_VERSION="$api_version" QC_FIXTURE_CAPABILITIES="$capabilities" \
    "$PYTHON" -c '
import json
import os
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

payload = {
    "ok": True,
    "app": os.environ["QC_FIXTURE_APP"],
    "data_dir": os.environ["QC_FIXTURE_DATA_DIR"],
    "pairing_token_path": os.environ["QC_FIXTURE_TOKEN_PATH"],
    "vault_dir": os.environ["QC_FIXTURE_VAULT_DIR"],
}
api_version = os.environ["QC_FIXTURE_API_VERSION"]
if api_version != "legacy":
    payload["api_version"] = int(api_version)
capabilities = os.environ["QC_FIXTURE_CAPABILITIES"]
if capabilities != "missing":
    payload["capabilities"] = [item for item in capabilities.split(",") if item]
expected_token = os.environ["QC_FIXTURE_EXPECTED_TOKEN"]
auth_status = int(os.environ["QC_FIXTURE_AUTH_STATUS"])

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, payload)
            return
        if path == "/v1/projects":
            supplied = self.headers.get("x-qc-pairing-token", "")
            if auth_status == 200 and secrets.compare_digest(supplied, expected_token):
                self.send_json(200, {"ok": True, "projects": []})
            else:
                self.send_json(auth_status if auth_status != 200 else 403, {"ok": False, "error": "invalid pairing token"})
            return
        self.send_json(404, {"ok": False})

    def log_message(self, *_args):
        pass

ThreadingHTTPServer(("127.0.0.1", int(os.environ["QC_FIXTURE_PORT"])), Handler).serve_forever()
' >/dev/null 2>&1 &
  FIXTURE_PID=$!
  FIXTURE_PIDS="$FIXTURE_PIDS $FIXTURE_PID"
  wait_for_health "$port" || fail_test "Fixture did not become healthy on port $port"
}

stop_fixture() {
  pid="$1"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  remaining_pids=""
  for fixture_pid in $FIXTURE_PIDS; do
    if [ "$fixture_pid" != "$pid" ]; then
      remaining_pids="$remaining_pids $fixture_pid"
    fi
  done
  FIXTURE_PIDS="$remaining_pids"
}

run_start() {
  output_path="$1"
  shift
  set +e
  env \
    QC_START_PYTHON="$PYTHON" \
    QC_START_SKIP_SETUP=1 \
    QC_START_NO_PAUSE=1 \
    "$@" \
    bash "$START_COMMAND" >"$output_path" 2>&1
  START_EXIT=$?
  set -e
}

printf '[1/13] Reuses only a strictly valid service and copies its authenticated token\n'
make_layout reuse "$VALID_TOKEN" 600
reuse_data="$LAYOUT_DATA"
reuse_vault="$LAYOUT_VAULT"
reuse_token_path="$LAYOUT_TOKEN"
reuse_port="$(free_port)"
start_health_fixture "$reuse_port" "QC Smart Reader" "$reuse_data" "$reuse_token_path" "$reuse_vault" "$VALID_TOKEN"
reuse_pid="$FIXTURE_PID"

fake_pbcopy="$TEST_DIR/pbcopy"
clipboard_output="$TEST_DIR/clipboard.txt"
printf '%s\n' '#!/bin/bash' 'set -eu' 'tee "$QC_CLIPBOARD_OUTPUT" >/dev/null' >"$fake_pbcopy"
chmod +x "$fake_pbcopy"
reuse_output="$TEST_DIR/reuse.out"
set +e
env \
  QC_START_PYTHON="$PYTHON" \
  QC_START_SKIP_SETUP=1 \
  QC_START_NO_PAUSE=1 \
  QC_START_PORT="$reuse_port" \
  QC_START_PBCOPY="$fake_pbcopy" \
  QC_CLIPBOARD_OUTPUT="$clipboard_output" \
  bash "$START_COMMAND" --data-dir "$reuse_data/../$(basename "$reuse_data")" >"$reuse_output" 2>&1
START_EXIT=$?
set -e
[ "$START_EXIT" -eq 0 ] || fail_test "Strictly valid QC service should be reused"
assert_contains "$reuse_output" "Existing QC Smart Reader service found"
assert_contains "$reuse_output" "Pairing Token   $VALID_TOKEN"
assert_contains "$reuse_output" "Pairing Token copied to clipboard"
[ "$(cat "$clipboard_output")" = "$VALID_TOKEN" ] || fail_test "pbcopy fixture received the wrong token"
kill -0 "$reuse_pid" 2>/dev/null || fail_test "Reusing the service must not terminate it"

printf '[2/13] Rejects API v1 services missing Selection First Evidence before reading or copying the token\n'
make_layout missing-capability "$VALID_TOKEN" 600
missing_capability_port="$(free_port)"
start_health_fixture \
  "$missing_capability_port" "QC Smart Reader" "$LAYOUT_DATA" "$LAYOUT_TOKEN" \
  "$LAYOUT_VAULT" "$VALID_TOKEN" 200 1 missing
missing_capability_pid="$FIXTURE_PID"
missing_capability_output="$TEST_DIR/missing-capability.out"
missing_capability_clipboard="$TEST_DIR/missing-capability-clipboard.txt"
run_start "$missing_capability_output" \
  QC_START_PORT="$missing_capability_port" \
  QC_START_PBCOPY="$fake_pbcopy" \
  QC_CLIPBOARD_OUTPUT="$missing_capability_clipboard"
[ "$START_EXIT" -ne 0 ] || fail_test "A Companion without Selection First Evidence must not be reused"
assert_contains "$missing_capability_output" "missing required capability 'selection_first_evidence_v1'"
assert_contains "$missing_capability_output" "Update Companion from the same release"
assert_not_contains "$missing_capability_output" "$VALID_TOKEN"
[ ! -e "$missing_capability_clipboard" ] || fail_test "An incompatible Companion token must not reach pbcopy"
kill -0 "$missing_capability_pid" 2>/dev/null || fail_test "Rejected old Companion must not be terminated"
stop_fixture "$missing_capability_pid"

printf '[3/13] Rejects an existing QC service with a different explicit data dir\n'
mismatch_output="$TEST_DIR/data-dir-mismatch.out"
set +e
env \
  QC_START_PYTHON="$PYTHON" \
  QC_START_SKIP_SETUP=1 \
  QC_START_NO_PAUSE=1 \
  QC_START_PORT="$reuse_port" \
  bash "$START_COMMAND" --data-dir "$TEST_DIR/different-data" >"$mismatch_output" 2>&1
START_EXIT=$?
set -e
[ "$START_EXIT" -ne 0 ] || fail_test "An explicit mismatched data dir must be rejected"
assert_contains "$mismatch_output" "not requested"
kill -0 "$reuse_pid" 2>/dev/null || fail_test "A data-dir mismatch must not terminate the existing service"
stop_fixture "$reuse_pid"

printf '[4/13] Never reads or copies a lookalike health endpoint external file\n'
make_layout external "$VALID_TOKEN" 600
external_port="$(free_port)"
start_health_fixture "$external_port" "QC Smart Reader" "$LAYOUT_DATA" "$ROOT/requirements.txt" "$LAYOUT_VAULT" "$VALID_TOKEN"
external_pid="$FIXTURE_PID"
external_output="$TEST_DIR/external.out"
external_clipboard="$TEST_DIR/external-clipboard.txt"
run_start "$external_output" \
  QC_START_PORT="$external_port" \
  QC_START_PBCOPY="$fake_pbcopy" \
  QC_CLIPBOARD_OUTPUT="$external_clipboard"
[ "$START_EXIT" -ne 0 ] || fail_test "A health response pointing outside its data dir must be rejected"
assert_contains "$external_output" "secure pairing metadata"
assert_not_contains "$external_output" "pypdf"
[ ! -e "$external_clipboard" ] || fail_test "Untrusted file content must never reach pbcopy"
kill -0 "$external_pid" 2>/dev/null || fail_test "Rejected lookalike listener must not be terminated"
stop_fixture "$external_pid"

printf '[5/13] Rejects malformed, over-permissive, and symlink token files\n'
for variant in malformed permissive symlink; do
  case "$variant" in
    malformed)
      variant_token='short-token'
      make_layout "$variant" "$variant_token" 600
      ;;
    permissive)
      variant_token="$VALID_TOKEN"
      make_layout "$variant" "$variant_token" 644
      ;;
    symlink)
      variant_token="$VALID_TOKEN"
      make_layout "$variant" "$variant_token" 600
      rm "$LAYOUT_TOKEN"
      symlink_target="$TEST_DIR/symlink-target.txt"
      printf '%s\n' "$VALID_TOKEN" >"$symlink_target"
      chmod 600 "$symlink_target"
      ln -s "$symlink_target" "$LAYOUT_TOKEN"
      ;;
  esac
  variant_port="$(free_port)"
  start_health_fixture "$variant_port" "QC Smart Reader" "$LAYOUT_DATA" "$LAYOUT_TOKEN" "$LAYOUT_VAULT" "$variant_token"
  variant_pid="$FIXTURE_PID"
  variant_output="$TEST_DIR/$variant.out"
  run_start "$variant_output" QC_START_PORT="$variant_port" QC_START_PBCOPY="$TEST_DIR/missing-pbcopy"
  [ "$START_EXIT" -ne 0 ] || fail_test "$variant token file must be rejected"
  assert_contains "$variant_output" "secure pairing metadata"
  kill -0 "$variant_pid" 2>/dev/null || fail_test "Rejected $variant listener must not be terminated"
  stop_fixture "$variant_pid"
done

printf '[6/13] Rejects a valid-looking listener when the authenticated probe returns 403\n'
make_layout auth403 "$VALID_TOKEN" 600
auth_port="$(free_port)"
start_health_fixture "$auth_port" "QC Smart Reader" "$LAYOUT_DATA" "$LAYOUT_TOKEN" "$LAYOUT_VAULT" "$VALID_TOKEN" 403
auth_pid="$FIXTURE_PID"
auth_output="$TEST_DIR/auth403.out"
auth_clipboard="$TEST_DIR/auth403-clipboard.txt"
run_start "$auth_output" \
  QC_START_PORT="$auth_port" \
  QC_START_PBCOPY="$fake_pbcopy" \
  QC_CLIPBOARD_OUTPUT="$auth_clipboard"
[ "$START_EXIT" -ne 0 ] || fail_test "A 403 authenticated probe must prevent reuse"
assert_contains "$auth_output" "authenticated API check is invalid"
assert_not_contains "$auth_output" "$VALID_TOKEN"
[ ! -e "$auth_clipboard" ] || fail_test "A token rejected by the service must not reach pbcopy"
kill -0 "$auth_pid" 2>/dev/null || fail_test "Auth-rejected listener must not be terminated"
stop_fixture "$auth_pid"

printf '[7/13] Rejects a foreign application without terminating it\n'
make_layout foreign "$VALID_TOKEN" 600
foreign_port="$(free_port)"
start_health_fixture "$foreign_port" "Not QC Smart Reader" "$LAYOUT_DATA" "$LAYOUT_TOKEN" "$LAYOUT_VAULT" "$VALID_TOKEN"
foreign_pid="$FIXTURE_PID"
foreign_output="$TEST_DIR/foreign.out"
run_start "$foreign_output" QC_START_PORT="$foreign_port"
[ "$START_EXIT" -ne 0 ] || fail_test "Foreign listener must be rejected"
assert_contains "$foreign_output" "identity"
kill -0 "$foreign_pid" 2>/dev/null || fail_test "Foreign listener must not be terminated"
stop_fixture "$foreign_pid"

printf '[8/13] Rejects legacy or incompatible API services without reading their token\n'
for fixture_api in legacy 2; do
  make_layout "api-$fixture_api" "$VALID_TOKEN" 600
  incompatible_port="$(free_port)"
  start_health_fixture \
    "$incompatible_port" "QC Smart Reader" "$LAYOUT_DATA" "$LAYOUT_TOKEN" \
    "$LAYOUT_VAULT" "$VALID_TOKEN" 200 "$fixture_api"
  incompatible_pid="$FIXTURE_PID"
  incompatible_output="$TEST_DIR/api-$fixture_api.out"
  incompatible_clipboard="$TEST_DIR/api-$fixture_api-clipboard.txt"
  run_start "$incompatible_output" \
    QC_START_PORT="$incompatible_port" \
    QC_START_PBCOPY="$fake_pbcopy" \
    QC_CLIPBOARD_OUTPUT="$incompatible_clipboard"
  [ "$START_EXIT" -ne 0 ] || fail_test "API fixture '$fixture_api' must not be reused"
  assert_contains "$incompatible_output" "identity"
  assert_not_contains "$incompatible_output" "$VALID_TOKEN"
  [ ! -e "$incompatible_clipboard" ] || fail_test "Incompatible API token must not reach pbcopy"
  kill -0 "$incompatible_pid" 2>/dev/null || fail_test "Incompatible API listener must not be terminated"
  stop_fixture "$incompatible_pid"
done

printf '[9/13] Cleans up the process it launched after a health timeout\n'
stalled_port="$(free_port)"
stalled_pid_path="$TEST_DIR/stalled.pid"
stalled_server="$TEST_DIR/stalled_service.py"
printf '%s\n' \
  'import os' \
  'import time' \
  'from pathlib import Path' \
  'Path(os.environ["QC_FIXTURE_PID_PATH"]).write_text(str(os.getpid()), encoding="utf-8")' \
  'while True: time.sleep(1)' >"$stalled_server"
stalled_output="$TEST_DIR/stalled.out"
run_start "$stalled_output" \
  QC_START_PORT="$stalled_port" \
  QC_START_SERVER="$stalled_server" \
  QC_START_HEALTH_ATTEMPTS=3 \
  QC_START_HEALTH_INTERVAL=0.05 \
  QC_FIXTURE_PID_PATH="$stalled_pid_path"
[ "$START_EXIT" -ne 0 ] || fail_test "A service that never becomes healthy must fail"
assert_contains "$stalled_output" "did not answer with a valid QC Smart Reader /health"
[ -s "$stalled_pid_path" ] || fail_test "Stalled fixture did not record its pid"
stalled_pid="$(cat "$stalled_pid_path")"
for _ in $(seq 1 20); do
  if ! kill -0 "$stalled_pid" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if kill -0 "$stalled_pid" 2>/dev/null; then
  fail_test "Failed startup left process $stalled_pid running"
fi

printf '[10/13] Finder-style PATH exposes an explicit local tool directory to the server\n'
tool_bin="$TEST_DIR/tool-bin"
mkdir -p "$tool_bin"
for tool_name in codex yt-dlp; do
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$tool_bin/$tool_name"
  chmod +x "$tool_bin/$tool_name"
done
tool_server="$TEST_DIR/tool_service.py"
tool_path_record="$TEST_DIR/tool-path.txt"
tool_data="$TEST_DIR/tool-service-data"
cat >"$tool_server" <<'PY'
import argparse
import json
import os
import secrets
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, required=True)
args, _ = parser.parse_known_args()
data_dir = Path(os.environ["QC_TOOL_DATA_DIR"]).resolve()
vault_dir = data_dir / "vault"
token_path = data_dir / "state" / "pairing_token.txt"
vault_dir.mkdir(parents=True, exist_ok=True)
token_path.parent.mkdir(parents=True, exist_ok=True)
token = os.environ["QC_TOOL_TOKEN"]
token_path.write_text(token + "\n", encoding="ascii")
token_path.chmod(0o600)
Path(os.environ["QC_PATH_RECORD"]).write_text(
    "codex=" + str(shutil.which("codex")) + "\n"
    "yt-dlp=" + str(shutil.which("yt-dlp")) + "\n"
    "PATH=" + os.environ.get("PATH", "") + "\n",
    encoding="utf-8",
)

health = {
    "ok": True,
    "app": "QC Smart Reader",
    "version": "0.9.0",
    "service_version": "0.9.0",
    "api_version": 1,
    "schema_version": 1,
    "min_extension_version": "0.9.0",
    "capabilities": ["selection_first_evidence_v1"],
    "data_dir": str(data_dir),
    "vault_dir": str(vault_dir),
    "pairing_token_path": str(token_path),
}

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(200, health)
            return
        if path == "/v1/projects" and secrets.compare_digest(
            self.headers.get("x-qc-pairing-token", ""), token
        ):
            self.send_json(200, {"ok": True, "projects": []})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self.send_json(403, {"ok": False})

    def log_message(self, *_args):
        pass

server = ThreadingHTTPServer((args.host, args.port), Handler)
server.serve_forever()
server.server_close()
PY
tool_port="$(free_port)"
tool_output="$TEST_DIR/tool-service.out"
run_start "$tool_output" \
  PATH="/usr/bin:/bin" \
  QC_START_TOOL_PATH="$tool_bin:relative-path:$TEST_DIR/not-a-directory" \
  QC_START_PORT="$tool_port" \
  QC_START_SERVER="$tool_server" \
  QC_START_PBCOPY="$TEST_DIR/missing-pbcopy" \
  QC_TOOL_DATA_DIR="$tool_data" \
  QC_TOOL_TOKEN="$VALID_TOKEN" \
  QC_PATH_RECORD="$tool_path_record"
[ "$START_EXIT" -eq 0 ] || fail_test "Valid fixture service should start and exit cleanly"
assert_contains "$tool_path_record" "codex=$tool_bin/codex"
assert_contains "$tool_path_record" "yt-dlp=$tool_bin/yt-dlp"
assert_contains "$tool_path_record" "PATH=$tool_bin:"
assert_not_contains "$tool_path_record" "relative-path"
assert_contains "$tool_output" "Service is up."

printf '[11/13] Duplicate user PATH entries are not added twice\n'
path_line="$(grep '^PATH=' "$tool_path_record")"
tool_occurrences="$(printf '%s' "$path_line" | awk -F"$tool_bin" '{print NF-1}')"
[ "$tool_occurrences" -eq 1 ] || fail_test "QC_START_TOOL_PATH was duplicated in PATH"

printf '[12/13] A same-version forged package with a self-consistent RECORD is rejected before startup\n'
tampered_venv="$TEST_DIR/tampered-venv"
"$PYTHON" -m venv "$tampered_venv"
tampered_site="$("$tampered_venv/bin/python" -c 'import site; print(site.getsitepackages()[0])')"
"$tampered_venv/bin/python" - "$tampered_site" <<'PY'
import base64
import hashlib
import sys
from pathlib import Path

site = Path(sys.argv[1])
fixtures = (
    ("pypdf", "6.16.0", "pypdf/__init__.py", b"self-consistent forged runtime", b"self-consistent forged runtime"),
    ("typing_extensions", "4.15.0", "typing_extensions.py", b"verified", b"verified"),
)
for name, version, runtime, installed, recorded in fixtures:
    dist_info = site / f"{name}-{version}.dist-info"
    dist_info.mkdir(parents=True)
    (dist_info / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        encoding="utf-8",
    )
    runtime_path = site / runtime
    runtime_path.parent.mkdir(parents=True, exist_ok=True)
    runtime_path.write_bytes(installed)
    digest = base64.urlsafe_b64encode(hashlib.sha256(recorded).digest()).rstrip(b"=").decode("ascii")
    (dist_info / "RECORD").write_text(
        f"{runtime},sha256={digest},{len(installed)}\n{dist_info.name}/RECORD,,\n",
        encoding="utf-8",
    )
PY
never_started_marker="$TEST_DIR/tampered-server-started"
tampered_server="$TEST_DIR/tampered_service.py"
printf '%s\n' \
  'import os' \
  'from pathlib import Path' \
  'Path(os.environ["QC_TAMPERED_MARKER"]).write_text("started", encoding="utf-8")' >"$tampered_server"
tampered_output="$TEST_DIR/tampered-runtime.out"
set +e
env \
  QC_START_PYTHON="$PYTHON" \
  QC_START_VENV_DIR="$tampered_venv" \
  QC_START_NO_PAUSE=1 \
  QC_START_PORT="$(free_port)" \
  QC_START_SERVER="$tampered_server" \
  QC_TAMPERED_MARKER="$never_started_marker" \
  PIP_NO_INDEX=1 \
  bash "$START_COMMAND" >"$tampered_output" 2>&1
START_EXIT=$?
set -e
[ "$START_EXIT" -ne 0 ] || fail_test "A self-consistent forged package must not pass trusted runtime verification"
assert_contains "$tampered_output" "Installing exact locked requirements"
[ ! -e "$never_started_marker" ] || fail_test "The service started with a modified locked dependency"

printf '[13/13] Non-interactive failures never pause for input\n'
assert_contains "$stalled_output" "[x]"

printf 'start.command tests passed (13 cases).\n'
