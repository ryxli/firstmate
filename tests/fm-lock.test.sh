#!/usr/bin/env bash
# OMP launched through bun must own the per-home session lock.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-lock.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/home/state"
cat > "$TMP_ROOT/bin/ps" <<'SH'
#!/usr/bin/env bash
field= pid=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) field=$2; shift 2 ;;
    -p) pid=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "${FM_LOCK_TEST_HOLDER:-}" ] && [ "$pid" = "$FM_LOCK_TEST_HOLDER" ]; then
  case "$field" in
    comm=) printf 'omp\n' ;;
    args=) printf 'omp --auto-approve\n' ;;
    ppid=) printf '1\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ -n "${FM_LOCK_TEST_ME:-}" ] && [ "$pid" = "$FM_LOCK_TEST_ME" ]; then
  case "$field" in
    comm=) printf 'omp\n' ;;
    args=) printf 'omp --auto-approve\n' ;;
    ppid=) printf '1\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ -n "${FM_LOCK_TEST_STALE_HOLDER:-}" ] && [ "$pid" = "$FM_LOCK_TEST_STALE_HOLDER" ]; then
  exit 1
fi
parent="${FM_LOCK_TEST_ME:-222}"
case "$field" in
  comm=) [ "$pid" = "$parent" ] && printf 'bun\n' || printf 'bash\n' ;;
  args=) [ "$pid" = "$parent" ] && printf 'bun /opt/omp/packages/coding-agent/scripts/omp.ts --auto-approve\n' || printf 'bash /tmp/tool-call.sh\n' ;;
  ppid=) [ "$pid" = "$parent" ] && printf '1\n' || printf '%s\n' "$parent" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$TMP_ROOT/bin/ps"

run_lock() {
  PATH="$TMP_ROOT/bin:$PATH" FM_HOME="$TMP_ROOT/home" "$ROOT/sbin/fm" lock "$@" 2>&1
}

out=$(run_lock) || true
case "$out" in
  *'lock acquired: harness pid 222'*) : ;;
  *) fail "bun-hosted omp ancestry was not detected: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = 222 ] || fail "lock did not retain bun harness pid"
pass "fm-lock detects OMP through bun script ancestry"

holder_pid=
stale_pid=
me_pid=
cleanup_holders() {
  if [ -n "${holder_pid:-}" ]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  if [ -n "${stale_pid:-}" ]; then
    kill "$stale_pid" 2>/dev/null || true
    wait "$stale_pid" 2>/dev/null || true
  fi
  if [ -n "${me_pid:-}" ]; then
    kill "$me_pid" 2>/dev/null || true
    wait "$me_pid" 2>/dev/null || true
  fi
}
trap 'cleanup_holders; rm -rf "$TMP_ROOT"' EXIT

sleep 1000 &
holder_pid=$!
printf '%s\n' "$holder_pid" > "$TMP_ROOT/home/state/.lock"
set +e
out=$(FM_LOCK_TEST_HOLDER="$holder_pid" run_lock)
status=$?
set -e
[ "$status" -eq 1 ] || fail "unmarked conflict exited $status instead of 1: $out"
case "$out" in
  *"error: another live firstmate session holds the lock (pid $holder_pid)"*) : ;;
  *) fail "unmarked conflict did not refuse with holder pid: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = "$holder_pid" ] || fail "unmarked conflict rewrote the live holder lock"
pass "fm-lock refuses unmarked live-holder conflicts"

sleep 1000 &
me_pid=$!
printf '%s\n' "$holder_pid" > "$TMP_ROOT/home/state/.lock"
set +e
out=$(FM_LOCK_TEST_HOLDER="$holder_pid" FM_LOCK_TEST_ME="$me_pid" run_lock release)
status=$?
set -e
[ "$status" -eq 1 ] || fail "non-owner release exited $status instead of 1: $out"
[ "$(cat "$TMP_ROOT/home/state/.lock")" = "$holder_pid" ] || fail "non-owner release removed or rewrote the live holder lock"
pass "fm-lock release refuses callers that are not the recorded owner"

printf '%s\n' "$me_pid" > "$TMP_ROOT/home/state/.lock"
out=$(FM_LOCK_TEST_ME="$me_pid" run_lock release) || fail "owner release failed: $out"
case "$out" in
  *"lock released: harness pid $me_pid"*) : ;;
  *) fail "owner release did not report released pid: $out" ;;
esac
[ ! -e "$TMP_ROOT/home/state/.lock" ] || fail "owner release did not remove the lock"
pass "fm-lock release removes only the caller-owned live lock"

rm -f "$TMP_ROOT/home/state/.lock"
out=$(run_lock) || fail "free acquisition failed: $out"
case "$out" in
  *'lock acquired: harness pid 222'*) : ;;
  *) fail "free acquisition did not acquire: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = 222 ] || fail "free acquisition did not write the harness pid"
pass "fm-lock acquires a free lock"

sleep 1000 &
stale_pid=$!
printf '%s\n' "$stale_pid" > "$TMP_ROOT/home/state/.lock"
out=$(FM_LOCK_TEST_STALE_HOLDER="$stale_pid" run_lock) || fail "stale acquisition failed: $out"
case "$out" in
  *'lock acquired: harness pid 222'*) : ;;
  *) fail "stale acquisition did not acquire: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = 222 ] || fail "stale acquisition did not replace the stale holder"
pass "fm-lock acquires a stale lock"
