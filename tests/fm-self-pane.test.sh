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
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-self-pane-tests.XXXXXX")

make_fake_herdr() {
  local fakebin=$1
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-} ${2:-}" in
  "status ")
    printf '%s\n' 'status: running'
    exit 0
    ;;
  "pane current")
    if [ -n "${FM_HERDR_CURRENT_FILE:-}" ]; then
      cat "$FM_HERDR_CURRENT_FILE"
    else
      printf '%s' "${FM_HERDR_CURRENT_JSON:-}"
      [ -z "${FM_HERDR_CURRENT_JSON:-}" ] || printf '\n'
    fi
    exit "${FM_HERDR_CURRENT_EXIT:-0}"
    ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
}

make_bootstrap_toolchain() {
  local dir=$1 fakebin tool
  fakebin="$dir/fakebin"
  make_fake_herdr "$fakebin"
  for tool in node gh-axi chrome-devtools-axi lavish-axi; do
    cat > "$fakebin/$tool" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod +x "$fakebin/$tool"
  done
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

self_pane_json() {
  local pane=$1 workspace=$2 tab=$3 status=$4
  printf '{"result":{"pane":{"pane_id":"%s","workspace_id":"%s","tab_id":"%s","agent_status":"%s"}}}\n' \
    "$pane" "$workspace" "$tab" "$status"
}

assert_meta_value() {
  local meta=$1 key=$2 expected=$3 actual
  actual=$(grep "^$key=" "$meta" | tail -1 | cut -d= -f2- || true)
  [ "$actual" = "$expected" ] || fail "expected $key=$expected in $meta, got $actual"
}

run_self_pane() {
  local fakebin=$1 home=$2 json=$3
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" FM_HERDR_CURRENT_JSON="$json" "$ROOT/sbin/fm-self-pane.sh"
}

run_self_pane_check() {
  local fakebin=$1 home=$2 json=$3
  PATH="$fakebin:$BASE_PATH" FM_HOME="$home" FM_HERDR_CURRENT_JSON="$json" "$ROOT/sbin/fm-self-pane.sh" --check
}

test_normal_write() {
  local case_dir fakebin home out meta json
  case_dir="$TMP_ROOT/normal-write"
  fakebin="$case_dir/fakebin"
  home="$case_dir/home"
  make_fake_herdr "$fakebin"
  mkdir -p "$home"
  json=$(self_pane_json 'w1:p1' 'w1' 'w1:t1' 'idle')

  out=$(run_self_pane "$fakebin" "$home" "$json") || fail "self-pane normal write failed"
  [ "$out" = 'pane=w1:p1' ] || fail "unexpected normal write output: $out"
  meta="$home/state/self.meta"
  [ -f "$meta" ] || fail "normal write did not create self.meta"
  assert_meta_value "$meta" pane 'w1:p1'
  assert_meta_value "$meta" workspace 'w1'
  assert_meta_value "$meta" tab 'w1:t1'
  pass "self-pane writes current pane metadata"
}

test_refresh() {
  local case_dir fakebin home meta out first second
  case_dir="$TMP_ROOT/refresh"
  fakebin="$case_dir/fakebin"
  home="$case_dir/home"
  make_fake_herdr "$fakebin"
  mkdir -p "$home"
  first=$(self_pane_json 'w1:p1' 'w1' 'w1:t1' 'idle')
  second=$(self_pane_json 'w2:p9' 'w2' 'w2:t4' 'working')

  run_self_pane "$fakebin" "$home" "$first" >/dev/null || fail "self-pane initial refresh setup failed"
  out=$(run_self_pane "$fakebin" "$home" "$second") || fail "self-pane refresh failed"
  [ "$out" = 'pane=w2:p9' ] || fail "unexpected refresh output: $out"
  meta="$home/state/self.meta"
  assert_meta_value "$meta" pane 'w2:p9'
  assert_meta_value "$meta" workspace 'w2'
  assert_meta_value "$meta" tab 'w2:t4'
  if grep -qF 'pane=w1:p1' "$meta"; then
    fail "refresh left stale pane in self.meta"
  fi
  pass "self-pane refresh replaces stale metadata"
}

test_unresolved_preserves_metadata() {
  local case_dir fakebin home meta before after out err bad_json
  case_dir="$TMP_ROOT/unresolved"
  fakebin="$case_dir/fakebin"
  home="$case_dir/home"
  meta="$home/state/self.meta"
  make_fake_herdr "$fakebin"
  mkdir -p "$home/state"
  {
    printf 'pane=%s\n' 'w0:p0'
    printf 'workspace=%s\n' 'w0'
    printf 'tab=%s\n' 'w0:t0'
  } > "$meta"
  before=$(cat "$meta")
  bad_json='{"result":{"pane":{"workspace_id":"w9","tab_id":"w9:t9","agent_status":"idle"}}}'

  out="$case_dir/out"
  err="$case_dir/err"
  if PATH="$fakebin:$BASE_PATH" FM_HOME="$home" FM_HERDR_CURRENT_JSON="$bad_json" "$ROOT/sbin/fm-self-pane.sh" >"$out" 2>"$err"; then
    fail "unresolved pane current unexpectedly succeeded"
  fi
  after=$(cat "$meta")
  [ "$after" = "$before" ] || fail "unresolved pane current changed self.meta"
  [ ! -s "$out" ] || fail "unresolved pane current wrote stdout"
  grep -qF 'did not resolve pane_id/workspace_id/tab_id/agent_status' "$err" || fail "unresolved error did not explain missing fields"
  pass "self-pane refuses unresolved current output without changing metadata"
}

test_check_match_and_drift() {
  local case_dir fakebin home match drift out meta absent
  case_dir="$TMP_ROOT/check"
  fakebin="$case_dir/fakebin"
  home="$case_dir/home"
  make_fake_herdr "$fakebin"
  mkdir -p "$home"
  match=$(self_pane_json 'w1:p1' 'w1' 'w1:t1' 'idle')
  drift=$(self_pane_json 'w9:p9' 'w9' 'w9:t9' 'working')

  run_self_pane "$fakebin" "$home" "$match" >/dev/null || fail "self-pane check setup failed"
  out=$(run_self_pane_check "$fakebin" "$home" "$match") || fail "self-pane --check match failed"
  [ -z "$out" ] || fail "self-pane --check match wrote stdout: $out"

  out=$(run_self_pane_check "$fakebin" "$home" "$drift") && fail "self-pane --check drift unexpectedly succeeded"
  [ "$out" = 'self-pane drift: recorded=w1:p1 current=w9:p9' ] || fail "unexpected drift output: $out"
  meta="$home/state/self.meta"
  assert_meta_value "$meta" pane 'w1:p1'

  absent="$TMP_ROOT/check-absent/home"
  mkdir -p "$absent"
  out=$(run_self_pane_check "$fakebin" "$absent" "$match") && fail "self-pane --check absent metadata unexpectedly succeeded"
  [ "$out" = 'self-pane drift: recorded=absent current=w1:p1' ] || fail "unexpected absent output: $out"
  pass "self-pane --check is quiet on match and reports drift"
}

test_bootstrap_unresolved_warning() {
  local case_dir fakebin home out bad_json
  case_dir="$TMP_ROOT/bootstrap-warning"
  home="$case_dir/home"
  mkdir -p "$home"
  fakebin=$(make_bootstrap_toolchain "$case_dir")
  bad_json='{"result":{"pane":{"workspace_id":"w9","tab_id":"w9:t9","agent_status":"idle"}}}'

  out=$(PATH="$fakebin:$BASE_PATH" FM_HOME="$home" FM_HERDR_CURRENT_JSON="$bad_json" \
    "$ROOT/sbin/fm-bootstrap.sh") || fail "bootstrap failed on unresolved self-pane"
  [ "$out" = 'SELF_PANE: error: herdr pane current did not resolve pane_id/workspace_id/tab_id/agent_status' ] \
    || fail "unexpected bootstrap unresolved warning: $out"
  pass "bootstrap reports one self-pane warning and continues"
}

test_normal_write
test_refresh
test_unresolved_preserves_metadata
test_check_match_and_drift
test_bootstrap_unresolved_warning
