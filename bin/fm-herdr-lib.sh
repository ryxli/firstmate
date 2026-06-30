#!/usr/bin/env bash
# fm-herdr-lib.sh - shared herdr pane primitives for firstmate.
#
# Replaces fm-tmux-lib.sh. All functions operate on herdr pane IDs
# (e.g. "w8:p3") rather than tmux targets. Sourced by fm-send.sh so compose/submit
# logic stays in one place (the supervisor extension reimplements it in TS).
#
# herdr tracks agent status natively (idle|working|blocked|done|unknown),
# so the ANSI ghost-text stripping and pane-hash busy detection from the
# tmux era are gone. The guarantees this lib provides instead:
#
#   1. fm_pane_is_busy: reads herdr agent status; returns 0 when "working".
#   2. fm_pane_input_pending: reads visible pane content to detect a
#      half-typed human line in the composer; same semantics as before but
#      simpler implementation (no ANSI parsing, no SGR stripping).
#   3. fm_herdr_submit_core: sends text+Enter via "herdr pane run" and
#      verifies the agent received it by waiting briefly for a working->idle
#      transition or a clean idle state; returns a verdict string the caller
#      can act on.
#   4. fm_sendq_* (dir/count/enqueue/flush): a per-pane on-disk send queue so a
#      message is never run into a composer that holds a human's unsent draft.
#      A blocked send is queued (FIFO) instead of clobbering the draft, and the
#      queue drains on the next send once the composer is clear again.
#
# All functions are set -u and set -e safe.

# herdr_json_get <key> [<key>...]: read a herdr JSON response on stdin, walk the
# nested keys, and print the leaf value (or nothing on any parse error / missing
# key). This is the canonical accessor for herdr's one-shot JSON responses -
# prefer it over grep/sed on the raw JSON, which silently assumes one object per
# line and breaks on multi-object payloads (e.g. `workspace list`).
#
# Exception: fm_herdr_agent_status below stays on grep deliberately. It is the
# hot-path submit-verification poll (called per agent), where a python3 startup
# per call would be a real cost; a single-field grep is correct and ~30x cheaper
# there.
herdr_json_get() {
  python3 -c '
import sys, json
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1:]:
        v = v[k]
    print(v)
except Exception:
    pass
' "$@" 2>/dev/null || true
}

# fm_herdr_agent_status: print the current herdr agent status for a pane id.
# Outputs one of: idle working blocked done unknown
fm_herdr_agent_status() {
  local pane=$1
  herdr agent get "$pane" 2>/dev/null \
    | grep -o '"agent_status":"[^"]*"' | head -1 \
    | sed 's/.*"agent_status":"\([^"]*\)".*/\1/' \
    || printf 'unknown'
}

# fm_pane_is_busy: 0 if the agent is currently working (agent mid-turn).
fm_pane_is_busy() {
  local status
  status=$(fm_herdr_agent_status "$1")
  [ "$status" = "working" ]
}

