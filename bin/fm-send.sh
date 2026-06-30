#!/usr/bin/env bash
# Send one line of literal text to a crewmate pane, then Enter.
# Usage: fm-send.sh <pane> <text...>
#   <pane> may be a task-id shorthand (fm-<id>) that looks up the pane via
#   this home's state/<id>.meta, a worker label (e.g. fix-login) resolved
#   via herdr agent get, or an explicit herdr pane id (e.g. w8:p3).
# Special keys instead of text: fm-send.sh <pane> --key Escape   (or Enter, ...)
#
# Text submission uses herdr pane run (text+Enter atomically) and verifies
# delivery: if a positively-confirmed swallow is detected (text still in the
# composer after all retries), fm-send exits NON-ZERO. The compose/submit
# logic lives in bin/fm-herdr-lib.sh. Tune with FM_SEND_RETRIES (default 3)
# and FM_SEND_SLEEP (0.4).
#
# Peek-and-defer guard: before submitting, fm-send checks the pane's composer.
# If it holds a human's unsent draft, the message is NOT run (that would clobber
# the draft); it is queued under state/.sendq/<pane>/ and fm-send exits 75
# (deferred). The queue drains FIFO on the next send once the composer is clear,
# so a deferred message is delivered, not lost. The --key path is unguarded:
# special keys (Escape, Enter) are control actions, not text that can clobber.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

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
      pane=$(herdr agent get "$1" 2>/dev/null | herdr_json_get result agent pane_id)
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

  # Peek-and-defer guard. First drain any messages already queued for this pane
  # while the composer is clear, then refuse to clobber a human's unsent draft:
  # if the composer holds one, queue this message (FIFO) and exit 75 (deferred)
  # rather than running text into it. The queue lives under state/.sendq/<pane>/
  # and drains on the next send once the composer is clear again.
  qdir=$(fm_sendq_dir "$STATE" "$P")
  fm_sendq_flush "$qdir" "$P" "$retries" "$sleep_s" >/dev/null || true
  if fm_pane_input_pending "$P"; then
    fm_sendq_enqueue "$qdir" "$*"
    echo "deferred: $P composer holds an unsent draft; queued message (will send when the composer is clear)" >&2
    exit 75
  fi

  verdict=$(fm_herdr_submit_core "$P" "$*" "$retries" "$sleep_s" "$settle")
  case "$verdict" in
    pending)
      echo "error: text not submitted to $P (Enter swallowed; text landed in composer and remains queued; retrying the same send will duplicate it)" >&2
      exit 1
      ;;
    send-failed)
      if fm_pane_input_pending "$P"; then
        echo "error: text not submitted to $P (herdr pane run failed after text landed in composer; retrying the same send will duplicate it)" >&2
      else
        echo "error: text not sent to $P (herdr pane run failed; composer does not show queued text)" >&2
      fi
      exit 1
      ;;
  esac
fi
