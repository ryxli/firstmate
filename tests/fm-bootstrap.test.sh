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
  local dir=$1 fakebin tool
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  for tool in bun node gh-axi chrome-devtools-axi lavish-axi; do
    cat > "$fakebin/$tool" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod +x "$fakebin/$tool"
  done
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

seed_handoff() {
  local home=$1
  mkdir -p "$home/data/handoff"
  cp "$ROOT/data/handoff/current-actions.md" "$home/data/handoff/current-actions.md"
  cp "$ROOT/data/handoff/firstmate-readback.md" "$home/data/handoff/firstmate-readback.md"
}

run_bootstrap() {
  local home=$1 fakebin=$2
  seed_handoff "$home"
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" "$ROOT/sbin/fm-bootstrap.sh"
}

run_bootstrap_existing() {
  local home=$1 fakebin=$2
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" "$ROOT/sbin/fm-bootstrap.sh"
}

test_bootstrap_silent_without_no_mistakes() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/without-no-mistakes"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")

  out=$(run_bootstrap "$case_dir/home" "$fakebin")
  [ -z "$out" ] || fail "bootstrap reported problems with all tools present: $out"
  pass "bootstrap is silent without no-mistakes installed"
}

test_bootstrap_reports_tasks_axi_when_available() {
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
  [ "$out" = 'TASKS_AXI: available' ] || fail "bootstrap did not report tasks-axi availability: $out"
  pass "bootstrap reports compatible optional tasks-axi availability"
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
  [ -z "$out" ] || fail "bootstrap reported incompatible tasks-axi as available: $out"
  pass "bootstrap ignores incompatible optional tasks-axi"
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

test_bootstrap_silent_without_no_mistakes
test_bootstrap_reports_tasks_axi_when_available
test_bootstrap_ignores_incompatible_tasks_axi
test_bootstrap_surfaces_handoff_failure
