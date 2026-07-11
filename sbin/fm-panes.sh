#!/usr/bin/env bash
# Print one line per herdr pane with a detected agent: name<TAB>agent_status<TAB>pane_id
# name = display_agent (preferred) falling back to agent
# Optional args: [--all] [name-filter]
#   --all: also list panes with NO detected agent as -<TAB>unknown<TAB><pane_id><TAB><cwd>
# Usage: fm-panes.sh [--all] [name-filter]
# Exit 0 with empty output when nothing matches; exit non-zero with stderr if herdr fails.
set -eu

FILTER=""
ALL=0
for _a in "$@"; do
  case "$_a" in
    --all) ALL=1 ;;
    *) FILTER="$_a" ;;
  esac
done

herdr pane list 2>&1 | python3 -c '
import json
import sys

filter_arg = sys.argv[1] if len(sys.argv) > 1 else ""
all_flag   = sys.argv[2] if len(sys.argv) > 2 else "0"
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
    pane_id = pane.get("pane_id", "")
    cwd = pane.get("cwd", "")

    if not agent and not display_agent:
        # Agentless pane: only included with --all
        if all_flag != "1":
            continue
        # Filter applies to pane_id for agentless panes (no name to filter on)
        if filter_arg:
            continue
        print(f"-\tunknown\t{pane_id}\t{cwd}")
        continue

    name = display_agent if display_agent else agent
    status = pane.get("agent_status", "")

    # Apply filter if provided
    if filter_arg:
        if filter_arg.lower() not in name.lower():
            continue

    print(f"{name}\t{status}\t{pane_id}")
' "$FILTER" "$ALL"
