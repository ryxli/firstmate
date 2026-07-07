#!/usr/bin/env bash
# Send one line of literal text to a crewmate pane, then Enter.
# Usage: fm-send.sh <pane> [--steer] <text...>
#   <pane> may be a bare firstmate pane name (fm-xyz), resolved through
#   this home's state/<id>.meta, or an explicit herdr pane id (e.g. w8:p3).
# --steer marks the message as steering/correction; it bypasses the dispatch
#   gate (freeze and focus locks) while still verifying delivery.
# Special keys instead of text: fm-send.sh <pane> [--steer] --key Escape
#
# Dispatch gate: new work is refused when state/.dispatch-freeze exists or
# state/.focus-<id> exists for the target mate. Bypass with --steer or
# FM_DISPATCH_OVERRIDE=1.
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

_target="$1"
P=$(fm_resolve_live_pane "$1" "$STATE")
shift

# Parse --steer: steering messages bypass the dispatch gate.
_steer=0
[ "${1:-}" = "--steer" ] && { _steer=1; shift; }

# Dispatch gate: block new work during a freeze or focus lock.
# Bypass with FM_DISPATCH_OVERRIDE=1 or --steer.
if [ "${FM_DISPATCH_OVERRIDE:-0}" != "1" ] && [ "$_steer" = "0" ]; then
  _freeze="$STATE/.dispatch-freeze"
  if [ -f "$_freeze" ]; then
    echo "error: dispatch frozen (use FM_DISPATCH_OVERRIDE=1 or --steer to bypass): $_freeze" >&2
    exit 1
  fi
  case "$_target" in
    fm-*)
      _lock="$STATE/.focus-${_target#fm-}"
      if [ -f "$_lock" ]; then
        _reason=$(head -n1 "$_lock" 2>/dev/null || true)
        echo "error: ${_target} is focus-locked${_reason:+: $_reason} (use FM_DISPATCH_OVERRIDE=1 or --steer to bypass)" >&2
        exit 1
      fi
      ;;
  esac
fi

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
