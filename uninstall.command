#!/bin/bash
# Remove the per-user QC Smart Reader companion runtime. Vault data is kept
# unless --purge-data is explicitly confirmed with the exact destructive phrase.

set -u
umask 077

LABEL="com.qcsmartreader.companion"
PURGE=0
CONFIRM_PHRASE="DELETE QC SMART READER VAULT"

say() { printf '%s\n' "$*"; }
pause_if_interactive() {
  if [ "${QC_UNINSTALL_NO_PAUSE:-0}" != "1" ] && [ -t 0 ] && [ -t 1 ]; then
    read -r -p "Press Return to close." _ 2>/dev/null || true
  fi
}
fail() { printf '\n[x] %s\n' "$*" >&2; pause_if_interactive; exit 1; }

case "$#" in
  0) ;;
  1) [ "$1" = "--purge-data" ] && PURGE=1 || fail "Unknown option: $1" ;;
  *) fail "Usage: bash uninstall.command [--purge-data]" ;;
esac

[ -n "${HOME:-}" ] || fail "HOME is not set."
case "$HOME" in /*) ;; *) fail "HOME must be an absolute path." ;; esac
[ -d "$HOME" ] && [ ! -L "$HOME" ] || fail "HOME must be an existing, non-symlink directory."
HOME_ROOT="$(cd "$HOME" 2>/dev/null && pwd -P)" || fail "Could not resolve HOME."
[ "$HOME_ROOT" != "/" ] || fail "Refusing to uninstall with HOME set to the filesystem root."

APP_ROOT="$HOME_ROOT/Library/Application Support/QC Smart Reader"
PLIST_PATH="$HOME_ROOT/Library/LaunchAgents/$LABEL.plist"
DATA_INPUT="$HOME_ROOT/Documents/QC Smart Reader Vault"
LAUNCHCTL="${QC_UNINSTALL_LAUNCHCTL:-/bin/launchctl}"
BOOTOUT_ATTEMPTS="${QC_UNINSTALL_BOOTOUT_ATTEMPTS:-100}"
USER_ID="$(id -u)"
DOMAIN="gui/$USER_ID"
SERVICE_TARGET="$DOMAIN/$LABEL"

case "$LAUNCHCTL" in /*) ;; *) fail "launchctl must be an absolute path." ;; esac
[ -x "$LAUNCHCTL" ] || fail "launchctl is unavailable: $LAUNCHCTL"
case "$BOOTOUT_ATTEMPTS" in ''|*[!0-9]*) fail "QC_UNINSTALL_BOOTOUT_ATTEMPTS must be a positive integer." ;; esac
[ "$BOOTOUT_ATTEMPTS" -gt 0 ] || fail "QC_UNINSTALL_BOOTOUT_ATTEMPTS must be a positive integer."

if [ "$PURGE" -eq 1 ]; then
  if [ ! -t 0 ]; then
    fail "--purge-data requires an interactive terminal confirmation."
  fi
  say "This permanently deletes: $DATA_INPUT"
  printf 'Type exactly "%s" to continue: ' "$CONFIRM_PHRASE"
  IFS= read -r confirmation || confirmation=""
  printf '\n'
  [ "$confirmation" = "$CONFIRM_PHRASE" ] || fail "Confirmation did not match; nothing was removed."
fi

safe_remove_tree() {
  remove_path="$1"
  expected_path="$2"
  [ "$remove_path" = "$expected_path" ] || return 1
  [ -e "$remove_path" ] || return 0
  [ -d "$remove_path" ] && [ ! -L "$remove_path" ] || return 1
  resolved="$(cd "$remove_path" 2>/dev/null && pwd -P)" || return 1
  [ "$resolved" = "$expected_path" ] || return 1
  find "$remove_path" -depth -delete
}

if [ -e "$APP_ROOT" ]; then
  [ -d "$APP_ROOT" ] && [ ! -L "$APP_ROOT" ] || fail "Managed application path is unsafe; refusing to remove it."
  [ "$(cd "$APP_ROOT" 2>/dev/null && pwd -P)" = "$APP_ROOT" ] || fail "Managed application path does not resolve exactly."
fi
if [ -e "$PLIST_PATH" ]; then
  [ -f "$PLIST_PATH" ] && [ ! -L "$PLIST_PATH" ] || fail "LaunchAgent path is unsafe; refusing to remove it."
fi
APP_PRESENT=0
PLIST_PRESENT=0
[ -e "$APP_ROOT" ] && APP_PRESENT=1
[ -e "$PLIST_PATH" ] && PLIST_PRESENT=1
[ "$APP_PRESENT" -eq "$PLIST_PRESENT" ] \
  || fail "Managed runtime and LaunchAgent are inconsistent; no lifecycle path was removed."

if [ "$PURGE" -eq 1 ] && [ -e "$DATA_INPUT" ]; then
  [ -d "$DATA_INPUT" ] && [ ! -L "$DATA_INPUT" ] || fail "Vault path is unsafe; refusing to purge it."
  DATA_DIR="$(cd "$DATA_INPUT" 2>/dev/null && pwd -P)" || fail "Could not resolve the Vault path."
  [ "$DATA_DIR" = "$DATA_INPUT" ] || fail "Vault path does not resolve exactly; refusing to purge it."
else
  DATA_DIR="$DATA_INPUT"
fi

if [ "$APP_PRESENT" -eq 1 ]; then
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
    fail "Timed out waiting for the LaunchAgent to stop; runtime and Vault were preserved."
  fi
  wait "$bootout_pid" 2>/dev/null
  bootout_status=$?
  if [ "$bootout_status" -ne 0 ] && "$LAUNCHCTL" print "$SERVICE_TARGET" >/dev/null 2>&1; then
    fail "LaunchAgent is still registered; runtime and Vault were preserved."
  fi
  absent_attempt=0
  while "$LAUNCHCTL" print "$SERVICE_TARGET" >/dev/null 2>&1; do
    [ "$absent_attempt" -lt "$BOOTOUT_ATTEMPTS" ] \
      || fail "LaunchAgent did not unregister; runtime and Vault were preserved."
    sleep 0.1
    absent_attempt=$((absent_attempt + 1))
  done
fi

if [ -e "$PLIST_PATH" ]; then
  unlink "$PLIST_PATH" || fail "Could not remove the LaunchAgent definition."
fi
safe_remove_tree "$APP_ROOT" "$APP_ROOT" || fail "Could not safely remove the managed application runtime."

if [ "$PURGE" -eq 1 ]; then
  safe_remove_tree "$DATA_DIR" "$DATA_INPUT" || fail "Could not safely purge the validated Vault path."
  say "QC Smart Reader companion runtime and Vault data were removed."
else
  say "QC Smart Reader companion runtime was removed."
  say "Vault data was preserved at: $DATA_INPUT"
fi
pause_if_interactive
