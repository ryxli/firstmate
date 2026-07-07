#!/usr/bin/env bash
# Print the tail of a crewmate pane (bounded, for cheap diagnosis).
# Usage: fm-peek.sh [--full] [--status-only] <pane>
#   --full        read 120 lines (default: 40)
#   --status-only print only the one-line header (<name> <agent_status>)
#   <pane> may be a bare firstmate pane name (fm-xyz), resolved through
#   this home's state/<id>.meta, or an explicit herdr pane id (e.g. w8:p3).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

"$SCRIPT_DIR/fm-guard.sh" || true

FULL=0
STATUS_ONLY=0
PANE_ARG=

while [ $# -gt 0 ]; do
  case "$1" in
    --full)        FULL=1 ;;
    --status-only) STATUS_ONLY=1 ;;
    -*)            printf 'error: unknown flag %s\n' "$1" >&2; exit 1 ;;
    *)
      if [ -n "$PANE_ARG" ]; then
        printf 'error: unexpected argument %s (pane already set to %s)\n' "$1" "$PANE_ARG" >&2
        exit 1
      fi
      PANE_ARG="$1"
      ;;
  esac
  shift
done

[ -n "$PANE_ARG" ] || { printf 'usage: fm-peek.sh [--full] [--status-only] <pane>\n' >&2; exit 1; }

P=$(fm_resolve_live_pane "$PANE_ARG" "$STATE")
N=40
[ "$FULL" = 1 ] && N=120

# Fetch agent status from herdr pane get for the one-line header.
STATUS=$(herdr pane get "$P" 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("agent_status","unknown"))' \
  2>/dev/null) || STATUS=""
[ -n "$STATUS" ] || STATUS="unknown"

printf '%s %s\n' "$PANE_ARG" "$STATUS"
[ "$STATUS_ONLY" = 1 ] && exit 0

herdr pane read "$P" --lines "$N" --source recent-unwrapped 2>/dev/null \
  || herdr pane read "$P" --lines "$N" 2>/dev/null \
  || { printf 'error: could not read pane %s\n' "$P" >&2; exit 1; }
