#!/usr/bin/env bash
# Tests for the fm-send.sh dispatch gate (freeze + focus lock).
# Stubs herdr via a minimal fake binary on PATH.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() { printf 'ok - %s\n' "$1"; }

cleanup() { [ -z "$TMP_ROOT" ] || rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-gate-tests.XXXXXX")

# make_gate_case: create a temp dir with state/ and a minimal fake herdr.
# The fake herdr logs each atomic "pane run" submission to
# $FM_GATE_SENT_LOG when set.
make_gate_case() {
  local name=$1 dir fakebin
  dir="$TMP_ROOT/$name"
  fakebin="$dir/fakebin"
  mkdir -p "$dir/state" "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  pane)
    case "${2:-}" in
      get)      exit 0 ;;
      read)     exit 0 ;;
      send-keys) exit 0 ;;
      run)
        pane="${3:-}"; shift 3 2>/dev/null || true; text="$*"
        log="${FM_GATE_SENT_LOG:-}"
        [ -n "$log" ] && printf '%s\n' "$text" >> "$log"
        exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      get) printf '{"agent_status":"idle"}\n'; exit 0 ;;
    esac ;;
  notification) exit 0 ;;
  status) printf 'status: running\n'; exit 0 ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$dir"
}

# write_meta: write state/<id>.meta so fm_resolve_live_pane can find the pane.
write_meta() {
  local state=$1 id=$2 pane=$3
  printf 'pane=%s\nkind=ship\n' "$pane" > "$state/${id}.meta"
}

# Common env knobs shared by send-exercising tests.
# -----------------------------------------------------------------------
# 1. Normal send with no gate flags active -> succeeds
# -----------------------------------------------------------------------
test_normal_send_unaffected() {
  local dir state fakebin sent err
  dir=$(make_gate_case normal)
  state="$dir/state"; fakebin="$dir/fakebin"
  sent="$dir/sent.log"; err="$dir/err"
  PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    FM_GATE_SENT_LOG="$sent" \
    "$ROOT/sbin/fm-send.sh" w1:p1 'do some work' >/dev/null 2>"$err" \
    || fail "normal send failed when no gate flags exist: $(cat "$err")"
  grep -qF 'do some work' "$sent" || fail "sent log missing expected text"
  pass "normal send succeeds with no gate flags"
}

# -----------------------------------------------------------------------
# 2. Dispatch freeze -> blocks send
# -----------------------------------------------------------------------
test_freeze_blocks_send() {
  local dir state fakebin err
  dir=$(make_gate_case freeze-block)
  state="$dir/state"; fakebin="$dir/fakebin"; err="$dir/err"
  printf 'ship is on standby\n' > "$state/.dispatch-freeze"
  if PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    "$ROOT/sbin/fm-send.sh" w1:p1 'new task' >/dev/null 2>"$err"; then
    fail "fm-send succeeded despite a dispatch freeze"
  fi
  grep -qF 'frozen' "$err" \
    || fail "stderr missing 'frozen' message: $(cat "$err")"
  grep -qF '.dispatch-freeze' "$err" \
    || fail "stderr missing freeze flag path: $(cat "$err")"
  pass "dispatch freeze blocks fm-send with clear error"
}

# -----------------------------------------------------------------------
# 3. --steer bypasses dispatch freeze
# -----------------------------------------------------------------------
test_steer_bypasses_freeze() {
  local dir state fakebin sent err
  dir=$(make_gate_case steer-bypass)
  state="$dir/state"; fakebin="$dir/fakebin"
  sent="$dir/sent.log"; err="$dir/err"
  printf 'frozen for drills\n' > "$state/.dispatch-freeze"
  PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    FM_GATE_SENT_LOG="$sent" \
    "$ROOT/sbin/fm-send.sh" w1:p1 --steer 'course correction' >/dev/null 2>"$err" \
    || fail "--steer did not bypass the dispatch freeze: $(cat "$err")"
  grep -qF 'course correction' "$sent" \
    || fail "--steer message was not delivered to the pane"
  pass "--steer bypasses dispatch freeze"
}

