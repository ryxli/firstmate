#!/usr/bin/env bash
# fm-lavish-open.sh - the standard way to open (or resume) a Lavish artifact.
#
# This is the render-delegation entry point. Instead of opening a session and
# then holding `lavish-axi poll` on your own thread, you call this: it opens the
# session in the browser, then launches a DETACHED steward worker
# (sbin/fm-lavish-steward.sh) that owns the long-poll and relays the captain's
# feedback back to YOUR pane. Control returns to you immediately, so firstmate's
# supervision thread (or a crewmate's work thread) is never tied up polling.
#
# Usage:
#   fm-lavish-open.sh <html-file> [--relay-pane <pane>] [--no-open]
#       Open/resume <html-file> and start its steward. The relay pane defaults to
#       the CURRENT herdr pane (the agent calling this), so feedback comes back to
#       you. Pass --relay-pane to target another pane, or "-" to record feedback
#       to disk without waking anyone. --no-open skips the browser launch (resume
#       the server/session only).
#   fm-lavish-open.sh --recover
#       Relaunch a steward for every still-open Lavish session this home owns that
#       has no live steward. Run at session start / recovery so a firstmate restart
#       never leaves an open artifact unattended. Recovery only relaunches stewards
#       whose state files this home already recorded.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sbin/fm-lavish-lib.sh
. "$SCRIPT_DIR/fm-lavish-lib.sh"

STATE_DIR=$(fm_lavish_state_dir)
mkdir -p "$STATE_DIR"

# current_pane: print the herdr pane id of the caller, or "-" if it cannot be
# resolved (herdr unavailable / not in a pane).
current_pane() {
  local p
  p=$(herdr pane current 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("pane_id",""))' 2>/dev/null)
  [ -n "$p" ] && printf '%s\n' "$p" || printf '%s\n' "-"
}

# launch_steward <canonical-file> <key> <relay-pane> <url>: start a detached
# steward worker that survives this shell, the calling agent's turn, and the
# firstmate session. macOS has no setsid; nohup + background + disown detaches.
launch_steward() {
  local file=$1 key=$2 relay=$3 url=$4
  nohup "$SCRIPT_DIR/fm-lavish-steward.sh" "$file" "$key" "$relay" "$url" \
    >>"$STATE_DIR/$key.steward.log" 2>&1 &
  disown 2>/dev/null || true
}

if [ "${1:-}" = "--recover" ]; then
  recovered=0
  shopt -s nullglob
  for meta in "$STATE_DIR"/*.steward; do
    key=$(grep '^key=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    file=$(grep '^file=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    relay=$(grep '^relay=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    url=$(grep '^url=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    [ -n "$key" ] && [ -n "$file" ] || continue
    if fm_lavish_steward_alive "$key"; then
      continue # already attended
    fi
    # Stale meta (dead steward). Relaunch only if the session is still open.
    status=$(bunx lavish-axi "$file" --no-open 2>/dev/null \
      | sed -n 's/^[[:space:]]*status:[[:space:]]*//p' | head -1)
    case "$status" in
      ended)
        rm -f "$meta" # session gone; drop the stale record
        ;;
      *)
        # Empty status (unexpected output or server error) is treated the same as
        # a live non-ended status: relaunch the steward and let its bounded-revive
        # determine whether the session is truly dead, rather than silently
        # abandoning a possibly-live session.
        fm_lavish_kill_polls "$file" # reap any orphan poll from the crashed steward
        launch_steward "$file" "$key" "${relay:--}" "$url"
        recovered=$((recovered + 1))
        ;;
    esac
  done
  echo "recovered: $recovered steward(s)"
  exit 0
fi

# Parse open args.
FILE=""
RELAY=""
NO_OPEN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --relay-pane) RELAY=${2:-}; shift 2 ;;
    --no-open) NO_OPEN=1; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) FILE=$1; shift ;;
  esac
done
[ -n "$FILE" ] || { echo "usage: fm-lavish-open.sh <html-file> [--relay-pane <pane>] [--no-open]" >&2; exit 2; }
[ -f "$FILE" ] || { echo "error: no such file: $FILE" >&2; exit 1; }

CANON=$(fm_lavish_canonical "$FILE")
KEY=$(fm_lavish_key "$CANON") || { echo "error: cannot derive session key (need shasum/sha256sum)" >&2; exit 1; }
[ -n "$RELAY" ] || RELAY=$(current_pane)

# Open/resume the session via the official CLI (also guarantees the server is up).
if [ "$NO_OPEN" -eq 1 ]; then
  OPEN_OUT=$(bunx lavish-axi "$CANON" --no-open 2>&1)
else
  OPEN_OUT=$(bunx lavish-axi "$CANON" 2>&1)
fi
OPEN_RC=$?
if [ "$OPEN_RC" -ne 0 ]; then
  echo "error: lavish-axi failed to open the session" >&2
  printf '%s\n' "$OPEN_OUT" >&2
  exit 1
fi
URL=$(printf '%s\n' "$OPEN_OUT" | sed -n 's/^[[:space:]]*url:[[:space:]]*//p' | head -1 | tr -d '"')

# Idempotent: only one steward per session.
if fm_lavish_steward_alive "$KEY"; then
  echo "steward already running for this session (key=$KEY)"
else
  fm_lavish_kill_polls "$CANON" # reap any orphan poll from a prior crashed steward
  launch_steward "$CANON" "$KEY" "$RELAY" "$URL"
  echo "steward launched (key=$KEY, relay=$RELAY)"
fi

echo "opened: $URL"
echo "Feedback will be relayed to pane $RELAY; this thread is free. Do NOT run 'lavish-axi poll' yourself."
