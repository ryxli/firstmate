#!/usr/bin/env bash
# Fast, network-free checks for the Lavish render-delegation primitives.
# Covers the pure session math (key/url/canonical/state-dir), steward liveness,
# the orphan-poll reaper's selectivity, and argument validation. The full
# open->relay->reply->end->recover flow is exercised live by the smoke path; CI
# stays offline, so these assert the contracts that must hold without a server.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/bin/fm-lavish-lib.sh"
OPEN="$ROOT/bin/fm-lavish-open.sh"
REPLY="$ROOT/bin/fm-lavish-reply.sh"
STEWARD="$ROOT/bin/fm-lavish-steward.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-lavish.XXXXXX")
trap 'pkill -f "$TMP_ROOT" 2>/dev/null; rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# shellcheck source=bin/fm-lavish-lib.sh
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
  [ ! -f "$home/state/lavish/deadbeef00000000.steward" ] \
    || fail "steward did not clean up its meta on give-up"
  pass "steward gives up (and cleans up) when the server stays unreachable"
}

test_key_is_sha256_16_and_deterministic
test_base_url_variants
test_canonical_is_absolute
test_state_dir_honors_fm_home
test_steward_alive_tracks_pid
test_kill_polls_is_selective
test_reply_arg_validation
test_open_arg_validation
test_recover_empty_is_clean
test_steward_gives_up_when_server_dead
