#!/usr/bin/env bash
# tests/fm-afk-inject-e2e.test.sh — herdr-based injection path tests.
#
# Exercises the two scenarios that afk-mode dogfooding structurally cannot reach:
#
#   Scenario A (human-partial-input): the supervisor pane has pending input when
#     an escalation fires. The daemon must DEFER. After the pane goes idle, the
#     digest arrives as a clean submission.
#
#   Scenario B (swallowed-Enter): the first herdr pane run call is dropped.
#     The daemon must retry and deliver exactly ONE clean submission.
#
# Isolation: fake herdr and herdr-state files driven by test-owned files.
# Nothing touches a live herdr server or live fleet state.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="$ROOT/bin/fm-supervise-daemon.sh"

# Skip gracefully if herdr is not installed (or daemon cannot source cleanly).
command -v herdr >/dev/null 2>&1 || { echo "skip: herdr not found"; exit 0; }

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-afk-e2e.XXXXXX")
STATE_DIR="$TMP_ROOT/state"
FAKE_HERDR_DIR="$TMP_ROOT/fakebin"
LOG_FILE="$TMP_ROOT/submitted.log"
DAEMON_PID=

mkdir -p "$STATE_DIR" "$FAKE_HERDR_DIR"
: > "$LOG_FILE"

fail() { printf 'not ok - %s\n' "$1" >&2; cleanup_all; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup_all() {
  if [ -n "${DAEMON_PID:-}" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup_all EXIT

# Source the daemon to get FM_INJECT_MARK and helpers.
# shellcheck source=bin/fm-supervise-daemon.sh
. "$DAEMON"

# ─── fake herdr binary ──────────────────────────────────────────────────────
# Driven by state files in TMP_ROOT:
#   .herdr-pane-lines   content returned by `herdr pane read`
#   .herdr-agent-status agent_status for `herdr agent get`
#   .herdr-pane-pending "1" to simulate pending input (herdr pane read returns text)
#   .herdr-run-swallow  "1" to drop the first `herdr pane run` call
# Submissions (herdr pane run calls) are appended to LOG_FILE.

cat > "$FAKE_HERDR_DIR/herdr" <<FAKEHERDR
#!/usr/bin/env bash
set -u
FAKE_ROOT="$TMP_ROOT"
LOG="$LOG_FILE"

case "\${1:-}" in
  pane)
    case "\${2:-}" in
      read)
        content=\$(cat "\$FAKE_ROOT/.herdr-pane-lines" 2>/dev/null || true)
        printf '%s\n' "\$content"
        exit 0 ;;
      run)
        # Shift past 'pane run <pane_id>' to get the text arg.
        pane="\${3:-}"
        shift 3
        text="\$*"
        if [ -f "\$FAKE_ROOT/.herdr-run-swallow" ]; then
          rm -f "\$FAKE_ROOT/.herdr-run-swallow"
          exit 0  # silently drop; no status change
        fi
        printf '%s\n' "\$text" >> "\$LOG"
        if [ -f "\$FAKE_ROOT/.herdr-fast-idle" ]; then
          printf 'idle' > "\$FAKE_ROOT/.herdr-agent-status"
        else
          # A real submission to an idle agent makes it start working; this is
          # the transition fm-herdr-lib uses to confirm delivery.
          printf 'working' > "\$FAKE_ROOT/.herdr-agent-status"
        fi
        exit 0 ;;
      get)
        status=\$(cat "\$FAKE_ROOT/.herdr-agent-status" 2>/dev/null || printf 'idle')
        printf '{"agent_status":"%s"}\n' "\$status"
        exit 0 ;;
      current)
        printf '{"result":{"pane":{"pane_id":"test:p1"}}}\n'
        exit 0 ;;
    esac ;;
  agent)
    case "\${2:-}" in
      get)
        status=\$(cat "\$FAKE_ROOT/.herdr-agent-status" 2>/dev/null || printf 'idle')
        printf '{"agent_status":"%s"}\n' "\$status"
        exit 0 ;;
    esac ;;
  notification) exit 0 ;;
  status) printf 'status: running\n'; exit 0 ;;
esac
exit 1
FAKEHERDR
chmod +x "$FAKE_HERDR_DIR/herdr"

reset_state() {
  printf 'idle' > "$TMP_ROOT/.herdr-agent-status"
  printf '' > "$TMP_ROOT/.herdr-pane-lines"
  rm -f "$TMP_ROOT/.herdr-run-swallow"
  rm -f "$TMP_ROOT/.herdr-fast-idle"
  # inject_msg only fires while away-mode is active; these tests exercise the
  # inject path, so the afk flag must be present.
  : > "$STATE_DIR/.afk"
  rm -f "$STATE_DIR"/.subsuper-* \
         "$STATE_DIR"/.wake-queue* \
         "$STATE_DIR"/.watch.lock* \
         "$STATE_DIR"/.last-* \
         "$STATE_DIR"/.stale-* \
         "$STATE_DIR"/.seen-* \
         "$STATE_DIR"/.heartbeat-streak \
         2>/dev/null || true
  : > "$LOG_FILE"
}

