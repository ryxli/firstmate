#!/usr/bin/env bash
# Print the tail of a crewmate pane (bounded, for cheap diagnosis).
# Usage: fm-peek.sh <pane> [lines=40]
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

P=$(fm_resolve_live_pane "$1" "$STATE")
N=${2:-40}
herdr pane read "$P" --lines "$N" --source recent-unwrapped 2>/dev/null \
  || herdr pane read "$P" --lines "$N" 2>/dev/null \
  || { echo "error: could not read pane $P" >&2; exit 1; }
