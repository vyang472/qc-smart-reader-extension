#!/bin/bash

set -euo pipefail

PYTHON="${QC_TEST_PYTHON:-/usr/bin/python3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEST_DIR_RAW="$(mktemp -d "${TMPDIR:-/tmp}/qc-install-lifecycle.XXXXXX")"
TEST_DIR="$(cd "$TEST_DIR_RAW" && pwd -P)"
TEST_HOME="$TEST_DIR/home"
STATE_DIR="$TEST_DIR/launch-state"
VALID_TOKEN='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-'
PORT=""

fail_test() {
  printf '[FAIL] %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  file="$1"
  expected="$2"
  grep -F -- "$expected" "$file" >/dev/null || fail_test "Expected '$expected' in $file"
}

assert_not_contains() {
  file="$1"
  unexpected="$2"
  if grep -F -- "$unexpected" "$file" >/dev/null; then
    fail_test "Did not expect '$unexpected' in $file"
  fi
}

stop_fixture_service() {
  if [ -x "$TEST_DIR/launchctl" ]; then
    QC_TEST_LAUNCH_STATE="$STATE_DIR" "$TEST_DIR/launchctl" bootout "gui/$(id -u)/com.qcsmartreader.companion" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  stop_fixture_service
  if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
    find "$TEST_DIR" -depth -delete
  fi
}
trap cleanup EXIT INT TERM

[ "${#VALID_TOKEN}" -eq 43 ] || fail_test "Fixture token must be exactly 43 URL-safe characters"
"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' \
  || fail_test "Tests require Python 3.9+"

mkdir -p "$TEST_HOME" "$STATE_DIR"
PORT="$("$PYTHON" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
RUNTIME_FIXTURE="$TEST_DIR/runtime-fixture"
"$PYTHON" "$ROOT/companion_service/verify_runtime.py" "$ROOT/requirements.txt" \
  "$ROOT/companion_service/runtime_manifest.json" >/dev/null \
  || fail_test "The lifecycle fixture Python must contain the trusted locked runtime"
"$PYTHON" - "$RUNTIME_FIXTURE" <<'PY'
import importlib.metadata
import shutil
import sys
from pathlib import Path, PurePosixPath

destination = Path(sys.argv[1])
destination.mkdir(parents=True)
for name in ("pypdf", "typing_extensions"):
    distribution = importlib.metadata.distribution(name)
    for entry in distribution.files or ():
        relative = PurePosixPath(entry.as_posix())
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"unsafe runtime fixture path: {relative}")
        source = Path(distribution.locate_file(entry))
        if not source.is_file() or source.is_symlink():
            continue
        target = destination.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
PY

LAUNCHCTL_LOG="$TEST_DIR/launchctl.log"
PIP_LOG="$TEST_DIR/pip.log"
CLIPBOARD="$TEST_DIR/clipboard.txt"

cat >"$TEST_DIR/launchctl" <<'SH'
#!/bin/bash
set -u
state="${QC_TEST_LAUNCH_STATE:?}"
mkdir -p "$state"
printf '%s\n' "$*" >>"$state/launchctl.log"
command_name="${1:-}"
pid_file="$state/pid"

stop_process() {
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file")"
    case "$pid" in ''|*[!0-9]*) ;; *) kill "$pid" 2>/dev/null || true ;; esac
    attempt=0
    while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 40 ]; do
      sleep 0.05
      attempt=$((attempt + 1))
    done
    kill -9 "$pid" 2>/dev/null || true
    unlink "$pid_file" 2>/dev/null || true
  fi
}

case "$command_name" in
  bootout)
    has_wait=0
    for argument in "$@"; do [ "$argument" = "--wait" ] && has_wait=1; done
    if [ "${QC_TEST_BOOTOUT_HANG:-0}" = "1" ]; then
      while [ ! -e "$state/release-bootout-hang" ]; do sleep 0.1; done
      exit 1
    fi
    if [ "$has_wait" -eq 1 ]; then
      sleep "${QC_TEST_BOOTOUT_DELAY:-0}"
      stop_process
    else
      (sleep "${QC_TEST_BOOTOUT_DELAY:-0}"; stop_process) &
    fi
    exit 0
    ;;
  print)
    [ -f "$pid_file" ] || exit 1
    pid="$(cat "$pid_file")"
    kill -0 "$pid" 2>/dev/null
    exit $?
    ;;
  bootstrap)
    plist=""
    for argument in "$@"; do plist="$argument"; done
    [ -f "$plist" ] || exit 1
    [ ! -f "$pid_file" ] || exit 1
    /usr/bin/python3 - "$plist" "$pid_file" <<'PY'
