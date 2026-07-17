#!/usr/bin/env bash
# Behavior tests for `fm report`: the status-append helper crewmates and
# secondmates invoke instead of `echo "<line>" >> <file>` (the omp bash tool
# blocks a direct redirection but allows a script that redirects internally).
# It appends one line, creates a missing parent dir, accumulates across calls,
# and rejects the wrong argument count.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT=("$ROOT/sbin/fm" report)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-report.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

eq() {
  # eq <description> <expected> <actual>
  [ "$2" = "$3" ] || fail "$1: expected [$2], got [$3]"
}

test_appends_one_line() {
  local f="$TMP_ROOT/flat.status"
  "${REPORT[@]}" "$f" "working: started" || fail "report exited non-zero on a plain append"
  eq "single line written" "working: started" "$(cat "$f")"
  eq "exactly one line" "1" "$(wc -l < "$f" | tr -d ' ')"
  pass "appends a single status line"
}

test_creates_missing_parent_dir() {
  local f="$TMP_ROOT/nested/deeper/sub.status"
  [ -d "$TMP_ROOT/nested" ] && fail "parent dir existed before the call"
  "${REPORT[@]}" "$f" "done: ready" || fail "report exited non-zero when parent dir was missing"
  [ -f "$f" ] || fail "status file not created under a missing parent dir"
  eq "line written into created tree" "done: ready" "$(cat "$f")"
  pass "creates the missing parent directory (mkdir -p)"
}

test_accumulates_across_calls() {
  local f="$TMP_ROOT/accum.status"
  "${REPORT[@]}" "$f" "working: one" || fail "first append failed"
  "${REPORT[@]}" "$f" "needs-decision: two" || fail "second append failed"
  "${REPORT[@]}" "$f" "done: three" || fail "third append failed"
  eq "three accumulated lines" "3" "$(wc -l < "$f" | tr -d ' ')"
  eq "first line preserved" "working: one" "$(sed -n '1p' "$f")"
  eq "second line preserved" "needs-decision: two" "$(sed -n '2p' "$f")"
  eq "last line appended in order" "done: three" "$(sed -n '3p' "$f")"
  pass "accumulates lines across repeated invocations"
}

test_preserves_line_verbatim() {
  # A status line with shell metacharacters and spaces must land verbatim;
  # the helper uses printf '%s\n' so nothing is re-interpreted or globbed.
  local f="$TMP_ROOT/verbatim.status"
  # shellcheck disable=SC2016  # the $HOME/$() text is intentionally literal, not expanded
  local line='blocked: cannot find $HOME/* (see #12 & rule "x")'
  "${REPORT[@]}" "$f" "$line" || fail "append of a metachar-heavy line failed"
  eq "line stored verbatim" "$line" "$(cat "$f")"
  pass "stores the status line verbatim without interpretation"
}

test_errors_on_wrong_arg_count() {
  local out rc
  out=$("${REPORT[@]}" 2>&1); rc=$?
  eq "no-arg exit code" "2" "$rc"
  printf '%s' "$out" | grep -q 'usage:' || fail "no-arg run did not print usage to stderr"

  "${REPORT[@]}" "$TMP_ROOT/one.status" >/dev/null 2>&1; rc=$?
  eq "one-arg exit code" "2" "$rc"
  [ -e "$TMP_ROOT/one.status" ] && fail "one-arg run should not create the file"

  "${REPORT[@]}" a b c >/dev/null 2>&1; rc=$?
  eq "three-arg exit code" "2" "$rc"
  pass "rejects the wrong argument count with usage and exit 2"
}

test_appends_one_line
test_creates_missing_parent_dir
test_accumulates_across_calls
test_preserves_line_verbatim
test_errors_on_wrong_arg_count
