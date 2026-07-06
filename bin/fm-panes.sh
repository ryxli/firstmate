#!/usr/bin/env bash
# Print one line per herdr pane with a detected agent: name<TAB>agent_status<TAB>pane_id
# name = display_agent (preferred) falling back to agent
# Optional first arg: case-insensitive substring filter on name.
# Usage: fm-panes.sh [name-filter]
# Exit 0 with empty output when nothing matches; exit non-zero with stderr if herdr fails.
set -eu

FILTER="${1:-}"

herdr pane list 2>&1 | python3 -c '
import json
import sys

filter_arg = sys.argv[1] if len(sys.argv) > 1 else ""
data_json = sys.stdin.read()

try:
    data = json.loads(data_json)
except json.JSONDecodeError as e:
    print(f"error: invalid JSON from herdr pane list: {e}", file=sys.stderr)
    sys.exit(1)

panes = data.get("result", {}).get("panes", [])

for pane in panes:
    agent = pane.get("agent", "")
    display_agent = pane.get("display_agent", "")
    
    # Skip panes with no detected agent
    if not agent and not display_agent:
        continue
    
    name = display_agent if display_agent else agent
    status = pane.get("agent_status", "")
    pane_id = pane.get("pane_id", "")
    
    # Apply filter if provided
    if filter_arg:
        if filter_arg.lower() not in name.lower():
            continue
    
    print(f"{name}\t{status}\t{pane_id}")
' "$FILTER"
