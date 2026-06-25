#!/usr/bin/env bash
# fm-watch.sh stale-pane detection around PR-ready ship tasks.
#
# A ship task keeps its agent pane until the PR merges and teardown runs, so
# once the crewmate reports "done: PR ..." the pane sits idle waiting for merge.
# The watcher must NOT treat that idle pane as stale (repeated useless wakes),
# yet every other behavior is unchanged: ordinary idle ship panes still go
# stale, a done task without a recorded PR still goes stale, the merge poll
# (*.check.sh) still runs for the parked task, and secondmate panes are still
# skipped.
#
# These tests drive the real bin/fm-watch.sh against a temp state fixture with a
# fake herdr (fixed agent status) on PATH, FM_STALE_POLLS=1 so one idle poll is
# enough, and a pre-seeded .seen-* marker so the status-file signal scan does
# not fire before stale detection is reached.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH="$ROOT/bin/fm-watch.sh"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-watch-stale-tests.XXXXXX")
cleanup() { [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

if [ "$(uname)" = Darwin ]; then
  sig_of() { stat -f '%z:%Fm' "$1" 2>/dev/null; }
else
  sig_of() { stat -c '%s:%Y' "$1" 2>/dev/null; }
fi

# Fake herdr: only `agent get` is exercised; returns FM_FAKE_AGENT_STATUS (idle).
make_fake_herdr() {
  local fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = agent ] && [ "${2:-}" = get ]; then
  printf '{"agent_status":"%s"}\n' "${FM_FAKE_AGENT_STATUS:-idle}"
  exit 0
fi
exit 0
SH
  chmod +x "$fb/herdr"
}

# new_state <name>: create a fresh state dir + fake herdr, echo its path.
new_state() {
  local d="$TMP_ROOT/$1/state"
  mkdir -p "$d"
  make_fake_herdr "$TMP_ROOT/$1"
  printf '%s\n' "$d"
}

# write_meta <state> <id> <line>...: write a *.meta file.
write_meta() {
  local state=$1 id=$2; shift 2
  printf '%s\n' "$@" > "$state/$id.meta"
}

# write_status <state> <id> <line>...: write a *.status file and seed its
# .seen-* marker so the signal scan stays quiet.
write_status() {
  local state=$1 id=$2; shift 2
  printf '%s\n' "$@" > "$state/$id.status"
  printf '%s' "$(sig_of "$state/$id.status")" > "$state/.seen-${id}_status"
}

# run_watch <state> <max_ticks>: run fm-watch.sh until it wakes (prints reason
# and exits) or max_ticks*0.2s elapse. Echoes captured output; returns the
# watcher exit code, or 124 on timeout. CHECK_INTERVAL/AGENT_STATUS overridable
# via caller-scoped vars.
run_watch() {
  local state=$1 max=$2 out pid i fakebin
  local ci="${CHECK_INTERVAL:-99999}"
  fakebin="$(dirname "$state")/fakebin"
  out="$state/.watch.out"
  : > "$out"
  (
    FM_STATE_OVERRIDE="$state" \
    FM_POLL=1 FM_STALE_POLLS=1 FM_SIGNAL_GRACE=1 \
    FM_CHECK_INTERVAL="$ci" FM_HEARTBEAT=99999 FM_HEARTBEAT_MAX=99999 \
    FM_FAKE_AGENT_STATUS="${FM_FAKE_AGENT_STATUS:-idle}" \
    PATH="$fakebin:$PATH" \
    bash "$WATCH" >"$out" 2>&1
  ) &
  pid=$!
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.2; i=$((i + 1))
    [ "$i" -ge "$max" ] && break
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    cat "$out"
    return 124
  fi
  wait "$pid" 2>/dev/null
  cat "$out"
  return 0
}

# --- tests -------------------------------------------------------------------

# PR-ready ship task: pr= recorded, status ends in done: PR ... -> NO stale.
test_pr_ready_no_stale() {
  local state out rc
  state=$(new_state pr-ready)
  write_meta "$state" task \
    "pane=w1:p1" "kind=ship" "mode=no-mistakes" \
    "pr=https://github.com/o/r/pull/1"
  write_status "$state" task \
    "working: building" "done: PR https://github.com/o/r/pull/1 checks green"
  out=$(run_watch "$state" 15); rc=$?
  case "$out" in
    *stale:*) fail "PR-ready task awaiting merge falsely emitted a stale wake: $out" ;;
  esac
  [ "$rc" -eq 124 ] || fail "PR-ready task woke for some other reason (rc=$rc): $out"
  pass "PR-ready ship task awaiting merge does NOT stale-wake"
}