import os
import plistlib
import subprocess
import sys

with open(sys.argv[1], "rb") as handle:
    payload = plistlib.load(handle)
stdout = open(payload["StandardOutPath"], "ab", buffering=0)
stderr = open(payload["StandardErrorPath"], "ab", buffering=0)
process = subprocess.Popen(
    payload["ProgramArguments"],
    cwd=payload["WorkingDirectory"],
    stdout=stdout,
    stderr=stderr,
    start_new_session=True,
)
with open(sys.argv[2], "w", encoding="ascii") as handle:
    handle.write(f"{process.pid}\n")
PY
    exit $?
    ;;
  kickstart)
    [ -f "$pid_file" ] || exit 1
    pid="$(cat "$pid_file")"
    kill -0 "$pid" 2>/dev/null
    exit $?
    ;;
esac
exit 1
SH
chmod +x "$TEST_DIR/launchctl"
ln -s "$STATE_DIR/launchctl.log" "$LAUNCHCTL_LOG"

cat >"$TEST_DIR/pip" <<'SH'
#!/bin/bash
set -eu
venv_python="$1"
shift
printf '%s\n' "$*" >>"${QC_TEST_PIP_LOG:?}"
case " ${*} " in
  *" install "*)
    case " ${*} " in *" --require-hashes "*) ;; *) exit 91 ;; esac
    case " ${*} " in *" --only-binary=:all: "*) ;; *) exit 92 ;; esac
    site_dir="$("$venv_python" -c 'import site; print(site.getsitepackages()[0])')"
    if [ "${QC_TEST_PIP_PARTIAL_FAIL:-0}" = "1" ]; then
      exit 73
    fi
    find "$site_dir" -maxdepth 1 -type d -name 'pypdf' -depth -delete 2>/dev/null || true
    find "$site_dir" -maxdepth 1 -type d -name 'pypdf-*.dist-info' -depth -delete 2>/dev/null || true
    find "$site_dir" -maxdepth 1 -type d -name 'typing_extensions-*.dist-info' -depth -delete 2>/dev/null || true
    find "$site_dir" -maxdepth 1 -type f -name 'typing_extensions.py' -delete 2>/dev/null || true
    cp -R "${QC_TEST_RUNTIME_FIXTURE:?}/." "$site_dir/"
    ;;
  *" check "*) ;;
esac
SH
chmod +x "$TEST_DIR/pip"

cat >"$TEST_DIR/pbcopy" <<'SH'
#!/bin/bash
set -eu
tee "${QC_TEST_CLIPBOARD:?}" >/dev/null
SH
chmod +x "$TEST_DIR/pbcopy"

