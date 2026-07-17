#!/usr/bin/env bash
# fm-lavish-steward.sh - the dedicated Lavish poll worker.
#
# ONE steward process owns the long-poll for ONE Lavish session. It holds
# `bunx lavish-axi poll <file>` (the official, stable long-poll), and every time
# the captain sends feedback it:
#   1. appends the feedback to state/lavish/<key>.feedback.md (durable record),
#   2. wakes the ORIGINATING agent's pane via sbin/fm-send.sh with a one-line
#      pointer to that file plus the reply command,
# then loops back into the poll. It exits when the session ends (the captain
# closes it) or when it is told to stop. Because the steward is a separate
# process from the agent that opened the artifact, the agent's own thread is
# NEVER tied up polling Lavish - it just gets woken when there is feedback.
#
# Detection/diagnosability: every exit (graceful or not) appends a reason to
# state/lavish/<key>.laststate, which is never deleted. Its own meta file
# (<key>.steward) is only self-removed on a reason that means nothing is left
# to watch (session-ended, signaled); a give-up after the server stayed
# unreachable leaves the meta behind (dead pid) on purpose so
# fm-lavish-open.sh --recover / --check can find it and revive the session or
# confirm it truly ended, instead of the steward silently erasing its own
# evidence.
#
# Usage (normally launched detached by sbin/fm-lavish-open.sh, not by hand):
#   fm-lavish-steward.sh <canonical-file> <session-key> <relay-pane> [<session-url>]
#     <canonical-file> realpath of the artifact (the lavish session key source)
#     <session-key>    16-hex key (fm_lavish_key); names the state files
#     <relay-pane>     herdr pane id of the agent that opened the artifact, OR
#                      "-" to relay nowhere (feedback still recorded to disk)
#     <session-url>    optional browser URL, recorded for context
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sbin/fm-lavish-lib.sh
. "$SCRIPT_DIR/fm-lavish-lib.sh"

FILE=${1:-}
KEY=${2:-}
RELAY=${3:-}
URL=${4:-}
if [ -z "$FILE" ] || [ -z "$KEY" ] || [ -z "$RELAY" ]; then
  echo "usage: fm-lavish-steward.sh <canonical-file> <session-key> <relay-pane> [<session-url>]" >&2
  exit 2
fi

STATE_DIR=$(fm_lavish_state_dir)
mkdir -p "$STATE_DIR"
META="$STATE_DIR/$KEY.steward"
FEEDBACK="$STATE_DIR/$KEY.feedback.md"
LOG="$STATE_DIR/$KEY.steward.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }

# Record steward metadata (pid, file, relay target) so open can be idempotent
# and recovery can detect a dead steward.
{
  printf 'pid=%s\n' "$$"
  printf 'file=%s\n' "$FILE"
  printf 'key=%s\n' "$KEY"
  printf 'relay=%s\n' "$RELAY"
  printf 'url=%s\n' "$URL"
  printf 'started=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S')"
} > "$META"

POLL_OUT="$STATE_DIR/$KEY.poll.out"
LASTSTATE="$STATE_DIR/$KEY.laststate"
POLL_PID=""
# EXIT_REASON names why the loop below stops; cleanup() uses it to decide
# whether META may be removed. Set it right before every break/exit path.
EXIT_REASON="unknown"

# record_laststate: append a durable forensic line that outlives META itself.
# This is the diagnosable trace a health check (fm-lavish-open.sh --check)
# reads to explain why a steward is no longer running - the fix for the
# silent-drop bug was precisely that this information used to vanish with
# META on every exit, crash or not.
record_laststate() {
  printf 'exited=%s pid=%s reason=%s file=%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S')" "$$" "$EXIT_REASON" "$FILE" >> "$LASTSTATE"
}

cleanup() {
  [ -n "$POLL_PID" ] && kill "$POLL_PID" 2>/dev/null
  log "steward stopping (pid $$, reason=$EXIT_REASON)"
  record_laststate
  rm -f "$POLL_OUT"
  # Only remove META on a reason that means nothing is left to watch: the
  # captain closed the session (session-ended) or we were deliberately told to
  # stop (signaled, e.g. by teardown). Any other reason - above all giving up
  # after the server stayed unreachable - MUST leave META behind (its pid now
  # dead) so --recover / the per-session health check can find it and either
  # revive the steward or confirm the session truly ended. Unconditionally
  # deleting META here was the silent-drop bug: a permanently-down server used
  # to erase its own evidence, so nothing downstream ever knew to look again.
  case "$EXIT_REASON" in
    session-ended|signaled) rm -f "$META" ;;
  esac
}
running=1
# On TERM/INT, stop looping AND kill the in-flight poll child so it cannot
# consume (and then drop) a feedback event after we have decided to exit.
on_signal() {
  running=0
  EXIT_REASON="signaled"
  [ -n "$POLL_PID" ] && kill "$POLL_PID" 2>/dev/null
}
trap cleanup EXIT
trap on_signal TERM INT

log "steward started pid=$$ file=$FILE relay=$RELAY url=$URL"