# Ordinary idle ship task (no pr=): still goes stale. This is the same idle
# pane as the PR-ready case; only the pr=/done:PR metadata suppresses the wake.
test_non_pr_idle_still_stale() {
  local state out rc
  state=$(new_state non-pr-idle)
  write_meta "$state" task "pane=w2:p1" "kind=ship" "mode=no-mistakes"
  write_status "$state" task "working: building"
  out=$(run_watch "$state" 25); rc=$?
  [ "$rc" -eq 0 ] || fail "non-PR idle ship task did not wake (rc=$rc): $out"
  case "$out" in
    *"stale: w2:p1"*) ;;
    *) fail "non-PR idle ship task did not emit expected stale wake: $out" ;;
  esac
  pass "non-PR idle ship task still stale-wakes"
}

# A done task with no recorded pr= is NOT awaiting merge -> existing behavior:
# its idle pane still goes stale (the narrow skip is pr= + done:PR only).
test_done_without_pr_still_stale() {
  local state out rc
  state=$(new_state done-no-pr)
  write_meta "$state" task "pane=w3:p1" "kind=ship" "mode=local-only"
  write_status "$state" task "done: refactor complete, ready in branch fm/task"
  out=$(run_watch "$state" 25); rc=$?
  [ "$rc" -eq 0 ] || fail "done-without-pr task did not wake (rc=$rc): $out"
  case "$out" in
    *"stale: w3:p1"*) ;;
    *) fail "done-without-pr task did not emit expected stale wake: $out" ;;
  esac
  pass "done task without pr= still stale-wakes"
}

# Secondmate panes are managed by their own home -> never stale (unchanged).
test_secondmate_skip_unchanged() {
  local state out rc
  state=$(new_state secondmate)
  write_meta "$state" sm "pane=w4:p1" "kind=secondmate" "home=/tmp/sm"
  write_status "$state" sm "working: supervising"
  out=$(run_watch "$state" 15); rc=$?
  case "$out" in
    *stale:*) fail "secondmate pane falsely emitted a stale wake: $out" ;;
  esac
  [ "$rc" -eq 124 ] || fail "secondmate pane woke for some other reason (rc=$rc): $out"
  pass "secondmate pane skip unchanged (no stale)"
}

# The merge poll keeps running for a PR-ready task: its *.check.sh still fires.
test_pr_ready_merge_poll_still_runs() {
  local state out rc
  state=$(new_state pr-ready-check)
  write_meta "$state" task \
    "pane=w5:p1" "kind=ship" "mode=no-mistakes" \
    "pr=https://github.com/o/r/pull/5"
  write_status "$state" task \
    "working: building" "done: PR https://github.com/o/r/pull/5 checks green"
  printf '#!/usr/bin/env bash\necho MERGED\n' > "$state/task.check.sh"
  chmod +x "$state/task.check.sh"
  # CHECK_INTERVAL=0 so the poll runs immediately; no .last-check pre-seed.
  CHECK_INTERVAL=0 out=$(run_watch "$state" 25); rc=$?
  [ "$rc" -eq 0 ] || fail "PR-ready merge poll did not fire (rc=$rc): $out"
  case "$out" in
    *"check:"*MERGED*) ;;
    *) fail "PR-ready task's merge poll (check.sh) did not run: $out" ;;
  esac
  pass "PR-ready ship task still runs its merge poll"
}

test_pr_ready_no_stale
test_non_pr_idle_still_stale
test_done_without_pr_still_stale
test_secondmate_skip_unchanged
test_pr_ready_merge_poll_still_runs