make_release() {
  destination="$1"
  marker="$2"
  app_value="$3"
  service_version="$4"
  api_version="$5"
  schema_version="$6"
  configured_token="$7"
  rotate_token="$8"
  mkdir -p "$destination/companion_service"
  cp "$ROOT/install.command" "$destination/install.command"
  cp "$ROOT/uninstall.command" "$destination/uninstall.command"
  cp "$ROOT/LICENSE" "$destination/LICENSE"
  cp "$ROOT/PRIVACY.md" "$destination/PRIVACY.md"
  cp "$ROOT/requirements.txt" "$destination/requirements.txt"
  cp "$ROOT/requirements.lock" "$destination/requirements.lock"
  cp "$ROOT/companion_service/verify_runtime.py" "$destination/companion_service/verify_runtime.py"
  cp "$ROOT/companion_service/runtime_manifest.json" "$destination/companion_service/runtime_manifest.json"
  cp "$ROOT/companion_service/pdf_extract_worker.py" "$destination/companion_service/pdf_extract_worker.py"
  cp "$ROOT/companion_service/pdf_ocr_worker.swift" "$destination/companion_service/pdf_ocr_worker.swift"
  chmod +x "$destination/install.command" "$destination/uninstall.command"
  INSTALLER_PATH="$destination/install.command" INSTALLER_VERSION="$service_version" INSTALLER_API="$api_version" "$PYTHON" - <<'PY'
import os
import re
from pathlib import Path
path = Path(os.environ["INSTALLER_PATH"])
text = path.read_text(encoding="utf-8")
text, count = re.subn(
    r'^REQUIRED_SERVICE_VERSION="[^"]+"$',
    f'REQUIRED_SERVICE_VERSION="{os.environ["INSTALLER_VERSION"]}"',
    text,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit(1)
text, count = re.subn(
    r'^REQUIRED_API_VERSION="[^"]+"$',
    f'REQUIRED_API_VERSION="{os.environ["INSTALLER_API"]}"',
    text,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit(1)
path.write_text(text, encoding="utf-8")
PY
  {
    printf 'FIXTURE_RELEASE = %s\n' "$(printf '%s' "$marker" | "$PYTHON" -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    printf 'APP_VALUE = %s\n' "$(printf '%s' "$app_value" | "$PYTHON" -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    printf 'SERVICE_VERSION = %s\n' "$(printf '%s' "$service_version" | "$PYTHON" -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    printf 'API_VERSION = %s\n' "$api_version"
    printf 'SCHEMA_VERSION = %s\n' "$schema_version"
    printf 'CONFIGURED_TOKEN = %s\n' "$(printf '%s' "$configured_token" | "$PYTHON" -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    printf 'ROTATE_TOKEN = %s\n' "$rotate_token"
    cat <<'PY'
import argparse
import json
import secrets
import signal
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--host", required=True)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--data-dir", type=Path, required=True)
args = parser.parse_args()
data_dir = args.data_dir.resolve()
state_dir = data_dir / "state"
vault_dir = data_dir / "vault"
state_dir.mkdir(parents=True, exist_ok=True)
vault_dir.mkdir(parents=True, exist_ok=True)
token_path = state_dir / "pairing_token.txt"
if ROTATE_TOKEN or not token_path.exists():
    token_path.write_text(CONFIGURED_TOKEN + "\n", encoding="ascii")
token_path.chmod(0o600)
TOKEN = token_path.read_text(encoding="ascii").strip()
settings_path = state_dir / "model_settings.json"
if FIXTURE_RELEASE == "release-bad":
    settings_path.write_text('{"provider":"candidate-bad"}\n', encoding="utf-8")
    settings_path.chmod(0o600)
db_path = state_dir / "qc_smart_reader.sqlite3"
with sqlite3.connect(db_path) as database:
    current_schema = int(database.execute("PRAGMA user_version").fetchone()[0])
    if current_schema > SCHEMA_VERSION and FIXTURE_RELEASE != "release-bad":
        raise RuntimeError(f"schema {current_schema} is newer than supported {SCHEMA_VERSION}")
    database.execute("CREATE TABLE IF NOT EXISTS lifecycle_fixture(value TEXT NOT NULL)")
    if database.execute("SELECT COUNT(*) FROM lifecycle_fixture").fetchone()[0] == 0:
        database.execute("INSERT INTO lifecycle_fixture(value) VALUES (?)", (FIXTURE_RELEASE,))
    if FIXTURE_RELEASE == "release-bad":
        database.execute("CREATE TABLE IF NOT EXISTS candidate_mutations(value TEXT NOT NULL)")
        database.execute("INSERT INTO candidate_mutations(value) VALUES ('must be rolled back')")
        database.execute("PRAGMA user_version=99")
    else:
        database.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

health = {
    "ok": True,
    "app": APP_VALUE,
    "version": SERVICE_VERSION,
    "service_version": SERVICE_VERSION,
    "api_version": API_VERSION,
    "schema_version": SCHEMA_VERSION,
    "min_extension_version": SERVICE_VERSION,
    "data_dir": str(data_dir),
    "vault_dir": str(vault_dir),
    "pairing_required": True,
    "pairing_token_path": str(token_path),
    "db_path": str(db_path),
}

class Server(ThreadingHTTPServer):
    allow_reuse_address = True

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, health)
        elif self.path == "/v1/projects":
            supplied = self.headers.get("x-qc-pairing-token", "")
            if secrets.compare_digest(supplied, TOKEN):
                self.send_json(200, {"ok": True, "projects": []})
            else:
                self.send_json(403, {"ok": False, "error": "invalid pairing token"})
        else:
            self.send_json(404, {"ok": False})

    def log_message(self, *_args):
        pass

server = Server((args.host, args.port), Handler)
signal.signal(signal.SIGTERM, lambda *_args: raise_signal_exit())

def raise_signal_exit():
    raise SystemExit(0)

server.serve_forever()
PY
  } >"$destination/companion_service/server.py"
}

GOOD_V1="$TEST_DIR/release-v1"
GOOD_V2="$TEST_DIR/release-v2"
BAD_RELEASE="$TEST_DIR/release-bad"
BAD_TOKEN='0123456789abcdefghijklmnopqrstuvwxyzABCDE_-'
[ "${#BAD_TOKEN}" -eq 43 ] || fail_test "Bad fixture token must be exactly 43 URL-safe characters"
make_release "$GOOD_V1" "release-v1" "QC Smart Reader" "0.8.0" 1 1 "$VALID_TOKEN" False
make_release "$GOOD_V2" "release-v2" "QC Smart Reader" "0.9.0" 1 2 "$VALID_TOKEN" False
make_release "$BAD_RELEASE" "release-bad" "Wrong Local Service" "0.9.1" 2 99 "$BAD_TOKEN" True

run_install() {
  release_dir="$1"
  output="$2"
  shift 2
  set +e
  env \
    HOME="$TEST_HOME" \
    QC_INSTALL_NO_PAUSE=1 \
    QC_INSTALL_PYTHON="$PYTHON" \
    QC_INSTALL_LAUNCHCTL="$TEST_DIR/launchctl" \
    QC_INSTALL_PIP="$TEST_DIR/pip" \
    QC_INSTALL_PBCOPY="$TEST_DIR/pbcopy" \
    QC_INSTALL_PORT="$PORT" \
    QC_INSTALL_HEALTH_ATTEMPTS=30 \
    QC_INSTALL_HEALTH_INTERVAL=0.05 \
    QC_INSTALL_BOOTOUT_ATTEMPTS=50 \
    QC_TEST_LAUNCH_STATE="$STATE_DIR" \
    QC_TEST_PIP_LOG="$PIP_LOG" \
    QC_TEST_RUNTIME_FIXTURE="$RUNTIME_FIXTURE" \
    QC_TEST_CLIPBOARD="$CLIPBOARD" \
    "$@" \
    bash "$release_dir/install.command" >"$output" 2>&1
  INSTALL_EXIT=$?
  set -e
}

run_uninstall() {
  script_path="$1"
  output="$2"
  shift 2
  set +e
  env \
    HOME="$TEST_HOME" \
    QC_UNINSTALL_LAUNCHCTL="$TEST_DIR/launchctl" \
    QC_TEST_LAUNCH_STATE="$STATE_DIR" \
    "$@" \
    bash "$script_path" >"$output" 2>&1
  UNINSTALL_EXIT=$?
  set -e
}

run_interactive_purge() {
  script_path="$1"
  confirmation="$2"
  output="$3"
  set +e
  QC_EXPECT_HOME="$TEST_HOME" \
  QC_EXPECT_LAUNCHCTL="$TEST_DIR/launchctl" \
  QC_EXPECT_LAUNCH_STATE="$STATE_DIR" \
  QC_EXPECT_SCRIPT="$script_path" \
  QC_EXPECT_CONFIRMATION="$confirmation" \
  QC_EXPECT_OUTPUT="$output" \
  /usr/bin/expect <<'EXPECT'
set timeout 20
log_file -noappend $env(QC_EXPECT_OUTPUT)
spawn /usr/bin/env \
  HOME=$env(QC_EXPECT_HOME) \
  QC_UNINSTALL_LAUNCHCTL=$env(QC_EXPECT_LAUNCHCTL) \
  QC_UNINSTALL_NO_PAUSE=1 \
  QC_TEST_LAUNCH_STATE=$env(QC_EXPECT_LAUNCH_STATE) \
  /bin/bash $env(QC_EXPECT_SCRIPT) --purge-data
expect {
  "to continue:" { send -- "$env(QC_EXPECT_CONFIRMATION)\r" }
  timeout { exit 124 }
  eof { }
}
expect eof
set result [wait]
exit [lindex $result 3]
EXPECT
  PURGE_EXIT=$?
  set -e
}

APP_ROOT="$TEST_HOME/Library/Application Support/QC Smart Reader"
CURRENT="$APP_ROOT/current"
PLIST="$TEST_HOME/Library/LaunchAgents/com.qcsmartreader.companion.plist"
VAULT="$TEST_HOME/Documents/QC Smart Reader Vault"
DB="$VAULT/state/qc_smart_reader.sqlite3"

printf '[1/10] Fresh install copies allowlisted runtime files, builds an isolated venv, and authenticates token delivery\n'
first_output="$TEST_DIR/install-first.out"
run_install "$GOOD_V1" "$first_output"
[ "$INSTALL_EXIT" -eq 0 ] || { sed -n '1,240p' "$first_output" >&2; fail_test "Fresh install failed"; }
[ -d "$CURRENT" ] || fail_test "Current runtime was not installed"
[ -f "$PLIST" ] || fail_test "LaunchAgent plist was not installed"
[ -f "$DB" ] || fail_test "Fixture database was not created"
assert_contains "$CURRENT/companion_service/server.py" 'FIXTURE_RELEASE = "release-v1"'
assert_contains "$first_output" "QC Smart Reader companion is installed and authenticated"
assert_contains "$first_output" "Pairing Token   $VALID_TOKEN"
[ "$(cat "$CLIPBOARD")" = "$VALID_TOKEN" ] || fail_test "Trusted token was not copied after authentication"
actual_files="$(cd "$CURRENT" && find . -path './venv' -prune -o -type f -print | sort)"
expected_files="$(printf '%s\n' './LICENSE' './PRIVACY.md' './companion_service/pdf_extract_worker.py' './companion_service/pdf_ocr_worker.swift' './companion_service/runtime_manifest.json' './companion_service/server.py' './companion_service/verify_runtime.py' './requirements.lock' './requirements.txt' './uninstall.command' | sort)"
[ "$actual_files" = "$expected_files" ] || fail_test "Installed runtime escaped the explicit file allowlist"
[ -x "$CURRENT/venv/bin/python" ] || fail_test "Installed runtime does not own its isolated virtualenv"
assert_contains "$PIP_LOG" "--require-hashes --only-binary=:all:"
"$PYTHON" - "$PLIST" "$CURRENT" "$PORT" <<'PY'
import plistlib
import sys
with open(sys.argv[1], "rb") as handle:
    payload = plistlib.load(handle)
assert payload["Label"] == "com.qcsmartreader.companion"
assert payload["WorkingDirectory"] == sys.argv[2]
assert payload["ProgramArguments"][2:6] == ["--host", "127.0.0.1", "--port", sys.argv[3]]
assert payload["ProgramArguments"][6] == "--data-dir"
assert payload["EnvironmentVariables"]["PYTHONDONTWRITEBYTECODE"] == "1"
PY

printf '[2/10] Partial pip failure is contained entirely inside candidate and never stops or mutates current\n'
partial_output="$TEST_DIR/install-partial-pip.out"
run_install "$GOOD_V2" "$partial_output" QC_TEST_PIP_PARTIAL_FAIL=1
[ "$INSTALL_EXIT" -ne 0 ] || fail_test "Partial pip failure must block the candidate"
assert_contains "$CURRENT/companion_service/server.py" 'FIXTURE_RELEASE = "release-v1"'
curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" | "$PYTHON" -c 'import json,sys; assert json.load(sys.stdin)["service_version"] == "0.8.0"'
[ -x "$CURRENT/venv/bin/python" ] || fail_test "Partial pip failure damaged the installed virtualenv"

printf '[3/10] Cross-version upgrade waits for asynchronous bootout, verifies DB backup, and atomically activates\n'
second_output="$TEST_DIR/install-upgrade.out"
run_install "$GOOD_V2" "$second_output" QC_TEST_BOOTOUT_DELAY=0.2
[ "$INSTALL_EXIT" -eq 0 ] || { sed -n '1,240p' "$second_output" >&2; fail_test "Idempotent upgrade failed"; }
assert_contains "$CURRENT/companion_service/server.py" 'FIXTURE_RELEASE = "release-v2"'
assert_contains "$second_output" "Verified database backup:"
assert_contains "$LAUNCHCTL_LOG" "bootout --wait"
backup_count="$(find "$VAULT/state/backups" -type f -name '*.bak' | wc -l | tr -d ' ')"
[ "$backup_count" -ge 1 ] || fail_test "Upgrade did not retain a verified database backup"
for backup in "$VAULT"/state/backups/*.bak; do
  "$PYTHON" - "$backup" <<'PY'
import sqlite3
import sys
with sqlite3.connect(sys.argv[1]) as database:
    assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
PY
done
printf '%s\n' '{"provider":"stable-old"}' >"$VAULT/state/model_settings.json"
chmod 600 "$VAULT/state/model_settings.json"

printf '[4/10] Failed readiness restores previous version/API, schema, token, settings, plist, venv, and service\n'
unlink "$CLIPBOARD"
failed_output="$TEST_DIR/install-failed.out"
run_install "$BAD_RELEASE" "$failed_output"
[ "$INSTALL_EXIT" -ne 0 ] || fail_test "An invalid health identity must fail installation"
assert_contains "$failed_output" "Previous installation restored and restarted"
assert_not_contains "$failed_output" "Pairing Token   $VALID_TOKEN"
[ ! -e "$CLIPBOARD" ] || fail_test "Failed candidate must not copy a token"
assert_contains "$CURRENT/companion_service/server.py" 'FIXTURE_RELEASE = "release-v2"'
curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" | "$PYTHON" -c 'import json,sys; assert json.load(sys.stdin)["app"] == "QC Smart Reader"'
[ "$(cat "$VAULT/state/pairing_token.txt")" = "$VALID_TOKEN" ] || fail_test "Rollback did not restore the previous pairing token"
assert_contains "$VAULT/state/model_settings.json" 'stable-old'
"$PYTHON" - "$DB" <<'PY'
import sqlite3
import sys
with sqlite3.connect(sys.argv[1]) as database:
    mutation_table = database.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='candidate_mutations'"
    ).fetchone()[0]
assert mutation_table == 0, "failed candidate database mutation survived rollback"
assert database.execute("PRAGMA user_version").fetchone()[0] == 2
PY

printf '[5/10] TERM during the post-swap window performs rollback and never deletes the only previous runtime\n'
signal_output="$TEST_DIR/install-signal.out"
env \
  HOME="$TEST_HOME" \
  QC_INSTALL_NO_PAUSE=1 \
  QC_INSTALL_PYTHON="$PYTHON" \
  QC_INSTALL_LAUNCHCTL="$TEST_DIR/launchctl" \
  QC_INSTALL_PIP="$TEST_DIR/pip" \
  QC_INSTALL_PBCOPY="$TEST_DIR/pbcopy" \
  QC_INSTALL_PORT="$PORT" \
  QC_INSTALL_HEALTH_ATTEMPTS=100 \
  QC_INSTALL_HEALTH_INTERVAL=0.1 \
  QC_INSTALL_BOOTOUT_ATTEMPTS=50 \
  QC_TEST_LAUNCH_STATE="$STATE_DIR" \
  QC_TEST_PIP_LOG="$PIP_LOG" \
  QC_TEST_RUNTIME_FIXTURE="$RUNTIME_FIXTURE" \
  QC_TEST_CLIPBOARD="$CLIPBOARD" \
  bash "$BAD_RELEASE/install.command" >"$signal_output" 2>&1 &
signal_installer_pid=$!
signal_ready=0
for _ in $(seq 1 100); do
  if [ -f "$CURRENT/companion_service/server.py" ] \
    && grep -F 'FIXTURE_RELEASE = "release-bad"' "$CURRENT/companion_service/server.py" >/dev/null 2>&1; then
    signal_ready=1
    break
  fi
  sleep 0.05
done
[ "$signal_ready" -eq 1 ] || fail_test "Signal fixture never reached the post-swap window"
kill -TERM "$signal_installer_pid"
set +e
wait "$signal_installer_pid"
signal_exit=$?
set -e
[ "$signal_exit" -ne 0 ] || fail_test "Interrupted upgrade must not report success"
assert_contains "$signal_output" "Previous installation restored and restarted"
assert_contains "$CURRENT/companion_service/server.py" 'FIXTURE_RELEASE = "release-v2"'
[ "$(find "$APP_ROOT" -maxdepth 1 -name '.previous-*' | wc -l | tr -d ' ')" -eq 0 ] \
  || fail_test "Signal rollback left an ambiguous previous runtime"
curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" | "$PYTHON" -c 'import json,sys; assert json.load(sys.stdin)["service_version"] == "0.9.0"'

printf '[6/10] Uninstall timeout preserves live runtime, LaunchAgent, and Vault instead of racing deletion\n'
uninstall_source="$GOOD_V2/uninstall.command"
timeout_output="$TEST_DIR/uninstall-timeout.out"
run_uninstall "$uninstall_source" "$timeout_output" \
  QC_UNINSTALL_NO_PAUSE=1 QC_UNINSTALL_BOOTOUT_ATTEMPTS=2 QC_TEST_BOOTOUT_HANG=1
[ "$UNINSTALL_EXIT" -ne 0 ] || fail_test "A hung bootout must block uninstall"
[ -d "$APP_ROOT" ] && [ -f "$PLIST" ] && [ -f "$DB" ] || fail_test "Bootout timeout removed a live lifecycle path"
curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null \
  || fail_test "Bootout timeout terminated the managed service unexpectedly"

printf '[7/10] Default uninstall waits for delayed bootout, removes runtime, and preserves the Vault\n'
preserve_output="$TEST_DIR/uninstall-preserve.out"
run_uninstall "$uninstall_source" "$preserve_output" \
  QC_UNINSTALL_NO_PAUSE=1 QC_UNINSTALL_BOOTOUT_ATTEMPTS=50 QC_TEST_BOOTOUT_DELAY=0.2
[ "$UNINSTALL_EXIT" -eq 0 ] || { sed -n '1,200p' "$preserve_output" >&2; fail_test "Default uninstall failed"; }
[ ! -e "$APP_ROOT" ] || fail_test "Default uninstall left the managed runtime"
[ ! -e "$PLIST" ] || fail_test "Default uninstall left the LaunchAgent"
[ -f "$DB" ] || fail_test "Default uninstall removed Vault data"
assert_contains "$preserve_output" "Vault data was preserved"

printf '[8/10] Purge refuses a non-interactive caller before changing runtime or data\n'
reinstall_output="$TEST_DIR/reinstall.out"
run_install "$GOOD_V2" "$reinstall_output"
[ "$INSTALL_EXIT" -eq 0 ] || { sed -n '1,240p' "$reinstall_output" >&2; fail_test "Reinstall before purge test failed"; }
noninteractive_output="$TEST_DIR/purge-noninteractive.out"
set +e
printf '%s\n' 'DELETE QC SMART READER VAULT' | env \
  HOME="$TEST_HOME" \
  QC_UNINSTALL_LAUNCHCTL="$TEST_DIR/launchctl" \
  QC_UNINSTALL_NO_PAUSE=1 \
  QC_TEST_LAUNCH_STATE="$STATE_DIR" \
  bash "$uninstall_source" --purge-data >"$noninteractive_output" 2>&1
noninteractive_exit=$?
set -e
[ "$noninteractive_exit" -ne 0 ] || fail_test "Non-interactive purge must be refused"
[ -d "$APP_ROOT" ] && [ -f "$DB" ] || fail_test "Non-interactive purge changed runtime or Vault data"
assert_contains "$noninteractive_output" "requires an interactive terminal"

printf '[9/10] Interactive purge refuses non-exact confirmation without changing runtime or data\n'
refusal_output="$TEST_DIR/purge-refusal.out"
run_interactive_purge "$uninstall_source" "delete it" "$refusal_output" >/dev/null 2>&1
[ "$PURGE_EXIT" -ne 0 ] || fail_test "Non-exact purge confirmation must be refused"
[ -d "$APP_ROOT" ] && [ -f "$DB" ] || fail_test "Purge refusal changed runtime or Vault data"
assert_contains "$refusal_output" "nothing was removed"

printf '[10/10] Exact interactive purge confirmation removes only validated runtime and Vault paths\n'
purge_output="$TEST_DIR/purge-confirmed.out"
run_interactive_purge "$uninstall_source" "DELETE QC SMART READER VAULT" "$purge_output" >/dev/null 2>&1
[ "$PURGE_EXIT" -eq 0 ] || { sed -n '1,200p' "$purge_output" >&2; fail_test "Confirmed purge failed"; }
[ ! -e "$APP_ROOT" ] && [ ! -e "$PLIST" ] && [ ! -e "$VAULT" ] \
  || fail_test "Confirmed purge left a managed lifecycle path"
assert_contains "$purge_output" "runtime and Vault data were removed"

printf 'install lifecycle tests passed (10 cases).\n'
