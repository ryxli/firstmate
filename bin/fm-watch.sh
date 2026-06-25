#!/usr/bin/env bash
# Firstmate watcher.
# Blocks until supervision work is due, then exits printing one reason line:
#   signal: <file>...     a crewmate wrote a status line or finished a turn
#                         (herdr agent went working->idle). Signals landing
#                         within FM_SIGNAL_GRACE of each other coalesce.
#   stale: <pane>         a crewmate has been idle without reporting status
#   check: <script>: <out> a per-task check script produced output
#   heartbeat              fleet review due
# Run as a background task. Re-arm after handling each wake.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
mkdir -p "$STATE"

# shellcheck source=bin/fm-wake-lib.sh
. "$SCRIPT_DIR/fm-wake-lib.sh"

# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

WATCH_LOCK="$STATE/.watch.lock"
WATCHER_STALE_GRACE=${FM_WATCHER_STALE_GRACE:-${FM_GUARD_GRACE:-300}}
if ! fm_lock_try_acquire "$WATCH_LOCK"; then
  BEAT="$STATE/.last-watcher-beat"
  if [ -n "${FM_LOCK_HELD_PID:-}" ]; then
    if [ -e "$BEAT" ]; then
      beat_age=$(fm_path_age "$BEAT")
      if [ "$beat_age" -ge "$WATCHER_STALE_GRACE" ]; then
        echo "watcher: lock held by live pid $FM_LOCK_HELD_PID but heartbeat is stale for ${beat_age}s (>${WATCHER_STALE_GRACE}s); inspect or stop that watcher before re-arming." >&2
        exit 1
      fi
    elif [ "$(fm_path_age "$WATCH_LOCK")" -ge "$WATCHER_STALE_GRACE" ]; then
      echo "watcher: lock held by live pid $FM_LOCK_HELD_PID but no heartbeat exists; inspect or stop that watcher before re-arming." >&2
      exit 1
    fi
    echo "watcher: already running pid $FM_LOCK_HELD_PID"
  else
    echo "watcher: already running"
  fi
  exit 0
fi
trap 'fm_lock_release "$WATCH_LOCK"' EXIT

if [ "$(uname)" = Darwin ]; then
  stat_mtime() { stat -f %m "$1" 2>/dev/null; }
  stat_sig()   { stat -f '%z:%Fm' "$1" 2>/dev/null; }
else
  stat_mtime() { stat -c %Y "$1" 2>/dev/null; }
  stat_sig()   { stat -c '%s:%Y' "$1" 2>/dev/null; }
fi

POLL=${FM_POLL:-15}
HEARTBEAT=${FM_HEARTBEAT:-600}
HEARTBEAT_MAX=${FM_HEARTBEAT_MAX:-7200}
CHECK_INTERVAL=${FM_CHECK_INTERVAL:-300}
CHECK_TIMEOUT=${FM_CHECK_TIMEOUT:-30}
SIGNAL_GRACE=${FM_SIGNAL_GRACE:-30}

# Number of consecutive idle polls before a pane is declared stale.
STALE_POLLS=${FM_STALE_POLLS:-2}

wake() {
  case "$1" in
    heartbeat*) echo $(( $(cat "$STATE/.heartbeat-streak" 2>/dev/null || echo 0) + 1 )) > "$STATE/.heartbeat-streak" ;;
    *) echo 0 > "$STATE/.heartbeat-streak" ;;
  esac
  echo "$1"
  exit 0
}

age_of() {
  local f=$1 m
  m=$(stat_mtime "$f") || { echo 999999; return; }
  echo $(( $(date +%s) - m ))
}

# pane_key: safe filename suffix from a herdr pane id (e.g. "w8:p3" -> "w8_p3").
pane_key() { printf '%s' "$1" | tr ':' '_'; }

# Retrieve the pane id recorded in a meta file.
meta_pane() { grep '^pane=' "$1" | cut -d= -f2- || true; }
meta_kind() { grep '^kind=' "$1" | cut -d= -f2- || true; }
meta_pr()   { grep '^pr=' "$1" | cut -d= -f2- || true; }

# awaiting_merge <meta-file>: 0 (true) when a ship task is parked waiting for
# its PR to merge — it has a recorded pr= and its status file's last non-empty
# line is a terminal PR-ready/done-PR state. Such a pane is idle by design
# (the crewmate finished and is waiting on merge), so stale-pane detection must
# skip it. The merge poll (*.check.sh), heartbeat review, and status-file
# signal scan are all independent of this and keep running.
awaiting_merge() {
  local meta=$1 pr id statusf last
  pr=$(meta_pr "$meta")
  [ -n "$pr" ] || return 1
  id=$(basename "$meta" .meta)
  statusf="$STATE/$id.status"
  [ -e "$statusf" ] || return 1
  last=$(grep -v '^[[:space:]]*$' "$statusf" | tail -n1)
  case "$last" in
    done:*" PR "*|*"PR ready"*) return 0 ;;
    *) return 1 ;;
  esac
}

