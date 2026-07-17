#!/usr/bin/env bash
# fm-herdr-lib.sh - shared herdr pane primitives for firstmate.
#
# Replaces fm-tmux-lib.sh. All functions operate on herdr pane IDs
# (e.g. "w8:p3") rather than tmux targets. Sourced by fm-send.sh and
# fm-peek.sh; live-pane resolution plus compose/submit logic stays in one place.
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
#
# Text submission lives in fm-send.sh and uses one atomic
# "herdr pane run" call. This library never retries or queues text.
#
# All functions are set -u and set -e safe.

# fm_json_get <key> [<key>...]: read a JSON object on stdin, walk the nested
# keys given as positional arguments, and print the leaf value (or nothing on
# any parse error / missing key). This is the canonical accessor for herdr's
# one-shot JSON responses; prefer it over grep/sed on raw JSON.
fm_json_get() {
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
  local target=$1 state=${2:-} meta pane live slot
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
      slot=$(fm_meta_value "$meta" agent_slot)
      [ -n "$slot" ] || slot="$target"
      live=$(fm_herdr_pane_id "$slot")
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

# fm_herdr_pane_agent_process_verdict <pane>: determine whether a pane contains
# a live coding harness when native status is still unknown. "shell" proves an
# agent-less restored shell; "agent" and "err" must fail closed.
fm_herdr_pane_agent_process_verdict() {
  local pane=$1 process_info
  process_info=$(herdr pane process-info --pane "$pane" 2>/dev/null || true)
  [ -n "$process_info" ] || { printf 'err'; return 0; }
  printf '%s' "$process_info" | python3 -c '
import json
import re
import sys

try:
    processes = json.load(sys.stdin)["result"]["process_info"]["foreground_processes"]
except Exception:
    print("err")
    raise SystemExit

if not isinstance(processes, list):
    print("err")
    raise SystemExit

harness = re.compile(r"\b(omp|claude|codex|opencode|pi|node|bun|deno)\b")
for process in processes:
    text = " ".join(str(process.get(key, "")) for key in ("argv0", "name", "cmdline"))
    if harness.search(text):
        print("agent")
        raise SystemExit
print("shell")
' 2>/dev/null || printf 'err'
}

# fm_herdr_classify_slot <slot>: decide whether a persisted agent registration
# may be safely reused after herdr restores a session layout. Only a confirmed
# agent-less husk is reusable. A bound or booting agent remains protected.
fm_herdr_classify_slot() {
  local slot=$1 info pane pane_info status
  info=$(herdr agent get "$slot" 2>/dev/null) || { printf 'free'; return 0; }
  case "$info" in *'"error"'*) printf 'free'; return 0 ;; esac
  pane=$(printf '%s' "$info" | fm_json_get result agent pane_id)
  [ -n "$pane" ] || { printf 'free'; return 0; }
  pane_info=$(herdr pane get "$pane" 2>/dev/null || true)
  case "$pane_info" in
    ''|*'"error"'*) printf 'husk'; return 0 ;;
  esac
  status=$(printf '%s' "$pane_info" | fm_json_get result pane agent_status)
  case "$status" in
    working|idle|blocked|done) printf 'live'; return 0 ;;
  esac
  case "$(fm_herdr_pane_agent_process_verdict "$pane")" in
    shell) printf 'husk' ;;
    *) printf 'unknown' ;;
  esac
}

# fm_herdr_reap_husk_slot <slot>: remove only a confirmed session-restore husk.
# Callers must create the replacement tab before this function so closing the
# restored tab cannot leave its workspace empty.
fm_herdr_reap_husk_slot() {
  local slot=$1 verdict info tab pane
  verdict=$(fm_herdr_classify_slot "$slot")
  case "$verdict" in
    free) return 0 ;;
    husk)
      info=$(herdr agent get "$slot" 2>/dev/null || true)
      tab=$(printf '%s' "$info" | fm_json_get result agent tab_id)
      pane=$(printf '%s' "$info" | fm_json_get result agent pane_id)
      if [ -n "$tab" ]; then
        herdr tab close "$tab" >/dev/null 2>&1 || true
      elif [ -n "$pane" ]; then
        herdr pane close "$pane" >/dev/null 2>&1 || true
      fi
      sleep "${FM_HUSK_REAP_SETTLE:-0.3}"
      printf "info: reaped husk agent slot '%s' before respawn\n" "$slot" >&2
      return 0
      ;;
    live)
      printf "error: agent slot '%s' is held by a live agent - refusing to replace\n" "$slot" >&2
      return 1
      ;;
    *)
      printf "error: agent slot '%s' is occupied and not confidently a husk - refusing to replace\n" "$slot" >&2
      return 1
      ;;
  esac
}

