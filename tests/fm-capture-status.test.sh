#!/usr/bin/env bash
# Tests for fm-capture-status.sh and the loaded marker lifecycle.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-capture-status-tests.XXXXXX")

# ---------------------------------------------------------------------------
# fm-capture-status.sh: detects missing loaded marker
# ---------------------------------------------------------------------------

CAPTURE_DIR="$TMP_ROOT/capture"
mkdir -p "$CAPTURE_DIR"

# Create a minimal events.jsonl so status tool has something to read
EVENTS="$CAPTURE_DIR/events.jsonl"
python3 - "$EVENTS" <<'PYEOF'
import json, sys, time
events_path = sys.argv[1]
event = {
    "ts": int(time.time() * 1000),
    "plane": "fleet",
    "kind": "steer",
    "author": "captain",
    "target": "test-mate",
    "raw": "",
    "corrected": "test message",
    "trace_ref": "",
    "session_id": "",
    "reachable": None,
}
with open(events_path, "w") as f:
    f.write(json.dumps(event) + "\n")
PYEOF

# Mock the extension path so status helper finds it
EXTENSION_PATH="$TMP_ROOT/extensions/capture"
mkdir -p "$EXTENSION_PATH"
touch "$EXTENSION_PATH/index.ts"

output=$(CAPTURE_DIR="$CAPTURE_DIR" \
         EXTENSION_PATH="$EXTENSION_PATH" \
         bash "$ROOT/bin/fm-capture-status.sh" 2>&1)

# Should show ✓ capture extension found
echo "$output" | grep -q "Capture extension found" || fail "status should find extension"
pass "fm-capture-status.sh detects extension"

# Should show ✗ loaded marker missing
echo "$output" | grep -q "Loaded marker does NOT exist" || fail "status should warn about missing marker"
pass "fm-capture-status.sh detects missing loaded marker"

# Should show last event
echo "$output" | grep -q "Last event" || fail "status should show last event"
pass "fm-capture-status.sh shows last event"

# ---------------------------------------------------------------------------
# Loaded marker format validation
# ---------------------------------------------------------------------------

LOADED="$CAPTURE_DIR/loaded.json"

# Write a valid marker
python3 - "$LOADED" <<'PYEOF'
import json, sys, os
marker_path = sys.argv[1]
marker = {
    "pid": os.getpid(),
    "session_id": "test-session-123",
    "session_path": "/test/session/path",
    "ts": 1720348800000,
    "revision": "capture-v1",
}
with open(marker_path, "w") as f:
    json.dump(marker, f, indent=2)
PYEOF

[ -f "$LOADED" ] || fail "marker file not created"
pass "loaded marker file created"

# Verify all required fields
for field in pid session_id session_path ts revision; do
  python3 - "$LOADED" "$field" <<'PYEOF' || fail "field '$field' missing or invalid"
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
field = sys.argv[2]
assert field in data, f"field {field} missing"
print(f"ok: {field}")
PYEOF
done
pass "all required fields present in loaded marker"

# ---------------------------------------------------------------------------
# fm-capture-status.sh: detects live loaded marker
# ---------------------------------------------------------------------------

# Create a marker with current process pid
THIS_PID=$$
python3 - "$LOADED" <<PYEOF
import json
marker = {
    "pid": $THIS_PID,
    "session_id": "test-session-live",
    "session_path": "/test/session/live",
    "ts": $(date +%s)000,
    "revision": "capture-v1",
}
with open("$LOADED", "w") as f:
    json.dump(marker, f, indent=2)
PYEOF

output=$(CAPTURE_DIR="$CAPTURE_DIR" \
         EXTENSION_PATH="$EXTENSION_PATH" \
         bash "$ROOT/bin/fm-capture-status.sh" 2>&1)

# Should show ✓ supervisor extension loaded with live PID
echo "$output" | grep -q "Supervisor extension loaded" || fail "status should show loaded marker"
echo "$output" | grep -q "PID: $THIS_PID, alive" || fail "status should show correct PID as alive"
pass "fm-capture-status.sh detects live loaded marker"

# Should show session info
echo "$output" | grep -q "Session: test-session-live" || fail "status should show session id"
pass "fm-capture-status.sh shows session info from marker"

# ---------------------------------------------------------------------------
# fm-capture-status.sh: detects dead process in marker
# ---------------------------------------------------------------------------

# Use an impossible PID (9999999)
DEAD_PID=9999999
python3 - "$LOADED" <<PYEOF
import json
marker = {
    "pid": $DEAD_PID,
    "session_id": "test-session-dead",
    "session_path": "/test/session/dead",
    "ts": $(date +%s)000,
    "revision": "capture-v1",
}
with open("$LOADED", "w") as f:
    json.dump(marker, f, indent=2)
PYEOF

output=$(CAPTURE_DIR="$CAPTURE_DIR" \
         EXTENSION_PATH="$EXTENSION_PATH" \
         bash "$ROOT/bin/fm-capture-status.sh" 2>&1)

# Should show ✗ process not alive
echo "$output" | grep -q "process (PID: $DEAD_PID) is NOT alive" || fail "status should detect dead process"
pass "fm-capture-status.sh detects dead process in marker"

# ---------------------------------------------------------------------------
# fm-capture-status.sh: handles invalid JSON in marker
# ---------------------------------------------------------------------------

echo "{ invalid json" > "$LOADED"

output=$(CAPTURE_DIR="$CAPTURE_DIR" \
         EXTENSION_PATH="$EXTENSION_PATH" \
         bash "$ROOT/bin/fm-capture-status.sh" 2>&1)

# Should show warning about invalid JSON
echo "$output" | grep -q "invalid JSON" || fail "status should warn about invalid JSON"
pass "fm-capture-status.sh handles invalid marker JSON"

echo ""
echo "All fm-capture-status tests passed."
