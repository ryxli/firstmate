#!/usr/bin/env bash
# Append one fleet-plane capture event to the events journal.
# Usage: fm-capture.sh <kind> <target> <corrected> [raw]
#   kind      : steer | redo
#   target    : mate pane id or name (e.g. fm-riggs)
#   corrected : the steering message text
#   raw       : optional prior context (empty string if not available)
#
# Schema matches the supervisor plane exactly so a future collector reads one
# schema. Writes are O_APPEND + fsync via python3 so a crash never truncates
# a previously flushed line. Fails open: any error exits 0 silently.
set -eu

python3 - "$1" "$2" "$3" "${4:-}" <<'PYEOF' || true
import json, os, sys, time

kind, target, corrected, raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
events_path = os.environ.get(
    "CAPTURE_EVENTS_PATH",
    os.path.join(os.path.expanduser("~"), ".omp", "agent", "capture", "events.jsonl"),
)
try:
    os.makedirs(os.path.dirname(events_path), exist_ok=True)
    event = {
        "ts": int(time.time() * 1000),
        "plane": "fleet",
        "kind": kind,
        "author": "captain",
        "target": target,
        "raw": raw,
        "corrected": corrected,
        "trace_ref": "",
        "session_id": "",
        "reachable": None,
    }
    with open(events_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")
        f.flush()
        os.fsync(f.fileno())
except Exception:
    pass  # fail open - never exit non-zero over a capture write
PYEOF
