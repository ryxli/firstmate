#!/usr/bin/env bash
# Fast, network-free checks for the Lavish render-delegation primitives.
# Covers the pure session math (key/url/canonical/state-dir), steward liveness,
# the orphan-poll reaper's selectivity, and argument validation. The full
# open->relay->reply->end->recover flow is exercised live by the smoke path; CI
# stays offline, so these assert the contracts that must hold without a server.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/sbin/fm-lavish-lib.sh"
OPEN="$ROOT/sbin/fm-lavish-open.sh"
REPLY="$ROOT/sbin/fm-lavish-reply.sh"
STEWARD="$ROOT/sbin/fm-lavish-steward.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-lavish.XXXXXX")
trap 'pkill -f "$TMP_ROOT" 2>/dev/null; rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# shellcheck source=sbin/fm-lavish-lib.sh
. "$LIB"

test_key_is_sha256_16_and_deterministic() {
  local p k1 k2 expect
  p="/tmp/fixed/path.html"
  # Independent golden: first 16 hex of sha256(path-string), no trailing newline.
  # Match the lib's portability (shasum on macOS, sha256sum on Linux CI).
  if command -v shasum >/dev/null 2>&1; then
    expect=$(printf '%s' "$p" | shasum -a 256 | cut -c1-16)
  else
    expect=$(printf '%s' "$p" | sha256sum | cut -c1-16)
  fi
  k1=$(fm_lavish_key "$p")
  k2=$(fm_lavish_key "$p")
  [ "$k1" = "$expect" ] || fail "key != sha256-16 golden ($k1 vs $expect)"
  [ "$k1" = "$k2" ] || fail "key not deterministic ($k1 vs $k2)"
  [ "${#k1}" -eq 16 ] || fail "key not 16 chars (${#k1})"
  pass "session key is deterministic sha256-16 of the path"
}

test_base_url_variants() {
  [ "$(fm_lavish_base_url)" = "http://127.0.0.1:4387" ] \
    || fail "default base url wrong: $(fm_lavish_base_url)"
  [ "$(LAVISH_AXI_PORT=9999 fm_lavish_base_url)" = "http://127.0.0.1:9999" ] \
    || fail "port override not honored"
  [ "$(LAVISH_AXI_HOST=0.0.0.0 fm_lavish_base_url)" = "http://127.0.0.1:4387" ] \
    || fail "wildcard host not mapped to loopback"
  [ "$(LAVISH_AXI_HOST=::1 fm_lavish_base_url)" = "http://[::1]:4387" ] \
    || fail "ipv6 host not bracketed"
  pass "base url honors host/port env and brackets ipv6"
}

