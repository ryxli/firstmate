#!/usr/bin/env bash
# Tests for fm-classify-status.sh and the supervisor's pure classifyAndDigest
# status relevance path.
#
# Contract under test:
#   - terminal status prefixes wake only at the start of the status line, after an
#     optional ISO-ish timestamp prefix;
#   - PR ready, checks green, ready in branch, and merged wake as whole phrases;
#   - substring lookalikes such as already, unmerged, and readying stay internal;
#   - the shell helper and TS supervisor export agree so the duplicated relevance
#     classifier cannot drift.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIFY="$ROOT/bin/fm-classify-status.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-classify-status.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

run_classifier() {
  OUT=$("$CLASSIFY" "$1" 2>&1); RC=$?
}

assert_captain() {
  local name=$1 line=$2
  run_classifier "$line"
  [ "$RC" -eq 0 ] || fail "$name: expected captain exit 0, got rc=$RC out=$OUT"
  [ "$OUT" = captain ] || fail "$name: expected output captain, got $OUT"
}

assert_internal() {
  local name=$1 line=$2
  run_classifier "$line"
  [ "$RC" -eq 1 ] || fail "$name: expected internal exit 1, got rc=$RC out=$OUT"
  [ "$OUT" = internal ] || fail "$name: expected output internal, got $OUT"
}

test_shell_classifier_precision() {
  assert_captain "timestamped done prefix" "2026-07-05T12:34:56Z done: PR https://github.com/o/r/pull/1"
  assert_captain "PR ready phrase" "validation complete, PR ready for review"
  assert_captain "checks green phrase" "CI finished with checks green on the PR"
  assert_captain "ready in branch phrase" "implementation ready in branch fm/status-precision"
  assert_captain "merged phrase" "PR merged to main"

  assert_internal "already is not ready" "already working through the review notes"
  assert_internal "unmerged is not merged" "still on an unmerged branch"
  assert_internal "readying is not ready in branch" "readying branch for a later push"
  assert_internal "prefix must lead" "progress update before done: still running checks"

  pass "fm-classify-status.sh classifies only anchored statuses and whole phrases"
}

test_supervisor_export_precision() {
  command -v bun >/dev/null 2>&1 || fail "bun is required for supervisor classifyAndDigest coverage"
  cat > "$TMP_ROOT/supervisor-classify.mjs" <<'JS'
const { classifyAndDigest } = await import(`${process.env.FM_ROOT}/.omp/extensions/fm-supervisor.ts`);

const positives = [
  ["timestamped done prefix", "2026-07-05T12:34:56Z done: PR https://github.com/o/r/pull/1"],
  ["PR ready phrase", "validation complete, PR ready for review"],
  ["checks green phrase", "CI finished with checks green on the PR"],
  ["ready in branch phrase", "implementation ready in branch fm/status-precision"],
  ["merged phrase", "PR merged to main"],
];
const negatives = [
  ["already is not ready", "already working through the review notes"],
  ["unmerged is not merged", "still on an unmerged branch"],
  ["readying is not ready in branch", "readying branch for a later push"],
  ["prefix must lead", "progress update before done: still running checks"],
];

let failures = 0;
function eventFor(line, relevant) {
  return { t: 1, kind: "status", pane: "w1:p1", task: "status-precision", status_line: line, relevant };
}
function check(name, condition, details) {
  if (!condition) {
    console.error(`FAIL ${name}: ${details}`);
    failures++;
  }
}

for (const [name, line] of positives) {
  const result = classifyAndDigest([eventFor(line, true)]);
  check(name, result.wakes === 1, `expected one wake, got ${result.wakes}`);
  check(name, result.detected === 1, `expected one detected event, got ${result.detected}`);
  check(name, result.digests.length === 1 && result.digests[0].includes(line), `digest did not carry the status line: ${JSON.stringify(result.digests)}`);
}
for (const [name, line] of negatives) {
  const result = classifyAndDigest([eventFor(line, false)]);
  check(name, result.wakes === 0, `expected no wakes, got ${result.wakes}`);
  check(name, result.detected === 0, `expected no detected events, got ${result.detected}`);
  check(name, result.digests.length === 0, `expected no digests, got ${JSON.stringify(result.digests)}`);
}

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("supervisor classifyAndDigest status relevance: all checks pass");
JS

  FM_ROOT="$ROOT" bun "$TMP_ROOT/supervisor-classify.mjs" \
    || fail "supervisor classifyAndDigest relevance cases failed"
  pass "fm-supervisor.ts classifyAndDigest matches status relevance precision"
}

test_shell_classifier_precision
test_supervisor_export_precision
