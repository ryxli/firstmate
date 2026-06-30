#!/usr/bin/env bash
# fm-idle-digest.sh - the bounded idle-digest loop's state machine.
#
# When the first mate would otherwise go idle and the captain is away (the
# /afk flag is set, or the captain has been silent past a threshold), it does
# not emit a trickle of tiny per-event closeouts. Instead it consolidates every
# update into ONE running digest and relays a single ~one-screen summary the
# moment the captain returns. This helper owns the mechanical, testable bounds
# of that loop so the documented protocol (skill://idle-digest, AGENTS.md s.8)
# is enforced rather than trusted:
#
#   - begin   idempotent: create the running digest (or resume an in-progress
#             one across a restart) with a started= timestamp and passes=0.
#   - active  pure predicate: exit 0 while the refinement loop may keep running
#             (within the time window AND under the pass cap), exit 1 to STOP.
#   - pass    record one completed refinement pass; exit code mirrors `active`
#             AFTER the increment so the loop self-terminates.
#   - fold    append one bullet under a canonical section (dedups exact repeats,
#             rejects unknown sections) - this is how a closeout that WOULD have
#             woken the captain is folded into the digest instead.
#   - render  print the full accumulated digest (empty sections omitted).
#   - screen  print the one-screen-capped digest: "Needs you" is NEVER
#             truncated; other sections cap at FM_IDLE_DIGEST_SECTION_MAX with
#             an overflow pointer. This is what the captain sees on return.
#   - status  one machine-readable line: started/passes/elapsed/window/active.
#   - clear   delete the running digest (captain returned and was caught up).
#
# Bounds (seconds / counts; 0 disables that bound's refinement entirely):
#   FM_IDLE_DIGEST_WINDOW_SECS   refinement window           (default 1800)
#   FM_IDLE_DIGEST_MAX_PASSES    max refinement passes        (default 12)
#   FM_IDLE_DIGEST_SECTION_MAX   per-section bullet cap (screen)  (default 6)
#
# The loop NEVER changes who approves what or takes any project-mutating /
# destructive action: refinement is read-only, firstmate-repo-safe grooming.
# See skill://idle-digest for the consent, scope, and stop-condition contract.
#
# Usage:
#   fm-idle-digest.sh begin  [reason]
#   fm-idle-digest.sh active
#   fm-idle-digest.sh pass
#   fm-idle-digest.sh fold   <section> <line>
#   fm-idle-digest.sh render
#   fm-idle-digest.sh screen
#   fm-idle-digest.sh status
#   fm-idle-digest.sh clear
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DIGEST="$STATE/.idle-digest.md"

TITLE="# While you were away"
# Canonical sections, in render order. "Needs you" is first and never capped.
CANON=("Needs you" "Landed" "In flight" "Queued & blocked" "Fleet & cost")

WINDOW="${FM_IDLE_DIGEST_WINDOW_SECS:-1800}"
MAX_PASSES="${FM_IDLE_DIGEST_MAX_PASSES:-12}"
SECTION_MAX="${FM_IDLE_DIGEST_SECTION_MAX:-6}"

usage() {
  sed -n '2,/^set -eu/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//' >&2
  exit 2
}

now() { date '+%s'; }

require_digest() {
  [ -f "$DIGEST" ] || {
    echo "fm-idle-digest: no running digest; run 'begin' first" >&2
    exit 3
  }
}

# Read one header field (started|passes|reason) from the digest's metadata line.
header_field() {
  sed -n 's/.*<!-- fm-idle-digest .*'"$1"'=\([^ ]*\).*-->.*/\1/p' "$DIGEST" | head -1
}

