#!/usr/bin/env bash
# Focused behavior tests for fm-directive-receipt.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RECEIPT="$ROOT/bin/fm-directive-receipt.sh"
TMP_ROOT=$(fm_test_tmproot fm-directive-receipt)

run_receipt() {
  local home=$1
  shift
  FM_HOME="$home" "$RECEIPT" "$@"
}

line_count() {
  wc -l < "$1" | tr -d ' '
}

test_help_documents_command() {
  local out
  out=$("$RECEIPT" --help) || fail '--help exited non-zero'
  assert_contains "$out" 'usage: fm-directive-receipt.sh <append|list|latest|check>' 'help missing command usage'
  assert_contains "$out" 'executed|recorded|routed|disputed' 'help missing disposition enum'
  # shellcheck disable=SC2016  # The help text intentionally documents the literal environment variable.
  assert_contains "$out" 'Receipts are stored in $FM_HOME/state/directive-receipts.tsv' 'help missing storage path'
  pass '--help documents the directive receipt command'
}

test_append_writes_local_state_receipt() {
  local home="$TMP_ROOT/append-home" out file
  mkdir -p "$home"
  out=$(run_receipt "$home" append \
    --timestamp 2026-07-06T00:00:00Z \
    --summary 'route deployment directive' \
    --disposition routed \
    --evidence 'state/deploy.status') || fail 'append exited non-zero'
  file="$home/state/directive-receipts.tsv"
  assert_present "$file" 'append did not create state receipt file'
  [ "$(line_count "$file")" = 1 ] || fail 'append should write exactly one receipt line'
  assert_grep $'2026-07-06T00:00:00Z\troute deployment directive\trouted\tstate/deploy.status' "$file" 'receipt line not stored as expected TSV'
  assert_contains "$out" 'recorded directive receipt: 2026-07-06T00:00:00Z [routed]' 'append output missing receipt summary'
  assert_contains "$out" "storage: $file" 'append output missing storage path'
  pass 'append stores one local state receipt with all fields'
}

test_list_newest_first_with_limit() {
  local home="$TMP_ROOT/list-home" out
  mkdir -p "$home"
  run_receipt "$home" append --timestamp 2026-07-06T00:00:01Z --summary 'first directive' --disposition recorded --evidence 'notes/one' >/dev/null
  run_receipt "$home" append --timestamp 2026-07-06T00:00:02Z --summary 'second directive' --disposition executed --evidence 'tests/two' >/dev/null
  out=$(run_receipt "$home" list --limit 1) || fail 'list exited non-zero'
  assert_contains "$out" '2026-07-06T00:00:02Z [executed] second directive' 'list did not print newest receipt'
  assert_contains "$out" '  evidence: tests/two' 'list did not print evidence'
  assert_not_contains "$out" 'first directive' 'list --limit 1 printed older receipt'
  pass 'list prints receipts newest first and honors --limit'
}

test_latest_prints_newest_receipt() {
  local home="$TMP_ROOT/latest-home" out
  mkdir -p "$home"
  run_receipt "$home" append --timestamp 2026-07-06T00:00:01Z --summary 'older directive' --disposition recorded --evidence 'notes/older' >/dev/null
  run_receipt "$home" append --timestamp 2026-07-06T00:00:02Z --summary 'newer directive' --disposition disputed --evidence 'state/newer' >/dev/null
  out=$(run_receipt "$home" latest) || fail 'latest exited non-zero'
  assert_contains "$out" '2026-07-06T00:00:02Z [disputed] newer directive' 'latest did not print newest receipt'
  assert_contains "$out" '  evidence: state/newer' 'latest did not print evidence'
  assert_not_contains "$out" 'older directive' 'latest printed an older receipt'
  pass 'latest prints the newest receipt as a one-command check'
}

test_check_latest_and_summary_match() {
  local home="$TMP_ROOT/check-home" out
  mkdir -p "$home"
  run_receipt "$home" append --timestamp 2026-07-06T00:00:01Z --summary 'investigate cache directive' --disposition recorded --evidence 'state/cache.meta' >/dev/null
  run_receipt "$home" append --timestamp 2026-07-06T00:00:02Z --summary 'ship auth directive' --disposition executed --evidence 'tests/auth.test.sh' >/dev/null

  out=$(run_receipt "$home" check) || fail 'check latest exited non-zero'
  assert_contains "$out" 'receipt: yes' 'check latest missing yes receipt'
  assert_contains "$out" 'summary: ship auth directive' 'check latest did not use newest receipt'
  assert_contains "$out" 'disposition: executed' 'check latest missing disposition'
  assert_contains "$out" 'evidence: tests/auth.test.sh' 'check latest missing evidence'

  out=$(run_receipt "$home" check --summary cache) || fail 'check --summary exited non-zero'
  assert_contains "$out" 'summary: investigate cache directive' 'check --summary did not find matching receipt'
  assert_contains "$out" 'disposition: recorded' 'check --summary missing matched disposition'
  pass 'check verifies latest or matching directive disposition'
}

test_check_missing_receipt_exits_one() {
  local home="$TMP_ROOT/missing-home" out rc
  mkdir -p "$home"
  set +e
  out=$(run_receipt "$home" check --summary absent 2>&1)
  rc=$?
  expect_code 1 "$rc" 'missing check exit code'
  assert_contains "$out" 'receipt: no' 'missing check did not report no receipt'
  assert_contains "$out" 'summary-match: absent' 'missing check did not echo summary needle'
  assert_contains "$out" 'disposition: missing' 'missing check did not report missing disposition'
  pass 'check reports missing directive receipt with exit 1'
}

test_rejects_invalid_disposition_without_writing() {
  local home="$TMP_ROOT/invalid-home" out rc file
  mkdir -p "$home"
  set +e
  out=$(run_receipt "$home" append --summary 'bad directive' --disposition pending --evidence 'none' 2>&1)
  rc=$?
  expect_code 2 "$rc" 'invalid disposition exit code'
  assert_contains "$out" 'disposition must be executed, recorded, routed, or disputed' 'invalid disposition error missing enum'
  file="$home/state/directive-receipts.tsv"
  assert_absent "$file" 'invalid append should not create storage file'
  pass 'append rejects invalid dispositions before writing'
}

test_check_flags_corrupt_missing_disposition() {
  local home="$TMP_ROOT/corrupt-home" out rc file
  file="$home/state/directive-receipts.tsv"
  mkdir -p "$(dirname "$file")"
  printf '%s\t%s\t%s\t%s\n' '2026-07-06T00:00:03Z' 'bad stored directive' 'pending' 'state/bad' > "$file"

  set +e
  out=$(run_receipt "$home" check --summary stored 2>&1)
  rc=$?
  expect_code 1 "$rc" 'corrupt disposition exit code'
  assert_contains "$out" 'receipt: yes' 'corrupt check should still find receipt'
  assert_contains "$out" 'summary: bad stored directive' 'corrupt check missing summary'
  assert_contains "$out" 'disposition: missing' 'corrupt check did not mark invalid disposition missing'
  pass 'check treats invalid stored dispositions as missing'
}

test_help_documents_command
test_append_writes_local_state_receipt
test_list_newest_first_with_limit
test_latest_prints_newest_receipt
test_check_latest_and_summary_match
test_check_missing_receipt_exits_one
test_rejects_invalid_disposition_without_writing
test_check_flags_corrupt_missing_disposition
