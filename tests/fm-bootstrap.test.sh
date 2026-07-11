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
  for tool in node no-mistakes gh-axi chrome-devtools-axi lavish-axi; do
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

run_bootstrap() {
  local home=$1 fakebin=$2
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" "$ROOT/sbin/fm-bootstrap.sh"
}

test_bootstrap_clean_with_all_tools() {
  local case_dir fakebin out
  case_dir="$TMP_ROOT/all-tools"
  mkdir -p "$case_dir/home"
  fakebin=$(make_fake_toolchain "$case_dir")

  out=$(run_bootstrap "$case_dir/home" "$fakebin")
  [ -z "$out" ] || fail "bootstrap reported problems with all tools present: $out"
  pass "bootstrap is silent when all required tools are present"
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

test_bootstrap_clean_with_all_tools
test_bootstrap_reports_tasks_axi_when_available
test_bootstrap_ignores_incompatible_tasks_axi
