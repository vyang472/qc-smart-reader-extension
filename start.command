#!/bin/bash
# QC Smart Reader — one-command start for the companion service.
#
# macOS: double-click this file in Finder, or run `bash start.command`.
# Any extra arguments are passed straight through to the service, e.g.
#   bash start.command --data-dir "$HOME/Documents/QC Vault Test"
#
# What it does:
#   1. picks a usable Python (3.9+)
#   2. creates a local .venv and installs requirements.txt into it
#   3. starts the service, waits for /health, and prints the pairing token
#      you need to paste into the extension's settings panel

set -u
umask 077

# Finder-launched .command files inherit a minimal PATH and normally cannot see
# Homebrew-installed tools such as codex or yt-dlp. Add only known, existing
# absolute directories; QC_START_TOOL_PATH is a colon-separated test/operator
# override and is never evaluated as shell code.
prepend_tool_dir() {
  tool_dir="$1"
  [ -n "$tool_dir" ] || return 0
  case "$tool_dir" in
    /*) ;;
    *) return 0 ;;
  esac
  [ -d "$tool_dir" ] || return 0
  case ":${PATH:-}:" in
    *":$tool_dir:"*) return 0 ;;
  esac
  PATH="$tool_dir${PATH:+:$PATH}"
}

prepend_tool_dir "/usr/local/bin"
prepend_tool_dir "/opt/homebrew/bin"
if [ -n "${QC_START_TOOL_PATH:-}" ]; then
  old_ifs="$IFS"
  case "$-" in
    *f*) restore_globbing=0 ;;
    *) set -f; restore_globbing=1 ;;
  esac
  IFS=:
  for tool_dir in $QC_START_TOOL_PATH; do
    prepend_tool_dir "$tool_dir"
  done
  IFS="$old_ifs"
  [ "$restore_globbing" -eq 0 ] || set +f
fi
export PATH

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR" || exit 1

VENV_DIR="${QC_START_VENV_DIR:-$REPO_DIR/.venv}"
SERVER="${QC_START_SERVER:-$REPO_DIR/companion_service/server.py}"
RUNTIME_VERIFIER="$REPO_DIR/companion_service/verify_runtime.py"
RUNTIME_MANIFEST="$REPO_DIR/companion_service/runtime_manifest.json"
HOST="${QC_START_HOST:-127.0.0.1}"
PORT="${QC_START_PORT:-37621}"
REQUIRED_API_VERSION=1
REQUIRED_SERVICE_CAPABILITY="selection_first_evidence_v1"
REQUESTED_DATA_DIR=""
HEALTH_ATTEMPTS="${QC_START_HEALTH_ATTEMPTS:-40}"
HEALTH_INTERVAL="${QC_START_HEALTH_INTERVAL:-0.5}"
SERVER_PID=""
CLIPBOARD_AVAILABLE=0

# Honour --host/--port if the user passed them through, so the health probe
# below checks the address the service actually binds.
prev=""
for arg in "$@"; do
  case "$prev" in
    --host) HOST="$arg" ;;
    --port) PORT="$arg" ;;
    --data-dir) REQUESTED_DATA_DIR="$arg" ;;
  esac
  case "$arg" in
    --host=*) HOST="${arg#--host=}" ;;
    --port=*) PORT="${arg#--port=}" ;;
    --data-dir=*) REQUESTED_DATA_DIR="${arg#--data-dir=}" ;;
  esac
  prev="$arg"
done

say() { printf '%s\n' "$*"; }

pause_if_interactive() {
  if [ "${QC_START_NO_PAUSE:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Press Return to close." _ 2>/dev/null || true
  fi
}

cleanup_owned_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

fail() {
  cleanup_owned_server
  printf '\n[x] %s\n' "$*" >&2
  pause_if_interactive
  exit 1
}

# ---------------------------------------------------------------- 1. Python --
PYTHON=""
if [ -n "${QC_START_PYTHON:-}" ]; then
  if command -v "$QC_START_PYTHON" >/dev/null 2>&1 \
    && "$QC_START_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PYTHON="$QC_START_PYTHON"
  else
    fail "QC_START_PYTHON is not a usable Python 3.9+: $QC_START_PYTHON"
  fi
else
  for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
        PYTHON="$candidate"
        break
      fi
    fi
  done
fi
[ -n "$PYTHON" ] || fail "No Python 3.9+ found. Install one with: brew install python@3.12  (or xcode-select --install)"
say "[1/4] Python: $("$PYTHON" -V 2>&1)  ($(command -v "$PYTHON"))"

HEALTH_URL="http://$HOST:$PORT/health"
PROJECTS_URL="http://$HOST:$PORT/v1/projects"

fetch_health() {
  health_result="$(curl -sS --max-time 2 -w $'\n%{http_code}' "$HEALTH_URL" 2>/dev/null)" || return 0
  health_status="${health_result##*$'\n'}"
  case "$health_status" in
    2??) printf '%s' "${health_result%$'\n'*}" ;;
  esac
}

is_qc_api_health() {
  printf '%s' "$1" | "$PYTHON" -c '
import json
import sys
try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
valid = (
    isinstance(payload, dict)
    and payload.get("ok") is True
    and payload.get("app") == "QC Smart Reader"
    and type(payload.get("api_version")) is int
    and payload.get("api_version") == int(sys.argv[1])
)
raise SystemExit(0 if valid else 1)
' "$REQUIRED_API_VERSION" >/dev/null 2>&1
}

has_required_service_capability() {
  printf '%s' "$1" | "$PYTHON" -c '
import json
import sys
try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
capabilities = payload.get("capabilities")
valid = (
    isinstance(capabilities, list)
    and sys.argv[1] in capabilities
)
raise SystemExit(0 if valid else 1)
' "$REQUIRED_SERVICE_CAPABILITY" >/dev/null 2>&1
}

is_qc_health() {
  is_qc_api_health "$1" && has_required_service_capability "$1"
}

health_field() {
  printf '%s' "$1" | "$PYTHON" -c '
import json
import sys
payload = json.load(sys.stdin)
value = payload.get(sys.argv[1], "")
print(value if isinstance(value, str) else "")
' "$2"
}

resolved_path() {
  "$PYTHON" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).expanduser().resolve())' "$1"
}

# Validate every filesystem claim before opening the token file. The Python
# helper uses lstat/O_NOFOLLOW and checks ownership and permissions so a
# lookalike listener cannot point this launcher at an arbitrary local file.
validate_pairing_metadata() {
  printf '%s' "$1" | "$PYTHON" -c '
import json
import os
import re
import stat
import sys
from pathlib import Path

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)

def trusted_path(name):
    value = payload.get(name)
    if not isinstance(value, str) or not value or any(c in value for c in "\0\r\n\t"):
        raise SystemExit(1)
    path = Path(value)
    if not path.is_absolute():
        raise SystemExit(1)
    # The real service emits resolved paths. Reject aliases, dot segments and
    # paths traversing symlinks rather than attempting to guess their intent.
    resolved = Path(os.path.realpath(str(path)))
    if value != str(resolved):
        raise SystemExit(1)
    return path

data_dir = trusted_path("data_dir")
vault_dir = trusted_path("vault_dir")
token_path = trusted_path("pairing_token_path")
if not data_dir.is_dir() or not vault_dir.is_dir():
    raise SystemExit(1)
if vault_dir != (data_dir / "vault"):
    raise SystemExit(1)
if token_path != (data_dir / "state" / "pairing_token.txt"):
    raise SystemExit(1)

try:
    path_stat = os.lstat(str(token_path))
except OSError:
    raise SystemExit(1)
if stat.S_ISLNK(path_stat.st_mode) or not stat.S_ISREG(path_stat.st_mode):
    raise SystemExit(1)
if path_stat.st_uid != os.getuid() or (stat.S_IMODE(path_stat.st_mode) & 0o077):
    raise SystemExit(1)
if path_stat.st_size < 43 or path_stat.st_size > 258:
    raise SystemExit(1)

flags = os.O_RDONLY
flags |= getattr(os, "O_CLOEXEC", 0)
flags |= getattr(os, "O_NOFOLLOW", 0)
flags |= getattr(os, "O_NONBLOCK", 0)
try:
    fd = os.open(str(token_path), flags)
except OSError:
    raise SystemExit(1)
try:
    opened_stat = os.fstat(fd)
    if (opened_stat.st_dev, opened_stat.st_ino) != (path_stat.st_dev, path_stat.st_ino):
        raise SystemExit(1)
    if not stat.S_ISREG(opened_stat.st_mode):
        raise SystemExit(1)
    if opened_stat.st_uid != os.getuid() or (stat.S_IMODE(opened_stat.st_mode) & 0o077):
        raise SystemExit(1)
    raw = os.read(fd, 259)
finally:
    os.close(fd)

try:
    text = raw.decode("ascii")
except UnicodeDecodeError:
    raise SystemExit(1)
match = re.fullmatch(r"([A-Za-z0-9_-]{43,256})(?:\r?\n)?", text)
if not match:
    raise SystemExit(1)
token = match.group(1)
print("\t".join((str(data_dir), str(vault_dir), str(token_path), token)))
' 2>/dev/null
}

is_projects_response() {
  printf '%s' "$1" | "$PYTHON" -c '
import json
import sys
try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
valid = isinstance(payload, dict) and payload.get("ok") is True and isinstance(payload.get("projects"), list)
raise SystemExit(0 if valid else 1)
' >/dev/null 2>&1
}

validate_health_and_auth() {
  health="$1"
  is_qc_health "$health" || return 1
  metadata="$(validate_pairing_metadata "$health")" || return 1
  old_ifs="$IFS"
  IFS="$(printf '\t')"
  read -r candidate_data_dir candidate_vault_dir candidate_token_path candidate_token <<EOF
$metadata
EOF
  IFS="$old_ifs"
  [ -n "$candidate_data_dir" ] && [ -n "$candidate_vault_dir" ] \
    && [ -n "$candidate_token_path" ] && [ -n "$candidate_token" ] || return 1

  projects_result="$(curl -sS --max-time 2 -w $'\n%{http_code}' \
    -H "x-qc-pairing-token: $candidate_token" "$PROJECTS_URL" 2>/dev/null)" || return 1
  projects_status="${projects_result##*$'\n'}"
  case "$projects_status" in
    2??) projects_response="${projects_result%$'\n'*}" ;;
    *) return 1 ;;
  esac
  is_projects_response "$projects_response" || return 1

  VALIDATED_DATA_DIR="$candidate_data_dir"
  VALIDATED_VAULT_DIR="$candidate_vault_dir"
  VALIDATED_TOKEN_PATH="$candidate_token_path"
  VALIDATED_TOKEN="$candidate_token"
  return 0
}

requested_data_dir_matches() {
  [ -z "$REQUESTED_DATA_DIR" ] && return 0
  requested_resolved="$(resolved_path "$REQUESTED_DATA_DIR" 2>/dev/null)" || return 1
  [ "$requested_resolved" = "$VALIDATED_DATA_DIR" ]
}

copy_pairing_token() {
  token="$1"
  [ -n "$token" ] || return 1
  clipboard_command="${QC_START_PBCOPY:-}"
  if [ -z "$clipboard_command" ] && command -v pbcopy >/dev/null 2>&1; then
    clipboard_command="$(command -v pbcopy)"
  fi
  [ -n "$clipboard_command" ] || return 1
  if ! command -v "$clipboard_command" >/dev/null 2>&1 && [ ! -x "$clipboard_command" ]; then
    return 1
  fi
  CLIPBOARD_AVAILABLE=1
  printf '%s' "$token" | "$clipboard_command"
}

print_pairing_info() {
  state_label="$1"
  [ -n "${VALIDATED_TOKEN:-}" ] && [ -n "${VALIDATED_VAULT_DIR:-}" ] || return 1

  say ""
  say "[4/4] $state_label Paste these two values into the extension side panel → 设置:"
  say "─────────────────────────────────────────────────────────────"
  say "  Companion URL   http://$HOST:$PORT"
  say "  Pairing Token   $VALIDATED_TOKEN"
  say "─────────────────────────────────────────────────────────────"
  say "  Vault           $VALIDATED_VAULT_DIR"
  if copy_pairing_token "$VALIDATED_TOKEN"; then
    say "  [✓] Pairing Token copied to clipboard."
  elif [ "$CLIPBOARD_AVAILABLE" -eq 1 ]; then
    say "  [!] Pairing Token was not copied: pbcopy failed."
  fi
}

# Reuse only a listener that proves it is this application, speaks the exact
# compatible API contract and required capability, and accepts its protected
# local credential. A foreign or legacy process must never be reused, read
# from, or terminated.
EXISTING_HEALTH="$(fetch_health)"
PORT_IN_USE=0
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PORT_IN_USE=1
fi
if [ "$PORT_IN_USE" -eq 1 ] || [ -n "$EXISTING_HEALTH" ]; then
  if validate_health_and_auth "$EXISTING_HEALTH"; then
    if ! requested_data_dir_matches; then
      requested_resolved="$(resolved_path "$REQUESTED_DATA_DIR" 2>/dev/null || printf '%s' "$REQUESTED_DATA_DIR")"
      fail "QC Smart Reader on port $PORT uses data dir '$VALIDATED_DATA_DIR', not requested '$requested_resolved'. Stop it or choose another --port."
    fi
    say "[2/4] Existing QC Smart Reader service found; reusing it."
    say "[3/4] No new service process was started."
    print_pairing_info "Service is already running."
    result=$?
    [ "$result" -eq 0 ] || fail "The existing QC service returned malformed pairing information."
    pause_if_interactive
    exit 0
  fi
  if is_qc_api_health "$EXISTING_HEALTH" \
    && ! has_required_service_capability "$EXISTING_HEALTH"; then
    fail "QC Smart Reader on port $PORT is missing required capability '$REQUIRED_SERVICE_CAPABILITY'. Update Companion from the same release, stop the old service, then rerun start.command (or choose another --port)."
  fi
  fail "Port $PORT is already in use, but its identity, secure pairing metadata, or authenticated API check is invalid. Stop that process or choose another --port."
fi

# ------------------------------------------------------------------ 2. venv --
if [ "${QC_START_SKIP_SETUP:-0}" = "1" ]; then
  say "[2/4] Environment setup skipped by QC_START_SKIP_SETUP."
  VENV_PY="$PYTHON"
else
  if [ ! -x "$VENV_DIR/bin/python" ]; then
    say "[2/4] Creating virtualenv at $VENV_DIR ..."
    "$PYTHON" -m venv "$VENV_DIR" || fail "Could not create .venv. Try: $PYTHON -m pip install --user virtualenv"
  else
    say "[2/4] Reusing existing .venv"
  fi
  VENV_PY="$VENV_DIR/bin/python"

  verify_locked_requirements() {
    [ -f "$RUNTIME_VERIFIER" ] && [ ! -L "$RUNTIME_VERIFIER" ] \
      && [ -f "$RUNTIME_MANIFEST" ] && [ ! -L "$RUNTIME_MANIFEST" ] \
      && "$VENV_PY" "$RUNTIME_VERIFIER" "$REPO_DIR/requirements.txt" "$RUNTIME_MANIFEST" >/dev/null 2>&1
  }

  if ! verify_locked_requirements; then
    say "      Installing exact locked requirements (PDF support) ..."
    "$VENV_PY" -m pip install -q --disable-pip-version-check --upgrade --force-reinstall \
      --require-hashes --only-binary=:all: -r "$REPO_DIR/requirements.lock" \
      || fail "Could not install the locked Python requirements. Check the network, then rerun start.command."
    "$VENV_PY" -m pip check >/dev/null 2>&1 \
      || fail "Installed Python requirements are inconsistent. Remove .venv and rerun start.command."
    verify_locked_requirements \
      || fail "Installed Python requirements do not match requirements.txt. Remove .venv and rerun start.command."
  fi
fi

# --------------------------------------------------------------- 3. service --
say "[3/4] Starting companion service on http://$HOST:$PORT ..."
"$VENV_PY" "$SERVER" --host "$HOST" --port "$PORT" "$@" &
SERVER_PID=$!

shutdown() {
  say ""
  say "Shutting down companion service ..."
  cleanup_owned_server
  pause_if_interactive
  exit 0
}
trap shutdown INT TERM
trap cleanup_owned_server EXIT

HEALTH=""
case "$HEALTH_ATTEMPTS" in
  ''|*[!0-9]*) fail "QC_START_HEALTH_ATTEMPTS must be a positive integer." ;;
  0) fail "QC_START_HEALTH_ATTEMPTS must be a positive integer." ;;
esac
for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    fail "The service exited during startup. Scroll up for the Python error."
  fi
  CANDIDATE_HEALTH="$(fetch_health)"
  if [ -n "$CANDIDATE_HEALTH" ]; then
    if validate_health_and_auth "$CANDIDATE_HEALTH"; then
      HEALTH="$CANDIDATE_HEALTH"
      break
    fi
    fail "The new process answered $HEALTH_URL, but secure identity and pairing validation failed."
  fi
  sleep "$HEALTH_INTERVAL"
done
[ -n "$HEALTH" ] || fail "The service did not answer with a valid QC Smart Reader /health after $HEALTH_ATTEMPTS attempts."
if ! requested_data_dir_matches; then
  requested_resolved="$(resolved_path "$REQUESTED_DATA_DIR" 2>/dev/null || printf '%s' "$REQUESTED_DATA_DIR")"
  fail "The new service uses data dir '$VALIDATED_DATA_DIR', not requested '$requested_resolved'."
fi

# ------------------------------------------------------------- 4. pairing ----
print_pairing_info "Service is up." || fail "The service returned malformed pairing information."
say ""
say "Leave this window open. Press Control-C to stop the service."

wait "$SERVER_PID"
SERVER_EXIT=$?
SERVER_PID=""
trap - EXIT INT TERM
if [ "$SERVER_EXIT" -ne 0 ]; then
  printf '\n[x] Companion service exited with status %s.\n' "$SERVER_EXIT" >&2
  pause_if_interactive
  exit "$SERVER_EXIT"
fi
say "Companion service stopped."
pause_if_interactive
