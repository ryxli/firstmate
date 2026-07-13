#!/usr/bin/env bash
# fm-reconcile-status.sh - firstmate's own truth for a mate's working/idle state.
#
# Why this exists: herdr's agent_status for omp panes is unreliable. The
# omp<->herdr socket integration drops state reports (a failed send resolves as
# success and poisons its dedup, so a live "working" turn silently reads
# "idle"), and herdr has no screen-detection rule for omp
# (`agent explain` shows evaluated_rules: [], visible_working: false, and
# default_known_agent_idle_fallback). An external `report-agent` from firstmate
# is ignored, so we cannot correct herdr's status field.
#
# Instead firstmate derives the real state directly from the pane screen, which
# is unambiguous: an omp turn in flight renders a braille spinner glyph and an
# `<esc>` interrupt hint next to the composer; an idle turn shows only the empty
# composer box. The supervisor uses THIS instead of trusting agent_status.
#
# Usage:
#   fm-reconcile-status.sh <pane_id>          print: working|idle  (exit 0)
#   fm-reconcile-status.sh --all              one line per live agent pane:
#                                             <pane> <name> herdr=<s> real=<s> [DRIFT]
#   fm-reconcile-status.sh --drift            print only drifting panes; exit 1
#                                             if any pane drifts, else 0
# Strictly read-only: only `herdr pane read` / `herdr pane list`. Never mutates.
set -u

herdr_read() {
  # visible screen of a pane; empty on any failure (fail-open to idle).
  herdr pane read "$1" --source visible --lines 12 2>/dev/null || true
}

# Classify a captured screen as working|idle. Working iff a spinner glyph or the
# interrupt hint is present outside the composer border. The braille spinner set
# omp cycles is U+280B U+2819 U+2839 U+2838 U+283C U+2834 U+2826 U+2827 U+2807
# U+280F; the interrupt hint renders as the literal sequence "esc" inside angle
# brackets while a turn is in flight.
classify_screen() {
  local screen=$1
  # Any non-blank braille cell is an omp spinner frame (a turn in flight); the
  # interrupt hint renders while a turn is in flight for other harnesses too.
  case "$screen" in
    *[⠁-⣿]*) printf 'working\n'; return ;;
    *'esc⟩'*|*'⟨esc'*|*Working*|*Thinking*) printf 'working\n'; return ;;
  esac
  printf 'idle\n'
}

real_state() {
  classify_screen "$(herdr_read "$1")"
}

if [ "${1:-}" = "--all" ] || [ "${1:-}" = "--drift" ]; then
  mode=$1
  panes_json=$(herdr pane list 2>/dev/null || true)
  printf '%s' "$panes_json" | python3 -c '
import json, sys
try:
    panes = json.load(sys.stdin).get("result", {}).get("panes", [])
except Exception:
    panes = []
for p in panes:
    if not isinstance(p, dict):
        continue
    sess = p.get("agent_session")
    if not isinstance(sess, dict) or not sess.get("value"):
        continue
    print("%s\t%s\t%s" % (
        p.get("pane_id") or "unknown",
        p.get("display_agent") or p.get("label") or "unknown",
        p.get("agent_status") or "unknown",
    ))
' | {
    drift_found=0
    while IFS=$(printf '\t') read -r pane name herdr_state; do
      [ -n "$pane" ] || continue
      real=$(real_state "$pane")
      drift=""
      # Drift that matters: real work while herdr says idle/unknown. The reverse
      # (herdr working while screen idle) self-heals on the next turn and is not
      # actionable, so we do not flag it.
      if [ "$real" = working ] && [ "$herdr_state" != working ]; then
        drift="DRIFT"
        drift_found=1
      fi
      if [ "$mode" = "--all" ]; then
        printf '%s %s herdr=%s real=%s %s\n' "$pane" "$name" "$herdr_state" "$real" "$drift"
      elif [ -n "$drift" ]; then
        printf '%s %s herdr=%s real=%s DRIFT\n' "$pane" "$name" "$herdr_state" "$real"
      fi
    done
    exit "$drift_found"
  }
  exit $?
fi

PANE=${1:-}
[ -n "$PANE" ] || { echo "usage: fm-reconcile-status.sh <pane_id> | --all | --drift" >&2; exit 2; }
real_state "$PANE"