# fm_pane_input_pending: 0 (pending) if the pane's visible content shows real
# unsubmitted text a human typed into the composer. An idle composer, a bare
# prompt glyph, or a busy footer is NOT pending. With herdr we read the raw
# visible text; no ANSI SGR stripping needed because herdr pane read returns
# plain text by default. Note: --lines is not honored by --source visible
# (herdr always returns the full visible viewport for that source), so this
# scans the whole visible tail rather than relying on a short window.
fm_pane_input_pending() {
  local pane=$1 raw line stripped result found=1
  # If the agent is mid-turn, the visible last line is agent output, never
  # unsubmitted human text. Defer to the busy check so a working pane is
  # never misread as holding pending input.
  fm_pane_is_busy "$pane" && return 1
  raw=$(herdr pane read "$pane" --lines 3 --source visible 2>/dev/null \
    | grep -v '^[[:space:]]*$') || true
  [ -n "$raw" ] || return 1
  # Scan the visible tail top-to-bottom, keeping only the LAST line that is
  # neither known trailing chrome nor a border-only row; that survivor is the
  # composer's real content line. Current Claude Code layouts render, below
  # the composer's bottom border, a persistent mode-indicator footer (e.g.
  # "bypass permissions on (shift+tab to cycle)") and sometimes a shortcuts
  # hint - neither reflects composer content, so both are skipped instead of
  # being misread as an unsent draft (this was the false-positive bug: that
  # footer line was previously the last non-blank line, so it alone decided
  # pending/not-pending). A border-only row (e.g. omp/opus's "╰── … ──╯", or
  # Claude Code's plain rule lines) collapses to whitespace once box-drawing
  # chrome is stripped and is skipped the same way, since it carries no
  # signal either way. Nothing real follows the composer's actual content
  # line in these layouts, so the last surviving candidate is always that
  # content line. "result" (not "stripped") carries the winning candidate
  # across iterations, since a later skipped border/chrome row must not
  # clobber it.
  while IFS= read -r line; do
    case "$line" in
      *'shift+tab to cycle'*|*'for shortcuts'*) continue ;;
    esac
    stripped=${line//│/}; stripped=${stripped//┃/}; stripped=${stripped//|/}
    stripped=${stripped//─/}; stripped=${stripped//━/}
    stripped=${stripped//╭/}; stripped=${stripped//╮/}
    stripped=${stripped//╰/}; stripped=${stripped//╯/}
    stripped=${stripped//┌/}; stripped=${stripped//┐/}
    stripped=${stripped//└/}; stripped=${stripped//┘/}
    stripped="${stripped#"${stripped%%[![:space:]]*}"}"
    stripped="${stripped%"${stripped##*[![:space:]]}"}"
    [ -n "$stripped" ] || continue
    found=0
    result=$stripped
  done <<<"$raw"
  [ "$found" = 0 ] || return 1
  # Bare prompt glyph = empty composer.
  case "$result" in '>'|'❯'|'$'|'%'|'#') return 1 ;; esac
  # Custom idle-compositor override (after border stripping), e.g. for custom prompt patterns.
  if [ -n "${FM_COMPOSER_IDLE_RE:-}" ]; then
    if printf '%s' "$result" | grep -qE "$FM_COMPOSER_IDLE_RE"; then
      return 1
    fi
  fi
  # A busy footer on the cursor line is not pending input.
  if printf '%s' "$result" | grep -qiE "${FM_BUSY_REGEX:-esc (to )?interrupt|Working\.\.\.}"; then
    return 1
  fi
  return 0
}

