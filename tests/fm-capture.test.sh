#!/usr/bin/env bash
# Tests for `fm capture` (fleet plane event append) and the fm send
# --steer hook that calls it.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup() {
  if [ -n "${TMP_ROOT:-}" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-capture-tests.XXXXXX")

# ---------------------------------------------------------------------------
# fm capture: basic write
# ---------------------------------------------------------------------------

EVENTS="$TMP_ROOT/events.jsonl"

CAPTURE_EVENTS_PATH="$EVENTS" "$ROOT/sbin/fm" capture steer fm-riggs "focus on the dispatcher first" "" \
  || fail "fm capture exited non-zero on first write"

[ -f "$EVENTS" ] || fail "events.jsonl not created"

line=$(head -n1 "$EVENTS")
[ -n "$line" ] || fail "events.jsonl is empty after first write"
pass "fm capture creates events.jsonl with a line"

# ---------------------------------------------------------------------------
# Schema validation: all required fields present
# ---------------------------------------------------------------------------

for field in ts plane kind author target raw corrected trace_ref session_id reachable; do
  echo "$line" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
assert '$field' in data, 'missing field: $field'
" || fail "missing field: $field"
done
pass "all required schema fields present"

# ---------------------------------------------------------------------------
# Plane and kind are correct
# ---------------------------------------------------------------------------

plane=$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['plane'])")
kind=$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['kind'])")
[ "$plane" = "fleet" ] || fail "plane should be 'fleet', got '$plane'"
[ "$kind" = "steer" ] || fail "kind should be 'steer', got '$kind'"
pass "plane=fleet kind=steer correct"

# ---------------------------------------------------------------------------
# reachable is JSON null
# ---------------------------------------------------------------------------

reachable=$(echo "$line" | python3 -c "import json,sys; v=json.loads(sys.stdin.read())['reachable']; print('null' if v is None else str(v))")
[ "$reachable" = "null" ] || fail "reachable should be null, got '$reachable'"
pass "reachable=null"

# ---------------------------------------------------------------------------
# corrected field carries the steer message
# ---------------------------------------------------------------------------

corrected=$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['corrected'])")
[ "$corrected" = "focus on the dispatcher first" ] || fail "corrected mismatch: got '$corrected'"
pass "corrected field matches steer message"

# ---------------------------------------------------------------------------
# target field carries the mate
# ---------------------------------------------------------------------------

target_val=$(echo "$line" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['target'])")
[ "$target_val" = "fm-riggs" ] || fail "target mismatch: got '$target_val'"
pass "target field matches mate"

# ---------------------------------------------------------------------------
# Append-only: second write adds a second line, first line intact
# ---------------------------------------------------------------------------

CAPTURE_EVENTS_PATH="$EVENTS" "$ROOT/sbin/fm" capture steer fm-atlas "check the GPU memory" "" \
  || fail "second fm capture call failed"

linecount=$(wc -l < "$EVENTS")
[ "$linecount" -eq 2 ] || fail "expected 2 lines after second write, got $linecount"
pass "second write appends without corrupting first line"

first=$(sed -n '1p' "$EVENTS")
echo "$first" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
assert data['corrected'] == 'focus on the dispatcher first', f\"first line corrupted: {data['corrected']}\"
" || fail "first line was corrupted by second write"
pass "first line intact after second write"

# ---------------------------------------------------------------------------
# fs-survival: write then verify the line is valid JSON after the process exits
# (the write call above already exited; we just verify the file is intact)
# ---------------------------------------------------------------------------

for i in 1 2; do
  line_n=$(sed -n "${i}p" "$EVENTS")
  echo "$line_n" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
assert data.get('plane') == 'fleet', f'bad plane on line $i: {data}'
assert data.get('reachable') is None, f'reachable not null on line $i: {data}'
" || fail "line $i is not valid JSON after process exit (fsync may have failed)"
done
pass "all written lines are valid JSON after process exit"

# ---------------------------------------------------------------------------
# Special characters in message are JSON-safe
# ---------------------------------------------------------------------------

SPECIAL_EVENTS="$TMP_ROOT/special.jsonl"
# shellcheck disable=SC2016 # literal $vars/quotes are the special-character test payload
CAPTURE_EVENTS_PATH="$SPECIAL_EVENTS" "$ROOT/sbin/fm" capture steer fm-fran \
  'use "double quotes" and $vars and '\''single'\'' freely' "" \
  || fail "special char write failed"

special_line=$(head -n1 "$SPECIAL_EVENTS")
echo "$special_line" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
assert 'double quotes' in data['corrected'], f'quotes missing: {data[\"corrected\"]}'
" || fail "special characters corrupted by JSON encoding"
pass "special characters in message are JSON-safe"

# ---------------------------------------------------------------------------
# Fail-open: bad events path (unwritable dir) does not exit non-zero
# ---------------------------------------------------------------------------

if CAPTURE_EVENTS_PATH="/proc/no-such-path/events.jsonl" "$ROOT/sbin/fm" capture steer fm-riggs "test" ""; then
  pass "fail-open: bad path exits 0"
else
  fail "fail-open: bad path should not exit non-zero"
fi

echo ""
echo "All fm-capture tests passed."
