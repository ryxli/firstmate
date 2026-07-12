#!/usr/bin/env bash
# Behavior tests for bin/fm-browser.sh named-session semantics.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSER="$ROOT/sbin/fm-browser.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-browser.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

make_fakebin() {
  local case_dir=$1 fakebin
  fakebin="$case_dir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/bunx" <<'SH'
#!/usr/bin/env bash
printf 'session=%s args=%s\n' "${CHROME_DEVTOOLS_AXI_SESSION:-}" "$*" >> "${FAKE_BUNX_LOG:?}"
exit "${FAKE_BUNX_RC:-0}"
SH
  chmod +x "$fakebin/bunx"
  printf '%s\n' "$fakebin"
}

run_browser() {
  local home=$1 fakebin=$2
  shift 2
  PATH="$fakebin:$PATH" \
    FM_ROOT_OVERRIDE='' \
    FM_HOME="$home" \
    FM_STATE_OVERRIDE='' FM_DATA_OVERRIDE='' FM_PROJECTS_OVERRIDE='' FM_CONFIG_OVERRIDE='' \
    FAKE_BUNX_LOG="$home/bunx.log" \
    "$BROWSER" "$@" 2>&1
}

assert_contains() {
  local file=$1 needle=$2 label=$3
  grep -qF "$needle" "$file" || fail "$label: missing '$needle' in $file"
}

make_marker() {
  local marker=$1 session=$2
  mkdir -p "$(dirname "$marker")"
  cat > "$marker" <<EOF
session=$session
cwd=$TMP_ROOT
updated_at=2026-07-11T00:00:00Z
command=open http://example.test
EOF
}

