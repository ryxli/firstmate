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
case "$field" in
  comm=) [ "$pid" = 222 ] && printf 'bun\n' || printf 'bash\n' ;;
  args=) [ "$pid" = 222 ] && printf 'bun /opt/omp/packages/coding-agent/scripts/omp.ts --auto-approve\n' || printf 'bash /tmp/tool-call.sh\n' ;;
  ppid=) [ "$pid" = 222 ] && printf '1\n' || printf '222\n' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$TMP_ROOT/bin/ps"

out=$(PATH="$TMP_ROOT/bin:$PATH" FM_HOME="$TMP_ROOT/home" "$ROOT/sbin/fm" lock 2>&1) || true
case "$out" in
  *'lock acquired: harness pid 222'*) : ;;
  *) fail "bun-hosted omp ancestry was not detected: $out" ;;
esac
[ "$(cat "$TMP_ROOT/home/state/.lock")" = 222 ] || fail "lock did not retain bun harness pid"
pass "fm-lock detects OMP through bun script ancestry"
