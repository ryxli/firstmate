#!/usr/bin/env bash
# A/B E2E: prove the ported supervisor WAKES the main firstmate when a secondmate
# finishes routed work and goes idle WITHOUT leaving a captain-relevant status
# line - the awareness gap - and that the OLD (committed) extension MISSES it.
#
# The gap: a secondmate's working->idle transition is the completion signal the
# main firstmate needs, but the OLD extension excludes kind=secondmate panes from
# every idle backstop, so such a completion never wakes it. The NEW extension
# arms a short, corroborated completion backstop on that transition
# (target-existence + herdr-idle busy-banner corroboration + status-log check).
#
# Substrate is REAL (herdr + omp), not a mock:
#   - a real omp "secondmate" agent (slot = task id) that does a turn and returns
#     to idle without touching its status file, and
#   - a real omp "supervisor" agent loaded with the extension under an isolated
#     FM_HOME, watching that secondmate pane over the herdr socket.
# The wake is detected by the supervisor pane rendering the injected wake digest.
#
# Runs BOTH extensions and prints a before/after A/B verdict:
#   NEW must WAKE, OLD must MISS. Exit 0 only when both hold.
#
# Usage: tests/fm-supervisor-secondmate-e2e.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEW_EXT="$REPO/.omp/extensions/fm-supervisor.ts"
[ -f "$NEW_EXT" ] || { echo "FAIL: extension not found at $NEW_EXT"; exit 1; }
command -v herdr >/dev/null || { echo "SKIP: herdr not available"; exit 0; }
command -v omp   >/dev/null || { echo "SKIP: omp not available"; exit 0; }
command -v git   >/dev/null || { echo "SKIP: git not available"; exit 0; }

# The OLD baseline is the extension as it was BEFORE this branch's fix, i.e. at
# the fork point with the base branch - NOT HEAD, which already carries the fix
# once committed. Resolve it from `merge-base HEAD <base>` (base = FM_TEST_BASE_REF,
# default origin/herdr) and extract that revision's extension to a temp file so
# the A/B compares the pre-change and post-change surfaces byte-for-byte.
BASE_REF="${FM_TEST_BASE_REF:-origin/herdr}"
OLD_EXT="$(mktemp "${TMPDIR:-/tmp}/fm-old-ext.XXXXXX.ts")"
BASE_SHA="$(git -C "$REPO" merge-base HEAD "$BASE_REF" 2>/dev/null || true)"
[ -n "$BASE_SHA" ] || { echo "SKIP: cannot resolve merge-base of HEAD and $BASE_REF (set FM_TEST_BASE_REF)"; rm -f "$OLD_EXT"; exit 0; }
if ! git -C "$REPO" show "$BASE_SHA:.omp/extensions/fm-supervisor.ts" > "$OLD_EXT" 2>/dev/null; then
  echo "SKIP: cannot extract baseline extension at $BASE_SHA"; rm -f "$OLD_EXT"; exit 0
fi

SOCK="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
IDLE_SECS="${FM_SECONDMATE_IDLE_SECS:-3}"   # shrink the completion backstop for the test
WAKE_WINDOW="${FM_TEST_WAKE_WINDOW:-60}"    # seconds to watch the supervisor pane

