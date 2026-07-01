#!/usr/bin/env bash
# fm-herdr-lib.sh - shared herdr pane primitives for firstmate.
#
# Replaces fm-tmux-lib.sh. All functions operate on herdr pane IDs
# (e.g. "w8:p3") rather than tmux targets. Sourced by fm-send.sh,
# fm-peek.sh, fm-watch.sh, and fm-supervise-daemon.sh so live-pane
# resolution plus compose/submit logic stays in one place.
#
# herdr tracks agent status natively (idle|working|blocked|done|unknown),
# so the ANSI ghost-text stripping and pane-hash busy detection from the
# tmux era are gone. The guarantees this lib provides instead:
#
#   1. fm_resolve_live_pane: resolve durable targets (fm-<id>) through the
#      live herdr agent identity, and refresh state/<id>.meta when pane=
#      drifts after a restart/reopen.
#   2. fm_pane_is_busy: reads herdr agent status; returns 0 when "working".
#   3. fm_pane_input_pending: reads visible pane content to detect a
#      half-typed human line in the composer; same semantics as before but
#      simpler implementation (no ANSI parsing, no SGR stripping).
#   4. fm_herdr_submit_core: sends text+Enter via "herdr pane run" and
#      verifies the agent received it by waiting briefly for a working->idle
#      transition or a clean idle state; returns a verdict string the caller
#      can act on.
#
# All functions are set -u and set -e safe.

fm_meta_value() {
  local meta=$1 key=$2
  grep "^$key=" "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

fm_meta_set() {
  local meta=$1 key=$2 value=$3 tmp line found=0
  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-meta.XXXXXX") || return 1
  if [ -f "$meta" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$key="*)
          printf '%s=%s\n' "$key" "$value" >> "$tmp"
          found=1
          ;;
        *)
          printf '%s\n' "$line" >> "$tmp"
          ;;
      esac
    done < "$meta"
  fi
  if [ "$found" = 0 ]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$meta"
}

fm_herdr_pane_id() {
  local target=$1
  herdr agent get "$target" 2>/dev/null \
    | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4 | head -1 || true
}

fm_resolve_live_pane() {
  local target=$1 state=${2:-} meta pane live
  case "$target" in
    *:*)
      printf '%s\n' "$target"
      return 0
      ;;
    fm-*)
      [ -n "$state" ] || {
        echo "error: fm_resolve_live_pane needs a state dir for $target" >&2
        return 1
      }
      meta="$state/${target#fm-}.meta"
      if [ ! -f "$meta" ]; then
        echo "error: no metadata for $target in $state; pass a pane id to target a pane outside this firstmate home" >&2
        return 1
      fi
      live=$(fm_herdr_pane_id "$target")
      if [ -n "$live" ]; then
        pane=$(fm_meta_value "$meta" pane)
        [ "$pane" = "$live" ] || fm_meta_set "$meta" pane "$live"
        printf '%s\n' "$live"
        return 0
      fi
      pane=$(fm_meta_value "$meta" pane)
      [ -n "$pane" ] || {
        echo "error: no pane recorded in $meta" >&2
        return 1
      }
      printf '%s\n' "$pane"
      return 0
      ;;
    *)
      pane=$(fm_herdr_pane_id "$target")
      [ -n "$pane" ] || {
        echo "error: no pane found for $target" >&2
        return 1
      }
      printf '%s\n' "$pane"
      return 0
      ;;
  esac
}

fm_task_for_pane() {
  local pane=$1 state=${2:-} meta task live
  [ -n "$state" ] || return 1
  for meta in "$state"/*.meta; do
    [ -e "$meta" ] || continue
    task=$(basename "$meta" .meta)
    live=$(fm_resolve_live_pane "fm-$task" "$state" 2>/dev/null || fm_meta_value "$meta" pane)
    [ "$live" = "$pane" ] || continue
    printf '%s\n' "$task"
    return 0
  done
  return 1
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
