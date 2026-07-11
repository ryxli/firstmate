#!/usr/bin/env bash
# Show whether the fleet hook and supervisor-plane capture extension are live.
# Usage: fm-capture-status.sh
set -eu

AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.omp/agent}"
CAPTURE_DIR="${AGENT_DIR}/capture"
EVENTS="${CAPTURE_EVENTS_PATH:-${CAPTURE_DIR}/events.jsonl}"
LOADED="${CAPTURE_LOADED_PATH:-${CAPTURE_DIR}/loaded.json}"
fleet_hook="present"
if ! grep -q 'fm-capture\.sh' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fm-send.sh"; then
  fleet_hook="missing"
fi

python3 - "$EVENTS" "$LOADED" "$fleet_hook" <<'PYEOF'
import json, os, sys, time, subprocess

events_path, loaded_path, fleet_hook = sys.argv[1:4]

def fmt_ts(ts_ms):
    if not ts_ms:
        return "-"
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts_ms / 1000))
    except Exception:
        return str(ts_ms)

loaded = None
loaded_state = "fresh-session-start-only"
if os.path.exists(loaded_path):
    try:
        loaded = json.load(open(loaded_path, encoding="utf-8"))
        pid = str(loaded.get("pid", ""))
        if pid and os.path.exists(f"/proc/{pid}"):
            loaded_state = "live"
        else:
            ps = subprocess.run(["ps", "-p", pid, "-o", "comm="], text=True, capture_output=True)
            loaded_state = "live" if ps.returncode == 0 and ps.stdout.strip() else "stale-marker"
    except Exception:
        loaded_state = "bad-marker"

last = None
if os.path.exists(events_path):
    try:
        with open(events_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    last = json.loads(line)
    except Exception:
        last = {"plane": "?", "kind": "bad-event-log", "ts": 0}

print(f"fleet_hook\t{fleet_hook}")
print(f"supervisor_auto\t{loaded_state}")
if loaded:
    print(f"loaded_ts\t{fmt_ts(loaded.get('ts', 0))}")
    print(f"loaded_pid\t{loaded.get('pid', '')}")
    print(f"loaded_revision\t{loaded.get('revision', '')}")
if last:
    print(f"last_event\t{last.get('plane','?')}\t{last.get('kind','?')}\t{fmt_ts(last.get('ts', 0))}")
else:
    print("last_event\tnone")
PYEOF
