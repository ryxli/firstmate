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

# Retrieve meta fields recorded in a task file.
meta_pane() { fm_meta_value "$1" pane; }
meta_kind() { fm_meta_value "$1" kind; }

recorded_panes() {
  local meta pane kind task seen=""
  for meta in "$STATE"/*.meta; do
    [ -e "$meta" ] || continue
    task=$(basename "$meta" .meta)
    pane=$(fm_resolve_live_pane "fm-$task" "$STATE" 2>/dev/null || meta_pane "$meta")
    [ -n "$pane" ] || continue
    kind=$(meta_kind "$meta")
    case "$seen" in *"|$pane|"*) continue ;; esac
    seen="$seen|$pane|"
    printf '%s\t%s\t%s\n' "$task" "${kind:-ship}" "$pane"
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
    files=""
    while IFS=$(printf '\t') read -r sf sig f; do
      [ -n "$sf" ] || continue
      case " $files " in *" $f "*) ;; *) files="$files $f" ;; esac
    done <<EOF
$pending
EOF
    reason="signal:$files"
    while IFS=$(printf '\t') read -r sf sig f; do
      [ -n "$sf" ] || continue
      fm_wake_append signal "$(basename "$f")" "$reason" || exit 1
    done <<EOF
$pending
EOF
    while IFS=$(printf '\t') read -r sf sig f; do
      [ -n "$sf" ] || continue
      printf '%s' "$sig" > "$sf"
    done <<EOF
$pending
EOF
    wake "$reason"
  fi

  # herdr agent status scan: detect working->idle transitions (replaces the
  # tmux-era turn-ended file + pane-hash staleness combo). Per-pane state is
  # persisted in .herdr-prev-status-<key> files so transitions survive restarts.
  # Secondmates manage themselves; only ship/scout panes are polled here.
  turn_end_files=""
  while IFS=$(printf '\t') read -r task kind pane; do
    [ -n "$pane" ] || continue
    [ "$kind" = secondmate ] && continue

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
    extra_pending=$(scan_signals)
    if [ -n "$extra_pending" ]; then
      while IFS=$(printf '\t') read -r sf sig f; do
        [ -n "$sf" ] || continue
        case " ${files:-} " in *" $f "*) ;; *) turn_end_files="$turn_end_files $f" ;; esac
      done <<EOF
$extra_pending
EOF
      while IFS=$(printf '\t') read -r sf sig f; do
        [ -n "$sf" ] || continue
        fm_wake_append signal "$(basename "$f")" "signal:$turn_end_files" || exit 1
      done <<EOF
$extra_pending
EOF
      while IFS=$(printf '\t') read -r sf sig f; do
        [ -n "$sf" ] || continue
        printf '%s' "$sig" > "$sf"
      done <<EOF
$extra_pending
EOF
    fi
    reason="signal:$turn_end_files"
    fm_wake_append signal "herdr-turn-end" "$reason" || exit 1
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