recorded_panes() {
  local meta pane seen=""
  for meta in "$STATE"/*.meta; do
    [ -e "$meta" ] || continue
    pane=$(meta_pane "$meta")
    [ -n "$pane" ] || continue
    case "$seen" in *"|$pane|"*) continue ;; esac
    seen="$seen|$pane|"
    printf '%s\n' "$pane"
  done
}

# Status-file signal scan (unchanged from tmux era: watches *.status files).
scan_signals() {
  local f sig sf
  for f in "$STATE"/*.status; do
    [ -e "$f" ] || continue
    sig=$(stat_sig "$f") || continue
    sf="$STATE/.seen-$(basename "$f" | tr '.' '_')"
    if [ "$sig" != "$(cat "$sf" 2>/dev/null)" ]; then
      printf '%s\t%s\t%s\n' "$sf" "$sig" "$f"
    fi
  done
}

CLASSIFY_STATUS="$SCRIPT_DIR/fm-classify-status.sh"
STATUS_INTERNAL_LOG="${FM_STATUS_INTERNAL_LOG:-$STATE/.status-internal.log}"
STATUS_INTERNAL_LOG_MAX=${FM_STATUS_INTERNAL_LOG_MAX:-500}

log_internal_status() {
  local f=$1 line=$2 tmp
  printf '[%s] %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$(basename "$f")" "$line" >> "$STATUS_INTERNAL_LOG"
  if [ "$(wc -l < "$STATUS_INTERNAL_LOG" 2>/dev/null)" -gt "$STATUS_INTERNAL_LOG_MAX" ] 2>/dev/null; then
    tmp="${STATUS_INTERNAL_LOG}.tmp"
    tail -n "$STATUS_INTERNAL_LOG_MAX" "$STATUS_INTERNAL_LOG" > "$tmp" && mv "$tmp" "$STATUS_INTERNAL_LOG"
  fi
}

captain_status_files() {
  local pending=$1 files="" seen="" sf sig f last
  while IFS=$(printf '\t') read -r sf sig f; do
    [ -n "$sf" ] || continue
    [ -e "$f" ] || continue
    case " $seen " in *" $f "*) continue ;; esac
    seen="$seen $f"
    last=$(last_status_line "$f")
    if "$CLASSIFY_STATUS" "$last" >/dev/null 2>&1; then
      files="$files $f"
    else
      log_internal_status "$f" "$last"
    fi
  done <<EOF
$pending
EOF
  printf '%s' "$files"
}

mark_signal_seen() {
  local pending=$1 sf sig f
  while IFS=$(printf '\t') read -r sf sig f; do
    [ -n "$sf" ] || continue
    printf '%s' "$sig" > "$sf"
  done <<EOF
$pending
EOF
}

append_signal_wakes() {
  local reason=$1 files=$2 f
  for f in $files; do
    fm_wake_append signal "$(basename "$f")" "$reason" || exit 1
  done
}

run_check() {
  local c=$1
  if command -v timeout >/dev/null 2>&1; then
    timeout "$CHECK_TIMEOUT" bash "$c" 2>/dev/null || true
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$CHECK_TIMEOUT" bash "$c" 2>/dev/null || true
  else
    # shellcheck disable=SC2016
    perl -e 'my $t = shift; my $pid = fork; die "fork failed" unless defined $pid; if (!$pid) { setpgrp(0, 0); exec @ARGV } local $SIG{ALRM} = sub { kill "TERM", -$pid; select undef, undef, undef, 0.2; kill "KILL", -$pid; exit 124 }; alarm $t; waitpid $pid, 0; exit($? >> 8)' "$CHECK_TIMEOUT" bash "$c" 2>/dev/null || true
  fi
}

[ -e "$STATE/.last-heartbeat" ] || touch "$STATE/.last-heartbeat"

while :; do
  touch "$STATE/.last-watcher-beat"

  # Slow per-task checks (e.g. merged-PR poll). Evaluated before signal scan.
  if [ "$(age_of "$STATE/.last-check")" -ge "$CHECK_INTERVAL" ]; then
    for c in "$STATE"/*.check.sh; do
      [ -e "$c" ] || continue
      out=$(run_check "$c")
      if [ -n "$out" ]; then
        reason="check: $c: $out"
        fm_wake_append check "$c" "$reason" || exit 1
        touch "$STATE/.last-check"
        wake "$reason"
      fi
    done
    touch "$STATE/.last-check"
  fi

  # Status-file signal scan.
  pending=$(scan_signals)
  if [ -n "$pending" ]; then
    sleep "$SIGNAL_GRACE"
    pending=$(printf '%s\n%s' "$pending" "$(scan_signals)")
    files=$(captain_status_files "$pending")
    if [ -n "$files" ]; then
      reason="signal:$files"
      append_signal_wakes "$reason" "$files"
      mark_signal_seen "$pending"
      wake "$reason"
    else
      mark_signal_seen "$pending"
    fi
  fi

  # herdr agent status scan: detect working->idle transitions (replaces the
  # tmux-era turn-ended file + pane-hash staleness combo). Per-pane state is
  # persisted in .herdr-prev-status-<key> files so transitions survive restarts.
  # Secondmates manage themselves; only ship/scout panes are polled here.
  turn_end_files=""
  while IFS= read -r pane; do
    # Find this pane's kind and meta from its meta file.
    kind=ship
    meta_for_pane=""
    for meta in "$STATE"/*.meta; do
      [ -e "$meta" ] || continue
      mp=$(meta_pane "$meta")
      [ "$mp" = "$pane" ] || continue
      meta_for_pane="$meta"
      k=$(meta_kind "$meta")
      [ -n "$k" ] && kind=$k
      break
    done
    [ "$kind" = secondmate ] && continue
    # A ship task parked on a green PR keeps its pane idle while waiting for
    # merge; skip stale detection for it (merge poll + heartbeat still cover it).
    if [ -n "$meta_for_pane" ] && awaiting_merge "$meta_for_pane"; then
      continue
    fi

    key=$(pane_key "$pane")
    prev_sf="$STATE/.herdr-prev-status-$key"
    idle_cf="$STATE/.herdr-idle-count-$key"
    stale_sf="$STATE/.stale-$key"

    cur_status=$(fm_herdr_agent_status "$pane")
    prev_status=$(cat "$prev_sf" 2>/dev/null || echo "unknown")

    printf '%s' "$cur_status" > "$prev_sf"

    if [ "$prev_status" = "working" ] && [ "$cur_status" = "idle" ]; then
      # Turn ended: generate a signal wake, coalescing in SIGNAL_GRACE window.
      marker="$STATE/.herdr-turn-$key"
      if [ ! -e "$marker" ] || [ "$(age_of "$marker")" -ge "$SIGNAL_GRACE" ]; then
        touch "$marker"
        turn_end_files="$turn_end_files $pane"
      fi
      # Reset stale tracking: the agent was active.
      echo 0 > "$idle_cf"
      rm -f "$stale_sf"
    elif [ "$cur_status" = "working" ]; then
      echo 0 > "$idle_cf"
      rm -f "$stale_sf"
    elif [ "$cur_status" = "idle" ] || [ "$cur_status" = "unknown" ]; then
      n=$(( $(cat "$idle_cf" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$idle_cf"
      if [ "$n" -ge "$STALE_POLLS" ]; then
        if [ "$(cat "$stale_sf" 2>/dev/null || true)" != "$cur_status" ]; then
          fm_wake_append stale "$pane" "stale: $pane" || exit 1
          printf '%s' "$cur_status" > "$stale_sf"
          wake "stale: $pane"
        fi
      fi
    fi
  done < <(recorded_panes)

  if [ -n "$turn_end_files" ]; then
    # Linger one grace period then re-scan so status writes that follow a
    # turn-end coalesce into the same wake.
    sleep "$SIGNAL_GRACE"
    status_files=""
    extra_pending=$(scan_signals)
    if [ -n "$extra_pending" ]; then
      status_files=$(captain_status_files "$extra_pending")
      if [ -n "$status_files" ]; then
        for f in $status_files; do
          case " $turn_end_files " in *" $f "*) ;; *) turn_end_files="$turn_end_files $f" ;; esac
        done
      fi
    fi
    reason="signal:$turn_end_files"
    fm_wake_append signal "herdr-turn-end" "$reason" || exit 1
    append_signal_wakes "$reason" "${status_files:-}"
    [ -n "$extra_pending" ] && mark_signal_seen "$extra_pending"
    wake "$reason"
  fi

  # Heartbeat.
  streak=$(cat "$STATE/.heartbeat-streak" 2>/dev/null || echo 0)
  [ "$streak" -gt 12 ] && streak=12
  hb=$(( HEARTBEAT * (1 << streak) ))
  [ "$hb" -gt "$HEARTBEAT_MAX" ] && hb=$HEARTBEAT_MAX
  if [ "$(age_of "$STATE/.last-heartbeat")" -ge "$hb" ]; then
    fm_wake_append heartbeat heartbeat heartbeat || exit 1
    touch "$STATE/.last-heartbeat"
    wake "heartbeat"
  fi

  sleep "$POLL"
done
