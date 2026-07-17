#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=
fail(){ printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass(){ printf 'ok - %s\n' "$1"; }
cleanup(){ [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-capture-status.XXXXXX")

EVENTS="$TMP_ROOT/events.jsonl"
LOADED="$TMP_ROOT/loaded.json"

cat >"$EVENTS" <<'EOF'
{"ts": 1700000000000, "plane": "fleet", "kind": "steer", "author": "captain", "target": "fm-riggs", "raw": "", "corrected": "demo", "trace_ref": "", "session_id": "", "reachable": null}
EOF

python3 - "$LOADED" <<'PYEOF'
import json, os, sys, time
path = sys.argv[1]
json.dump({"pid": os.getpid(), "session_id": "s1", "session_path": "/tmp/s1.jsonl", "ts": int(time.time()*1000), "revision": "capture-v1"}, open(path, 'w'))
PYEOF

out=$(CAPTURE_EVENTS_PATH="$EVENTS" CAPTURE_LOADED_PATH="$LOADED" "$ROOT/sbin/fm" capture-status) || fail "status helper exited non-zero"
printf '%s\n' "$out" | grep '^fleet_hook[[:space:]]present$' >/dev/null || fail "fleet hook missing"
printf '%s\n' "$out" | grep '^supervisor_auto[[:space:]]stale-marker$' >/dev/null || fail "synthetic marker should report stale-marker"
printf '%s\n' "$out" | grep '^last_event[[:space:]]fleet[[:space:]]steer[[:space:]]' >/dev/null || fail "last event line missing"
pass "status helper reports stale marker and last event"

rm -f "$LOADED"
out=$(CAPTURE_EVENTS_PATH="$EVENTS" CAPTURE_LOADED_PATH="$LOADED" "$ROOT/sbin/fm" capture-status) || fail "status helper exited non-zero without marker"
printf '%s\n' "$out" | grep '^supervisor_auto[[:space:]]fresh-session-start-only$' >/dev/null || fail "missing marker should report fresh-session-start-only"
pass "status helper reports fresh-session-start-only without marker"

echo ""
echo "All fm-capture-status tests passed."
