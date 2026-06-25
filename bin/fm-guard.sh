#!/usr/bin/env bash
# Watcher liveness guard, called at the top of the supervision scripts.
# Warns to stderr about three independent conditions:
#   1. Pending wakes in state/.wake-queue (drain with fm-wake-drain.sh).
#   2. state/.watch-rearm-needed present with a stale or missing liveness
#      beacon (state/.last-watcher-beat) - previous wake still needs re-arm.
#   3. Beacon missing or older than FM_GUARD_GRACE seconds with no re-arm
#      marker - watcher has not run recently.
# Conditions 1 and 2 fire regardless of whether tasks are in flight; condition
# 3 drops the "tasks are in flight but" prefix when no state/*.meta exists.
# Exits immediately (no warning) only when all three conditions are absent.
# Always exits 0: the guard warns, it never blocks.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
GRACE=${FM_GUARD_GRACE:-300}
queue_pending=false

# shellcheck source=bin/fm-wake-lib.sh
. "$SCRIPT_DIR/fm-wake-lib.sh"

# Portable mtime; see fm-watch.sh for why the `stat -f || stat -c` fallback breaks on Linux.
if [ "$(uname)" = Darwin ]; then
  stat_mtime() { stat -f %m "$1" 2>/dev/null; }
else
  stat_mtime() { stat -c %Y "$1" 2>/dev/null; }
fi

has_meta=false
for meta in "$STATE"/*.meta; do
  [ -e "$meta" ] || continue
  has_meta=true
  break
done

if ! "$has_meta" && [ ! -s "$FM_WAKE_QUEUE" ] && [ ! -e "$STATE/.watch-rearm-needed" ]; then
  exit 0
fi

if [ -s "$FM_WAKE_QUEUE" ]; then
  queue_pending=true
  echo "WARNING: queued wakes pending - drain them with bin/fm-wake-drain.sh before anything else." >&2
fi
BEAT="$STATE/.last-watcher-beat"
REARM="$STATE/.watch-rearm-needed"
if [ -e "$BEAT" ]; then
  m=$(stat_mtime "$BEAT") || exit 0
  age=$(( $(date +%s) - m ))
  if [ "$age" -lt "$GRACE" ]; then
    exit 0
  elif [ -e "$REARM" ]; then
    reason=$(cat "$REARM" 2>/dev/null || true)
    echo "WARNING: watcher exited for a wake and still needs re-arm; beacon is stale for ${age}s (>${GRACE}s)." >&2
    [ -n "$reason" ] && echo "Last wake needing re-arm: $reason" >&2
  else
    if "$has_meta"; then
      echo "WARNING: tasks are in flight but no watcher has been alive for ${age}s (>${GRACE}s)." >&2
    else
      echo "WARNING: no watcher has been alive for ${age}s (>${GRACE}s)." >&2
    fi
  fi
else
  if [ -e "$REARM" ]; then
    reason=$(cat "$REARM" 2>/dev/null || true)
    echo "WARNING: watcher exited for a wake and still needs re-arm; no liveness beacon exists." >&2
    [ -n "$reason" ] && echo "Last wake needing re-arm: $reason" >&2
  else
    if "$has_meta"; then
      echo "WARNING: tasks are in flight but no watcher has ever run (no liveness beacon)." >&2
    else
      echo "WARNING: no watcher has ever run (no liveness beacon)." >&2
    fi
  fi
fi
if "$queue_pending"; then
  echo "After draining queued wakes, re-arm the watcher: run bin/fm-watch.sh as a background task." >&2
else
  echo "Restart it NOW, before anything else: run bin/fm-watch.sh as a background task." >&2
fi
exit 0
