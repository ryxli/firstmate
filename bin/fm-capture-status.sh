#!/usr/bin/env bash
# Show the current state of the capture system:
# - whether the fleet hook is present in the capture extension
# - whether the supervisor extension loaded marker exists and is from a live process
# - the last captured event by plane, kind, and timestamp
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Paths
CAPTURE_DIR="${CAPTURE_DIR:-${HOME}/.omp/agent/capture}"
EVENTS_FILE="${CAPTURE_EVENTS_PATH:-${CAPTURE_DIR}/events.jsonl}"
LOADED_FILE="${CAPTURE_LOADED_PATH:-${CAPTURE_DIR}/loaded.json}"
EXTENSION_PATH="${HOME}/.omp/agent/extensions/capture"

echo "=== Capture System Status ==="
echo ""

# 1. Check if capture extension exists
if [ -f "$EXTENSION_PATH/index.ts" ]; then
  echo "✓ Capture extension found: $EXTENSION_PATH"
else
  echo "✗ Capture extension NOT found"
  exit 1
fi

# 2. Check if loaded marker exists and is from a live process
echo ""
if [ -f "$LOADED_FILE" ]; then
  # Parse the marker file
  pid=$(python3 -c "import json; data=json.load(open('$LOADED_FILE')); print(data.get('pid', 'unknown'))" 2>/dev/null || echo "")
  ts=$(python3 -c "import json; data=json.load(open('$LOADED_FILE')); print(data.get('ts', 'unknown'))" 2>/dev/null || echo "")
  session_id=$(python3 -c "import json; data=json.load(open('$LOADED_FILE')); print(data.get('session_id', 'unknown'))" 2>/dev/null || echo "")
  revision=$(python3 -c "import json; data=json.load(open('$LOADED_FILE')); print(data.get('revision', 'unknown'))" 2>/dev/null || echo "")
  
  if [ -z "$pid" ]; then
    echo "✗ Loaded marker exists but is invalid JSON"
  else
    # Check if process is alive
    if ps -p "$pid" > /dev/null 2>&1; then
      echo "✓ Supervisor extension loaded (PID: $pid, alive)"
      echo "  Session: $session_id"
      echo "  Revision: $revision"
      # Format timestamp
      if [ -n "$ts" ] && [ "$ts" != "unknown" ]; then
        date_str=$(python3 -c "import datetime; print(datetime.datetime.fromtimestamp($ts/1000).strftime('%Y-%m-%d %H:%M:%S'))" 2>/dev/null || echo "$ts")
        echo "  Loaded at: $date_str"
      fi
    else
      echo "✗ Loaded marker exists but process (PID: $pid) is NOT alive"
      echo "  (Session: $session_id)"
    fi
  fi
else
  echo "✗ Loaded marker does NOT exist at $LOADED_FILE"
  echo "  (Extension loads on fresh session start only)"
fi

# 3. Show last captured event
echo ""
if [ -f "$EVENTS_FILE" ]; then
  last_event=$(tail -n1 "$EVENTS_FILE" 2>/dev/null)
  if [ -n "$last_event" ]; then
    plane=$(echo "$last_event" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('plane', '?'))" 2>/dev/null || echo "?")
    kind=$(echo "$last_event" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('kind', '?'))" 2>/dev/null || echo "?")
    ts_last=$(echo "$last_event" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('ts', 0))" 2>/dev/null || echo "0")
    
    if [ -n "$ts_last" ] && [ "$ts_last" != "0" ]; then
      date_str=$(python3 -c "import datetime; print(datetime.datetime.fromtimestamp($ts_last/1000).strftime('%Y-%m-%d %H:%M:%S'))" 2>/dev/null || echo "$ts_last")
      echo "✓ Last event: plane=$plane kind=$kind at $date_str"
    else
      echo "✓ Last event: plane=$plane kind=$kind"
    fi
  else
    echo "  (No events recorded yet)"
  fi
else
  echo "  (No events file at $EVENTS_FILE)"
fi

echo ""
