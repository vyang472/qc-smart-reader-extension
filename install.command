#!/bin/bash
# Install or upgrade the QC Smart Reader companion service for the current
# macOS user. This script is shipped at the root of the companion release ZIP.

set -u
umask 077

APP_NAME="QC Smart Reader"
LABEL="com.qcsmartreader.companion"
HOST="127.0.0.1"
PORT="${QC_INSTALL_PORT:-37621}"
REQUIRED_API_VERSION="1"
REQUIRED_SERVICE_VERSION="0.9.3"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || exit 1
PYTHON=""
CANDIDATE=""
PREVIOUS=""
PLIST_BACKUP=""
BACKUP_PATH=""
STATE_SNAPSHOT=""
HAD_CURRENT=0
OLD_STOPPED=0
SWAPPED=0
COMMITTED=0
START_ATTEMPTED=0
DB_EXISTED_BEFORE=0
STATE_SNAPSHOT_READY=0
PREVIOUS_CONTRACT=""
PREVIOUS_TOKEN=""

say() { printf '%s\n' "$*"; }

pause_if_interactive() {
  if [ "${QC_INSTALL_NO_PAUSE:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Press Return to close." _ 2>/dev/null || true
  fi
}

fail_plain() {
  printf '\n[x] %s\n' "$*" >&2
  pause_if_interactive
  exit 1
}

[ -n "${HOME:-}" ] || fail_plain "HOME is not set."
case "$HOME" in
  /*) ;;
  *) fail_plain "HOME must be an absolute path." ;;
esac
[ -d "$HOME" ] && [ ! -L "$HOME" ] || fail_plain "HOME must be an existing, non-symlink directory."
HOME_ROOT="$(cd "$HOME" 2>/dev/null && pwd -P)" || fail_plain "Could not resolve HOME."
[ "$HOME_ROOT" != "/" ] || fail_plain "Refusing to install with HOME set to the filesystem root."

APP_ROOT="$HOME_ROOT/Library/Application Support/QC Smart Reader"
CURRENT="$APP_ROOT/current"
LOG_DIR="$APP_ROOT/logs"
PLIST_PATH="$HOME_ROOT/Library/LaunchAgents/$LABEL.plist"
DATA_DIR_INPUT="$HOME_ROOT/Documents/QC Smart Reader Vault"
DB_PATH_INPUT="$DATA_DIR_INPUT/state/qc_smart_reader.sqlite3"

LAUNCHCTL="${QC_INSTALL_LAUNCHCTL:-/bin/launchctl}"
CURL="${QC_INSTALL_CURL:-/usr/bin/curl}"
PLUTIL="${QC_INSTALL_PLUTIL:-/usr/bin/plutil}"
PBCOPY="${QC_INSTALL_PBCOPY:-}"
HEALTH_ATTEMPTS="${QC_INSTALL_HEALTH_ATTEMPTS:-60}"
HEALTH_INTERVAL="${QC_INSTALL_HEALTH_INTERVAL:-0.5}"
BOOTOUT_ATTEMPTS="${QC_INSTALL_BOOTOUT_ATTEMPTS:-100}"
USER_ID="$(id -u)"
DOMAIN="gui/$USER_ID"
SERVICE_TARGET="$DOMAIN/$LABEL"

case "$LAUNCHCTL" in /*) ;; *) fail_plain "launchctl must be an absolute path." ;; esac
case "$CURL" in /*) ;; *) fail_plain "curl must be an absolute path." ;; esac
case "$PLUTIL" in /*) ;; *) fail_plain "plutil must be an absolute path." ;; esac
[ -x "$LAUNCHCTL" ] || fail_plain "launchctl is unavailable: $LAUNCHCTL"
[ -x "$CURL" ] || fail_plain "curl is unavailable: $CURL"
[ -x "$PLUTIL" ] || fail_plain "plutil is unavailable: $PLUTIL"
case "$HEALTH_ATTEMPTS" in ''|*[!0-9]*) fail_plain "QC_INSTALL_HEALTH_ATTEMPTS must be a positive integer." ;; esac
[ "$HEALTH_ATTEMPTS" -gt 0 ] || fail_plain "QC_INSTALL_HEALTH_ATTEMPTS must be a positive integer."
case "$BOOTOUT_ATTEMPTS" in ''|*[!0-9]*) fail_plain "QC_INSTALL_BOOTOUT_ATTEMPTS must be a positive integer." ;; esac
[ "$BOOTOUT_ATTEMPTS" -gt 0 ] || fail_plain "QC_INSTALL_BOOTOUT_ATTEMPTS must be a positive integer."
case "$PORT" in ''|*[!0-9]*) fail_plain "QC_INSTALL_PORT must be an integer from 1 through 65535." ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail_plain "QC_INSTALL_PORT must be an integer from 1 through 65535."

select_python() {
  if [ -n "${QC_INSTALL_PYTHON:-}" ]; then
    if command -v "$QC_INSTALL_PYTHON" >/dev/null 2>&1 \
      && "$QC_INSTALL_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      PYTHON="$QC_INSTALL_PYTHON"
      return 0
    fi
    return 1
  fi
  for candidate_python in python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$candidate_python" >/dev/null 2>&1 \
      && "$candidate_python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      PYTHON="$(command -v "$candidate_python")"
      return 0
    fi
  done
  return 1
}

select_python || fail_plain "Python 3.9+ is required. Install it with Homebrew or Xcode Command Line Tools."

validate_release_source() {
  [ ! -L "${BASH_SOURCE[0]}" ] || return 1
  for relative in \
    LICENSE \
    PRIVACY.md \
    requirements.txt \
    requirements.lock \
    uninstall.command \
    companion_service/server.py \
    companion_service/verify_runtime.py \
    companion_service/runtime_manifest.json \
    companion_service/pdf_extract_worker.py \
    companion_service/pdf_ocr_worker.swift
  do
    source_path="$SOURCE_DIR/$relative"
    [ -f "$source_path" ] && [ ! -L "$source_path" ] || return 1
    resolved_source="$("$PYTHON" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$source_path" 2>/dev/null)" || return 1
    case "$resolved_source" in "$SOURCE_DIR"/*) ;; *) return 1 ;; esac
  done
  "$PYTHON" - "$SOURCE_DIR/requirements.txt" <<'PY'
import re
import sys
from pathlib import Path

lines = []
for raw in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    value = raw.strip()
    if not value or value.startswith("#"):
        continue
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9_.+!-]*", value):
        raise SystemExit(1)
    lines.append(value.lower())
if not lines or len(lines) != len(set(item.split("==", 1)[0] for item in lines)):
    raise SystemExit(1)
PY
  "$PYTHON" - "$SOURCE_DIR/requirements.txt" "$SOURCE_DIR/requirements.lock" <<'PY'
import re
import sys
from pathlib import Path

requirements = {
    value.strip().lower()
    for value in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
    if value.strip() and not value.lstrip().startswith("#")
}
text = Path(sys.argv[2]).read_text(encoding="utf-8")
locked = {
    match.group(1).lower()
    for match in re.finditer(
        r"^([A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9_.+!-]*)\s*\\\s*$\n"
        r"\s*--hash=sha256:[0-9a-f]{64}\s*$",
        text,
        re.MULTILINE | re.IGNORECASE,
    )
}
if locked != requirements or not locked:
    raise SystemExit(1)
PY
}

validate_release_source || fail_plain "This is not a complete, trusted companion release. Extract the companion ZIP and run install.command from its root."

ensure_managed_directories() {
  mkdir -p "$APP_ROOT" "$LOG_DIR" "$HOME_ROOT/Library/LaunchAgents" "$DATA_DIR_INPUT/state" "$DATA_DIR_INPUT/vault" || return 1
  chmod 700 "$APP_ROOT" "$LOG_DIR" "$DATA_DIR_INPUT/state" 2>/dev/null || return 1
  for managed in "$APP_ROOT" "$LOG_DIR" "$DATA_DIR_INPUT" "$DATA_DIR_INPUT/state"; do
    [ -d "$managed" ] && [ ! -L "$managed" ] || return 1
  done
  app_resolved="$(cd "$APP_ROOT" 2>/dev/null && pwd -P)" || return 1
  [ "$app_resolved" = "$APP_ROOT" ] || return 1
  DATA_DIR="$(cd "$DATA_DIR_INPUT" 2>/dev/null && pwd -P)" || return 1
  DB_PATH="$DATA_DIR/state/qc_smart_reader.sqlite3"
  return 0
}

ensure_managed_directories || fail_plain "Could not create secure application and Vault directories."
if [ -e "$DB_PATH" ]; then
  DB_EXISTED_BEFORE=1
fi

safe_remove_tree() {
  remove_path="$1"
  case "$remove_path" in
    "$APP_ROOT"/.candidate-*|"$APP_ROOT"/.previous-*|"$APP_ROOT"/.state-snapshot-*) ;;
    *) return 1 ;;
  esac
  [ -e "$remove_path" ] || return 0
  [ -d "$remove_path" ] && [ ! -L "$remove_path" ] || return 1
  find "$remove_path" -depth -delete
}

unlink_regular_file() {
  unlink_path="$1"
  [ -e "$unlink_path" ] || return 0
  [ -f "$unlink_path" ] && [ ! -L "$unlink_path" ] || return 1
  unlink "$unlink_path"
}

CANDIDATE="$APP_ROOT/.candidate-$$"
PREVIOUS="$APP_ROOT/.previous-$$"
PLIST_BACKUP="$APP_ROOT/.launchagent-backup-$$"
STATE_SNAPSHOT="$APP_ROOT/.state-snapshot-$$"
[ ! -e "$CANDIDATE" ] && [ ! -e "$PREVIOUS" ] && [ ! -e "$PLIST_BACKUP" ] && [ ! -e "$STATE_SNAPSHOT" ] \
  || fail_plain "A conflicting installation staging path already exists."
mkdir -m 700 "$CANDIDATE" "$CANDIDATE/companion_service" || fail_plain "Could not create the installation staging directory."

cleanup_transient() {
  if [ -n "$CANDIDATE" ] && [ -e "$CANDIDATE" ]; then
    safe_remove_tree "$CANDIDATE" >/dev/null 2>&1 || true
  fi
  # Never delete PREVIOUS from a generic exit path: it is the last known-good
  # runtime until readiness commits the upgrade. A rollback restores it.
  if [ "$OLD_STOPPED" -eq 0 ] && [ -n "$PLIST_BACKUP" ] && [ -e "$PLIST_BACKUP" ]; then
    unlink_regular_file "$PLIST_BACKUP" >/dev/null 2>&1 || true
  fi
  if [ -n "$STATE_SNAPSHOT" ] && [ -e "$STATE_SNAPSHOT" ]; then
    safe_remove_tree "$STATE_SNAPSHOT" >/dev/null 2>&1 || true
  fi
}

handle_interruption() {
  trap - EXIT INT TERM
  if [ "$OLD_STOPPED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
    rollback_and_fail "Installation was interrupted before the upgrade committed."
  fi
  cleanup_transient
  exit 130
}

handle_unexpected_exit() {
  exit_status=$?
  trap - EXIT INT TERM
  if [ "$exit_status" -ne 0 ] && [ "$OLD_STOPPED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
    rollback_and_fail "Installation exited unexpectedly before the upgrade committed."
  fi
  cleanup_transient
  exit "$exit_status"
}

trap handle_unexpected_exit EXIT
trap handle_interruption INT TERM

copy_release_file() {
  relative="$1"
  mode="$2"
  source_path="$SOURCE_DIR/$relative"
  destination_path="$CANDIDATE/$relative"
  destination_parent="${destination_path%/*}"
  [ "$destination_parent" != "$destination_path" ] || destination_parent="$CANDIDATE"
  mkdir -p "$destination_parent" || return 1
  cp "$source_path" "$destination_path" || return 1
  chmod "$mode" "$destination_path" || return 1
}

copy_release_file LICENSE 644 \
  && copy_release_file PRIVACY.md 644 \
  && copy_release_file requirements.txt 644 \
  && copy_release_file requirements.lock 644 \
  && copy_release_file uninstall.command 755 \
  && copy_release_file companion_service/server.py 644 \
  && copy_release_file companion_service/verify_runtime.py 644 \
  && copy_release_file companion_service/runtime_manifest.json 644 \
  && copy_release_file companion_service/pdf_extract_worker.py 644 \
  && copy_release_file companion_service/pdf_ocr_worker.swift 644 \
  || fail_plain "Could not copy the allowlisted runtime files into staging."

if [ -e "$CURRENT" ]; then
  [ -d "$CURRENT" ] && [ ! -L "$CURRENT" ] || fail_plain "The managed current runtime is not a regular directory."
  [ -x "$CURRENT/venv/bin/python" ] && [ -f "$CURRENT/companion_service/server.py" ] \
    || fail_plain "The managed current runtime is incomplete; repair it manually before upgrading."
  HAD_CURRENT=1
fi
if [ -e "$PLIST_PATH" ]; then
  [ -f "$PLIST_PATH" ] && [ ! -L "$PLIST_PATH" ] || fail_plain "The LaunchAgent path is not a regular file."
  cp "$PLIST_PATH" "$PLIST_BACKUP" && chmod 600 "$PLIST_BACKUP" \
    || fail_plain "Could not preserve the existing LaunchAgent definition."
fi
if { [ "$HAD_CURRENT" -eq 1 ] && [ ! -e "$PLIST_PATH" ]; } \
  || { [ "$HAD_CURRENT" -eq 0 ] && [ -e "$PLIST_PATH" ]; }; then
  fail_plain "The managed runtime and LaunchAgent are inconsistent; refusing an unsafe lifecycle change."
fi

say "[1/6] Validated the extracted companion release and locked requirements."

run_pip() {
  venv_python="$1"
  shift
  if [ -n "${QC_INSTALL_PIP:-}" ]; then
    "$QC_INSTALL_PIP" "$venv_python" "$@"
  else
    "$venv_python" -m pip "$@"
  fi
}

verify_installed_requirements() {
  "$1" "$CANDIDATE/companion_service/verify_runtime.py" "$2" \
    "$CANDIDATE/companion_service/runtime_manifest.json"
}

install_requirements() {
  venv_python="$1"
  requirements_path="$2"
  lock_path="$3"
  if verify_installed_requirements "$venv_python" "$requirements_path" >/dev/null 2>&1; then
    return 0
  fi
  run_pip "$venv_python" install --disable-pip-version-check --upgrade --require-hashes --only-binary=:all: --requirement "$lock_path" >/dev/null \
    && run_pip "$venv_python" check >/dev/null \
    && verify_installed_requirements "$venv_python" "$requirements_path" >/dev/null 2>&1
}

CANDIDATE_VENV="$CANDIDATE/venv"
"$PYTHON" -m venv "$CANDIDATE_VENV" || fail_plain "Could not create the isolated candidate Python virtualenv."
CANDIDATE_PYTHON="$CANDIDATE_VENV/bin/python"
[ -x "$CANDIDATE_PYTHON" ] || fail_plain "The isolated candidate virtualenv is unusable."
install_requirements "$CANDIDATE_PYTHON" "$CANDIDATE/requirements.txt" "$CANDIDATE/requirements.lock" \
  || fail_plain "Could not install and verify the exact locked Python requirements."
say "[2/6] Isolated candidate virtualenv and locked dependencies are verified."

stop_agent() {
  "$LAUNCHCTL" bootout --wait "$SERVICE_TARGET" >/dev/null 2>&1 &
  bootout_pid=$!
  bootout_attempt=0
  while kill -0 "$bootout_pid" 2>/dev/null && [ "$bootout_attempt" -lt "$BOOTOUT_ATTEMPTS" ]; do
    sleep 0.1
    bootout_attempt=$((bootout_attempt + 1))
  done
  if kill -0 "$bootout_pid" 2>/dev/null; then
    kill "$bootout_pid" 2>/dev/null || true
    wait "$bootout_pid" 2>/dev/null || true
    return 1
  fi
  wait "$bootout_pid" 2>/dev/null
  bootout_status=$?
  if [ "$bootout_status" -ne 0 ] && "$LAUNCHCTL" print "$SERVICE_TARGET" >/dev/null 2>&1; then
    return 1
  fi
  absent_attempt=0
  while "$LAUNCHCTL" print "$SERVICE_TARGET" >/dev/null 2>&1; do
    [ "$absent_attempt" -lt "$BOOTOUT_ATTEMPTS" ] || return 1
    sleep 0.1
    absent_attempt=$((absent_attempt + 1))
  done
  wait_until_stopped
}

start_agent() {
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || return 1
  "$LAUNCHCTL" kickstart -k "$SERVICE_TARGET" >/dev/null 2>&1 || return 1
}

fetch_health() {
  health_result="$("$CURL" -sS --max-time 2 -w $'\n%{http_code}' "http://$HOST:$PORT/health" 2>/dev/null)" || return 0
  health_status="${health_result##*$'\n'}"
  case "$health_status" in 2??) printf '%s' "${health_result%$'\n'*}" ;; esac
}

wait_until_stopped() {
  stopped_attempt=0
  while [ "$stopped_attempt" -lt 40 ]; do
    [ -z "$(fetch_health)" ] && return 0
    stopped_attempt=$((stopped_attempt + 1))
    sleep 0.1
  done
  return 1
}

validate_health_metadata() {
  expected_service_version="$2"
  expected_api_version="$3"
  "$PYTHON" - "$DATA_DIR" "$expected_api_version" "$expected_service_version" "$1" <<'PY'
import json
import os
import re
import stat
import sys
from pathlib import Path

expected_data = Path(sys.argv[1])
expected_api = int(sys.argv[2])
expected_version = sys.argv[3]
try:
    payload = json.loads(sys.argv[4])
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)

valid = (
    isinstance(payload, dict)
    and payload.get("ok") is True
    and payload.get("app") == "QC Smart Reader"
    and payload.get("api_version") == expected_api
    and payload.get("version") == expected_version
    and payload.get("service_version") == expected_version
    and payload.get("pairing_required") is True
)
if not valid:
    raise SystemExit(1)

def exact_path(name):
    value = payload.get(name)
    if not isinstance(value, str) or not value or any(char in value for char in "\0\r\n\t"):
        raise SystemExit(1)
    path = Path(value)
    if not path.is_absolute() or value != os.path.realpath(value):
        raise SystemExit(1)
    return path

data = exact_path("data_dir")
vault = exact_path("vault_dir")
token_path = exact_path("pairing_token_path")
db_path = exact_path("db_path")
if (
    data != expected_data
    or vault != data / "vault"
    or token_path != data / "state" / "pairing_token.txt"
    or db_path != data / "state" / "qc_smart_reader.sqlite3"
):
    raise SystemExit(1)
if not data.is_dir() or not vault.is_dir():
    raise SystemExit(1)

try:
    before = os.lstat(token_path)
except OSError:
    raise SystemExit(1)
if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
    raise SystemExit(1)
if before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) & 0o077:
    raise SystemExit(1)
if before.st_size < 43 or before.st_size > 258:
    raise SystemExit(1)
flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
fd = os.open(token_path, flags)
try:
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
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
print("\t".join((str(data), str(vault), str(token_path), match.group(1))))
PY
}

validate_projects_response() {
  printf '%s' "$1" | "$PYTHON" -c '
import json, sys
try:
    value = json.load(sys.stdin)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
raise SystemExit(0 if isinstance(value, dict) and value.get("ok") is True and isinstance(value.get("projects"), list) else 1)
' >/dev/null 2>&1
}

service_contract() {
  "$PYTHON" - "$1" "$DATA_DIR" <<'PY'
import json
import os
import sys
from pathlib import Path

try:
    payload = json.loads(sys.argv[1])
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
expected_data = Path(sys.argv[2])
if not isinstance(payload, dict) or payload.get("ok") is not True or payload.get("app") != "QC Smart Reader":
    raise SystemExit(1)
version = payload.get("service_version") or payload.get("version")
api = payload.get("api_version")
data = payload.get("data_dir")
if not isinstance(version, str) or not version or type(api) is not int:
    raise SystemExit(1)
if not isinstance(data, str) or data != str(expected_data) or data != os.path.realpath(data):
    raise SystemExit(1)
print(f"{version}\t{api}")
PY
}

validate_service_expected() {
  service_health="$1"
  expected_service_version="$2"
  expected_api_version="$3"
  VALIDATED_TOKEN=""
  service_metadata="$(validate_health_metadata "$service_health" "$expected_service_version" "$expected_api_version" 2>/dev/null)" || return 1
  old_ifs="$IFS"
  IFS="$(printf '\t')"
  read -r validated_data validated_vault validated_token_path validated_token <<EOF
$service_metadata
EOF
  IFS="$old_ifs"
  [ "$validated_data" = "$DATA_DIR" ] && [ -n "$validated_token" ] || return 1
  projects_result="$("$CURL" -sS --max-time 2 -w $'\n%{http_code}' \
    -H "x-qc-pairing-token: $validated_token" "http://$HOST:$PORT/v1/projects" 2>/dev/null)" || return 1
  projects_status="${projects_result##*$'\n'}"
  case "$projects_status" in 2??) projects_body="${projects_result%$'\n'*}" ;; *) return 1 ;; esac
  validate_projects_response "$projects_body" || return 1
  VALIDATED_TOKEN="$validated_token"
  VALIDATED_VAULT="$validated_vault"
  return 0
}

validate_service() {
  validate_service_expected "$1" "$REQUIRED_SERVICE_VERSION" "$REQUIRED_API_VERSION"
}

wait_for_service() {
  service_attempt=0
  while [ "$service_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    candidate_health="$(fetch_health)"
    if [ -n "$candidate_health" ] && validate_service "$candidate_health"; then
      return 0
    fi
    service_attempt=$((service_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

wait_for_previous_service() {
  previous_version="${PREVIOUS_CONTRACT%%	*}"
  previous_api="${PREVIOUS_CONTRACT#*	}"
  service_attempt=0
  while [ "$service_attempt" -lt "$HEALTH_ATTEMPTS" ]; do
    candidate_health="$(fetch_health)"
    if [ -n "$candidate_health" ]; then
      candidate_contract="$(service_contract "$candidate_health" 2>/dev/null)" || candidate_contract=""
      if [ "$candidate_contract" = "$PREVIOUS_CONTRACT" ] \
        && validate_service_expected "$candidate_health" "$previous_version" "$previous_api" \
        && [ "$VALIDATED_TOKEN" = "$PREVIOUS_TOKEN" ]; then
        return 0
      fi
    fi
    service_attempt=$((service_attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

create_database_backup() {
  [ -e "$DB_PATH" ] || return 0
  backup_dir="$DATA_DIR/state/backups"
  mkdir -m 700 -p "$backup_dir" || return 1
  [ -d "$backup_dir" ] && [ ! -L "$backup_dir" ] || return 1
  backup_stamp="$(date -u '+%Y%m%dT%H%M%SZ')" || return 1
  BACKUP_PATH="$backup_dir/qc_smart_reader.sqlite3.pre-install-$backup_stamp-$$.bak"
  [ ! -e "$BACKUP_PATH" ] || return 1
  "$PYTHON" - "$DB_PATH" "$BACKUP_PATH" <<'PY'
import os
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
metadata = os.lstat(source)
if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.getuid():
    raise SystemExit(1)
if source.resolve() != source or destination.exists() or destination.is_symlink():
    raise SystemExit(1)
temporary_fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.tmp-", dir=destination.parent)
os.close(temporary_fd)
temporary = Path(temporary_name)
try:
    source_db = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)
    backup_db = sqlite3.connect(temporary)
    try:
        source_integrity = source_db.execute("PRAGMA integrity_check").fetchone()[0]
        if source_integrity != "ok":
            raise sqlite3.DatabaseError(f"source integrity_check: {source_integrity}")
        source_db.backup(backup_db)
        backup_db.commit()
    finally:
        backup_db.close()
        source_db.close()
    verify_db = sqlite3.connect(f"{temporary.resolve().as_uri()}?mode=ro", uri=True)
    try:
        backup_integrity = verify_db.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        verify_db.close()
    if backup_integrity != "ok":
        raise sqlite3.DatabaseError(f"backup integrity_check: {backup_integrity}")
    os.chmod(temporary, 0o600)
    os.link(temporary, destination)
    directory_fd = os.open(destination.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
PY
}

snapshot_state_files() {
  mkdir -m 700 "$STATE_SNAPSHOT" || return 1
  for state_name in pairing_token.txt model_settings.json; do
    state_source="$DATA_DIR/state/$state_name"
    if [ -e "$state_source" ]; then
      [ -f "$state_source" ] && [ ! -L "$state_source" ] || return 1
      state_resolved="$("$PYTHON" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$state_source" 2>/dev/null)" || return 1
      [ "$state_resolved" = "$state_source" ] || return 1
      cp "$state_source" "$STATE_SNAPSHOT/$state_name" || return 1
      chmod 600 "$STATE_SNAPSHOT/$state_name" || return 1
      printf 'present\n' >"$STATE_SNAPSHOT/$state_name.status" || return 1
    else
      printf 'absent\n' >"$STATE_SNAPSHOT/$state_name.status" || return 1
    fi
    chmod 600 "$STATE_SNAPSHOT/$state_name.status" || return 1
  done
  STATE_SNAPSHOT_READY=1
}

restore_state_files() {
  [ -d "$STATE_SNAPSHOT" ] && [ ! -L "$STATE_SNAPSHOT" ] || return 1
  "$PYTHON" - "$STATE_SNAPSHOT" "$DATA_DIR/state" <<'PY'
import os
import stat
import sys
import tempfile
from pathlib import Path

snapshot = Path(sys.argv[1])
state = Path(sys.argv[2])
if snapshot.resolve() != snapshot or state.resolve() != state:
    raise SystemExit(1)
for name in ("pairing_token.txt", "model_settings.json"):
    status_path = snapshot / f"{name}.status"
    status = status_path.read_text(encoding="ascii").strip()
    target = state / name
    if target.exists() or target.is_symlink():
        metadata = os.lstat(target)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise SystemExit(1)
    if status == "absent":
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        continue
    if status != "present":
        raise SystemExit(1)
    source = snapshot / name
    metadata = os.lstat(source)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise SystemExit(1)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{name}.rollback-", dir=state)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle, source.open("rb") as source_handle:
            handle.write(source_handle.read())
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
directory_fd = os.open(state, os.O_RDONLY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
}

restore_database_backup() {
  [ "$START_ATTEMPTED" -eq 1 ] || return 0
  if [ -z "$BACKUP_PATH" ]; then
    # If no database existed before the attempted upgrade, remove only the
    # exact SQLite files the failed candidate may have created. The restored
    # service will initialize its own compatible schema on restart.
    [ "$DB_EXISTED_BEFORE" -eq 0 ] || return 1
    "$PYTHON" - "$DB_PATH" <<'PY'
import os
import stat
import sys
from pathlib import Path

database = Path(sys.argv[1])
for path in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm")):
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        continue
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise SystemExit(1)
    path.unlink()
PY
    return $?
  fi
  "$PYTHON" - "$BACKUP_PATH" "$DB_PATH" <<'PY'
import os
import sqlite3
import stat
import sys
import tempfile
from pathlib import Path

backup = Path(sys.argv[1])
database = Path(sys.argv[2])
backup_metadata = os.lstat(backup)
if not stat.S_ISREG(backup_metadata.st_mode) or stat.S_ISLNK(backup_metadata.st_mode):
    raise SystemExit(1)
if backup_metadata.st_uid != os.getuid() or backup.resolve() != backup:
    raise SystemExit(1)
temporary_fd, temporary_name = tempfile.mkstemp(prefix=f".{database.name}.rollback-", dir=database.parent)
os.close(temporary_fd)
temporary = Path(temporary_name)
try:
    source_db = sqlite3.connect(f"{backup.as_uri()}?mode=ro", uri=True)
    restored_db = sqlite3.connect(temporary)
    try:
        integrity = source_db.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise sqlite3.DatabaseError(f"backup integrity_check: {integrity}")
        source_db.backup(restored_db)
        restored_db.commit()
    finally:
        restored_db.close()
        source_db.close()
    verify_db = sqlite3.connect(f"{temporary.resolve().as_uri()}?mode=ro", uri=True)
    try:
        restored_integrity = verify_db.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        verify_db.close()
    if restored_integrity != "ok":
        raise sqlite3.DatabaseError(f"restored integrity_check: {restored_integrity}")
    os.chmod(temporary, 0o600)
    for sidecar in (Path(str(database) + "-wal"), Path(str(database) + "-shm")):
        try:
            metadata = os.lstat(sidecar)
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError(f"unsafe SQLite sidecar: {sidecar}")
        sidecar.unlink()
    if database.exists() or database.is_symlink():
        metadata = os.lstat(database)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError("unsafe database replacement target")
    os.replace(temporary, database)
    directory_fd = os.open(database.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
PY
}

write_launch_agent() {
  temporary_plist="$HOME_ROOT/Library/LaunchAgents/.$LABEL.plist.tmp-$$"
  [ ! -e "$temporary_plist" ] || return 1
  "$PYTHON" - "$temporary_plist" "$LABEL" "$CURRENT/venv/bin/python" "$CURRENT/companion_service/server.py" \
    "$CURRENT" "$LOG_DIR/companion.log" "$LOG_DIR/companion-error.log" "$DATA_DIR" "$HOST" "$PORT" <<'PY'
import os
import plistlib
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "Label": sys.argv[2],
    "ProgramArguments": [sys.argv[3], sys.argv[4], "--host", sys.argv[9], "--port", sys.argv[10], "--data-dir", sys.argv[8]],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Background",
    "EnvironmentVariables": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "PYTHONDONTWRITEBYTECODE": "1",
    },
    "WorkingDirectory": sys.argv[5],
    "StandardOutPath": sys.argv[6],
    "StandardErrorPath": sys.argv[7],
}
with path.open("xb") as handle:
    plistlib.dump(payload, handle, fmt=plistlib.FMT_XML, sort_keys=True)
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(path, 0o600)
PY
  plist_result=$?
  if [ "$plist_result" -ne 0 ]; then
    [ ! -e "$temporary_plist" ] || unlink_regular_file "$temporary_plist" >/dev/null 2>&1 || true
    return 1
  fi
  "$PLUTIL" -lint "$temporary_plist" >/dev/null 2>&1 || {
    unlink_regular_file "$temporary_plist" >/dev/null 2>&1 || true
    return 1
  }
  mv "$temporary_plist" "$PLIST_PATH"
}

restore_plist() {
  if [ -e "$PLIST_BACKUP" ]; then
    [ ! -e "$PLIST_PATH" ] || unlink_regular_file "$PLIST_PATH" || return 1
    mv "$PLIST_BACKUP" "$PLIST_PATH" || return 1
  elif [ "$HAD_CURRENT" -eq 0 ]; then
    unlink_regular_file "$PLIST_PATH" || return 1
  fi
  return 0
}

rollback_and_fail() {
  rollback_reason="$1"
  rollback_ok=1
  trap - EXIT INT TERM
  stop_agent || rollback_ok=0
  if [ "$SWAPPED" -eq 1 ]; then
    if [ -e "$CURRENT" ]; then
      rollback_failed="$APP_ROOT/.candidate-rollback-$$"
      mv "$CURRENT" "$rollback_failed" && safe_remove_tree "$rollback_failed" || rollback_ok=0
    fi
  fi
  if [ "$HAD_CURRENT" -eq 1 ] && [ ! -e "$CURRENT" ] && [ -e "$PREVIOUS" ]; then
    mv "$PREVIOUS" "$CURRENT" || rollback_ok=0
  fi
  restore_plist || rollback_ok=0
  if [ "$rollback_ok" -eq 1 ]; then
    restore_database_backup || rollback_ok=0
  fi
  if [ "$rollback_ok" -eq 1 ] && [ "$STATE_SNAPSHOT_READY" -eq 1 ]; then
    restore_state_files || rollback_ok=0
  fi
  if [ "$HAD_CURRENT" -eq 1 ] && [ "$rollback_ok" -eq 1 ]; then
    start_agent && wait_for_previous_service || rollback_ok=0
  fi
  if [ "$rollback_ok" -eq 1 ]; then
    cleanup_transient
    printf '\n[x] %s Previous installation restored and restarted.\n' "$rollback_reason" >&2
  else
    printf '\n[x] %s Automatic rollback was incomplete; recovery artifacts were preserved under %s. Inspect %s before retrying.\n' \
      "$rollback_reason" "$APP_ROOT" "$PLIST_PATH" >&2
  fi
  pause_if_interactive
  exit 1
}

if [ "$HAD_CURRENT" -eq 1 ]; then
  previous_health="$(fetch_health)"
  PREVIOUS_CONTRACT="$(service_contract "$previous_health" 2>/dev/null)" \
    || fail_plain "The existing managed service did not expose a valid rollback contract."
  previous_version="${PREVIOUS_CONTRACT%%	*}"
  previous_api="${PREVIOUS_CONTRACT#*	}"
  validate_service_expected "$previous_health" "$previous_version" "$previous_api" \
    || fail_plain "The existing managed service failed authenticated pre-upgrade validation."
  PREVIOUS_TOKEN="$VALIDATED_TOKEN"
fi
OLD_STOPPED=1
say "[3/6] Stopping the previous LaunchAgent and waiting for complete job removal."
stop_agent || rollback_and_fail "The previous LaunchAgent did not stop and unregister cleanly."

create_database_backup || rollback_and_fail "Could not create and verify the required pre-upgrade database backup."
if [ -n "$BACKUP_PATH" ]; then
  say "[4/6] Verified database backup: $BACKUP_PATH"
else
  say "[4/6] No existing database required a pre-upgrade backup."
fi
snapshot_state_files || rollback_and_fail "Could not snapshot pairing and model state before upgrade."

if [ "$HAD_CURRENT" -eq 1 ]; then
  mv "$CURRENT" "$PREVIOUS" || rollback_and_fail "Could not preserve the previous runtime."
fi
SWAPPED=1
mv "$CANDIDATE" "$CURRENT" || rollback_and_fail "Could not activate the staged runtime."
CANDIDATE=""
write_launch_agent || rollback_and_fail "Could not install the LaunchAgent definition."
START_ATTEMPTED=1
start_agent || rollback_and_fail "launchctl could not start the companion service."
say "[5/6] LaunchAgent installed and started; validating identity and authenticated API."
wait_for_service || rollback_and_fail "The new service did not pass exact health, version, path, token, and authenticated API checks."
COMMITTED=1

if [ -e "$PREVIOUS" ]; then
  if ! safe_remove_tree "$PREVIOUS"; then
    say "  [!] The verified previous runtime remains at $PREVIOUS; it may be removed manually after inspection."
  fi
fi
PREVIOUS=""
if [ -e "$PLIST_BACKUP" ]; then
  if ! unlink_regular_file "$PLIST_BACKUP"; then
    say "  [!] The previous LaunchAgent backup remains at $PLIST_BACKUP."
  fi
fi
PLIST_BACKUP=""
if [ -e "$STATE_SNAPSHOT" ]; then
  safe_remove_tree "$STATE_SNAPSHOT" || say "  [!] The verified state snapshot remains at $STATE_SNAPSHOT."
fi
STATE_SNAPSHOT=""

say "[6/6] QC Smart Reader companion is installed and authenticated."
say "  Companion URL   http://$HOST:$PORT"
say "  Pairing Token   $VALIDATED_TOKEN"
say "  Vault           $VALIDATED_VAULT"
if [ -z "$PBCOPY" ] && command -v pbcopy >/dev/null 2>&1; then
  PBCOPY="$(command -v pbcopy)"
fi
if [ -n "$PBCOPY" ]; then
  case "$PBCOPY" in
    /*) if [ -x "$PBCOPY" ] && printf '%s' "$VALIDATED_TOKEN" | "$PBCOPY"; then say "  [✓] Pairing Token copied to clipboard."; fi ;;
  esac
fi

trap - EXIT INT TERM
pause_if_interactive
exit 0