# wake_agent <prompt-count>: nudge the originating agent's pane with a one-line
# pointer to the recorded feedback and the reply command. Best-effort: feedback
# is already on disk, so a failed send is logged but never fatal.
wake_agent() {
  local n=$1 msg
  [ "$RELAY" != "-" ] || { log "relay disabled; feedback recorded only"; return 0; }
  msg="Lavish feedback ($n item(s)) on $FILE - read $FEEDBACK, apply the changes, then acknowledge in-browser with: $SCRIPT_DIR/fm-lavish-reply.sh \"$FILE\" \"<message>\" (do NOT run 'lavish-axi poll' yourself - the steward owns it)"
  if "$SCRIPT_DIR/fm-send.sh" "$RELAY" "$msg" >>"$LOG" 2>&1; then
    log "relayed feedback to pane $RELAY ($n items)"
  else
    log "WARN relay to pane $RELAY failed (feedback is recorded at $FEEDBACK)"
  fi
}

# extract_prompt_count <toon>: read the N from a `prompts[N]{...}:` header line.
extract_prompt_count() {
  printf '%s\n' "$1" | sed -n 's/^prompts\[\([0-9]*\)\].*/\1/p' | head -1
}

# FM_LAVISH_FAIL_MAX: give up after this many consecutive poll failures so a
# permanently dead server never leaves a steward spinning. FM_LAVISH_BACKOFF_CAP
# caps the exponential backoff. Both are env-tunable (and let tests run fast).
backoff=${FM_LAVISH_BACKOFF_START:-2}
fails=0
FAIL_MAX=${FM_LAVISH_FAIL_MAX:-8}
BACKOFF_CAP=${FM_LAVISH_BACKOFF_CAP:-30}
while [ "$running" -eq 1 ]; do
  # Run the poll as a tracked background child so on_signal can kill it; `wait`
  # is interruptible by the trap, unlike a foreground command substitution.
  : > "$POLL_OUT"
  bunx lavish-axi poll "$FILE" >"$POLL_OUT" 2>>"$LOG" &
  POLL_PID=$!
  wait "$POLL_PID"
  rc=$?
  POLL_PID=""
  out=$(cat "$POLL_OUT" 2>/dev/null)
  [ "$running" -eq 1 ] || break

  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    # A non-zero/empty return is an error (e.g. server down), not feedback.
    # Revive the server/session headlessly; if the revive reports the session is
    # ended (or gone), stop - the captain closed it. Otherwise back off and retry,
    # giving up after FAIL_MAX consecutive failures so a permanently dead server
    # never leaves a steward spinning forever.
    fails=$((fails + 1))
    revive=$(bunx lavish-axi "$FILE" --no-open 2>>"$LOG")
    case "$revive" in
      *"status: ended"*)
        log "revive reports session ended; steward exiting"
        EXIT_REASON="session-ended"
        break
        ;;
    esac
    if [ "$fails" -ge "$FAIL_MAX" ]; then
      log "poll failed $fails times consecutively (server unreachable); steward giving up"
      EXIT_REASON="server-unreachable-giveup"
      break
    fi
    log "poll rc=$rc empty=$([ -z "$out" ] && echo yes || echo no); revive+backoff ${backoff}s (fail $fails/$FAIL_MAX)"
    sleep "$backoff"
    [ "$backoff" -lt "$BACKOFF_CAP" ] && backoff=$((backoff * 2))
    continue
  fi
  backoff=${FM_LAVISH_BACKOFF_START:-2}
  fails=0

  case "$out" in
    *"status: ended"*)
      log "session ended; steward exiting"
      EXIT_REASON="session-ended"
      break
      ;;
    *"status: feedback"*)
      n=$(extract_prompt_count "$out")
      [ -n "$n" ] || n="?"
      # Drop the upstream `next_step:` block: it instructs the reader to run
      # `lavish-axi poll --agent-reply` itself and "never kill it" - exactly the
      # self-poll this steward exists to avoid. We replace it with the reply path
      # that routes through the write-only endpoint and never blocks the agent.
      body=$(printf '%s\n' "$out" | sed '/^next_step:/,$d')
      fence='```'
      {
        printf '\n## Feedback %s (%s item(s))\n\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$n"
        printf '%s\n%s\n%s\n' "$fence" "$body" "$fence"
        printf '\nApply the requested changes to %s, then acknowledge in-browser:\n' "$FILE"
        printf '    %s/fm-lavish-reply.sh "%s" "<message for the captain>"\n' "$SCRIPT_DIR" "$FILE"
        printf "Do NOT run 'lavish-axi poll' yourself - the steward owns the poll and will relay the next round here.\n"
      } >> "$FEEDBACK"
      log "feedback received ($n items); appended to $FEEDBACK"
      wake_agent "$n"
      ;;
    *)
      # status: waiting or an unrecognized shape (we never pass --timeout-ms, so
      # waiting should not occur). Treat as a transient and re-poll without spin.
      log "unrecognized poll result; re-polling"
      sleep 1
      ;;
  esac
done
