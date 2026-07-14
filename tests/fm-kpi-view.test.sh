#!/usr/bin/env bash
# Verify the KPI visual consumer collects metrics through FleetSnapshot.
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR/data" "$HOME_DIR/state" "$HOME_DIR/config" "$HOME_DIR/sbin"
printf '%s\n' '## In flight' '- **active** - running (repo: app)' '## Queued' '- [ ] **waiting** - queued (repo: app)' '## Done' '- [x] **landed** - done (repo: app)' > "$HOME_DIR/data/backlog.md"
printf '%s\n' '{"result":{"panes":[]}}' > "$TMP/panes.json"
FOLDER="${HOME_DIR//\//-}"
printf '%s\n' '{"byFolder":[{"folder":"'"$FOLDER"'","totalCost":1.25,"totalInputTokens":100,"totalOutputTokens":50,"totalCacheReadTokens":30,"totalCacheWriteTokens":20,"totalRequests":2,"failedRequests":0}],"byAgentType":[{"agentType":"gpt-camel","totalCost":1.25,"totalInputTokens":100,"totalOutputTokens":50},{"agent_type":"snake-compatible","cost_usd":0.5,"input_tokens":10,"output_tokens":5}]}' > "$TMP/stats.json"
: > "$HOME_DIR/sbin/fm-spawn.sh"

FM_HOME="$HOME_DIR" FM_FLEET_PANES_FILE="$TMP/panes.json" FM_FLEET_STATS_FILE="$TMP/stats.json" \
  "$ROOT/sbin/fm-kpi-view.sh" --home "$HOME_DIR" --no-open --output "$TMP/kpi.html"

python3 - "$TMP/kpi.html" <<'PY'
import sys
text = open(sys.argv[1]).read()
assert '"schema":"fm-kpi/1"' in text
assert '"tasks_in_flight":1' in text
assert '"tasks_queued":1' in text
assert '"tasks_landed":1' in text
assert '"cache_hit_rate":0.2' in text
assert '"agent_type":"gpt-camel"' in text
assert '"agent_type":"snake-compatible"' in text
PY
printf '%s\n' 'ok - KPI view uses FleetSnapshot metrics and normalizes agent types'
