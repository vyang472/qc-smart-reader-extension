#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qc-test-all.XXXXXX")"
TEST_SCOPE="${QC_TEST_SCOPE:-all}"

case "$TEST_SCOPE" in
  all)
    RUN_CORE=1
    RUN_NODE=1
    ;;
  core)
    RUN_CORE=1
    RUN_NODE=0
    ;;
  node)
    RUN_CORE=0
    RUN_NODE=1
    ;;
  *)
    printf '[x] QC_TEST_SCOPE must be all, core, or node (received: %s)\n' "$TEST_SCOPE" >&2
    exit 1
    ;;
esac

cleanup() {
  if [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ]; then
    find "$RUN_DIR" -depth -delete
  fi
}
trap cleanup EXIT INT TERM

fail() {
  printf '[x] %s\n' "$*" >&2
  exit 1
}

valid_python() {
  command -v "$1" >/dev/null 2>&1 \
    && "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}

select_python() {
  if [ -n "${QC_TEST_PYTHON:-}" ]; then
    valid_python "$QC_TEST_PYTHON" || fail "QC_TEST_PYTHON is not a usable Python 3.9+: $QC_TEST_PYTHON"
    printf '%s\n' "$QC_TEST_PYTHON"
    return
  fi
  project_python="$ROOT/.venv/bin/python"
  if valid_python "$project_python"; then
    printf '%s\n' "$project_python"
    return
  fi
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
    if valid_python "$candidate"; then
      command -v "$candidate"
      return
    fi
  done
  fail "No Python 3.9+ was found."
}

valid_node() {
  [ -x "$1" ] \
    && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

select_node() {
  if [ -n "${QC_TEST_NODE:-}" ]; then
    valid_node "$QC_TEST_NODE" || fail "QC_TEST_NODE is not a usable Node.js 18+: $QC_TEST_NODE"
    printf '%s\n' "$QC_TEST_NODE"
    return
  fi

  project_node="$ROOT/node_modules/.bin/node"
  if valid_node "$project_node"; then
    printf '%s\n' "$project_node"
    return
  fi

  path_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$path_node" ] && valid_node "$path_node"; then
    printf '%s\n' "$path_node"
    return
  fi

  bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  if valid_node "$bundled_node"; then
    printf '%s\n' "$bundled_node"
    return
  fi
  fail "No Node.js 18+ was found in the project, PATH, or bundled Codex runtime."
}

PYTHON="$(select_python)"
NODE="$(select_node)"
cd "$ROOT"

PYTHON_FILES=()
while IFS= read -r file; do
  PYTHON_FILES+=("$file")
done < <(find "$ROOT/companion_service" "$ROOT/scripts" "$ROOT/tests" -type f -name '*.py' | sort)

JS_FILES=()
while IFS= read -r file; do
  JS_FILES+=("$file")
done < <(find "$ROOT" -maxdepth 2 -type f \( -name '*.js' -o -name '*.mjs' \) | sort)

NODE_TEST_FILES=()
while IFS= read -r file; do
  NODE_TEST_FILES+=("$file")
done < <(find "$ROOT/tests" -maxdepth 1 -type f -name 'test_*.mjs' | sort)

[ "${#PYTHON_FILES[@]}" -gt 0 ] || fail "No Python files were found for syntax validation."
[ "${#JS_FILES[@]}" -gt 0 ] || fail "No JavaScript files were found for syntax validation."
[ "${#NODE_TEST_FILES[@]}" -gt 0 ] || fail "No Node test files were found."

printf 'QC Smart Reader %s validation\n' "$TEST_SCOPE"
printf '  root:   %s\n' "$ROOT"
printf '  python: %s (%s)\n' "$PYTHON" "$("$PYTHON" -V 2>&1)"
printf '  node:   %s (%s)\n' "$NODE" "$("$NODE" --version)"

printf '\n[1/6] Syntax: %s Python files, %s JS/MJS files, 6 shell entrypoints\n' \
  "${#PYTHON_FILES[@]}" "${#JS_FILES[@]}"
PYTHONPYCACHEPREFIX="$RUN_DIR/pycache" "$PYTHON" -m py_compile "${PYTHON_FILES[@]}"
"$PYTHON" "$ROOT/companion_service/verify_runtime.py" "$ROOT/requirements.txt" \
  "$ROOT/companion_service/runtime_manifest.json" \
  || fail "Python runtime does not match the hash-verified companion dependencies. Run bash start.command once, then retry."
for file in "${JS_FILES[@]}"; do
  "$NODE" --check "$file" >/dev/null
done
bash -n \
  "$ROOT/install.command" \
  "$ROOT/start.command" \
  "$ROOT/uninstall.command" \
  "$ROOT/scripts/test_all.sh" \
  "$ROOT/tests/test_install_lifecycle.sh" \
  "$ROOT/tests/test_start_command.sh"

if [ "$RUN_CORE" -eq 1 ]; then
  printf '\n[2/6] Python unittest suite\n'
  PYTHON_LOG="$RUN_DIR/python-tests.log"
  PYTHONDONTWRITEBYTECODE=1 "$PYTHON" -m unittest discover -s "$ROOT/tests" -v 2>&1 | tee "$PYTHON_LOG"
  PYTHON_TESTS="$(sed -n 's/^Ran \([0-9][0-9]*\) tests.*$/\1/p' "$PYTHON_LOG" | tail -n 1)"
  [ -n "$PYTHON_TESTS" ] || fail "Could not read the Python test count."
  PYTHON_RESULT="$(sed -n '/^OK/p' "$PYTHON_LOG" | tail -n 1)"
  [ "$PYTHON_RESULT" = "OK" ] \
    || fail "Python validation must finish without skipped or expected-failure tests (reported: ${PYTHON_RESULT:-missing OK status})."

  printf '\n[3/6] start.command integration suite\n'
  STARTUP_LOG="$RUN_DIR/startup-tests.log"
  QC_TEST_PYTHON="$PYTHON" bash "$ROOT/tests/test_start_command.sh" 2>&1 | tee "$STARTUP_LOG"
  STARTUP_TESTS="$(sed -n 's/^start\.command tests passed (\([0-9][0-9]*\) cases)\.$/\1/p' "$STARTUP_LOG" | tail -n 1)"
  [ -n "$STARTUP_TESTS" ] || fail "Could not read the start.command integration test count."

  printf '\n[4/6] macOS install / upgrade / uninstall lifecycle suite\n'
  LIFECYCLE_LOG="$RUN_DIR/install-lifecycle-tests.log"
  QC_TEST_PYTHON="$PYTHON" bash "$ROOT/tests/test_install_lifecycle.sh" 2>&1 | tee "$LIFECYCLE_LOG"
  LIFECYCLE_TESTS="$(sed -n 's/^install lifecycle tests passed (\([0-9][0-9]*\) cases)\.$/\1/p' "$LIFECYCLE_LOG" | tail -n 1)"
  [ -n "$LIFECYCLE_TESTS" ] || fail "Could not read the install lifecycle integration test count."
fi

if [ "$RUN_NODE" -eq 1 ]; then
  printf '\n[5/6] Node test suite (%s files, browser strict by default)\n' "${#NODE_TEST_FILES[@]}"
  NODE_LOG="$RUN_DIR/node-tests.log"
  BROWSER_REQUIREMENT="${QC_REQUIRE_BROWSER:-1}"
  QC_REQUIRE_BROWSER="$BROWSER_REQUIREMENT" "$NODE" --test --test-reporter=tap "${NODE_TEST_FILES[@]}" 2>&1 | tee "$NODE_LOG"
  NODE_TESTS="$(sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$NODE_LOG" | tail -n 1)"
  NODE_FAILURES="$(sed -n 's/^# fail \([0-9][0-9]*\)$/\1/p' "$NODE_LOG" | tail -n 1)"
  NODE_SKIPS="$(sed -n 's/^# skipped \([0-9][0-9]*\)$/\1/p' "$NODE_LOG" | tail -n 1)"
  [ -n "$NODE_TESTS" ] && [ -n "$NODE_FAILURES" ] && [ -n "$NODE_SKIPS" ] \
    || fail "Could not read Node test totals."
  [ "$NODE_FAILURES" -eq 0 ] || fail "Node reported $NODE_FAILURES failed tests."
  case "$BROWSER_REQUIREMENT" in
    1|true|TRUE|yes|YES|on|ON)
      [ "$NODE_SKIPS" -eq 0 ] || fail "Strict browser validation reported $NODE_SKIPS skipped tests."
      ;;
  esac
fi

if [ "$RUN_CORE" -eq 1 ]; then
  printf '\n[6/6] Companion-service evidence-chain smoke test\n'
  PYTHONDONTWRITEBYTECODE=1 "$PYTHON" "$ROOT/scripts/smoke_e2e.py"
fi

case "$TEST_SCOPE" in
  all)
    printf '\nAll validation passed: %s Python tests, %s Node tests, %s Node skips, %s startup cases, %s lifecycle cases, 1 E2E smoke.\n' \
      "$PYTHON_TESTS" "$NODE_TESTS" "$NODE_SKIPS" "$STARTUP_TESTS" "$LIFECYCLE_TESTS"
    ;;
  core)
    printf '\nCore validation passed: %s Python tests, %s startup cases, %s lifecycle cases, 1 E2E smoke.\n' \
      "$PYTHON_TESTS" "$STARTUP_TESTS" "$LIFECYCLE_TESTS"
    ;;
  node)
    printf '\nNode validation passed: %s tests, %s skips.\n' "$NODE_TESTS" "$NODE_SKIPS"
    ;;
esac
