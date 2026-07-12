#!/usr/bin/env bash
# Tests for fm-send's durable send queue and background drain.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup() {
  if [ -n "${TMP_ROOT:-}" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-sendq-tests.XXXXXX")

make_fake_herdr() {
  local dir=$1 fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:-/dev/null}"
case "${1:-}" in
  agent)
    case "${2:-}" in
      get)
        printf '{"agent_status":"%s","pane_id":"w1:p1"}\n' "${FM_FAKE_AGENT_STATUS:-idle}"
        exit 0 ;;
    esac ;;
  pane)
    case "${2:-}" in
      read)
        if [ -n "${FM_FAKE_PANE_LINES_AFTER_RUN:-}" ] && grep -F 'herdr pane run ' "${FM_FAKE_HERDR_LOG:-/dev/null}" >/dev/null 2>&1; then
          printf '%s\n' "$FM_FAKE_PANE_LINES_AFTER_RUN"
        else
          printf '%s\n' "${FM_FAKE_PANE_LINES:-}"
        fi
        exit 0 ;;
      run|send-keys)
        exit 0 ;;
    esac ;;
esac
exit 1
SH
  chmod +x "$fb/herdr"
  printf '%s\n' "$fb"
}

make_home() {
  local home=$1
  mkdir -p "$home/state"
  cat > "$home/state/task.meta" <<EOF
pane=w1:p1
kind=ship
EOF
}

test_send_queues_when_composer_stays_busy() {
  local dir home fb err qcount
  dir="$TMP_ROOT/queue"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")
  err="$dir/send.err"

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="" FM_FAKE_PANE_LINES_AFTER_RUN="│ still typed │" \
    FM_SEND_RETRIES=1 FM_SENDQ_NO_BACKGROUND=1 \
    "$ROOT/sbin/fm-send.sh" fm-task "queued work" >"$dir/send.out" 2>"$err" \
    || fail "fm-send should return success after queueing a pending delivery"

  qcount=$(find "$home/state/sendq" -name '*.json' | wc -l | tr -d ' ')
  [ "$qcount" = "1" ] || fail "expected one queued send item, got $qcount"
  grep -F 'queued: text not submitted to w1:p1' "$err" >/dev/null \
    || fail "fm-send did not report queued delivery"
  pass "fm-send queues pending composer deliveries"
}

test_send_defers_human_draft_without_clobbering_or_duplicating() {
  local dir home fb err rc qcount body
  dir="$TMP_ROOT/defer-draft"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")
  err="$dir/send.err"

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="│ captain draft │" \
    FM_SEND_RETRIES=1 FM_SENDQ_NO_BACKGROUND=1 \
    "$ROOT/sbin/fm-send.sh" fm-task "deferred steer" >"$dir/send.out" 2>"$err" \
    || rc=$?
  [ "$rc" = "75" ] || fail "expected deferred send to exit 75, got $rc"
  grep -F 'herdr pane run ' "$dir/herdr.log" >/dev/null \
    && fail "deferred send ran text into a human draft"
  qcount=$(find "$home/state/sendq" -name '*.json' | wc -l | tr -d ' ')
  [ "$qcount" = "1" ] || fail "expected one deferred queue item, got $qcount"
  body=$(SENDQ_FILE="$(find "$home/state/sendq" -name '*.json')" python3 -c 'import json, os; print(json.load(open(os.environ["SENDQ_FILE"], encoding="utf-8"))["text"])')
  [ "$body" = "deferred steer" ] || fail "deferred queue item had wrong text: $body"

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="│ captain draft │" \
    FM_SEND_RETRIES=1 FM_SENDQ_NO_BACKGROUND=1 \
    "$ROOT/sbin/fm-send.sh" fm-task "deferred steer" >/dev/null 2>/dev/null \
    || rc=$?
  [ "$rc" = "75" ] || fail "repeat deferred send should exit 75, got $rc"
  qcount=$(find "$home/state/sendq" -name '*.json' | wc -l | tr -d ' ')
  [ "$qcount" = "1" ] || fail "repeat deferred send duplicated the queue"
  pass "fm-send defers human drafts without clobbering or duplicate queueing"
}

test_key_bypasses_composer_defer() {
  local dir home fb
  dir="$TMP_ROOT/key-bypass"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="│ captain draft │" \
    "$ROOT/sbin/fm-send.sh" fm-task --key Escape \
    || fail "control key unexpectedly deferred"
  grep -F 'herdr pane send-keys w1:p1 Escape' "$dir/herdr.log" >/dev/null \
    || fail "control key was not sent through"
  pass "fm-send bypasses composer defer for control keys"
}

test_drain_surfaces_stale_pending_item() {
  local dir home fb status
  dir="$TMP_ROOT/stale"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="" FM_FAKE_PANE_LINES_AFTER_RUN="│ still typed │" \
    FM_SEND_RETRIES=1 FM_SENDQ_NO_BACKGROUND=1 \
    "$ROOT/sbin/fm-send.sh" fm-task "queued work" >/dev/null 2>/dev/null \
    || fail "fm-send failed to queue stale test item"

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="" FM_FAKE_PANE_LINES_AFTER_RUN="│ still typed │" \
    FM_SENDQ_ALERT_SECS=0 "$ROOT/sbin/fm-sendq-drain.sh" --once \
    || fail "sendq drain failed"

  status="$home/state/sendq.status"
  [ -f "$status" ] || fail "sendq drain did not create sendq.status"
  grep -F 'blocked: sendq pending for fm-task' "$status" >/dev/null \
    || fail "sendq drain did not surface stale pending item"
  pass "sendq drain surfaces stale pending deliveries"
}

test_drain_removes_delivered_item() {
  local dir home fb qcount
  dir="$TMP_ROOT/delivered"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="" FM_FAKE_PANE_LINES_AFTER_RUN="│ still typed │" \
    FM_SEND_RETRIES=1 FM_SENDQ_NO_BACKGROUND=1 \
    "$ROOT/sbin/fm-send.sh" fm-task "queued work" >/dev/null 2>/dev/null \
    || fail "fm-send failed to queue delivered test item"

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="working" FM_FAKE_PANE_LINES="" \
    "$ROOT/sbin/fm-sendq-drain.sh" --once \
    || fail "sendq drain failed delivery test"

  qcount=$(find "$home/state/sendq" -name '*.json' | wc -l | tr -d ' ')
  [ "$qcount" = "0" ] || fail "delivered sendq item was not removed"
  pass "sendq drain removes delivered items"
}

test_send_queues_when_composer_stays_busy
test_drain_surfaces_stale_pending_item
test_send_defers_human_draft_without_clobbering_or_duplicating
test_key_bypasses_composer_defer
test_drain_removes_delivered_item