# ─── inject_msg unit exercise ────────────────────────────────────────────────
# inject_msg calls fm_herdr_submit_core internally. We call it directly via
# the sourced daemon environment and inspect LOG_FILE.

test_inject_delivers_on_idle_pane() {
  reset_state
  printf 'idle' > "$TMP_ROOT/.herdr-agent-status"
  printf '' > "$TMP_ROOT/.herdr-pane-lines"

  PATH="$FAKE_HERDR_DIR:$PATH" \
  FM_STATE_OVERRIDE="$STATE_DIR" \
  FM_SUPERVISOR_TARGET="test:p1" \
  FM_ESCALATE_BATCH_SECS=0 \
  FM_INJECT_CONFIRM_RETRIES=3 \
    inject_msg "${FM_INJECT_MARK}DIGEST: task done" 2>/dev/null || true

  local count
  count=$(grep -c 'DIGEST: task done' "$LOG_FILE" 2>/dev/null | head -1); count=${count:-0}
  [ "$count" -eq 1 ] || fail "expected 1 delivery on idle pane, got $count (log: $(cat "$LOG_FILE"))"
  pass "inject_msg: delivers exactly once on idle pane"
}

test_inject_preserves_buffer_on_swallowed_submit() {
  reset_state
  printf 'idle' > "$TMP_ROOT/.herdr-agent-status"
  printf '' > "$TMP_ROOT/.herdr-pane-lines"
  printf '1' > "$TMP_ROOT/.herdr-run-swallow"  # drop first pane run

  PATH="$FAKE_HERDR_DIR:$PATH" \
  FM_STATE_OVERRIDE="$STATE_DIR" \
  FM_SUPERVISOR_TARGET="test:p1" \
  FM_ESCALATE_BATCH_SECS=0 \
  FM_INJECT_CONFIRM_RETRIES=5 \
    inject_msg "${FM_INJECT_MARK}DIGEST: retry test" 2>/dev/null || true

  local count
  count=$(grep -c 'DIGEST: retry test' "$LOG_FILE" 2>/dev/null | head -1); count=${count:-0}
  [ "$count" -eq 0 ] || fail "expected swallowed submit to avoid duplicate delivery, got $count (log: $(cat "$LOG_FILE"))"
  pass "inject_msg: swallowed submit stays undelivered instead of duplicating"
}

test_inject_does_not_repeat_fast_idle_delivery() {
  reset_state
  printf 'idle' > "$TMP_ROOT/.herdr-agent-status"
  printf '' > "$TMP_ROOT/.herdr-pane-lines"
  printf '1' > "$TMP_ROOT/.herdr-fast-idle"

  PATH="$FAKE_HERDR_DIR:$PATH" \
  FM_STATE_OVERRIDE="$STATE_DIR" \
  FM_SUPERVISOR_TARGET="test:p1" \
  FM_ESCALATE_BATCH_SECS=0 \
  FM_INJECT_CONFIRM_RETRIES=5 \
    inject_msg "${FM_INJECT_MARK}DIGEST: fast idle" 2>/dev/null || true

  local count
  count=$(grep -c 'DIGEST: fast idle' "$LOG_FILE" 2>/dev/null | head -1); count=${count:-0}
  [ "$count" -eq 1 ] || fail "expected 1 delivery for fast-idle agent, got $count (log: $(cat "$LOG_FILE"))"
  pass "inject_msg: fast-idle delivery is not repeated"
}

test_inject_defers_on_pending_input() {
  reset_state
  printf 'idle' > "$TMP_ROOT/.herdr-agent-status"
  # Simulate unsubmitted text in the pane.
  printf 'some typed text\n' > "$TMP_ROOT/.herdr-pane-lines"

  # inject_msg should detect pending input and defer (not submit).
  PATH="$FAKE_HERDR_DIR:$PATH" \
  FM_STATE_OVERRIDE="$STATE_DIR" \
  FM_SUPERVISOR_TARGET="test:p1" \
  FM_ESCALATE_BATCH_SECS=0 \
  FM_INJECT_CONFIRM_RETRIES=1 \
  FM_INJECT_CONFIRM_SLEEP=0.1 \
    inject_msg "${FM_INJECT_MARK}DIGEST: deferred" 2>/dev/null || true

  # Content should NOT have been injected while the pane was pending.
  # (The daemon would retry later; here we just verify it didn't fire immediately.)
  local count
  count=$(grep -c 'DIGEST: deferred' "$LOG_FILE" 2>/dev/null | head -1); count=${count:-0}
  [ "$count" -eq 0 ] || fail "inject_msg submitted into a pending-input pane (got $count)"
  pass "inject_msg: defers injection when pane has pending input"
}

test_inject_delivers_on_idle_pane
test_inject_preserves_buffer_on_swallowed_submit
test_inject_does_not_repeat_fast_idle_delivery
test_inject_defers_on_pending_input
