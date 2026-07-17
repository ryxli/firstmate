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
#   fm-lavish-open.sh --check <session-key>
#       Single-session health check: alive is silent; a dead steward is revived
#       (or its ended session retired) and reported with the last recorded exit
#       reason. This is what makes a mid-session steward crash self-heal and
#       surface WITHOUT waiting for a firstmate restart: every open/recover/check
#       arms a companion state/lavish-<key>.check.sh (plus a gate-only
#       state/lavish-<key>.meta, no pane=) that the existing in-process
#       supervisor's *.check.sh timer already polls every FM_CHECK_INTERVAL
#       (default 300s); non-empty output from a check is a captain-relevant wake
#       by the supervisor's own contract, so a steward that died between
#       restarts is caught and reported on its own, not just at the next
#       recovery. No new daemon is added - this rides the existing check.sh
#       timer and --recover machinery.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sbin/fm-lavish-lib.sh
. "$SCRIPT_DIR/fm-lavish-lib.sh"

STATE_DIR=$(fm_lavish_state_dir)
mkdir -p "$STATE_DIR"
TOP_STATE_DIR=$(dirname "$STATE_DIR")
mkdir -p "$TOP_STATE_DIR"

# current_pane: print the herdr pane id of the caller, or "-" if it cannot be
# resolved (herdr unavailable / not in a pane).
current_pane() {
  local p
  p=$(herdr pane current 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("pane_id",""))' 2>/dev/null)
  [ -n "$p" ] && printf '%s\n' "$p" || printf '%s\n' "-"
}

# shell_quote <string>: single-quote a value for safe embedding in a generated
# script (mirrors the same helper in sbin/fm-pr-check.sh).
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

# arm_check <key> <file>: (re)write the companion health-check pair the
# in-process supervisor's *.check.sh timer already polls every
# FM_CHECK_INTERVAL: state/lavish-<key>.meta (existence-only gate, no pane= so
# it is never treated as a crewmate/fleet entry) and state/lavish-<key>.check.sh
# (invokes this script's --check mode, with this process's FM_HOME /
# FM_STATE_OVERRIDE / FM_ROOT_OVERRIDE pinned so it behaves the same regardless
# of the timer's own environment). This is what lets a mid-session steward
# crash be caught and revived on its own, not just at the next firstmate
# restart.
arm_check() {
  local key=$1 file=$2
  {
    printf 'lavish_key=%s\n' "$key"
    printf 'file=%s\n' "$file"
  } > "$TOP_STATE_DIR/lavish-$key.meta"
  {
    [ -n "${FM_HOME:-}" ] && printf 'export FM_HOME=%s\n' "$(shell_quote "$FM_HOME")"
    [ -n "${FM_STATE_OVERRIDE:-}" ] && printf 'export FM_STATE_OVERRIDE=%s\n' "$(shell_quote "$FM_STATE_OVERRIDE")"
    [ -n "${FM_ROOT_OVERRIDE:-}" ] && printf 'export FM_ROOT_OVERRIDE=%s\n' "$(shell_quote "$FM_ROOT_OVERRIDE")"
    printf '%s --check %s\n' "$(shell_quote "$SCRIPT_DIR/fm-lavish-open.sh")" "$(shell_quote "$key")"
  } > "$TOP_STATE_DIR/lavish-$key.check.sh"
}

# disarm_check <key>: drop the health-check pair once nothing is left to
# watch (the session ended, or its steward record was corrupt beyond use).
disarm_check() {
  local key=$1
  rm -f "$TOP_STATE_DIR/lavish-$key.check.sh" "$TOP_STATE_DIR/lavish-$key.meta"
}

# launch_steward <canonical-file> <key> <relay-pane> <url>: start a detached
# steward worker that survives this shell, the calling agent's turn, and the
# firstmate session. macOS has no setsid; nohup + background + disown detaches.
# Also (re)arms the health check so this launch is itself supervised.
launch_steward() {
  local file=$1 key=$2 relay=$3 url=$4
  arm_check "$key" "$file"
  nohup "$SCRIPT_DIR/fm-lavish-steward.sh" "$file" "$key" "$relay" "$url" \
    >>"$STATE_DIR/$key.steward.log" 2>&1 &
  disown 2>/dev/null || true
}

