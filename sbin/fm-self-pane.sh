#!/usr/bin/env bash
# Resolve and record this firstmate's current herdr pane.
# Usage: fm-self-pane.sh [--check]
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
META="$STATE/self.meta"
MODE="write"

# shellcheck source=sbin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  *) echo "usage: fm-self-pane.sh [--check]" >&2; exit 2 ;;
esac

current_json=$(herdr pane current 2>/dev/null || true)
if [ -z "$current_json" ]; then
  exit 1
fi

pane=$(printf '%s' "$current_json" | fm_json_get result pane pane_id)
workspace=$(printf '%s' "$current_json" | fm_json_get result pane workspace_id)
tab=$(printf '%s' "$current_json" | fm_json_get result pane tab_id)
agent_status=$(printf '%s' "$current_json" | fm_json_get result pane agent_status)

if [ -z "$pane" ] || [ -z "$workspace" ] || [ -z "$tab" ] || [ -z "$agent_status" ]; then
  echo "error: herdr pane current did not resolve pane_id/workspace_id/tab_id/agent_status" >&2
  exit 1
fi

if [ "$MODE" = check ]; then
  recorded=""
  if [ -f "$META" ]; then
    recorded=$(fm_meta_value "$META" pane)
  fi
  if [ "$recorded" != "$pane" ]; then
    [ -n "$recorded" ] || recorded=absent
    printf 'self-pane drift: recorded=%s current=%s\n' "$recorded" "$pane"
    exit 1
  fi
  exit 0
fi

mkdir -p "$STATE"
tmp=$(mktemp "$STATE/.self.meta.XXXXXX") || exit 1
{
  printf 'pane=%s\n' "$pane"
  printf 'workspace=%s\n' "$workspace"
  printf 'tab=%s\n' "$tab"
} > "$tmp"
mv "$tmp" "$META"
printf 'pane=%s\n' "$pane"
