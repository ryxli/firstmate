#!/usr/bin/env bash
# fm-herdr-lib.sh — shared herdr pane primitives for firstmate.
#
# Replaces fm-tmux-lib.sh. All functions operate on herdr pane IDs
# (e.g. "w8:p3") rather than tmux targets. Sourced by fm-send.sh and
# fm-supervise-daemon.sh so compose/submit logic stays in one place.
#
# herdr tracks agent status natively (idle|working|blocked|done|unknown),
# so the ANSI ghost-text stripping and pane-hash busy detection from the
# tmux era are gone. The three guarantees this lib provides instead:
#
#   1. fm_pane_is_busy: reads herdr agent status; returns 0 when "working".
#   2. fm_pane_input_pending: reads visible pane content to detect a
#      half-typed human line in the composer; same semantics as before but
#      simpler implementation (no ANSI parsing, no SGR stripping).
#   3. fm_herdr_submit_core: sends text+Enter via "herdr pane run" and
#      verifies the agent received it by waiting briefly for a working→idle
#      transition or a clean idle state; returns a verdict string the caller
#      can act on.
#
# All functions are set -u and set -e safe.

# herdr_json_get <key> [<key>...]: read a herdr JSON response on stdin, walk the
# nested keys, and print the leaf value (or nothing on any parse error / missing
# key). This is the canonical accessor for herdr's one-shot JSON responses -
# prefer it over grep/sed on the raw JSON, which silently assumes one object per
# line and breaks on multi-object payloads (e.g. `workspace list`).
#
# Exception: fm_herdr_agent_status below stays on grep deliberately. It is the
# hot-path supervision poll (called per agent, every watcher cycle), where a
# python3 startup per call would be a real cost; a single-field grep is correct
# and ~30x cheaper there.
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
  # last visible line is the bottom border (e.g. omp/opus draw "╰── … ──╯"),
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

# fm_herdr_submit_core: submit <text> to <pane> and verify delivery, retrying
# the submission when it cannot be confirmed. Returns a verdict string:
#   empty       - delivered (agent accepted the message)
#   pending     - could not confirm delivery after <retries> attempts
#   send-failed - the herdr command itself failed
#
# Delivery is confirmed by the agent transitioning to working/done. After each
# attempt, while the agent is still idle:
#   - composer holds our text (Enter swallowed): re-send Enter only.
#   - composer is empty (submission never landed): re-issue "herdr pane run".
# Confirming via the working/done transition keeps delivery idempotent: once the
# agent reacts we stop, so a swallowed first attempt still yields exactly one
# landed submission. Slash commands open a completion popup; <settle> lets it
# close before we judge the result.
fm_herdr_submit_core() {
  local pane=$1 text=$2 retries=${3:-3} sleep_s=${4:-0.4} settle=${5:-0.3}
  local status i=0
  herdr pane run "$pane" "$text" 2>/dev/null || { printf 'send-failed'; return 0; }
  while :; do
    sleep "$settle"
    status=$(fm_herdr_agent_status "$pane")
    case "$status" in working|done) printf 'empty'; return 0 ;; esac
    i=$((i + 1))
    [ "$i" -lt "$retries" ] || break
    if fm_pane_input_pending "$pane"; then
      # Text landed but was not submitted: re-send Enter only.
      herdr pane send-keys "$pane" enter 2>/dev/null || true
    else
      # Idle with a clear composer: the submission never landed; re-issue it.
      herdr pane run "$pane" "$text" 2>/dev/null || { printf 'send-failed'; return 0; }
    fi
    sleep "$sleep_s"
  done
  # Final arbitration: an idle agent with a clear composer is treated as
  # delivered (a fast turn that already completed); a non-empty composer means
  # the text is still stuck unsubmitted.
  [ "$status" = idle ] && ! fm_pane_input_pending "$pane" && { printf 'empty'; return 0; }
  printf 'pending'
}
