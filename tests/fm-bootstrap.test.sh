#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}

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

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-bootstrap-tests.XXXXXX")

make_fake_toolchain() {
  local dir=$1 fakebin tool real_bun
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  for tool in node gh-axi chrome-devtools-axi lavish-axi; do
    cat > "$fakebin/$tool" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod +x "$fakebin/$tool"
  done
  # bootstrap now shells out to the bun-based `fm` CLI (e.g. handoff-check,
  # self-pane), so the fake bun must really run that one script; every other
  # bun invocation (e.g. `bun install --frozen-lockfile`) stays a fast no-op.
  real_bun=$(command -v bun)
  cat > "$fakebin/bun" <<SH
#!/usr/bin/env bash
case "\${1:-}" in
  */sbin/fm) exec "$real_bun" "\$@" ;;
  *) exit 0 ;;
esac
SH
  chmod +x "$fakebin/bun"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = status ]; then
  printf '%s\n' 'status: running'
  exit 0
fi
exit 0
SH
  chmod +x "$fakebin/herdr"
  cat > "$fakebin/gh" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then
  exit 0
fi
exit 0
SH
  chmod +x "$fakebin/gh"
  printf '%s\n' "$fakebin"
}

OMP_EXTENSIONS="fleet-bus thinking-tag-guard agent-effectiveness capture"

make_ext_fixture() {
  local dir=$1 ext
  shift
  mkdir -p "$dir"
  for ext in "$@"; do
    mkdir -p "$dir/$ext"
  done
  printf '%s\n' "$dir"
}

# shellcheck disable=SC2086
ALL_EXT_DIR=$(make_ext_fixture "$TMP_ROOT/ext-all" $OMP_EXTENSIONS)

seed_handoff() {
  local home=$1
  mkdir -p "$home/data/handoff"
  cp "$ROOT/tests/fixtures/handoff/current-actions.md" "$home/data/handoff/current-actions.md"
  cp "$ROOT/tests/fixtures/handoff/firstmate-readback.md" "$home/data/handoff/firstmate-readback.md"
}

run_bootstrap() {
  local home=$1 fakebin=$2 extdir=${3:-$ALL_EXT_DIR}
  seed_handoff "$home"
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" FM_OMP_EXT_OVERRIDE="$extdir" \
    "$ROOT/sbin/fm" bootstrap
}

run_bootstrap_existing() {
  local home=$1 fakebin=$2 extdir=${3:-$ALL_EXT_DIR}
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" FM_OMP_EXT_OVERRIDE="$extdir" \
    "$ROOT/sbin/fm" bootstrap
}

test_bootstrap_silent_without_no_mistakes() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/without-no-mistakes"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")

  out=$(run_bootstrap "$case_dir/home" "$fakebin")
  [ "$out" = 'TASKS: native' ] || fail "bootstrap reported problems with all tools present: $out"
  pass "bootstrap is silent (but for the unconditional native-tasks line) without no-mistakes installed"
}

test_bootstrap_reports_native_tasks_regardless_of_tasks_axi() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/tasks-axi-available"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")
  cat > "$fakebin/tasks-axi" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = --version ]; then
  printf '%s\n' '0.1.1'
fi
exit 0
SH
  chmod +x "$fakebin/tasks-axi"

  out=$(run_bootstrap "$case_dir/home" "$fakebin")
  [ "$out" = 'TASKS: native' ] || fail "bootstrap did not report native task support: $out"
  pass "bootstrap reports native task support unconditionally, even with a compatible tasks-axi present"
}

test_bootstrap_ignores_incompatible_tasks_axi() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/tasks-axi-incompatible"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")
  cat > "$fakebin/tasks-axi" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = --version ]; then
  printf '%s\n' '0.1.0'
fi
exit 0
SH
  chmod +x "$fakebin/tasks-axi"

  out=$(run_bootstrap "$case_dir/home" "$fakebin")
  case "$out" in
    *'TASKS_AXI'*) fail "bootstrap still reports the retired TASKS_AXI probe: $out" ;;
  esac
  [ "$out" = 'TASKS: native' ] || fail "bootstrap reported incompatible tasks-axi as available: $out"
  pass "bootstrap ignores incompatible optional tasks-axi entirely, reporting only native task support"
}

test_bootstrap_surfaces_handoff_failure() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/handoff-failure"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")
  seed_handoff "$case_dir/home"
  awk 'NR == 7 { print "3. Pursue an unrelated completed request."; next } { print }' \
    "$case_dir/home/data/handoff/firstmate-readback.md" > "$case_dir/home/data/handoff/readback.tmp"
  mv "$case_dir/home/data/handoff/readback.tmp" "$case_dir/home/data/handoff/firstmate-readback.md"

  if out=$(run_bootstrap_existing "$case_dir/home" "$fakebin"); then
    fail "bootstrap unexpectedly continued with a contradictory handoff: $out"
  fi
  case "$out" in
    *'FAIL: current-actions.md:13'*'firstmate-readback.md:7'*) ;;
    *) fail "bootstrap did not surface handoff diagnostics: $out" ;;
  esac
  pass "bootstrap surfaces handoff validation failure before normal sync"
}

test_bootstrap_silent_with_all_omp_extensions() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/ext-all-present"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")

  out=$(run_bootstrap "$case_dir/home" "$fakebin" "$ALL_EXT_DIR")
  [ "$out" = 'TASKS: native' ] || fail "bootstrap reported problems with all OMP extensions present: $out"
  pass "bootstrap is silent (but for the unconditional native-tasks line) when all provisioned OMP extensions are present"
}

test_bootstrap_reports_missing_omp_extension() {
  local case_dir fakebin extdir out expected
  case_dir="$TMP_ROOT/ext-one-missing"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")
  extdir=$(make_ext_fixture "$case_dir/ext" fleet-bus thinking-tag-guard agent-effectiveness)

  out=$(run_bootstrap "$case_dir/home" "$fakebin" "$extdir")
  expected='MISSING_EXT: capture (provision: chezmoi apply - dotfiles repo is the canonical owner)
TASKS: native'
  [ "$out" = "$expected" ] || fail "bootstrap did not report the one missing OMP extension exactly: $out"
  pass "bootstrap reports exactly one MISSING_EXT line for a missing OMP extension"
}

test_bootstrap_silent_without_no_mistakes
test_bootstrap_reports_native_tasks_regardless_of_tasks_axi
test_bootstrap_ignores_incompatible_tasks_axi
test_bootstrap_surfaces_handoff_failure
test_bootstrap_silent_with_all_omp_extensions
test_bootstrap_reports_missing_omp_extension
