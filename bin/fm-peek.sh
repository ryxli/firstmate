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

"$SCRIPT_DIR/fm-guard.sh" || true

resolve() {
  case "$1" in
    *:*)  # explicit pane id like w8:p3
      echo "$1" ;;
    fm-*)
      meta="$STATE/${1#fm-}.meta"
      if [ ! -f "$meta" ]; then
        echo "error: no metadata for $1 in $STATE; pass a pane id directly to target a pane outside this firstmate home" >&2
        exit 1
      fi
      pane=$(grep '^pane=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
      [ -n "$pane" ] || { echo "error: no pane recorded in $meta" >&2; exit 1; }
      echo "$pane"
      ;;
    *)
      # Try to resolve by agent name.
      pane=$(herdr agent get "$1" 2>/dev/null | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4 | head -1 || true)
      [ -n "$pane" ] || { echo "error: no pane found for $1" >&2; exit 1; }
      echo "$pane"
      ;;
  esac
}

P=$(resolve "$1")
N=${2:-40}
herdr pane read "$P" --lines "$N" --source recent-unwrapped 2>/dev/null \
  || herdr pane read "$P" --lines "$N" 2>/dev/null \
  || { echo "error: could not read pane $P" >&2; exit 1; }