# fm_pane_input_pending: 0 (pending) if the pane's visible last line looks
# like real unsubmitted text a human typed. An idle composer, a bare prompt
# glyph, or a busy footer is NOT pending. With herdr we read the raw visible
# text; no ANSI SGR stripping needed because herdr pane read returns plain
# text by default.
fm_pane_input_pending() {
  local pane=$1 line stripped
  # If the agent is mid-turn, the visible last line is agent output, never
  # unsubmitted human text. Defer to the busy check so a working pane is
  # never misread as holding pending input.
  fm_pane_is_busy "$pane" && return 1
  line=$(herdr pane read "$pane" --lines 3 --source visible 2>/dev/null \
    | grep -v '^[[:space:]]*$' | tail -1 || true)
  [ -n "$line" ] || return 1
  # Strip composer box-drawing chrome. Real composers are full boxes whose
  # last visible line is the bottom border (a horizontal rule capped by corners),
  # so stripping only the light/heavy verticals leaves a border-only line that
  # reads as pending input. Strip the verticals, horizontals, and corners so a
  # border-only line collapses to whitespace and is treated as an empty composer.
  stripped=${line//│/}; stripped=${stripped//┃/}; stripped=${stripped//|/}
  stripped=${stripped//─/}; stripped=${stripped//━/}
  stripped=${stripped//╭/}; stripped=${stripped//╮/}
  stripped=${stripped//╰/}; stripped=${stripped//╯/}
  stripped=${stripped//┌/}; stripped=${stripped//┐/}
  stripped=${stripped//└/}; stripped=${stripped//┘/}
  stripped="${stripped#"${stripped%%[![:space:]]*}"}"
  stripped="${stripped%"${stripped##*[![:space:]]}"}"
  [ -n "$stripped" ] || return 1
  # Bare prompt glyph = empty composer.
  case "$stripped" in '>'|'❯'|'$'|'%'|'#') return 1 ;; esac
  # Custom idle-compositor override (after border stripping), e.g. for custom prompt patterns.
  if [ -n "${FM_COMPOSER_IDLE_RE:-}" ]; then
    if printf '%s' "$stripped" | grep -qE "$FM_COMPOSER_IDLE_RE"; then
      return 1
    fi
  fi
  # A busy footer on the cursor line is not pending input.
  if printf '%s' "$stripped" | grep -qiE "${FM_BUSY_REGEX:-esc (to )?interrupt|Working\.\.\.}"; then
    return 1
  fi
  return 0
}

last_status_line() {
  local f=$1
  [ -e "$f" ] || return 0
  grep -v '^[[:space:]]*$' "$f" 2>/dev/null | tail -n1
}

# fm_herdr_submit_core: submit <text> to <pane> and verify delivery, retrying
# the submission when it cannot be confirmed. Returns a verdict string:
#   empty       - delivered (agent accepted the message)
#   pending     - could not confirm delivery after <retries> attempts
#   send-failed - the herdr command itself failed
#
# Delivery is confirmed by the agent transitioning to working/done. After each
# attempt, while the agent is still idle:
#   - composer holds our text (Enter swallowed): re-send Enter only.
#   - composer is empty: do NOT re-send the whole text, because a fast-turn
#     agent may have already accepted it and finished before herdr reported
#     a working transition.
# This biases toward avoiding duplicate messages. Slash commands open a
# completion popup; <settle> lets it close before we judge the result.
fm_herdr_submit_core() {
  local pane=$1 text=$2 retries=${3:-3} sleep_s=${4:-0.4} settle=${5:-0.3}
  local status i=0
  herdr pane run "$pane" "$text" 2>/dev/null || { printf 'send-failed'; return 0; }
  while :; do
    sleep "$settle"
    status=$(fm_herdr_agent_status "$pane")
    case "$status" in working|done) printf 'empty'; return 0 ;; esac
    if [ "$status" = idle ] && ! fm_pane_input_pending "$pane"; then
      # Fast-turn agents can accept and finish before herdr ever reports
      # a working transition. A clear idle composer means the message is
      # gone, so treat it as delivered instead of re-sending duplicates.
      printf 'empty'
      return 0
    fi
    i=$((i + 1))
    [ "$i" -lt "$retries" ] || break
    if fm_pane_input_pending "$pane"; then
      # Text landed but was not submitted: re-send Enter only.
      herdr pane send-keys "$pane" enter 2>/dev/null || true
    fi
    sleep "$sleep_s"
  done
  # Final arbitration: an idle agent with a clear composer is treated as
  # delivered (a fast turn that already completed); a non-empty composer means
  # the text is still stuck unsubmitted.
  [ "$status" = idle ] && ! fm_pane_input_pending "$pane" && { printf 'empty'; return 0; }
  printf 'pending'
}

# --- Composer-safe send queue ------------------------------------------------
#
# These four functions back fm-send.sh's peek-and-defer guard: never run text
# into a pane whose composer holds a human's unsent draft. A blocked send is
# appended to a per-pane on-disk queue (FIFO) instead of clobbering the draft,
# and the queue drains on the next send once the composer is clear again.

# fm_sendq_dir <queue-root> <pane>: print the queue directory for a pane id.
# The pane id (e.g. "w8:p3") is sanitized to a filesystem-safe name so the
# colon never breaks the path.
fm_sendq_dir() {
  local root=$1 pane=$2 safe
  safe=$(printf '%s' "$pane" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/.sendq/%s' "$root" "$safe"
}

# fm_sendq_count <queue-dir>: print the number of queued messages (0 if none).
fm_sendq_count() {
  local dir=$1 n=0 f
  if [ -d "$dir" ]; then
    for f in "$dir"/*.msg; do
      [ -e "$f" ] || continue
      n=$((n + 1))
    done
  fi
  printf '%s' "$n"
}

# fm_sendq_enqueue <queue-dir> <text>: append <text> as the next FIFO message.
# Idempotent against an immediate retry: if the newest queued message already
# holds identical text, nothing is added (so re-running a deferred send while
# the draft persists never duplicates the message).
fm_sendq_enqueue() {
  local dir=$1 text=$2 last seq=1 f base n
  mkdir -p "$dir"
  last=""
  for f in "$dir"/*.msg; do
    [ -e "$f" ] || continue
    base=${f##*/}; base=${base%.msg}
    n=$((10#$base))
    if [ "$n" -ge "$seq" ]; then seq=$((n + 1)); fi
    last=$f
  done
  if [ -n "$last" ] && [ "$(cat "$last")" = "$text" ]; then
    return 0
  fi
  printf '%s' "$text" > "$dir/$(printf '%012d' "$seq").msg"
}

# fm_sendq_flush <queue-dir> <pane> <retries> <sleep_s>: deliver queued messages
# in FIFO order while the composer stays clear, removing each file as it lands.
# Stops at the first message that cannot be delivered (the composer now holds a
# draft, or the send could not be confirmed) so queued order is preserved and a
# human draft is never clobbered. Prints the number delivered; returns 0 only
# when the queue is fully drained.
fm_sendq_flush() {
  local dir=$1 pane=$2 retries=${3:-3} sleep_s=${4:-0.4}
  local f text settle verdict delivered=0 remaining=0
  if [ ! -d "$dir" ]; then printf '0'; return 0; fi
  for f in "$dir"/*.msg; do
    [ -e "$f" ] || continue
    if [ "$remaining" -gt 0 ]; then
      remaining=$((remaining + 1)); continue
    fi
    if fm_pane_input_pending "$pane"; then
      remaining=$((remaining + 1)); continue
    fi
    text=$(cat "$f")
    case "$text" in /*) settle=1.2 ;; *) settle=0.3 ;; esac
    verdict=$(fm_herdr_submit_core "$pane" "$text" "$retries" "$sleep_s" "$settle")
    if [ "$verdict" = empty ]; then
      rm -f "$f"; delivered=$((delivered + 1))
    else
      remaining=$((remaining + 1))
    fi
  done
  printf '%s' "$delivered"
  [ "$remaining" -eq 0 ]
}
