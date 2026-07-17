#!/usr/bin/env bash
# Tests for `fm peek`: flag parsing, status header, line-count defaults.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=
# `sbin/fm` is a bun script, so the fake-herdr PATH prefix must still leave
# the real PATH reachable (for bun itself) - prepending BIN_DIR is enough to
# shadow any real herdr further down the chain.
BASE_PATH=${FM_TEST_BASE_PATH:-$PATH}

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup() { [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-peek-tests.XXXXXX")
BIN_DIR="$TMP_ROOT/fakebin"
mkdir -p "$BIN_DIR"

# Fake herdr:
#   pane get <id>     -> JSON with agent_status from FM_FAKE_PANE_STATUS (default: idle)
#   pane read <id>    -> records --lines value to FM_FAKE_PEEK_LINES_FILE; prints FM_FAKE_PEEK_PANE_FILE
#   agent get <id>    -> returns empty pane_id so fm_resolve_live_pane falls back to literal
cat > "$BIN_DIR/herdr" <<'SH'
#!/usr/bin/env bash
set -u
PANE_STATUS="${FM_FAKE_PANE_STATUS:-idle}"
LINES_FILE="${FM_FAKE_PEEK_LINES_FILE:-}"
PANE_FILE="${FM_FAKE_PEEK_PANE_FILE:-}"
case "${1:-}" in
  pane)
    case "${2:-}" in
      get)
        printf '{"result":{"pane":{"agent_status":"%s"}}}\n' "$PANE_STATUS"
        exit 0 ;;
      read)
        # Capture the --lines value.
        while [ $# -gt 0 ]; do
          if [ "${1:-}" = "--lines" ]; then
            shift
            [ -n "$LINES_FILE" ] && printf '%s' "${1:-}" > "$LINES_FILE"
          fi
          shift
        done
        [ -n "$PANE_FILE" ] && [ -f "$PANE_FILE" ] && cat "$PANE_FILE"
        exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      get)
        # Return no pane_id; fm_resolve_live_pane for a raw w:p id short-circuits before this.
        printf '{"agent_status":"%s"}\n' "$PANE_STATUS"
        exit 0 ;;
    esac ;;
esac
exit 0
SH
chmod +x "$BIN_DIR/herdr"

PANE_FILE="$TMP_ROOT/pane_content.txt"
LINES_FILE="$TMP_ROOT/lines_used.txt"
STATE_DIR="$TMP_ROOT/state"
mkdir -p "$STATE_DIR"
printf 'test pane output\n' > "$PANE_FILE"

run_peek() {
  PATH="$BIN_DIR:$BASE_PATH" \
    FM_FAKE_PEEK_LINES_FILE="$LINES_FILE" \
    FM_FAKE_PEEK_PANE_FILE="$PANE_FILE" \
    FM_FAKE_PANE_STATUS="idle" \
    FM_STATE_OVERRIDE="$STATE_DIR" \
    "$ROOT/sbin/fm" peek "$@"
}

# ---- tests ----

test_default_uses_40_lines() {
  rm -f "$LINES_FILE"
  run_peek w8:p3 >/dev/null 2>&1 || fail "default peek exited non-zero"
  lines=$(cat "$LINES_FILE" 2>/dev/null || printf '')
  [ "$lines" = "40" ] || fail "expected 40 lines, got '$lines'"
  pass "default uses 40 lines"
}

test_full_uses_120_lines() {
  rm -f "$LINES_FILE"
  run_peek --full w8:p3 >/dev/null 2>&1 || fail "--full peek exited non-zero"
  lines=$(cat "$LINES_FILE" 2>/dev/null || printf '')
  [ "$lines" = "120" ] || fail "expected 120 lines, got '$lines'"
  pass "--full uses 120 lines"
}

test_status_only_prints_header_no_body() {
  out=$(run_peek --status-only w8:p3 2>/dev/null) || fail "--status-only exited non-zero"
  printf '%s\n' "$out" | grep -Fq 'w8:p3' || fail "header missing pane name"
  printf '%s\n' "$out" | grep -Fq 'idle'  || fail "header missing agent status"
  printf '%s\n' "$out" | grep -Fq 'test pane output' && fail "--status-only should not print pane body" || true
  pass "--status-only prints header only, no body"
}

test_header_prepended_in_normal_mode() {
  out=$(run_peek w8:p3 2>/dev/null) || fail "peek exited non-zero"
  first=$(printf '%s\n' "$out" | head -1)
  printf '%s\n' "$first" | grep -Fq 'w8:p3' || fail "first line missing pane name"
  printf '%s\n' "$first" | grep -Fq 'idle'  || fail "first line missing agent status"
  printf '%s\n' "$out" | grep -Fq 'test pane output' || fail "pane body missing from output"
  pass "status header prepended before pane body"
}

test_unknown_flag_exits_nonzero() {
  run_peek --bogus w8:p3 >/dev/null 2>&1 && fail "--bogus should exit non-zero" || true
  pass "unknown flag exits non-zero"
}

test_no_pane_exits_nonzero() {
  run_peek >/dev/null 2>&1 && fail "no pane arg should exit non-zero" || true
  pass "no pane arg exits non-zero"
}

test_default_uses_40_lines
test_full_uses_120_lines
test_status_only_prints_header_no_body
test_header_prepended_in_normal_mode
test_unknown_flag_exits_nonzero
test_no_pane_exits_nonzero
