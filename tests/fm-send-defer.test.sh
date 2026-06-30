#!/usr/bin/env bash
# Peek-and-defer guard for fm-send.sh.
#
# fm-send must never run text into a pane whose composer holds a human's unsent
# draft, because herdr pane run would append to and submit (clobber) that draft.
# These tests pin the contract:
#   1. Empty composer: the send is delivered immediately (herdr pane run logged),
#      exactly as before the guard existed.
#   2. Pending draft: the send is deferred (exit 75), NO pane run is issued, and
#      the message is queued under state/.sendq/<pane>/ so the draft survives.
#   3. Drain: a queued message is delivered on the next send once the composer
#      is clear, in FIFO order ahead of the new message.
#   4. Idempotent defer: re-running a deferred send while the same draft persists
#      does not duplicate the queued message.
# They also exercise the fm_sendq_* library helpers directly.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/bin/fm-herdr-lib.sh"
SEND="$ROOT/bin/fm-send.sh"

# shellcheck source=bin/fm-herdr-lib.sh
. "$LIB"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-send-defer-tests.XXXXXX")
cleanup() { [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# Build a fake herdr that logs every call and models the idle->working delivery
# transition. Knobs:
#   FM_FAKE_PANE_LINES   - content for `herdr pane read` (the composer)
#   FM_FAKE_AGENT_STATUS - forces a fixed agent_status; when unset, the agent
#                          reads idle until any `pane run` is logged, then working
#                          (so a delivered submit confirms as expected).
#   FM_FAKE_HERDR_LOG    - call log path
make_fake_herdr() {
  local dir=$1 fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:-/dev/null}"
case "${1:-}" in
  pane)
    case "${2:-}" in
      read) printf '%s\n' "${FM_FAKE_PANE_LINES:-}"; exit 0 ;;
      run|send-keys) exit 0 ;;
      get) printf '{"pane_id":"w1:p1"}\n'; exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      get)
        if [ -n "${FM_FAKE_AGENT_STATUS:-}" ]; then
          printf '{"agent_status":"%s"}\n' "$FM_FAKE_AGENT_STATUS"
        elif grep -q 'pane run' "${FM_FAKE_HERDR_LOG:-/dev/null}" 2>/dev/null; then
          printf '{"agent_status":"working"}\n'
        else
          printf '{"agent_status":"idle"}\n'
        fi
        exit 0 ;;
    esac ;;
esac
exit 1
SH
  chmod +x "$fb/herdr"
  printf '%s\n' "$fb"
}

# --- library helpers ---------------------------------------------------------

test_sendq_dir_sanitizes_pane() {
  local got
  got=$(fm_sendq_dir "/state" "w8:p3")
  [ "$got" = "/state/.sendq/w8_p3" ] \
    || fail "fm_sendq_dir did not sanitize the pane colon: $got"
  pass "fm_sendq_dir: sanitizes the pane id into a safe path"
}

