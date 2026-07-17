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
if [ -n "${FM_LOCK_TEST_STALE_HOLDER:-}" ] && [ "$pid" = "$FM_LOCK_TEST_STALE_HOLDER" ]; then
  exit 1
fi
case "$field" in
  comm=) [ "$pid" = 222 ] && printf 'bun\n' || printf 'bash\n' ;;
  args=) [ "$pid" = 222 ] && printf 'bun /opt/omp/packages/coding-agent/scripts/omp.ts --auto-approve\n' || printf 'bash /tmp/tool-call.sh\n' ;;
  ppid=) [ "$pid" = 222 ] && printf '1\n' || printf '222\n' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$TMP_ROOT/bin/ps"

run_lock() {
  PATH="$TMP_ROOT/bin:$PATH" FM_HOME="$TMP_ROOT/home" "$ROOT/sbin/fm" lock 2>&1
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
cleanup_holders() {
  if [ -n "${holder_pid:-}" ]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  if [ -n "${stale_pid:-}" ]; then
    kill "$stale_pid" 2>/dev/null || true
    wait "$stale_pid" 2>/dev/null || true
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

printf '%s\n' "$holder_pid" > "$TMP_ROOT/home/state/.lock"
set +e
out=$(FM_LOCK_TEST_HOLDER="$holder_pid" FM_SUPERVISED_SUCCESSOR=1 run_lock)
status=$?
set -e
[ "$status" -eq 0 ] || fail "marked conflict exited $status instead of 0: $out"
case "$out" in
  *"authority remains with live holder pid $holder_pid"*"supervised successor is read-only until handoff"*) : ;;
  *) fail "marked conflict did not report read-only handoff semantics: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = "$holder_pid" ] || fail "marked conflict rewrote the live holder lock"
pass "fm-lock lets marked successors stay read-only without rewriting a live holder lock"

rm -f "$TMP_ROOT/home/state/.lock"
out=$(FM_SUPERVISED_SUCCESSOR=1 run_lock) || fail "marked free acquisition failed: $out"
case "$out" in
  *'lock acquired: harness pid 222'*) : ;;
  *) fail "marked free acquisition did not acquire: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = 222 ] || fail "marked free acquisition did not write the harness pid"
pass "fm-lock lets marked successors acquire a free lock"

sleep 1000 &
stale_pid=$!
printf '%s\n' "$stale_pid" > "$TMP_ROOT/home/state/.lock"
out=$(FM_LOCK_TEST_STALE_HOLDER="$stale_pid" FM_SUPERVISED_SUCCESSOR=1 run_lock) || fail "marked stale acquisition failed: $out"
case "$out" in
  *'lock acquired: harness pid 222'*) : ;;
  *) fail "marked stale acquisition did not acquire: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = 222 ] || fail "marked stale acquisition did not replace the stale holder"
pass "fm-lock lets marked successors acquire a stale lock"
