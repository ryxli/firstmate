#!/usr/bin/env bash
# Tests for sbin/fm-status-compact.sh
#
# Fixtures:
#   1. terminal-line compaction  - done history is archived, newest terminal line kept
#   2. needs-decision preservation - nd line in current lane is preserved, not archived
#   3. refusal case              - file ending with needs-decision is never touched
#   4. archive file created      - archive log written to .status-archive/<name>.<date>.log
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPACT="$ROOT/sbin/fm-status-compact.sh"
TMP_ROOT=

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup() { [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-status-compact.XXXXXX")
STATE="$TMP_ROOT/state"
mkdir -p "$STATE"

# Write lines as a status file.
mk_status() {
  local name="$1"; shift
  printf '%s\n' "$@" > "$STATE/${name}.status"
}

# Run compact with the test state dir wired in.
run_compact() {
  FM_STATE_OVERRIDE="$STATE" FM_ROOT_OVERRIDE="$TMP_ROOT" "$COMPACT" "$@"
}

# ── 1. terminal-line compaction ──────────────────────────────────────────────
test_terminal_compaction() {
  mk_status tc \
    "done: task A" \
    "done: task B" \
    "done: task C"

  run_compact tc

  local hdr
  hdr=$(head -n1 "$STATE/tc.status")
  [[ "$hdr" == "compacted "* ]] \
    || fail "terminal_compaction: header line missing (got: $hdr)"

  grep -q "done: task C" "$STATE/tc.status" \
    || fail "terminal_compaction: done:C missing from file"
  grep -q "done: task A" "$STATE/tc.status" \
    && fail "terminal_compaction: done:A still in file (should be archived)"
  grep -q "done: task B" "$STATE/tc.status" \
    && fail "terminal_compaction: done:B still in file (should be archived)"

  pass "terminal-line compaction"
}

# ── 2. needs-decision preservation ──────────────────────────────────────────
# nd line sits between old done lines and the newest terminal line; it falls
# inside the current lane and must be preserved in the output file.
test_nd_preservation() {
  mk_status nd \
    "done: task A" \
    "done: task B" \
    "needs-decision: which approach" \
    "done: task C"

  run_compact nd

  local hdr
  hdr=$(head -n1 "$STATE/nd.status")
  [[ "$hdr" == "compacted "* ]] \
    || fail "nd_preservation: header line missing"

  grep -q "needs-decision: which approach" "$STATE/nd.status" \
    || fail "nd_preservation: needs-decision line not preserved in output"
  grep -q "done: task C" "$STATE/nd.status" \
    || fail "nd_preservation: done:C missing from output"
  grep -q "done: task A" "$STATE/nd.status" \
    && fail "nd_preservation: done:A still in file (should be archived)"
  grep -q "done: task B" "$STATE/nd.status" \
    && fail "nd_preservation: done:B still in file (should be archived)"

  pass "needs-decision preservation"
}

# ── 3. refusal case ──────────────────────────────────────────────────────────
# File whose last non-blank line is needs-decision must not be modified.
test_refusal() {
  mk_status ref \
    "done: old task" \
    "needs-decision: captain must approve X"

  local before
  before=$(cat "$STATE/ref.status")

  run_compact ref

  local after
  after=$(cat "$STATE/ref.status")
  [[ "$before" == "$after" ]] \
    || fail "refusal: file was modified despite ending with needs-decision"

  pass "refusal case"
}

# ── 4. archive file created ───────────────────────────────────────────────────
test_archive_created() {
  mk_status arc \
    "done: will be archived" \
    "done: will stay"

  run_compact arc

  # Archive directory and file must exist
  local arc_file
  arc_file=$(find "$STATE/.status-archive" -name "arc.*.log" -type f 2>/dev/null | head -n1)
  [ -n "$arc_file" ] \
    || fail "archive_created: no archive file found under $STATE/.status-archive/"

  grep -q "done: will be archived" "$arc_file" \
    || fail "archive_created: archived line missing from archive log"
  grep -q "done: will stay" "$arc_file" \
    && fail "archive_created: current line must not appear in archive log"

  # Current line must still be in the status file
  grep -q "done: will stay" "$STATE/arc.status" \
    || fail "archive_created: current line missing from status file after compaction"

  pass "archive file created"
}

test_terminal_compaction
test_nd_preservation
test_refusal
test_archive_created
