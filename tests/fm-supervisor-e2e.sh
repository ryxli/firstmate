#!/usr/bin/env bash
# E2E: prove the omp supervisor extension injects a wake on a captain-relevant
# status write, using the real herdr+omp substrate (not a mock).
#
# Contract under test (from local supervisor-redesign spec):
#   - the extension reads this home's in-flight crewmate panes from
#     $FM_HOME/state/*.meta (pane=, kind=, pr=),
#   - watches $FM_HOME/state/*.status,
#   - and on a captain-relevant status line (done:|blocked:|failed:|needs-decision:|
#     PR ready|checks green|ready in branch|merged) injects ONE dense wake into its
#     own omp session via pi.sendMessage(..., { deliverAs: "nextTurn", triggerTurn: true }).
#
# Observability: triggerTurn drives the session to WORKING. Because the omp<->herdr
# integration reports turn status, we detect the injection by waiting for that pane
# to transition to working. The status-file path is independent of the crewmate pane
# being live, so a placeholder pane= in the meta is fine.
#
# This is a behavior test against the contract. If SupervisorExt resolves the home
# differently (env var names, etc.), adjust the env block below to match the
# extension's documented assumptions; the rest is stable.
#
# Usage: tests/fm-supervisor-e2e.sh   (run after .omp/extensions/fm-supervisor.ts exists)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="${FM_SUPERVISOR_EXT:-$REPO/.omp/extensions/fm-supervisor.ts}"
[ -f "$EXT" ] || { echo "FAIL: extension not found at $EXT"; exit 1; }
command -v herdr >/dev/null || { echo "SKIP: herdr not available"; exit 0; }
command -v omp   >/dev/null || { echo "SKIP: omp not available"; exit 0; }

TMP="$(mktemp -d)"
PANE=""
# shellcheck disable=SC2329  # invoked indirectly via 'trap cleanup EXIT' on the next line
cleanup() { [ -n "$PANE" ] && herdr pane close "$PANE" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/state"
TASK=demo-e2e
# One in-flight ship crewmate. pane= is a placeholder: the status-file path does not
# require the crewmate pane to be live.
{
  echo "pane=w0:p0"
  echo "project=demo"
  echo "harness=omp"
  echo "kind=ship"
  echo "mode=no-mistakes"
} > "$TMP/state/$TASK.meta"
: > "$TMP/state/$TASK.status"

# Launch the extension-loaded omp, idle, in its own herdr pane, pointed at the temp home.
START_JSON="$(herdr agent start fm-e2e --no-focus \
  --env FM_HOME="$TMP" --env FM_STATE_OVERRIDE="$TMP/state" \
  --env PATH="$PATH" --env HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}" \
  --cwd "$TMP" -- omp -e "$EXT" --auto-approve --no-title --no-session --cwd "$TMP")"
PANE="$(printf '%s' "$START_JSON" | bun -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")).result; process.stdout.write((j&&(j.pane&&j.pane.pane_id||j.agent&&j.agent.pane_id))||"")')"
[ -n "$PANE" ] || { echo "FAIL: could not resolve launched pane id from: $START_JSON"; exit 1; }
echo "launched extension-loaded omp in pane $PANE"

# Let omp clear first-run onboarding AND the extension's session_start loop arm
# (refreshFleet + seedStatuses + fs.watch). seedStatuses marks the CURRENT last
# status as seen, so only a NEW post-arm write wakes - hence the generous settle.
herdr wait agent-status "$PANE" --status idle --timeout 30000 >/dev/null 2>&1 || true
sleep 12

# Trigger: append a captain-relevant status line (a NEW change after arm).
echo "trigger: writing a relevant status line"
printf 'done: PR https://github.com/o/r/pull/1 checks green\n' >> "$TMP/state/$TASK.status"

# Assert by pane CONTENT: the injected wake digest carries the task id + action.
# Content detection is robust to a fast turn that returns to idle before a
# working-status transition can be observed.
deadline=$(( $(date +%s) + 75 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  out="$(herdr pane read "$PANE" --source recent --lines 80 2>/dev/null || true)"
  if printf '%s' "$out" | grep -qiE 'demo-e2e|review.?merge|\[wake\]'; then
    echo "PASS: relevant status write triggered an injected wake (digest present in pane)"
    printf '%s\n' "$out" | tail -20
    exit 0
  fi
  sleep 2
done
echo "FAIL: no injected wake within 75s of a relevant status write"
echo "--- pane tail ---"
herdr pane read "$PANE" --source recent --lines 60 2>/dev/null || true
exit 1
