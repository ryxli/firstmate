#!/usr/bin/env bash
# fm-supervise-daemon.sh — presence-gated sub-supervisor.
#
# Wraps bin/fm-watch.sh: runs it as a child, classifies each wake reason, and
# either SELF-HANDLES the routine majority in bash (no firstmate turn) or
# ESCALATES a batched digest to the supervisor pane on captain-relevant events.
# Uses herdr pane read/run for all pane interaction (replaces the tmux layer).
#
# PRESENCE-GATING. The daemon is away-mode engine: active only when state/.afk
# exists (set by /afk skill, cleared on any real user message). When afk is
# off, the daemon self-handles and stays quiet.
#
# IN-BAND SENTINEL MARKER. Every injection is prefixed with FM_INJECT_MARK
# (ASCII unit separator, 0x1f). Firstmate treats a leading marker as an
# internal escalation (stay afk); absence means the captain is back.
#
# RELIABILITY. Nothing is lost: the wake-queue persists every wake before
# advancing suppression markers; fm-wake-drain.sh recovers missed injections.
# Wedge detection is bounded: if a digest stays undelivered past
# FM_MAX_DEFER_SECS, a herdr notification alarm fires.
#
# Usage: fm-supervise-daemon.sh
#   FM_SUPERVISOR_TARGET   supervisor pane id (override; auto-discovered otherwise)
#   FM_INJECT_SKIP         |-prefixes force-self-handle (default "heartbeat")
#   FM_STALE_ESCALATE_SECS idle seconds before a stale pane escalates (default 240)
#   FM_ESCALATE_BATCH_SECS buffer window; 0 = flush immediately (default 90)
#   FM_HEARTBEAT_SCAN_SECS catch-all status scan cadence (default 300)
#   FM_HOUSEKEEPING_TICK   seconds between housekeeping passes (default 15)
#   FM_MAX_DEFER_SECS      max seconds before wedge alarm (default 300)
#   FM_INJECT_CONFIRM_RETRIES  submit verification retries (default 3)
#   FM_INJECT_CONFIRM_SLEEP    seconds between checks (default 0.5)
set -u

FM_DAEMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$FM_DAEMON_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"

# shellcheck source=bin/fm-herdr-lib.sh
. "$FM_DAEMON_DIR/fm-herdr-lib.sh"

# --- tunables ---------------------------------------------------------------
FM_SUPERVISOR_TARGET_DEFAULT=""
INJECT_SKIP_DEFAULT="heartbeat"
STALE_ESCALATE_SECS_DEFAULT=240
ESCALATE_BATCH_SECS_DEFAULT=90
HEARTBEAT_SCAN_SECS_DEFAULT=300
HOUSEKEEPING_TICK_DEFAULT=15
MAX_DEFER_SECS_DEFAULT=300
CAPTAIN_RE_DEFAULT='done:|needs-decision:|blocked:|failed:|PR ready|checks green|ready in branch|merged'
INJECT_FAIL_SLEEP_DEFAULT=30
INJECT_CONFIRM_RETRIES_DEFAULT=3
INJECT_CONFIRM_SLEEP_DEFAULT=0.5
CRASH_THRESHOLD_DEFAULT=10
CRASH_WINDOW_DEFAULT=60
CRASH_BACKOFF_DEFAULT=60
CRASH_NORMAL_SLEEP_DEFAULT=5
LOG_MAX_BYTES_DEFAULT=1048576
LOG_KEEP_LINES_DEFAULT=2000

# --- presence-gating + sentinel marker --------------------------------------
FM_INJECT_MARK=$'\x1f'
AFK_FLAG_NAME=".afk"

_state_root() { printf '%s' "${FM_STATE_OVERRIDE:-$FM_HOME/state}"; }

if [ "$(uname)" = Darwin ]; then
  _stat_file_mtime() { stat -f %m "$1" 2>/dev/null; }
else
  _stat_file_mtime() { stat -c %Y "$1" 2>/dev/null; }