test_sendq_enqueue_count_and_fifo() {
  local dir
  dir="$TMP_ROOT/q-fifo/.sendq/w1_p1"
  fm_sendq_enqueue "$dir" "first"
  fm_sendq_enqueue "$dir" "second"
  [ "$(fm_sendq_count "$dir")" = "2" ] \
    || fail "expected 2 queued messages, got $(fm_sendq_count "$dir")"
  # FIFO: zero-padded names sort lexically, so the first glob match is the oldest.
  local first files
  files=("$dir"/*.msg)
  first=$(cat "${files[0]}")
  [ "$first" = "first" ] || fail "FIFO order broken; oldest is '$first'"
  pass "fm_sendq_enqueue/count: append, count, and FIFO order hold"
}

test_sendq_enqueue_idempotent_on_repeat() {
  local dir
  dir="$TMP_ROOT/q-dedup/.sendq/w1_p1"
  fm_sendq_enqueue "$dir" "same text"
  fm_sendq_enqueue "$dir" "same text"
  [ "$(fm_sendq_count "$dir")" = "1" ] \
    || fail "duplicate enqueue of identical newest text was not coalesced"
  fm_sendq_enqueue "$dir" "different"
  [ "$(fm_sendq_count "$dir")" = "2" ] \
    || fail "distinct text should enqueue a new message"
  pass "fm_sendq_enqueue: identical-newest is idempotent, distinct text appends"
}

# --- fm-send.sh end-to-end ---------------------------------------------------

test_empty_composer_sends_immediately() {
  local dir fb state log
  dir="$TMP_ROOT/send-empty"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  state="$dir/state"; mkdir -p "$state"
  log="$dir/herdr.log"; : > "$log"
  PATH="$fb:$PATH" FM_STATE_OVERRIDE="$state" FM_FAKE_HERDR_LOG="$log" \
    FM_FAKE_PANE_LINES="" FM_SEND_RETRIES=1 \
    "$SEND" w1:p1 "route this work" >/dev/null 2>&1 \
    || fail "fm-send failed sending into an empty composer"
  grep -F 'herdr pane run w1:p1 route this work' "$log" >/dev/null \
    || fail "empty-composer send did not run the text on the pane"
  [ "$(fm_sendq_count "$(fm_sendq_dir "$state" "w1:p1")")" = "0" ] \
    || fail "empty-composer send should not queue anything"
  pass "fm-send: empty composer delivers immediately (no queue)"
}

test_pending_draft_defers_and_preserves() {
  local dir fb state log rc qdir
  dir="$TMP_ROOT/send-draft"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  state="$dir/state"; mkdir -p "$state"
  log="$dir/herdr.log"; : > "$log"
  # The captain is mid-typing: a real, non-empty draft sits in the composer.
  rc=0
  PATH="$fb:$PATH" FM_STATE_OVERRIDE="$state" FM_FAKE_HERDR_LOG="$log" \
    FM_FAKE_PANE_LINES="half typed captain note" FM_FAKE_AGENT_STATUS="idle" \
    FM_SEND_RETRIES=1 \
    "$SEND" w1:p1 "supervisor message" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 75 ] || fail "deferred send should exit 75, got $rc"
  # The draft must NOT be clobbered: no pane run was issued at all.
  if grep -F 'herdr pane run' "$log" >/dev/null; then
    fail "deferred send ran text into a pane holding a human draft (clobber!)"
  fi
  qdir=$(fm_sendq_dir "$state" "w1:p1")
  [ "$(fm_sendq_count "$qdir")" = "1" ] \
    || fail "deferred message was not queued"
  [ "$(cat "$qdir"/*.msg)" = "supervisor message" ] \
    || fail "queued message body is wrong"
  pass "fm-send: pending draft defers (exit 75), draft preserved, message queued"
}

test_defer_is_idempotent_on_retry() {
  local dir fb state log qdir
  dir="$TMP_ROOT/send-retry"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  state="$dir/state"; mkdir -p "$state"
  log="$dir/herdr.log"; : > "$log"
  for _ in 1 2; do
    PATH="$fb:$PATH" FM_STATE_OVERRIDE="$state" FM_FAKE_HERDR_LOG="$log" \
      FM_FAKE_PANE_LINES="still typing" FM_FAKE_AGENT_STATUS="idle" \
      FM_SEND_RETRIES=1 \
      "$SEND" w1:p1 "same supervisor message" >/dev/null 2>&1 || true
  done
  qdir=$(fm_sendq_dir "$state" "w1:p1")
  [ "$(fm_sendq_count "$qdir")" = "1" ] \
    || fail "re-running a deferred send duplicated the queued message"
  pass "fm-send: re-running a deferred send does not duplicate the queue"
}

test_queue_drains_when_composer_clears() {
  local dir fb state log qdir
  dir="$TMP_ROOT/send-drain"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  state="$dir/state"; mkdir -p "$state"
  log="$dir/herdr.log"; : > "$log"
  # Pre-seed a queued message (as a prior deferral would have left it).
  qdir=$(fm_sendq_dir "$state" "w1:p1")
  fm_sendq_enqueue "$qdir" "queued earlier"
  # Now the composer is clear; sending a new message must first drain the queue,
  # then deliver the new message - both in FIFO order.
  PATH="$fb:$PATH" FM_STATE_OVERRIDE="$state" FM_FAKE_HERDR_LOG="$log" \
    FM_FAKE_PANE_LINES="" FM_SEND_RETRIES=1 \
    "$SEND" w1:p1 "new message" >/dev/null 2>&1 \
    || fail "fm-send failed draining the queue into a clear composer"
  grep -F 'herdr pane run w1:p1 queued earlier' "$log" >/dev/null \
    || fail "the queued message was not delivered on drain"
  grep -F 'herdr pane run w1:p1 new message' "$log" >/dev/null \
    || fail "the new message was not delivered after the drain"
  # FIFO: the queued message must be run before the new one.
  local q_line n_line
  q_line=$(grep -nF 'herdr pane run w1:p1 queued earlier' "$log" | head -1 | cut -d: -f1)
  n_line=$(grep -nF 'herdr pane run w1:p1 new message' "$log" | head -1 | cut -d: -f1)
  [ "$q_line" -lt "$n_line" ] \
    || fail "drain order broken: queued message ran after the new one"
  [ "$(fm_sendq_count "$qdir")" = "0" ] \
    || fail "queue was not emptied after a successful drain"
  pass "fm-send: queued message drains FIFO ahead of the new send when composer is clear"
}

test_key_path_is_unguarded() {
  local dir fb state log
  dir="$TMP_ROOT/send-key"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  state="$dir/state"; mkdir -p "$state"
  log="$dir/herdr.log"; : > "$log"
  # Even with a draft in the composer, a control key (Escape) must pass through:
  # it is an interrupt, not text that can clobber a draft.
  PATH="$fb:$PATH" FM_STATE_OVERRIDE="$state" FM_FAKE_HERDR_LOG="$log" \
    FM_FAKE_PANE_LINES="half typed note" FM_FAKE_AGENT_STATUS="idle" \
    "$SEND" w1:p1 --key Escape >/dev/null 2>&1 \
    || fail "fm-send --key failed"
  grep -F 'herdr pane send-keys w1:p1 Escape' "$log" >/dev/null \
    || fail "--key did not send the control key through"
  pass "fm-send: --key control keys are unguarded (interrupt, never deferred)"
}

test_sendq_dir_sanitizes_pane
test_sendq_enqueue_count_and_fifo
test_sendq_enqueue_idempotent_on_repeat
test_empty_composer_sends_immediately
test_pending_draft_defers_and_preserves
test_defer_is_idempotent_on_retry
test_queue_drains_when_composer_clears
test_key_path_is_unguarded
