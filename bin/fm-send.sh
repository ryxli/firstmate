#!/usr/bin/env bash
# Send one line of literal text to a crewmate pane, then Enter.
# Usage: fm-send.sh <pane> <text...>
#   <pane> may be a bare firstmate pane name (fm-xyz), resolved through
#   this home's state/<id>.meta, or an explicit herdr pane id (e.g. w8:p3).
# Special keys instead of text: fm-send.sh <pane> --key Escape   (or Enter, ...)
#
# Text submission uses herdr pane run (text+Enter atomically) and verifies
# delivery: if a positively-confirmed swallow is detected (text still in the
# composer after all retries), fm-send exits NON-ZERO. The compose/submit
# logic lives in bin/fm-herdr-lib.sh. Tune with FM_SEND_RETRIES (default 3)
# and FM_SEND_SLEEP (0.4).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

"$SCRIPT_DIR/fm-guard.sh" || true

resolve() {
  case "$1" in
    *:*)  # explicit pane id
      echo "$1" ;;
    fm-*)
      meta="$STATE/${1#fm-}.meta"
      if [ ! -f "$meta" ]; then
        echo "error: no metadata for $1 in $STATE; pass a pane id to target a pane outside this firstmate home" >&2
        exit 1
      fi
      pane=$(grep '^pane=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
      [ -n "$pane" ] || { echo "error: no pane recorded in $meta" >&2; exit 1; }
      echo "$pane"
      ;;
    *)
      pane=$(herdr agent get "$1" 2>/dev/null | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4 | head -1 || true)
      [ -n "$pane" ] || { echo "error: no pane found for $1" >&2; exit 1; }
      echo "$pane"
      ;;
  esac
}

P=$(resolve "$1")
shift

if [ "${1:-}" = "--key" ]; then
  herdr pane send-keys "$P" "$2"
else
  # Slash commands open a completion popup in some TUIs; give them more time.
  case "$*" in /*) settle=1.2 ;; *) settle=0.3 ;; esac
  retries=${FM_SEND_RETRIES:-3}
  sleep_s=${FM_SEND_SLEEP:-0.4}
  verdict=$(fm_herdr_submit_core "$P" "$*" "$retries" "$sleep_s" "$settle")
  case "$verdict" in
    pending)
      echo "error: text not submitted to $P (Enter swallowed; text left in composer)" >&2
      exit 1
      ;;
    send-failed)
      echo "error: text not sent to $P (herdr pane run failed)" >&2
      exit 1
      ;;
  esac
fi