is_canon() {
  local s
  for s in "${CANON[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}

# active_check <elapsed> <passes> -> 0 if the loop may continue, else 1.
active_check() {
  local elapsed=$1 passes=$2
  [ "$WINDOW" -gt 0 ] || return 1
  [ "$MAX_PASSES" -gt 0 ] || return 1
  [ "$elapsed" -lt "$WINDOW" ] || return 1
  [ "$passes" -lt "$MAX_PASSES" ] || return 1
  return 0
}

cmd_begin() {
  local reason="${1:-silence}"
  if [ -f "$DIGEST" ]; then
    echo "resumed: started=$(header_field started) passes=$(header_field passes) reason=$(header_field reason)"
    return 0
  fi
  mkdir -p "$STATE"
  {
    printf '<!-- fm-idle-digest started=%s passes=0 reason=%s -->\n' "$(now)" "$reason"
    printf '%s\n\n' "$TITLE"
    local s
    for s in "${CANON[@]}"; do printf '## %s\n' "$s"; done
  } > "$DIGEST"
  echo "begun: started=$(header_field started) reason=$reason window=${WINDOW}s max_passes=$MAX_PASSES"
}

cmd_active() {
  require_digest
  local started passes elapsed
  started=$(header_field started); passes=$(header_field passes)
  elapsed=$(( $(now) - started ))
  active_check "$elapsed" "$passes"
}

cmd_pass() {
  require_digest
  local started passes elapsed
  started=$(header_field started); passes=$(header_field passes)
  passes=$(( passes + 1 ))
  # Rewrite passes= in the metadata header.
  sed -i.bak 's/\(<!-- fm-idle-digest .*passes=\)[0-9]\{1,\}\( \)/\1'"$passes"'\2/' "$DIGEST"
  rm -f "$DIGEST.bak"
  elapsed=$(( $(now) - started ))
  if active_check "$elapsed" "$passes"; then
    echo "pass $passes/$MAX_PASSES (${elapsed}s/${WINDOW}s elapsed)"
    return 0
  fi
  echo "pass $passes/$MAX_PASSES (${elapsed}s/${WINDOW}s elapsed) - loop budget reached, stop refining"
  return 1
}

cmd_fold() {
  [ "$#" -eq 2 ] || usage
  require_digest
  local section=$1 line=${2#- }
  is_canon "$section" || {
    echo "fm-idle-digest: unknown section '$section' (one of: ${CANON[*]})" >&2
    exit 2
  }
  FOLD_TARGET="## $section" FOLD_BULLET="- $line" awk '
    function flush() { if (in_t && !seen && !ins) { print ENVIRON["FOLD_BULLET"]; ins=1 } }
    /^## / {
      flush()
      in_t = ($0 == ENVIRON["FOLD_TARGET"]) ? 1 : 0
      if (in_t) { seen=0; ins=0 }
      print; next
    }
    { if (in_t && $0 == ENVIRON["FOLD_BULLET"]) seen=1; print }
    END { flush() }
  ' "$DIGEST" > "$DIGEST.tmp"
  mv "$DIGEST.tmp" "$DIGEST"
}

# render_digest <cap>  (cap 0 = uncapped; "Needs you" is never capped)
render_digest() {
  awk -v cap="$1" -v protect="## Needs you" '
    function flush(   i, lim) {
      if (heading == "" || n == 0) { heading=""; n=0; return }
      print heading
      lim = n
      if (cap > 0 && heading != protect && n > cap) lim = cap
      for (i = 1; i <= lim; i++) print buf[i]
      if (lim < n) print "- (+" (n - lim) " more; full picture in data/backlog.md)"
      print ""
      heading=""; n=0
    }
    /^<!--/ { next }
    /^# / { print; print ""; next }
    /^## / { flush(); heading=$0; n=0; next }
    /^- / { buf[++n]=$0; next }
    END { flush() }
  ' "$DIGEST"
}

cmd_render() { require_digest; render_digest 0; }
cmd_screen() { require_digest; render_digest "$SECTION_MAX"; }

cmd_status() {
  require_digest
  local started passes reason elapsed act bullets
  started=$(header_field started); passes=$(header_field passes); reason=$(header_field reason)
  elapsed=$(( $(now) - started ))
  if active_check "$elapsed" "$passes"; then act=yes; else act=no; fi
  bullets=$(grep -c '^- ' "$DIGEST" || true)
  echo "started=$started reason=$reason passes=$passes/$MAX_PASSES elapsed=${elapsed}s window=${WINDOW}s active=$act bullets=$bullets"
}

cmd_clear() { rm -f "$DIGEST" "$DIGEST.bak" "$DIGEST.tmp"; echo "cleared"; }

[ "$#" -ge 1 ] || usage
sub=$1; shift
case "$sub" in
  begin)  cmd_begin "$@" ;;
  active) cmd_active ;;
  pass)   cmd_pass ;;
  fold)   cmd_fold "$@" ;;
  render) cmd_render ;;
  screen) cmd_screen ;;
  status) cmd_status ;;
  clear)  cmd_clear ;;
  *)      usage ;;
esac
