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

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR" || exit 1

VENV_DIR="$REPO_DIR/.venv"
SERVER="$REPO_DIR/companion_service/server.py"
HOST="127.0.0.1"
PORT="37621"

# Honour --host/--port if the user passed them through, so the health probe
# below checks the address the service actually binds.
prev=""
for arg in "$@"; do
  case "$prev" in
    --host) HOST="$arg" ;;
    --port) PORT="$arg" ;;
  esac
  case "$arg" in
    --host=*) HOST="${arg#--host=}" ;;
    --port=*) PORT="${arg#--port=}" ;;
  esac
  prev="$arg"
done

say() { printf '%s\n' "$*"; }
fail() { printf '\n[x] %s\n' "$*" >&2; read -r -p "Press Return to close." _ 2>/dev/null; exit 1; }

# ---------------------------------------------------------------- 1. Python --
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      PYTHON="$candidate"
      break
    fi
  fi
done
[ -n "$PYTHON" ] || fail "No Python 3.9+ found. Install one with: brew install python@3.12  (or xcode-select --install)"
say "[1/4] Python: $($PYTHON -V 2>&1)  ($(command -v "$PYTHON"))"

# ------------------------------------------------------------------ 2. venv --
if [ ! -x "$VENV_DIR/bin/python" ]; then
  say "[2/4] Creating virtualenv at .venv ..."
  "$PYTHON" -m venv "$VENV_DIR" || fail "Could not create .venv. Try: $PYTHON -m pip install --user virtualenv"
else
  say "[2/4] Reusing existing .venv"
fi
VENV_PY="$VENV_DIR/bin/python"

if ! "$VENV_PY" -c 'import pypdf' >/dev/null 2>&1; then
  say "      Installing requirements (pypdf, for PDF ingestion) ..."
  if ! "$VENV_PY" -m pip install -q --disable-pip-version-check -r "$REPO_DIR/requirements.txt"; then
    say "      [!] pypdf install failed — continuing without it."
    say "          Everything except PDF ingestion still works."
  fi
fi

# --------------------------------------------------------------- 3. service --
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $PORT is already in use. The service may already be running — check http://$HOST:$PORT/health, or stop the other process first."
fi

say "[3/4] Starting companion service on http://$HOST:$PORT ..."
"$VENV_PY" "$SERVER" "$@" &
SERVER_PID=$!

shutdown() {
  say ""
  say "Shutting down companion service ..."
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  exit 0
}
trap shutdown INT TERM

HEALTH=""
for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "The service exited during startup. Scroll up for the Python error."
  fi
  HEALTH="$(curl -s -m 2 "http://$HOST:$PORT/health" 2>/dev/null)"
  [ -n "$HEALTH" ] && break
  sleep 0.5
done
[ -n "$HEALTH" ] || fail "The service did not answer /health within 20s."

# ------------------------------------------------------------- 4. pairing ----
TOKEN_PATH="$(printf '%s' "$HEALTH" | "$VENV_PY" -c 'import json,sys; print(json.load(sys.stdin).get("pairing_token_path",""))' 2>/dev/null)"
VAULT_DIR="$(printf '%s' "$HEALTH" | "$VENV_PY" -c 'import json,sys; print(json.load(sys.stdin).get("vault_dir",""))' 2>/dev/null)"
TOKEN=""
[ -n "$TOKEN_PATH" ] && [ -f "$TOKEN_PATH" ] && TOKEN="$(tr -d '[:space:]' < "$TOKEN_PATH")"

say ""
say "[4/4] Service is up. Paste these two values into the extension side panel → 设置:"
say "─────────────────────────────────────────────────────────────"
say "  Companion URL   http://$HOST:$PORT"
say "  Pairing Token   ${TOKEN:-<see $TOKEN_PATH>}"
say "─────────────────────────────────────────────────────────────"
say "  Vault           ${VAULT_DIR:-unknown}"
say ""
say "Leave this window open. Press Control-C to stop the service."

wait "$SERVER_PID"