# --- one A/B leg: launch a secondmate + a supervisor(EXT), trigger a post-arm
#     working->idle on the secondmate with no status line, and report whether the
#     supervisor injected a wake. Prints WOKE or MISSED on the last line.
run_leg() {  # <label> <ext-path>
  local label=$1 ext=$2
  local tmp task sm_pane sup_pane sm_json sup_json out deadline verdict=MISSED
  tmp="$(mktemp -d)"
  task="sm-demo"
  mkdir -p "$tmp/state"

  # Launch the real omp "secondmate". It answers a trivial prompt then returns to
  # idle; it NEVER writes a status file, so only the herdr working->idle transition
  # signals completion.
  sm_json="$(herdr agent start "$task" --no-focus \
    --env PATH="$PATH" --env HERDR_SOCKET_PATH="$SOCK" --env PYTHONDONTWRITEBYTECODE=1 \
    --cwd "$tmp" -- omp --auto-approve --no-title --no-session --cwd "$tmp" \
    "Reply with the single word READY and then wait for further instructions.")"
  sm_pane="$(printf '%s' "$sm_json" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$sm_pane" ] || { echo "FAIL[$label]: no secondmate pane"; echo "$sm_json"; rm -rf "$tmp"; return 2; }

  # Meta: one in-flight secondmate on this pane. kind=secondmate is the case OLD
  # excludes from every idle backstop.
  {
    echo "pane=$sm_pane"
    echo "harness=omp"
    echo "agent_identity=omp"
    echo "kind=secondmate"
    echo "worker=sm-demo"
    echo "home=$tmp"
  } > "$tmp/state/$task.meta"
  : > "$tmp/state/$task.status"

  # Let the secondmate finish its startup turn and settle to idle.
  herdr wait agent-status "$sm_pane" --status idle --timeout 30000 >/dev/null 2>&1 || true

  # Launch the supervisor omp loaded with the extension under test, pointed at the
  # isolated home, with a shrunk completion backstop.
  sup_json="$(herdr agent start "fm-sup-$$" --no-focus \
    --env FM_HOME="$tmp" --env FM_STATE_OVERRIDE="$tmp/state" \
    --env FM_SECONDMATE_IDLE_SECS="$IDLE_SECS" \
    --env PATH="$PATH" --env HERDR_SOCKET_PATH="$SOCK" --env PYTHONDONTWRITEBYTECODE=1 \
    --cwd "$tmp" -- omp -e "$ext" --auto-approve --no-title --no-session --cwd "$tmp")"
  sup_pane="$(printf '%s' "$sup_json" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$sup_pane" ] || { echo "FAIL[$label]: no supervisor pane"; echo "$sup_json"; herdr pane close "$sm_pane" >/dev/null 2>&1 || true; rm -rf "$tmp"; return 2; }

  # Let omp clear onboarding AND the extension arm (refreshFleet + subscribe +
  # seedStatuses marks the secondmate's current status idle as seen).
  herdr wait agent-status "$sup_pane" --status idle --timeout 30000 >/dev/null 2>&1 || true
  sleep 12

  # Trigger: a POST-ARM working->idle on the secondmate with NO status line. This
  # is a secondmate finishing routed work and going idle.
  herdr pane run "$sm_pane" "Reply with the single word ACK and nothing else." >/dev/null 2>&1 || true

  # Assert by supervisor pane CONTENT: the injected completion wake digest.
  deadline=$(( $(date +%s) + WAKE_WINDOW ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    out="$(herdr pane read "$sup_pane" --source recent --lines 100 2>/dev/null || true)"
    if printf '%s' "$out" | grep -qiE 'secondmate idle after routed work|\[wake\].*sm-demo'; then
      verdict=WOKE; break
    fi
    sleep 2
  done

  herdr pane close "$sm_pane" >/dev/null 2>&1 || true
  herdr pane close "$sup_pane" >/dev/null 2>&1 || true
  rm -rf "$tmp"
  printf '%s\n' "$verdict"
}

echo "=== A/B: secondmate finishes routed work, goes idle, no status line ==="
echo "--- NEW ($NEW_EXT) ---"
NEW_VERDICT="$(run_leg NEW "$NEW_EXT" | tail -1)"
echo "NEW: $NEW_VERDICT"
echo "--- OLD (fork-point baseline $BASE_SHA) ---"
OLD_VERDICT="$(run_leg OLD "$OLD_EXT" | tail -1)"
echo "OLD: $OLD_VERDICT"
rm -f "$OLD_EXT"

echo
echo "=== A/B verdict ==="
echo "  OLD (before): $OLD_VERDICT   (expected MISSED - secondmate idle never woke the firstmate)"
echo "  NEW (after):  $NEW_VERDICT   (expected WOKE   - corroborated completion backstop)"
if [ "$NEW_VERDICT" = WOKE ] && [ "$OLD_VERDICT" = MISSED ]; then
  echo "PASS: NEW wakes on secondmate completion where OLD missed"
  exit 0
fi
echo "FAIL: expected NEW=WOKE and OLD=MISSED"
exit 1