# -----------------------------------------------------------------------
# 4. FM_DISPATCH_OVERRIDE=1 bypasses dispatch freeze
# -----------------------------------------------------------------------
test_override_env_bypasses_freeze() {
  local dir state fakebin sent err
  dir=$(make_gate_case override-env)
  state="$dir/state"; fakebin="$dir/fakebin"
  sent="$dir/sent.log"; err="$dir/err"
  printf 'frozen\n' > "$state/.dispatch-freeze"
  PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    FM_GATE_SENT_LOG="$sent" FM_DISPATCH_OVERRIDE=1 \
    "$ROOT/sbin/fm-send.sh" w1:p1 'override message' >/dev/null 2>"$err" \
    || fail "FM_DISPATCH_OVERRIDE=1 did not bypass freeze: $(cat "$err")"
  grep -qF 'override message' "$sent" \
    || fail "override message not delivered to pane"
  pass "FM_DISPATCH_OVERRIDE=1 bypasses dispatch freeze"
}

# -----------------------------------------------------------------------
# 5. Focus lock blocks send to that mate
# -----------------------------------------------------------------------
test_focus_lock_blocks_send() {
  local dir state fakebin err
  dir=$(make_gate_case focus-block)
  state="$dir/state"; fakebin="$dir/fakebin"; err="$dir/err"
  write_meta "$state" "target" "w2:p3"
  printf 'working on REI-999 only\n' > "$state/.focus-target"
  if PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    "$ROOT/sbin/fm-send.sh" fm-target 'new assignment' >/dev/null 2>"$err"; then
    fail "fm-send succeeded despite a focus lock"
  fi
  grep -qF 'focus-locked' "$err" \
    || fail "stderr missing 'focus-locked': $(cat "$err")"
  grep -qF 'REI-999 only' "$err" \
    || fail "stderr missing lock reason: $(cat "$err")"
  pass "focus lock blocks fm-send to the locked mate"
}

# -----------------------------------------------------------------------
# 6. No focus lock file -> send allowed
# -----------------------------------------------------------------------
test_focus_lock_absent_allows_send() {
  local dir state fakebin sent err
  dir=$(make_gate_case focus-off)
  state="$dir/state"; fakebin="$dir/fakebin"
  sent="$dir/sent.log"; err="$dir/err"
  write_meta "$state" "target" "w2:p4"
  # No .focus-target file present
  PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    FM_GATE_SENT_LOG="$sent" \
    "$ROOT/sbin/fm-send.sh" fm-target 'new task' >/dev/null 2>"$err" \
    || fail "fm-send failed when no focus lock exists: $(cat "$err")"
  grep -qF 'new task' "$sent" \
    || fail "message not delivered when focus lock is absent"
  pass "send succeeds when focus lock file is absent"
}

# -----------------------------------------------------------------------
# 7. --steer bypasses focus lock
# -----------------------------------------------------------------------
test_steer_bypasses_focus_lock() {
  local dir state fakebin sent err
  dir=$(make_gate_case steer-focus)
  state="$dir/state"; fakebin="$dir/fakebin"
  sent="$dir/sent.log"; err="$dir/err"
  write_meta "$state" "target" "w2:p5"
  printf 'deep focus on X\n' > "$state/.focus-target"
  PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" FM_SEND_SLEEP=0.05 FM_SEND_RETRIES=1 \
    FM_GATE_SENT_LOG="$sent" \
    "$ROOT/sbin/fm-send.sh" fm-target --steer 'quick correction' >/dev/null 2>"$err" \
    || fail "--steer did not bypass the focus lock: $(cat "$err")"
  grep -qF 'quick correction' "$sent" \
    || fail "--steer message not delivered past focus lock"
  pass "--steer bypasses focus lock"
}

# -----------------------------------------------------------------------
# 8. Freeze does not affect raw pane IDs for --key sends combined with --steer
# -----------------------------------------------------------------------
test_steer_key_send_bypasses_freeze() {
  local dir state fakebin err
  dir=$(make_gate_case steer-key)
  state="$dir/state"; fakebin="$dir/fakebin"; err="$dir/err"
  printf 'frozen\n' > "$state/.dispatch-freeze"
  PATH="$fakebin:$PATH" \
    FM_STATE_OVERRIDE="$state" \
    "$ROOT/sbin/fm-send.sh" w1:p1 --steer --key Escape >/dev/null 2>"$err" \
    || fail "--steer --key send blocked by freeze: $(cat "$err")"
  pass "--steer --key send bypasses freeze"
}

# -----------------------------------------------------------------------
# Run all tests
# -----------------------------------------------------------------------
test_normal_send_unaffected
test_freeze_blocks_send
test_steer_bypasses_freeze
test_override_env_bypasses_freeze
test_focus_lock_blocks_send
test_focus_lock_absent_allows_send
test_steer_bypasses_focus_lock
test_steer_key_send_bypasses_freeze