# process_steward_meta <meta-file>: ensure exactly one live steward owns the
# session named by this <key>.steward file (the key is the filename itself -
# fm-lavish-steward.sh names META that way, so it is authoritative even if the
# file's own key= line were ever missing or stale). Prints multi-line output,
# line 1 a status word, consumed by both --recover (bulk, mostly silent) and
# --check (single session, reports revived/ended/server-down loudly):
#   alive        - a live steward already owns it; nothing to do
#   corrupt      - meta had no file=; dropped (line 2: key)
#   ended        - session already ended server-side (line 2: file, 3: last
#                  exit reason) - meta + check retired
#   revived      - steward was dead; relaunched (line 2: file, 3: last exit
#                  reason)
#   server-down  - the Lavish server itself is unreachable; relaunched anyway
#                  (the steward owns its own bounded backoff/give-up against
#                  the server) but reported distinctly so the outage itself is
#                  named (line 2: file, 3: last exit reason)
process_steward_meta() {
  local meta=$1 key file relay url reason
  key=$(basename "$meta" .steward)
  file=$(grep '^file=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  relay=$(grep '^relay=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  url=$(grep '^url=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ -z "$file" ]; then
    rm -f "$meta"
    disarm_check "$key"
    printf 'corrupt\n%s\n' "$key"
    return 0
  fi
  if fm_lavish_steward_alive "$key"; then
    printf 'alive\n'
    return 0
  fi
  reason=$(fm_lavish_last_exit_reason "$key")
  if ! fm_lavish_server_up; then
    # The server itself is unreachable. Relaunch anyway - the steward's own
    # bounded backoff/give-up governs retries against the server - but report
    # this distinctly so a wake names the real cause (an outage) instead of a
    # generic "restarted", satisfying "surface the outage" rather than a
    # silent/opaque retry.
    fm_lavish_kill_polls "$file"
    launch_steward "$file" "$key" "${relay:--}" "$url"
    printf 'server-down\n%s\n%s\n' "$file" "$reason"
    return 0
  fi
  status=$(bunx lavish-axi "$file" --no-open 2>/dev/null \
    | sed -n 's/^[[:space:]]*status:[[:space:]]*//p' | head -1)
  case "$status" in
    ended)
      rm -f "$meta" # session gone; drop the stale record
      disarm_check "$key"
      printf 'ended\n%s\n%s\n' "$file" "$reason"
      ;;
    *)
      # Empty status (unexpected output) is treated the same as a live
      # non-ended status: relaunch the steward and let its bounded-revive
      # determine whether the session is truly dead, rather than silently
      # abandoning a possibly-live session.
      fm_lavish_kill_polls "$file" # reap any orphan poll from the crashed steward
      launch_steward "$file" "$key" "${relay:--}" "$url"
      printf 'revived\n%s\n%s\n' "$file" "$reason"
      ;;
  esac
}

if [ "${1:-}" = "--recover" ]; then
  recovered=0
  shopt -s nullglob
  for meta in "$STATE_DIR"/*.steward; do
    result=$(process_steward_meta "$meta")
    word=$(printf '%s\n' "$result" | sed -n '1p')
    case "$word" in
      revived|server-down) recovered=$((recovered + 1)) ;;
    esac
  done
  echo "recovered: $recovered steward(s)"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  KEY=${2:-}
  [ -n "$KEY" ] || { echo "usage: fm-lavish-open.sh --check <session-key>" >&2; exit 2; }
  META_FILE="$STATE_DIR/$KEY.steward"
  if [ ! -f "$META_FILE" ]; then
    # The steward already retired itself gracefully (session-ended/signaled);
    # nothing left to watch, so stop polling this key. Silent: expected path.
    disarm_check "$KEY"
    exit 0
  fi
  RESULT=$(process_steward_meta "$META_FILE")
  WORD=$(printf '%s\n' "$RESULT" | sed -n '1p')
  case "$WORD" in
    alive) : ;; # healthy; stay silent per the check.sh contract
    corrupt)
      echo "lavish steward record for key $KEY was corrupt (missing file=); dropped"
      ;;
    ended)
      F=$(printf '%s\n' "$RESULT" | sed -n '2p')
      R=$(printf '%s\n' "$RESULT" | sed -n '3p')
      echo "lavish steward for $F had died (last exit: $R) and its session had already ended - feedback sent while it was down may have been missed"
      ;;
    revived)
      F=$(printf '%s\n' "$RESULT" | sed -n '2p')
      R=$(printf '%s\n' "$RESULT" | sed -n '3p')
      echo "lavish steward for $F was down (last exit: $R); restarted automatically (key=$KEY)"
      ;;
    server-down)
      F=$(printf '%s\n' "$RESULT" | sed -n '2p')
      R=$(printf '%s\n' "$RESULT" | sed -n '3p')
      echo "lavish server unreachable at $(fm_lavish_base_url) for $F (steward last exit: $R); relaunched, will keep retrying with backoff"
      ;;
  esac
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
  arm_check "$KEY" "$CANON" # re-arm in case a prior check pair was lost/stale
  echo "steward already running for this session (key=$KEY)"
else
  fm_lavish_kill_polls "$CANON" # reap any orphan poll from a prior crashed steward
  launch_steward "$CANON" "$KEY" "$RELAY" "$URL"
  echo "steward launched (key=$KEY, relay=$RELAY)"
fi

echo "opened: $URL"
echo "Feedback will be relayed to pane $RELAY; this thread is free. Do NOT run 'lavish-axi poll' yourself."
