#!/usr/bin/env bash
# Manage the dispatch freeze flag and per-mate focus locks.
# Usage:
#   fm-freeze.sh on [reason]               - freeze all dispatches
#   fm-freeze.sh off                       - unfreeze
#   fm-freeze.sh focus <id> on [reason]    - focus-lock a mate (id without fm- prefix)
#   fm-freeze.sh focus <id> off            - remove focus lock
#
# The dispatch freeze blocks fm-send from delivering new work to any mate.
# A focus lock blocks fm-send from delivering new work to a specific mate.
# Both are bypassed by --steer or FM_DISPATCH_OVERRIDE=1 in fm-send.sh.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

usage() {
  echo "Usage: fm-freeze.sh on [reason]" >&2
  echo "       fm-freeze.sh off" >&2
  echo "       fm-freeze.sh focus <id> on [reason]" >&2
  echo "       fm-freeze.sh focus <id> off" >&2
  exit 1
}

[ "${1:-}" ] || usage

case "$1" in
  on)
    reason="${2:-}"
    printf '%s\n' "$reason" > "$STATE/.dispatch-freeze"
    echo "dispatch frozen${reason:+: $reason}"
    ;;
  off)
    rm -f "$STATE/.dispatch-freeze"
    echo "dispatch unfrozen"
    ;;
  focus)
    id="${2:-}"
    [ -n "$id" ] || usage
    shift 2
    case "${1:-}" in
      on)
        reason="${2:-}"
        printf '%s\n' "$reason" > "$STATE/.focus-$id"
        echo "focus lock set for $id${reason:+: $reason}"
        ;;
      off)
        rm -f "$STATE/.focus-$id"
        echo "focus lock removed for $id"
        ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac
