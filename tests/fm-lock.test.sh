#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  if [ -n "${TMP_ROOT:-}" ]; then
    rm -rf "$TMP_ROOT"
  fi
}

trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-lock-tests.XXXXXX")

expect_code() {
  local expected=$1 actual=$2 label=$3
  [ "$actual" = "$expected" ] || fail "$label: expected exit $expected, got $actual"
}

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

assert_grep() {
  grep -F -- "$1" "$2" >/dev/null || fail "$3"
}

make_fake_ps() {
  local fakebin=$1
  cat > "$fakebin/ps" <<'SH'
#!/usr/bin/env bash
set -eu

field=
pid=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      field=$2
      shift 2
      ;;
    -p)
      pid=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[ -n "$field" ] || exit 1
[ -n "$pid" ] || exit 1

case "$field" in
  comm=) var="FM_PS_COMM_$pid"; fallback="FM_PS_COMM_DEFAULT" ;;
  args=) var="FM_PS_ARGS_$pid"; fallback="FM_PS_ARGS_DEFAULT" ;;
  ppid=) var="FM_PS_PPID_$pid"; fallback="FM_PS_PPID_DEFAULT" ;;
  *) exit 1 ;;
esac

value=$(printenv "$var" 2>/dev/null || true)
if [ -z "$value" ]; then
  value=$(printenv "$fallback" 2>/dev/null || true)
fi
[ -n "$value" ] || exit 1
printf '%s\n' "$value"
SH
  chmod +x "$fakebin/ps"
}

setup_omp_bun_ancestry() {
  export FM_PS_COMM_DEFAULT=bash
  export FM_PS_ARGS_DEFAULT='bash /tmp/tool-call.sh'
  export FM_PS_PPID_DEFAULT=222
  export FM_PS_COMM_222=bun
  export FM_PS_ARGS_222='bun /opt/omp/packages/coding-agent/scripts/omp.ts --auto-approve /opt/omp/packages/coding-agent/dist/cli.js'
  export FM_PS_PPID_222=333
  export FM_PS_COMM_333='-zsh'
  export FM_PS_ARGS_333='-zsh'
  export FM_PS_PPID_333=1
}

run_lock() {
  local home=$1 fakebin=$2 script=$3
  PATH="$fakebin:$PATH" FM_HOME="$home" "$script"
}

# Derive the pre-fix script by stripping the optional `.ts` match out of the
# current HARNESS_RE. This pins the regression to the `(\.ts)?` clause itself
# rather than to any git ref (origin/main already carries the fix).
make_prefix_script() {
  local dest=$1
  # Strip the literal `(\.ts)?` clause to reconstruct the pre-fix HARNESS_RE.
  sed 's/(\\.ts)?//' "$ROOT/bin/fm-lock.sh" > "$dest"
  chmod +x "$dest"
}

test_omp_bun_ancestry_regression_was_real() {
  local home fakebin old_script out status
  home="$TMP_ROOT/old-home"
  fakebin="$TMP_ROOT/fakebin-old"
  mkdir -p "$home/state" "$fakebin"
  make_fake_ps "$fakebin"
  setup_omp_bun_ancestry

  old_script="$TMP_ROOT/fm-lock-old.sh"
  make_prefix_script "$old_script"
  # Guard: the derived script must actually be the pre-fix variant.
  grep -q "(^|/)omp(\$|\[\[:space:\]\])" "$old_script" || fail "could not derive pre-fix HARNESS_RE"

  set +e
  out=$(run_lock "$home" "$fakebin" "$old_script" 2>&1)
  status=$?
  set -e

  expect_code 1 "$status" "pre-fix bun omp ancestry lock acquire"
  assert_contains "$out" 'cannot locate harness process in ancestry' 'pre-fix script did not reproduce omp ancestry failure'
  pass "pre-fix fm-lock misses bun .../scripts/omp.ts ancestry"
}

test_omp_bun_ancestry_is_detected() {
  local home fakebin out status
  home="$TMP_ROOT/new-home"
  fakebin="$TMP_ROOT/fakebin-new"
  mkdir -p "$home/state" "$fakebin"
  make_fake_ps "$fakebin"
  setup_omp_bun_ancestry

  set +e
  out=$(run_lock "$home" "$fakebin" "$ROOT/bin/fm-lock.sh" 2>&1)
  status=$?
  set -e

  expect_code 0 "$status" "bun omp ancestry lock acquire"
  assert_contains "$out" 'lock acquired: harness pid 222' 'bun omp ancestry did not resolve bun harness pid'
  assert_grep '222' "$home/state/.lock" 'lock file did not record bun harness pid'
  pass "fm-lock detects omp when launched as bun .../scripts/omp.ts .../cli.js"
}

test_omp_bun_ancestry_regression_was_real
test_omp_bun_ancestry_is_detected
