#!/usr/bin/env bash
# Verify both visual wrappers reject flag values and honor explicit homes.
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

make_home() {
  local home=$1
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/sbin"
  : > "$home/sbin/fm-spawn.sh"
  printf '%s\n' '## In flight' '- **active** - running (repo: app)' '## Queued' '## Done' > "$home/data/backlog.md"
  printf '%s\n' 'fixture manifest' > "$home/AGENTS.md"
}

A="$TMP/home-a"
B="$TMP/home-b"
make_home "$A"
make_home "$B"
printf '%s\n' '{"result":{"panes":[]}}' > "$TMP/panes.json"
FOLDER="${B//\//-}"
printf '%s\n' '{"byFolder":[{"folder":"'"$FOLDER"'","totalCost":1.25,"totalInputTokens":100,"totalOutputTokens":50,"totalCacheReadTokens":30,"totalCacheWriteTokens":20,"totalRequests":2,"failedRequests":0}]}' > "$TMP/stats.json"

if FM_HOME="$A" FM_FLEET_PANES_FILE="$TMP/panes.json" \
  "$ROOT/sbin/fm-fleet-view.sh" --home --no-open >/dev/null 2>&1; then
  echo "fleet view accepted a following flag as --home value" >&2
  exit 1
elif [ "$?" -ne 2 ]; then
  echo "fleet view returned the wrong missing-value status" >&2
  exit 1
fi

if FM_HOME="$A" FM_FLEET_PANES_FILE="$TMP/panes.json" \
  FM_FLEET_STATS_FILE="$TMP/stats.json" \
  "$ROOT/sbin/fm-kpi-view.sh" --home --no-open >/dev/null 2>&1; then
  echo "KPI view accepted a following flag as --home value" >&2
  exit 1
elif [ "$?" -ne 2 ]; then
  echo "KPI view returned the wrong missing-value status" >&2
  exit 1
fi

FM_HOME="$A" FM_FLEET_PANES_FILE="$TMP/panes.json" \
  "$ROOT/sbin/fm-fleet-view.sh" --home "$B" --no-open --output "$TMP/fleet.html" >/dev/null
FM_HOME="$A" FM_FLEET_PANES_FILE="$TMP/panes.json" FM_FLEET_STATS_FILE="$TMP/stats.json" \
  "$ROOT/sbin/fm-kpi-view.sh" --home "$B" --no-open --output "$TMP/kpi.html" >/dev/null

python3 - "$B" "${B//\//-}" "$TMP/fleet.html" "$TMP/kpi.html" <<'PY'
import sys
home, folder, fleet, kpi = sys.argv[1:]
assert home in open(fleet).read(), home
assert folder in open(kpi).read(), folder
PY
printf '%s\n' 'ok - visual wrappers reject flag values and honor explicit homes'