test_wrapper_records_home_scoped_marker_and_invokes_bunx() {
  local home fakebin out marker
  home="$TMP_ROOT/env-session"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")

  out=$(FM_BROWSER_SESSION='Fix UI' run_browser "$home" "$fakebin" open http://example.test) \
    || fail "wrapper open failed: $out"

  marker="$home/state/browser/fix-ui.meta"
  [ -f "$marker" ] || fail "wrapper did not write a home-scoped session marker"
  assert_contains "$marker" 'session=fix-ui' 'session marker'
  assert_contains "$marker" 'command=open http://example.test' 'session marker'
  [ -f "$home/bunx.log" ] || fail "fake bunx was not invoked"
  assert_contains "$home/bunx.log" 'session=fix-ui args=chrome-devtools-axi open http://example.test' 'bunx log'
  pass "wrapper records a home-scoped marker and invokes chrome-devtools-axi through bunx"
}

test_stop_uses_marker_calls_upstream_stop_and_removes_marker() {
  local home fakebin out marker
  home="$TMP_ROOT/stop-marker"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")
  marker="$home/state/browser/ui-task.meta"
  make_marker "$marker" ui-task

  out=$(run_browser "$home" "$fakebin" --session ui-task stop) \
    || fail "stop with marker failed: $out"

  [ ! -f "$marker" ] || fail "successful stop did not remove the marker"
  assert_contains "$home/bunx.log" 'session=ui-task args=chrome-devtools-axi stop' 'bunx log'
  pass "stop uses the recorded marker, calls upstream stop, and removes the marker"
}

test_failed_stop_retains_marker_for_teardown_retry() {
  local home fakebin out marker rc
  home="$TMP_ROOT/stop-retry"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")
  marker="$home/state/browser/ui-task.meta"
  make_marker "$marker" ui-task

  out=$(FAKE_BUNX_RC=23 run_browser "$home" "$fakebin" --session ui-task stop)
  rc=$?

  [ "$rc" -eq 23 ] || fail "failed stop should preserve its upstream exit code (got $rc): $out"
  [ -f "$marker" ] || fail "failed stop removed the marker and prevented teardown retry"
  assert_contains "$home/bunx.log" 'session=ui-task args=chrome-devtools-axi stop' 'bunx log'
  pass "failed stop retains the marker for a safe retry"
}

test_stop_without_marker_is_noop() {
  local home fakebin out
  home="$TMP_ROOT/stop-empty"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")

  out=$(run_browser "$home" "$fakebin" --session ui-task stop) \
    || fail "stop without marker failed: $out"

  printf '%s\n' "$out" | grep -F 'browser session ui-task has no local marker; nothing to stop' >/dev/null \
    || fail "stop without marker printed the wrong message: $out"
  [ ! -e "$home/bunx.log" ] || fail "stop without marker should not invoke bunx"
  pass "stop without marker is a clean no-op"
}

test_global_port_is_blocked_unless_allowed() {
  local home fakebin out marker rc
  home="$TMP_ROOT/port-guard"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")

  out=$(CHROME_DEVTOOLS_AXI_PORT=9224 run_browser "$home" "$fakebin" --session ui-task open http://example.test)
  rc=$?

  [ "$rc" -eq 2 ] || fail "port guard should exit 2 (got $rc): $out"
  printf '%s\n' "$out" | grep -F 'error: CHROME_DEVTOOLS_AXI_PORT is set; unset it or set FM_BROWSER_ALLOW_PORT=1 for an intentional per-command override' >/dev/null \
    || fail "port guard printed the wrong diagnostic: $out"
  marker="$home/state/browser/ui-task.meta"
  [ ! -e "$marker" ] || fail "port guard should not write a marker"
  [ ! -e "$home/bunx.log" ] || fail "port guard should not invoke bunx"
  pass "global CHROME_DEVTOOLS_AXI_PORT is blocked unless explicitly allowed"
}

test_global_port_can_be_allowed_per_command() {
  local home fakebin out marker
  home="$TMP_ROOT/port-allow"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")

  out=$(CHROME_DEVTOOLS_AXI_PORT=9224 FM_BROWSER_ALLOW_PORT=1 \
    run_browser "$home" "$fakebin" --session 'Fix UI' open http://example.test) \
    || fail "allowed port override failed: $out"

  marker="$home/state/browser/fix-ui.meta"
  [ -f "$marker" ] || fail "allowed port override did not write the normalized marker"
  assert_contains "$home/bunx.log" 'session=fix-ui args=chrome-devtools-axi open http://example.test' 'bunx log'
  pass "global CHROME_DEVTOOLS_AXI_PORT works when explicitly allowed for the command"
}

test_browser_state_dir_override_stays_local_to_selected_home() {
  local home fakebin out marker
  home="$TMP_ROOT/state-dir-override"
  mkdir -p "$home"
  fakebin=$(make_fakebin "$home")

  out=$(FM_BROWSER_STATE_DIR="$home/selected-state/browser" \
    run_browser "$home" "$fakebin" --session ui-task open http://example.test) \
    || fail "state directory override failed: $out"

  marker="$home/selected-state/browser/ui-task.meta"
  [ -f "$marker" ] || fail "state directory override did not receive the session marker"
  [ ! -e "$home/state/browser/ui-task.meta" ] || fail "state directory override leaked a marker into the default state"
  pass "browser state directory override remains local to the selected home"
}

test_fallback_session_slug_is_stable_and_sanitized() {
  local home work out
  home="$TMP_ROOT/Home With Spaces"
  work="$home/worktrees/Fix UI"
  mkdir -p "$work"

  out=$(cd "$work" && FM_HOME="$home" "$BROWSER" session) \
    || fail "session fallback failed: $out"

  [ "$out" = 'fm-home-with-spaces-fix-ui' ] || fail "fallback session name was '$out'"
  pass "fallback session slug is stable and sanitized"
}

test_session_in_home_uses_manual_suffix() {
  local home out
  home="$TMP_ROOT/manual-browser"
  mkdir -p "$home"

  out=$(cd "$home" && FM_HOME="$home" "$BROWSER" session) \
    || fail "manual session fallback failed: $out"

  [ "$out" = 'fm-manual-browser-manual' ] || fail "manual fallback session name was '$out'"
  pass "session started from the home uses a stable manual suffix"
}

test_wrapper_records_home_scoped_marker_and_invokes_bunx
test_stop_uses_marker_calls_upstream_stop_and_removes_marker
test_failed_stop_retains_marker_for_teardown_retry
test_stop_without_marker_is_noop
test_global_port_is_blocked_unless_allowed
test_global_port_can_be_allowed_per_command
test_browser_state_dir_override_stays_local_to_selected_home
test_session_in_home_uses_manual_suffix
test_fallback_session_slug_is_stable_and_sanitized