test_canonical_is_absolute() {
  local out
  ( cd "$TMP_ROOT" && : > rel.html )
  out=$(cd "$TMP_ROOT" && fm_lavish_canonical rel.html)
  case "$out" in
    /*) : ;;
    *) fail "canonical not absolute: $out" ;;
  esac
  [ "$out" = "$(cd "$TMP_ROOT" && pwd -P)/rel.html" ] \
    || fail "canonical did not resolve to the real path: $out"
  pass "canonical resolves to an absolute path"
}

test_state_dir_honors_fm_home() {
  local out
  out=$(FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE='' fm_lavish_state_dir)
  [ "$out" = "$TMP_ROOT/home/state/lavish" ] \
    || fail "state dir did not honor FM_HOME: $out"
  pass "state dir honors FM_HOME"
}

test_steward_alive_tracks_pid() {
  local home dir key
  home="$TMP_ROOT/alive"
  dir="$home/state/lavish"
  mkdir -p "$dir"
  key="deadbeefdeadbeef"
  # No meta -> not alive.
  FM_HOME="$home" FM_STATE_OVERRIDE='' fm_lavish_steward_alive "$key" \
    && fail "alive returned true with no meta"
  # Live pid -> alive.
  sleep 30 & local live=$!
  printf 'pid=%s\n' "$live" > "$dir/$key.steward"
  FM_HOME="$home" FM_STATE_OVERRIDE='' fm_lavish_steward_alive "$key" \
    || fail "alive returned false for a live pid"
  kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
  # Dead pid -> not alive.
  FM_HOME="$home" FM_STATE_OVERRIDE='' fm_lavish_steward_alive "$key" \
    && fail "alive returned true for a dead pid"
  pass "steward liveness tracks the recorded pid"
}

# make_spoof_bin: create (once) a sleeper script whose invocation reads
# "...lavish-axi poll <file>", like a real steward's poll child, and echo its
# path. It kills its own sleep child on TERM, mirroring the real steward, so the
# reaper leaves no orphan. The caller backgrounds it directly and captures $! in
# the script body - backgrounding inside $() would let the substitution subshell
# reap the child before the test runs.
make_spoof_bin() {
  local bin="$TMP_ROOT/spoofbin/lavish-axi"
  mkdir -p "$TMP_ROOT/spoofbin"
  cat > "$bin" <<'SPOOF'
#!/usr/bin/env bash
s=""
trap '[ -n "$s" ] && kill "$s" 2>/dev/null' TERM
sleep 30 & s=$!
wait "$s"
SPOOF
  chmod +x "$bin"
  printf '%s\n' "$bin"
}

test_kill_polls_is_selective() {
  local keep_file kill_file bin keep_pid kill_pid
  keep_file="$TMP_ROOT/keep.html"
  kill_file="$TMP_ROOT/kill.html"
  bin=$(make_spoof_bin)
  bash "$bin" poll "$keep_file" >/dev/null 2>&1 & keep_pid=$!
  bash "$bin" poll "$kill_file" >/dev/null 2>&1 & kill_pid=$!
  sleep 0.5
  fm_lavish_kill_polls "$kill_file"
  sleep 0.5
  kill -0 "$kill_pid" 2>/dev/null && fail "reaper did not kill the matching poll"
  kill -0 "$keep_pid" 2>/dev/null || fail "reaper killed a non-matching poll"
  kill "$keep_pid" 2>/dev/null; wait "$keep_pid" 2>/dev/null
  pass "orphan-poll reaper kills only the matching session"
}

test_last_exit_reason_reads_laststate() {
  local home dir key
  home="$TMP_ROOT/laststate"
  dir="$home/state/lavish"
  mkdir -p "$dir"
  key="cafefeedcafefeed"
  [ "$(FM_HOME="$home" FM_STATE_OVERRIDE='' fm_lavish_last_exit_reason "$key")" = "unknown" ] \
    || fail "reason should be 'unknown' with no laststate file"
  printf 'exited=2020-01-01T00:00:00 pid=1 reason=session-ended file=/x.html\n' > "$dir/$key.laststate"
  printf 'exited=2020-01-01T00:01:00 pid=2 reason=server-unreachable-giveup file=/x.html\n' >> "$dir/$key.laststate"
  [ "$(FM_HOME="$home" FM_STATE_OVERRIDE='' fm_lavish_last_exit_reason "$key")" = "server-unreachable-giveup" ] \
    || fail "reason should read the most recent laststate line, not the first"
  pass "last exit reason reads the most recent laststate line"
}

test_reply_arg_validation() {
  local status
  "$REPLY" >/dev/null 2>&1; status=$?
  [ "$status" -eq 2 ] || fail "reply with no args should exit 2 (got $status)"
  "$REPLY" only-one-arg >/dev/null 2>&1; status=$?
  [ "$status" -eq 2 ] || fail "reply with one arg should exit 2 (got $status)"
  pass "reply rejects missing args with exit 2"
}

test_open_arg_validation() {
  local status
  "$OPEN" >/dev/null 2>&1; status=$?
  [ "$status" -eq 2 ] || fail "open with no file should exit 2 (got $status)"
  FM_HOME="$TMP_ROOT/openargs" "$OPEN" "$TMP_ROOT/does-not-exist.html" >/dev/null 2>&1; status=$?
  [ "$status" -eq 1 ] || fail "open with a missing file should exit 1 (got $status)"
  pass "open rejects missing/absent file before any launch"
}

test_recover_empty_is_clean() {
  local out status
  out=$(FM_HOME="$TMP_ROOT/recover-empty" FM_STATE_OVERRIDE='' "$OPEN" --recover 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "recover on empty state should exit 0: $out"
  printf '%s\n' "$out" | grep -F "recovered: 0 steward(s)" >/dev/null \
    || fail "recover on empty state should report 0: $out"
  pass "recover with no sessions is a clean no-op"
}

test_steward_gives_up_when_server_dead() {
  local home sp rc waited
  home="$TMP_ROOT/deadserver"
  mkdir -p "$home/state/lavish" "$TMP_ROOT/deadbin"
  # Shim bunx to always fail, so both the poll and the revive fail like a
  # permanently unreachable server. With tiny fail-max/backoff the steward must
  # give up on its own rather than spin forever.
  printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP_ROOT/deadbin/bunx"
  chmod +x "$TMP_ROOT/deadbin/bunx"
  printf '%s\n' '<!doctype html><title>x</title>' > "$home/art.html"
  PATH="$TMP_ROOT/deadbin:$PATH" FM_HOME="$home" FM_STATE_OVERRIDE='' \
    FM_LAVISH_FAIL_MAX=3 FM_LAVISH_BACKOFF_START=1 FM_LAVISH_BACKOFF_CAP=1 \
    bash "$STEWARD" "$home/art.html" deadbeef00000000 - "" & sp=$!
  waited=0
  while kill -0 "$sp" 2>/dev/null; do
    sleep 0.5; waited=$((waited + 1))
    [ "$waited" -lt 24 ] || { kill "$sp" 2>/dev/null; fail "steward did not give up (spun >12s)"; }
  done
  wait "$sp"; rc=$?
  [ "$rc" -eq 0 ] || fail "steward give-up exit was $rc, expected 0"
  # The meta must survive a give-up: deleting it here was the silent-drop bug
  # (a permanently-down server erased its own evidence, so --recover/--check
  # could never find it again to retry or report it). Its pid must now read as
  # dead, and a laststate line must record WHY, so the trace is diagnosable.
  [ -f "$home/state/lavish/deadbeef00000000.steward" ] \
    || fail "steward deleted its meta on give-up; this must survive for --recover/--check to find"
  FM_HOME="$home" FM_STATE_OVERRIDE='' fm_lavish_steward_alive deadbeef00000000 \
    && fail "meta's recorded pid should read as dead after give-up"
  grep -q 'reason=server-unreachable-giveup' "$home/state/lavish/deadbeef00000000.laststate" 2>/dev/null \
    || fail "give-up did not record a diagnosable reason in .laststate"
  pass "steward gives up on a dead server but leaves a diagnosable, findable trace behind"
}

# make_bunx_shim <no-open-status-text>: a bunx shim covering the two calls the
# --check/--recover path makes: `lavish-axi poll <file>` blocks (killable via
# TERM, mirroring a real steward's poll child) and `lavish-axi <file> --no-open`
# (the status query) prints <no-open-status-text> once. Echoes the bin dir.
make_bunx_shim() {
  local status=$1 bindir
  bindir="$TMP_ROOT/bunxbin-$$-$RANDOM"
  mkdir -p "$bindir"
  cat > "$bindir/bunx" <<EOF
#!/usr/bin/env bash
shift
if [ "\$1" = "poll" ]; then
  s=""
  trap '[ -n "\$s" ] && kill "\$s" 2>/dev/null' TERM
  sleep 30 & s=\$!
  wait "\$s"
  exit 0
fi
printf '%s\n' "$status"
EOF
  chmod +x "$bindir/bunx"
  printf '%s\n' "$bindir"
}

# make_curl_shim <exit-code>: satisfies fm_lavish_server_up's health probe
# deterministically (0 = server reachable, nonzero = unreachable).
make_curl_shim() {
  local rc=$1 bindir
  bindir="$TMP_ROOT/curlbin-$$-$RANDOM"
  mkdir -p "$bindir"
  printf '#!/usr/bin/env bash\nexit %s\n' "$rc" > "$bindir/curl"
  chmod +x "$bindir/curl"
  printf '%s\n' "$bindir"
}

# wait_for_new_pid <meta-file> <old-pid>: the freshly launched steward writes
# its own pid into META asynchronously (it is nohup+disown'd, detached from
# the caller), so poll briefly rather than reading META the instant --check
# returns. Prints the new pid once it differs from <old-pid> and is alive.
wait_for_new_pid() {
  local meta=$1 old=$2 tries=0 pid
  while [ "$tries" -lt 40 ]; do
    pid=$(grep '^pid=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    if [ -n "$pid" ] && [ "$pid" != "$old" ] && kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 0.1; tries=$((tries + 1))
  done
  return 1
}

# setup_stale_steward <home> <key> <art-file> <reason>: record a steward meta
# whose pid is already dead (kill+wait on a just-spawned sleep, the same
# accepted idiom test_steward_alive_tracks_pid already relies on), plus a
# laststate line so the health check has a reason to report.
setup_stale_steward() {
  local home=$1 key=$2 art=$3 reason=$4 deadpid
  mkdir -p "$home/state/lavish"
  printf '%s\n' '<!doctype html><title>x</title>' > "$art"
  ( sleep 30 ) & deadpid=$!
  kill "$deadpid" 2>/dev/null; wait "$deadpid" 2>/dev/null
  {
    printf 'pid=%s\n' "$deadpid"
    printf 'file=%s\n' "$art"
    printf 'key=%s\n' "$key"
    printf 'relay=-\n'
    printf 'url=http://example.invalid/x\n'
    printf 'started=2020-01-01T00:00:00\n'
  } > "$home/state/lavish/$key.steward"
  printf 'exited=2020-01-01T00:00:00 pid=%s reason=%s file=%s\n' "$deadpid" "$reason" "$art" \
    > "$home/state/lavish/$key.laststate"
}

test_check_missing_meta_disarms_silently() {
  local home key out status
  home="$TMP_ROOT/checkmissing"
  key="0000000000000001"
  mkdir -p "$home/state"
  : > "$home/state/lavish-$key.meta"
  : > "$home/state/lavish-$key.check.sh"
  out=$(FM_HOME="$home" FM_STATE_OVERRIDE='' "$OPEN" --check "$key" 2>&1); status=$?
  [ "$status" -eq 0 ] || fail "check on a retired session should exit 0: $out"
  [ -z "$out" ] || fail "check on a retired session (no steward meta) should be silent: $out"
  [ ! -f "$home/state/lavish-$key.check.sh" ] && [ ! -f "$home/state/lavish-$key.meta" ] \
    || fail "check did not disarm the orphaned check/meta pair"
  pass "check silently disarms once a session's steward meta is already gone"
}

test_check_corrupt_meta_is_dropped() {
  local home key out status
  home="$TMP_ROOT/checkcorrupt"
  key="0000000000000002"
  mkdir -p "$home/state/lavish"
  printf 'pid=1\nkey=%s\n' "$key" > "$home/state/lavish/$key.steward" # no file=
  : > "$home/state/lavish-$key.meta"
  : > "$home/state/lavish-$key.check.sh"
  out=$(FM_HOME="$home" FM_STATE_OVERRIDE='' "$OPEN" --check "$key" 2>&1); status=$?
  [ "$status" -eq 0 ] || fail "check on a corrupt meta should still exit 0: $out"
  printf '%s\n' "$out" | grep -qi "corrupt" || fail "check did not report the corrupt meta: $out"
  [ ! -f "$home/state/lavish/$key.steward" ] || fail "corrupt meta was not dropped"
  [ ! -f "$home/state/lavish-$key.check.sh" ] || fail "check did not disarm after dropping corrupt meta"
  pass "check reports and drops a corrupt steward meta (missing file=)"
}

test_check_revives_dead_steward_and_reports() {
  local home key art bunxbin curlbin out status oldpid newpid
  home="$TMP_ROOT/checkrevive"
  key="1111111111111111"
  art="$home/art.html"
  setup_stale_steward "$home" "$key" "$art" "server-unreachable-giveup"
  oldpid=$(grep '^pid=' "$home/state/lavish/$key.steward" | tail -1 | cut -d= -f2-)
  bunxbin=$(make_bunx_shim "status: waiting")
  curlbin=$(make_curl_shim 0) # server reachable
  out=$(PATH="$bunxbin:$curlbin:$PATH" FM_HOME="$home" FM_STATE_OVERRIDE='' "$OPEN" --check "$key" 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "check should exit 0 on a successful revive: $out"
  printf '%s\n' "$out" | grep -qF "restarted automatically" || fail "revive was not reported: $out"
  printf '%s\n' "$out" | grep -qF "server-unreachable-giveup" || fail "revive did not surface the last exit reason: $out"
  newpid=$(wait_for_new_pid "$home/state/lavish/$key.steward" "$oldpid") \
    || fail "revived steward pid never appeared/alive in META"
  [ -f "$home/state/lavish-$key.meta" ] || fail "revive did not (re-)arm the health-check meta"
  grep -q '^pane=' "$home/state/lavish-$key.meta" && fail "gate-only meta must never carry pane= (would join the crew fleet)"
  grep -qF -- "--check" "$home/state/lavish-$key.check.sh" || fail "check.sh companion does not invoke --check"
  grep -qF -- "$key" "$home/state/lavish-$key.check.sh" || fail "check.sh companion does not name its own session key"
  kill "$newpid" 2>/dev/null; wait "$newpid" 2>/dev/null
  pass "check revives a dead steward on a still-open session and reports why"
}

test_check_reports_ended_when_dead_and_session_over() {
  local home key art bunxbin curlbin out status
  home="$TMP_ROOT/checkended"
  key="2222222222222222"
  art="$home/art.html"
  setup_stale_steward "$home" "$key" "$art" "server-unreachable-giveup"
  bunxbin=$(make_bunx_shim "status: ended")
  curlbin=$(make_curl_shim 0)
  out=$(PATH="$bunxbin:$curlbin:$PATH" FM_HOME="$home" FM_STATE_OVERRIDE='' "$OPEN" --check "$key" 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "check should exit 0 when the session had already ended: $out"
  printf '%s\n' "$out" | grep -qF "already ended" || fail "ended-while-dead was not reported: $out"
  printf '%s\n' "$out" | grep -qF "server-unreachable-giveup" || fail "ended report did not surface the last exit reason: $out"
  [ ! -f "$home/state/lavish/$key.steward" ] || fail "steward meta should be retired once the session is confirmed ended"
  [ ! -f "$home/state/lavish-$key.check.sh" ] || fail "check companion should be disarmed once the session is confirmed ended"
  pass "check reports (not just silently retires) a steward found dead after its session ended"
}

test_check_server_down_relaunches_and_reports() {
  local home key art bunxbin curlbin out status oldpid newpid
  home="$TMP_ROOT/checkdown"
  key="3333333333333333"
  art="$home/art.html"
  setup_stale_steward "$home" "$key" "$art" "server-unreachable-giveup"
  oldpid=$(grep '^pid=' "$home/state/lavish/$key.steward" | tail -1 | cut -d= -f2-)
  bunxbin=$(make_bunx_shim "status: waiting") # unused: curl fails before this is reached
  curlbin=$(make_curl_shim 1) # server unreachable
  out=$(PATH="$bunxbin:$curlbin:$PATH" FM_HOME="$home" FM_STATE_OVERRIDE='' "$OPEN" --check "$key" 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "check should exit 0 even while the server is down: $out"
  printf '%s\n' "$out" | grep -qi "unreachable" || fail "server outage was not surfaced: $out"
  printf '%s\n' "$out" | grep -qF "retrying" || fail "server-down report should note retry/backoff: $out"
  newpid=$(wait_for_new_pid "$home/state/lavish/$key.steward" "$oldpid") \
    || fail "relaunched steward pid never appeared/alive in META"
  kill "$newpid" 2>/dev/null; wait "$newpid" 2>/dev/null
  pass "check relaunches through a server outage and surfaces it rather than failing silently"
}

test_key_is_sha256_16_and_deterministic
test_base_url_variants
test_canonical_is_absolute
test_state_dir_honors_fm_home
test_steward_alive_tracks_pid
test_kill_polls_is_selective
test_last_exit_reason_reads_laststate
test_reply_arg_validation
test_open_arg_validation
test_recover_empty_is_clean
test_steward_gives_up_when_server_dead
test_check_missing_meta_disarms_silently
test_check_corrupt_meta_is_dropped
test_check_revives_dead_steward_and_reports
test_check_reports_ended_when_dead_and_session_over
test_check_server_down_relaunches_and_reports
