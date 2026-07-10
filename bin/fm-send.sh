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
# delivery. If text is still stuck in the composer after retries, fm-send writes
# a durable sendq item and starts a background drain loop; the drain retries on a
# timer and appends state/sendq.status if the item is still pending after
# FM_SENDQ_ALERT_SECS (default 300). Tune direct retries with FM_SEND_RETRIES
# (default 3) and FM_SEND_SLEEP (0.4).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

fm_sendq_enqueue() {
  local state=$1 target=$2 pane=$3 text=$4 dir id tmp out
  dir="$state/sendq"
  mkdir -p "$dir"
  id="$(date +%s)-$$-$RANDOM"
  tmp="$dir/$id.tmp"
  out="$dir/$id.json"
  SENDQ_ID="$id" SENDQ_CREATED_AT="$(date +%s)" SENDQ_TARGET="$target" SENDQ_PANE="$pane" SENDQ_TEXT="$text" \
    python3 -c 'import json, os, sys; json.dump({"id": os.environ["SENDQ_ID"], "created_at": int(os.environ["SENDQ_CREATED_AT"]), "target": os.environ["SENDQ_TARGET"], "pane": os.environ["SENDQ_PANE"], "text": os.environ["SENDQ_TEXT"]}, sys.stdout); print()' > "$tmp"
  mv "$tmp" "$out"
  printf '%s\n' "$id"
}

fm_sendq_start_background() {
  [ "${FM_SENDQ_NO_BACKGROUND:-0}" = "1" ] && return 0
  FM_HOME="$FM_HOME" FM_STATE_OVERRIDE="$STATE" "$SCRIPT_DIR/fm-sendq-drain.sh" >/dev/null 2>&1 &
}

_target="$1"
P=$(fm_resolve_live_pane "$1" "$STATE")
shift

# Parse --steer: steering messages bypass the dispatch gate.
_steer=0
[ "${1:-}" = "--steer" ] && { _steer=1; shift; }
_steer_text="${*}"

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
  text="$*"
  verdict=$(fm_herdr_submit_core "$P" "$text" "$retries" "$sleep_s" "$settle")
  case "$verdict" in
    pending)
      qid=$(fm_sendq_enqueue "$STATE" "$_target" "$P" "$text")
      fm_sendq_start_background
      echo "queued: text not submitted to $P; sendq item $qid will retry in background" >&2
      ;;
    send-failed)
      echo "error: text not sent to $P (herdr pane run failed)" >&2
      exit 1
      ;;
  esac
fi

# Capture steer events: log to the events journal when a steering message was sent.
if [ "$_steer" = "1" ] && [ "${1:-}" != "--key" ] && [ -n "${_steer_text:-}" ]; then
  "${SCRIPT_DIR}/fm-capture.sh" steer "$_target" "$_steer_text" "" 2>/dev/null || true
fi