fi
_now() { date +%s; }
_file_age() {
  local f=$1 m
  m=$(_stat_file_mtime "$f") || { echo 999999; return; }
  echo $(( $(_now) - m ))
}

_hash_text() {
  if command -v md5 >/dev/null 2>&1; then printf '%s' "$1" | md5 -q
  else printf '%s' "$1" | md5sum | cut -d ' ' -f1; fi
}

afk_active() { [ -e "$1/$AFK_FLAG_NAME" ]; }
afk_enter() { mkdir -p "$1"; date '+%s' > "$1/$AFK_FLAG_NAME"; }
afk_exit() { rm -f "$1/$AFK_FLAG_NAME"; }

should_exit_afk() {
  local state=$1 msg=$2
  afk_active "$state" || return 1
  message_is_injection "$msg" && return 1
  case "$msg" in /afk*) return 1 ;; esac
  return 0
}

message_is_injection() {
  local msg=$1
  [ -n "$msg" ] || return 1
  case "$msg" in "$FM_INJECT_MARK"*) return 0 ;; esac
  return 1
}

strip_injection_marker() { printf '%s' "${1#"$FM_INJECT_MARK"}"; }

_collapse_newlines() {
  local s=$1
  s=${s//$'\n'/ - }
  printf '%s' "$s"
}

# Auto-discover the supervisor pane at daemon startup.
# Priority: FM_SUPERVISOR_TARGET override > herdr pane current > empty (error).
discover_supervisor_target() {
  if [ -n "${FM_SUPERVISOR_TARGET:-}" ]; then
    printf '%s' "$FM_SUPERVISOR_TARGET"
    return 0
  fi
  # Ask herdr which pane is current (the pane that launched the daemon).
  local pane_json pane
  pane_json=$(herdr pane current 2>/dev/null || true)
  pane=$(printf '%s\n' "$pane_json" | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4 | head -1 || true)
  if [ -n "$pane" ]; then
    printf '%s' "$pane"
    return 0
  fi
  # Could not discover; let the caller handle it.
  return 1
}

# --- classification helpers -------------------------------------------------
last_status_line() {
  local f=$1
  [ -e "$f" ] || return 0
  grep -v '^[[:space:]]*$' "$f" 2>/dev/null | tail -1
}

status_is_captain_relevant() {
  local line=$1
  [ -n "$line" ] || return 1
  printf '%s' "$line" | grep -qiE "${FM_CAPTAIN_RE:-$CAPTAIN_RE_DEFAULT}"
}

window_to_task() {
  local w=$1 t
  t="${w##*:}"; t="${t#fm-}"; printf '%s' "$t"
}

# For herdr, "window" concept maps to pane id or agent name "fm-<id>".
pane_to_task() {
  local pane=$1 meta mp task
  for meta in "${FM_STATE_DIR:-$(_state_root)}"/*.meta; do
    [ -e "$meta" ] || continue
    mp=$(grep '^pane=' "$meta" | cut -d= -f2- || true)
    [ "$mp" = "$pane" ] || continue
    task=$(basename "$meta" .meta)
    printf '%s' "$task"
    return 0
  done
  return 1
}

classify_signal() {
  local reason=$1 state=$2 f last distilled="" rel="" all_seen=1 task seen
  for f in $reason; do
    [ -e "$f" ] || continue
    last=$(last_status_line "$f")
    [ -n "$last" ] || continue
    distilled="${distilled}$(basename "$f"): ${last} | "
    status_is_captain_relevant "$last" || continue
    rel=1
    task=$(basename "$f"); task="${task%.status}"
    seen="$state/.subsuper-seen-status-$(_stale_key "$task")"
    [ "$(cat "$seen" 2>/dev/null || true)" = "$last" ] || all_seen=0
  done
  distilled="${distilled% | }"
  if [ -z "$rel" ]; then
    printf 'self|routine signal: %s' "$distilled"
  elif [ "$all_seen" = "1" ]; then
    printf 'self|signal already escalated (catch-all scan): %s' "$distilled"
  else
    printf 'escalate|%s' "$distilled"
  fi
}

classify_stale() {
  local pane=$1 state=$2 task last seen
  task=$(pane_to_task "$pane" 2>/dev/null || window_to_task "$pane")
  last=$(last_status_line "$state/$task.status")
  if [ -n "$last" ] && status_is_captain_relevant "$last"; then
    seen="$state/.subsuper-seen-status-$(_stale_key "$task")"
    if [ "$(cat "$seen" 2>/dev/null || true)" = "$last" ]; then
      printf 'self|stale + terminal (already escalated): %s' "$last"
      return
    fi
    printf 'escalate|stale + terminal status: %s' "$last"
    return
  fi
  printf 'self|transient stale (%s): %s' "$pane" "${last:-no status}"
}

classify_check() { printf 'escalate|%s' "$1"; }
classify_heartbeat() { printf 'self|heartbeat (catch-all scan runs in housekeeping)'; }
classify_unknown() { printf 'escalate|unknown wake: %s' "$1"; }

_stale_key() { printf '%s' "$1" | tr ':/.' '___'; }

stale_marker_record() {
  local pane=$1 state=$2 key marker
  key=$(_stale_key "$(pane_to_task "$pane" 2>/dev/null || window_to_task "$pane")")
  marker="$state/.subsuper-stale-$key"
  [ -e "$marker" ] || _now > "$marker"
}

stale_marker_remove() {
  local pane=$1 state=$2 key
  key=$(_stale_key "$(pane_to_task "$pane" 2>/dev/null || window_to_task "$pane")")
  rm -f "$state/.subsuper-stale-$key"
}

mark_status_seen() {
  local state=$1 task=$2 line=$3
  printf '%s' "$line" > "$state/.subsuper-seen-status-$(_stale_key "$task")"
}

mark_escalated_seen() {
  local kind=$1 arg=$2 state=$3 f last task
  case "$kind" in
    signal)
      for f in $arg; do
        [ -e "$f" ] || continue
        last=$(last_status_line "$f")
        [ -n "$last" ] || continue
        status_is_captain_relevant "$last" || continue
        task=$(basename "$f"); task="${task%.status}"
        mark_status_seen "$state" "$task" "$last"
      done ;;
    stale)
      task=$(pane_to_task "$arg" 2>/dev/null || window_to_task "$arg")
      last=$(last_status_line "$state/$task.status")
      [ -n "$last" ] && status_is_captain_relevant "$last" \
        && mark_status_seen "$state" "$task" "$last" ;;
  esac
}

# Busy/composer detection via herdr (replaces the tmux primitives).
pane_is_busy() { fm_pane_is_busy "$@"; }
pane_input_pending() { fm_pane_input_pending "$@"; }

escalate_add() {
  local state=$1 item=$2 buf
  buf="$state/.subsuper-escalations"
  [ -s "$buf" ] || _now > "${buf}.since"
  printf '%s\n' "$item" >> "$buf"
}

escalate_flush() {
  local state=$1 buf item n msg
  buf="$state/.subsuper-escalations"
  [ -s "$buf" ] || return 0
  n=$(wc -l < "$buf" 2>/dev/null || echo 0)
  msg=$(awk 'NR>1{printf " | "} {printf "%s",$0} END{print ""}' "$buf" 2>/dev/null)
  msg=$(printf 'Supervisor escalate (%s event(s)): %s (pre-read; re-arm not needed — watcher daemon-managed)' "$n" "$msg")
  if inject_msg "$msg" "$state"; then : > "$buf"; rm -f "${buf}.since" "$state/.subsuper-inject-wedged"; return 0; fi
  return 1
}

inject_wedge_alarm() {
  local state=$1 age=$2 marker
  marker="$state/.subsuper-inject-wedged"
  if [ "$(_file_age "$marker")" -lt "${FM_MAX_DEFER_SECS:-$MAX_DEFER_SECS_DEFAULT}" ]; then
    return 0
  fi
  log "ERROR: away-mode escalation undelivered ${age}s; inject could not confirm submit."
  {
    printf 'fm away-mode inject WEDGED: %ss undelivered as of %s\n' "$age" "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'Buffered items:\n'
    cat "$state/.subsuper-escalations" 2>/dev/null
  } > "$marker" 2>/dev/null || true
  # Use herdr notification instead of tmux display-message.
  herdr notification show "fm: away-mode escalations WEDGED ${age}s" \
    --body "See $marker" --sound request 2>/dev/null || true
}

_oldest_line_age() {
  local f=$1 since
  [ -s "$f" ] || { echo 999999; return; }
  since="${f}.since"
  if [ -r "$since" ]; then
    echo $(( $(_now) - $(cat "$since" 2>/dev/null || echo 0) ))
  else
    echo 999999
  fi
}

# Find a live crewmate pane for a given task key.
pane_for_task() {
  local key=$1 meta mp task
  local state="${FM_STATE_DIR:-$(_state_root)}"
  for meta in "$state"/*.meta; do
    [ -e "$meta" ] || continue
    mp=$(grep '^pane=' "$meta" | cut -d= -f2- || true)
    [ -n "$mp" ] || continue
    task=$(basename "$meta" .meta)
    [ "$(_stale_key "$task")" = "$key" ] && { printf '%s' "$mp"; return 0; }
  done
  return 1
}

housekeeping() {
  local state=$1 now due f key task pane marker age last max_defer oldest
  now=$(_now)

  # (1) batch flush
  if [ "${FM_ESCALATE_BATCH_SECS:-$ESCALATE_BATCH_SECS_DEFAULT}" -le 0 ]; then
    escalate_flush "$state" || true
  else
    due=$(_oldest_line_age "$state/.subsuper-escalations")
    if [ "$due" -ge "${FM_ESCALATE_BATCH_SECS:-$ESCALATE_BATCH_SECS_DEFAULT}" ]; then
      escalate_flush "$state" || true
    fi
  fi

  # (1b) max-defer escape
  max_defer=${FM_MAX_DEFER_SECS:-$MAX_DEFER_SECS_DEFAULT}
  if afk_active "$state" && [ "$max_defer" -gt 0 ] && [ -s "$state/.subsuper-escalations" ]; then
    oldest=$(_oldest_line_age "$state/.subsuper-escalations")
    if [ "$oldest" -ge "$max_defer" ] \
       && [ "$(_file_age "$state/.subsuper-inject-wedged")" -ge "$max_defer" ]; then
      if escalate_flush "$state"; then
        log "inject recovered after ${oldest}s"
        rm -f "$state/.subsuper-inject-wedged"
      else
        inject_wedge_alarm "$state" "$oldest"
      fi
    fi
  fi

  # (2) stale persistence recheck
  for marker in "$state"/.subsuper-stale-*; do
    [ -e "$marker" ] || continue
    key="${marker##*.subsuper-stale-}"
    age=$(( now - $(cat "$marker" 2>/dev/null || echo "$now") ))
    [ "$age" -ge "${FM_STALE_ESCALATE_SECS:-$STALE_ESCALATE_SECS_DEFAULT}" ] || continue
    pane=$(pane_for_task "$key" 2>/dev/null || true)
    if [ -z "$pane" ]; then
      rm -f "$marker"; continue
    fi
    if pane_is_busy "$pane"; then
      rm -f "$marker"
    else
      escalate_add "$state" "stale persisted ${age}s (possible wedge): $pane"
      stale_marker_remove "$pane" "$state"
    fi
  done

  # (3) heartbeat scan
  if [ "$(_file_age "$state/.subsuper-last-scan")" -ge "${FM_HEARTBEAT_SCAN_SECS:-$HEARTBEAT_SCAN_SECS_DEFAULT}" ]; then
    _now > "$state/.subsuper-last-scan"
    for f in "$state"/*.status; do
      [ -e "$f" ] || continue
      last=$(last_status_line "$f")
      status_is_captain_relevant "$last" || continue
      task=$(basename "$f"); task="${task%.status}"
      local seen
      seen="$state/.subsuper-seen-status-$(_stale_key "$task")"
      [ "$(cat "$seen" 2>/dev/null || true)" = "$last" ] && continue
      escalate_add "$state" "$(basename "$f"): $last (catch-all scan)"
      mark_status_seen "$state" "$task" "$last"
    done
  fi
}

# --- injection via herdr -----------------------------------------------------
inject_msg() {
  local msg=$1 state target retries sleep_s verdict
  state="${2:-$(_state_root)}"
  afk_active "$state" || { log "inject deferred: afk inactive"; return 1; }
  msg=$(_collapse_newlines "$msg")
  msg="${FM_INJECT_MARK}${msg}"
  target="${FM_SUPERVISOR_TARGET:-$FM_SUPERVISOR_TARGET_DEFAULT}"
  [ -n "$target" ] || { log "inject deferred: no supervisor target"; return 1; }
  # Verify the target pane still exists.
  herdr pane get "$target" >/dev/null 2>&1 || return 1
  # Busy-guard: do not inject while the agent is mid-turn.
  if pane_is_busy "$target"; then
    log "inject deferred: supervisor pane busy (agent mid-turn)"
    return 1
  fi
  # Input-pending guard: do not merge into half-typed human text.
  if pane_input_pending "$target"; then
    log "inject deferred: supervisor pane has pending input"
    return 1
  fi
  retries=${FM_INJECT_CONFIRM_RETRIES:-$INJECT_CONFIRM_RETRIES_DEFAULT}
  sleep_s=${FM_INJECT_CONFIRM_SLEEP:-$INJECT_CONFIRM_SLEEP_DEFAULT}
  verdict=$(fm_herdr_submit_core "$target" "$msg" "$retries" "$sleep_s" "$sleep_s")
  if [ "$verdict" = empty ]; then
    return 0
  fi
  log "inject failed: submit unconfirmed after $retries retries (verdict=$verdict)"
  return 1
}

# --- INJECT_SKIP prefix match ------------------------------------------------
should_force_self() {
  local reason=$1 skip="${FM_INJECT_SKIP:-$INJECT_SKIP_DEFAULT}" prefix
  [ -n "$skip" ] || return 1
  local -a prefixes
  IFS='|' read -ra prefixes <<<"$skip"
  for prefix in "${prefixes[@]}"; do
    [ -n "$prefix" ] || continue
    [ "$reason" != "${reason#"$prefix"}" ] && return 0
  done
  return 1
}

is_wake_reason() {
  local reason=$1
  case "$reason" in signal:*|stale:*|check:*|heartbeat|heartbeat:*) return 0 ;; esac
  return 1
}

handle_wake() {
  local reason=$1 state=$2 decision action distilled
  local kind="" arg=""
  if should_force_self "$reason"; then
    log "wake force-self (FM_INJECT_SKIP): $reason"; return
  fi
  case "$reason" in
    signal:*) kind=signal; arg="${reason#signal: }"
              decision=$(classify_signal "$arg" "$state") ;;
    stale:*)  kind=stale; arg="${reason#stale: }"
              decision=$(classify_stale "$arg" "$state") ;;
    check:*)  decision=$(classify_check "$reason") ;;
    heartbeat|heartbeat:*) decision=$(classify_heartbeat) ;;
    *)        decision=$(classify_unknown "$reason") ;;
  esac
  action=${decision%%|*}
  distilled=${decision#*|}
  if [ "$action" = "escalate" ]; then
    log "escalate: $reason -> $distilled"
    escalate_add "$state" "$distilled"
    [ "$kind" = "stale" ] && stale_marker_remove "$arg" "$state"
    mark_escalated_seen "$kind" "$arg" "$state"
    [ "${FM_ESCALATE_BATCH_SECS:-$ESCALATE_BATCH_SECS_DEFAULT}" -le 0 ] && { escalate_flush "$state" || true; }
  else
    [ "$kind" = "stale" ] && stale_marker_record "$arg" "$state"
    log "self-handle: $reason -> $distilled"
  fi
}

log() { [ -n "${LOG:-}" ] && printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

trim_log() {
  local sz tmp
  [ -n "${LOG:-}" ] || return 0
  sz=$(wc -c < "$LOG" 2>/dev/null) || return 0
  [ "$sz" -ge "${FM_LOG_MAX_BYTES:-$LOG_MAX_BYTES_DEFAULT}" ] || return 0
  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-daemon-log.XXXXXX") || return 0
  tail -n "${FM_LOG_KEEP_LINES:-$LOG_KEEP_LINES_DEFAULT}" "$LOG" >"$tmp" 2>/dev/null && mv -f "$tmp" "$LOG"
}

# ============================================================================
fm_super_main() {
  local STATE
  STATE="$(_state_root)"
  mkdir -p "$STATE"
  FM_STATE_OVERRIDE="$STATE" . "$FM_DAEMON_DIR/fm-wake-lib.sh"
  FM_STATE_DIR="$STATE"

  local WATCH="$FM_DAEMON_DIR/fm-watch.sh"
  local LOG="$STATE/.supervise-daemon.log"
  local WATCH_ERR="$STATE/.supervise-daemon.watcher.err"
  local LOCK="$STATE/.supervise-daemon.lock"
  local PIDFILE="$STATE/.supervise-daemon.pid"
  local INJECT_FAIL_SLEEP=${FM_INJECT_FAIL_SLEEP:-$INJECT_FAIL_SLEEP_DEFAULT}
  local CRASH_THRESHOLD=${FM_CRASH_THRESHOLD:-$CRASH_THRESHOLD_DEFAULT}
  local CRASH_WINDOW=${FM_CRASH_WINDOW:-$CRASH_WINDOW_DEFAULT}
  local CRASH_BACKOFF=${FM_CRASH_BACKOFF:-$CRASH_BACKOFF_DEFAULT}
  local CRASH_NORMAL_SLEEP=${FM_CRASH_NORMAL_SLEEP:-$CRASH_NORMAL_SLEEP_DEFAULT}

  [ -x "$WATCH" ] || { echo "error: watcher not found or not executable: $WATCH" >&2; exit 1; }

  if ! fm_lock_try_acquire "$LOCK"; then
    if [ -n "${FM_LOCK_HELD_PID:-}" ]; then
      echo "error: another fm-supervise-daemon is already running (pid $FM_LOCK_HELD_PID)" >&2
    else
      echo "error: another fm-supervise-daemon is already running" >&2
    fi
    exit 1
  fi
  echo "$$" > "$PIDFILE"

  # Auto-discover the supervisor pane (the herdr pane running firstmate).
  local discovered target_source="FM_SUPERVISOR_TARGET"
  if [ -z "${FM_SUPERVISOR_TARGET:-}" ]; then
    target_source="herdr-pane-current"
  fi
  if discovered=$(discover_supervisor_target); then
    : # resolved cleanly
  else
    echo "warn: could not auto-discover supervisor pane; set FM_SUPERVISOR_TARGET" >&2
    # Empty string; inject will bail until it resolves.
    discovered=""
  fi
  FM_SUPERVISOR_TARGET="${discovered}"
  FM_SUPERVISOR_TARGET_DEFAULT="${discovered}"
  local TARGET="$FM_SUPERVISOR_TARGET"

  if [ -n "$TARGET" ]; then
    if ! herdr pane get "$TARGET" >/dev/null 2>&1; then
      echo "error: supervisor target '$TARGET' does not resolve to a herdr pane; set FM_SUPERVISOR_TARGET" >&2
      log "startup failed: target '$TARGET' not found"
      fm_lock_release "$LOCK" 2>/dev/null || true
      rm -f "$PIDFILE" 2>/dev/null || true
      exit 1
    fi
  fi

  local afk_status="off"
  afk_active "$STATE" && afk_status="on"
  log "daemon starting (pid $$); target=$TARGET; target_source=$target_source; afk=$afk_status"

  local WATCHER_PID="" CUR_TMP=""
  cleanup() {
    trap - TERM INT
    escalate_flush "$STATE" 2>/dev/null || true
    if [ -n "${WATCHER_PID:-}" ]; then
      kill "$WATCHER_PID" 2>/dev/null || true
      wait "$WATCHER_PID" 2>/dev/null || true
    fi
    rm -f "${CUR_TMP:-}" 2>/dev/null || true
    fm_lock_release "$LOCK" 2>/dev/null || true
    rm -f "$PIDFILE" 2>/dev/null || true
    log "daemon shutting down"
    exit 0
  }
  trap cleanup TERM INT

  local crash_times=() backoff_secs=$CRASH_NORMAL_SLEEP
  record_crash() {
    local now t
    now=$(_now)
    local -a keep=()
    for t in "${crash_times[@]:-}"; do
      [ -n "$t" ] && [ $((now - t)) -lt "$CRASH_WINDOW" ] && keep+=("$t")
    done
    keep+=("$now")
    crash_times=("${keep[@]}")
    if [ "${#crash_times[@]}" -gt "$CRASH_THRESHOLD" ]; then
      log "ERROR: watcher crashed ${#crash_times[@]} times; backing off ${CRASH_BACKOFF}s"
      crash_times=()
      backoff_secs=$CRASH_BACKOFF
    else
      backoff_secs=$CRASH_NORMAL_SLEEP
    fi
  }

  start_watcher() {
    CUR_TMP=$(mktemp "${TMPDIR:-/tmp}/fm-watch.XXXXXX") || { log "mktemp failed"; sleep 5; return 1; }
    "$WATCH" >"$CUR_TMP" 2>>"$WATCH_ERR" &
    WATCHER_PID=$!
  }

  local rc reason
  while true; do
    # Pane-gone guard: back off while supervisor pane is unreachable.
    if [ -n "$TARGET" ] && ! herdr pane get "$TARGET" >/dev/null 2>&1; then
      log "warn: supervisor target '$TARGET' gone; backing off ${INJECT_FAIL_SLEEP}s"
      sleep "$INJECT_FAIL_SLEEP"
      continue
    fi

    if [ -z "${WATCHER_PID:-}" ] || ! kill -0 "${WATCHER_PID:-}" 2>/dev/null; then
      if [ -n "${WATCHER_PID:-}" ]; then
        if wait "${WATCHER_PID}"; then rc=0; else rc=$?; fi
        reason=""
        if [ -n "${CUR_TMP:-}" ] && [ -e "${CUR_TMP:-}" ]; then
          reason=$(<"${CUR_TMP}")
        fi
        rm -f "${CUR_TMP:-}" 2>/dev/null || true; CUR_TMP=""
        if [ "$rc" -ne 0 ] || [ -z "$reason" ]; then
          record_crash
          log "watcher exited rc=$rc reason='$reason'; restarting after ${backoff_secs}s"
          WATCHER_PID=""; sleep "$backoff_secs"; continue
        fi
        if ! is_wake_reason "$reason"; then
          log "watcher non-wake stdout, idling: $reason"
          WATCHER_PID=""; sleep "${HOUSEKEEPING_TICK:-$HOUSEKEEPING_TICK_DEFAULT}"; continue
        fi
        log "wake: $reason"
        handle_wake "$reason" "$STATE"
        trim_log
      fi
      start_watcher || continue
    fi

    sleep 1
    if [ "$(_file_age "$STATE/.subsuper-last-housekeep")" -ge "${FM_HOUSEKEEPING_TICK:-$HOUSEKEEPING_TICK_DEFAULT}" ]; then
      _now > "$STATE/.subsuper-last-housekeep"
      housekeeping "$STATE"
    fi
  done
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  fm_super_main "$@"
fi
