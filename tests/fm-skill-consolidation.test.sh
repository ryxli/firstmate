#!/usr/bin/env bash
# Behavioral contract for fm afk and whiteboard-write-gate.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FM="$ROOT/sbin/fm"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-skill-consolidation.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

export FM_HOME="$TMP/home"
export FM_STATE_OVERRIDE="$FM_HOME/state"
mkdir -p "$FM_STATE_OVERRIDE"

# --- afk ---
out=$("$FM" afk status) || fail "afk status failed"
case "$out" in *inactive*) pass "afk status inactive";; *) fail "expected inactive: $out";; esac

"$FM" afk enter >/dev/null || fail "afk enter failed"
[ -f "$FM_STATE_OVERRIDE/.afk" ] || fail "afk enter did not create flag"
out=$("$FM" afk status) || fail "afk status after enter"
case "$out" in *active*) pass "afk enter active";; *) fail "expected active: $out";; esac

# half-exit prevention: digest present must clear with exit
printf '# While you were away\n\n## Needs you\n- demo\n' > "$FM_STATE_OVERRIDE/.idle-digest.md"
# idle-digest clear expects its format; begin first if needed
"$FM" idle-digest begin >/dev/null 2>&1 || true
"$FM" afk exit >/dev/null || fail "afk exit failed"
[ ! -f "$FM_STATE_OVERRIDE/.afk" ] || fail "afk exit left flag"
[ ! -f "$FM_STATE_OVERRIDE/.idle-digest.md" ] || fail "afk exit left digest"
pass "afk exit clears flag and digest"

# --- whiteboard-write-gate ---
"$FM" whiteboard-write-gate --self-test || fail "whiteboard-write-gate self-test"
pass "whiteboard-write-gate behavioral cases"

# --- harness registry ---
"$FM" harness inspect omp | grep -q '"exitCommand": "/quit"' || fail "harness inspect omp"
"$FM" harness interrupt-keys opencode | grep -q 'Escape Escape' || fail "opencode double escape"
"$FM" harness exit-command claude | grep -q '/exit' || fail "claude exit"
pass "harness adapter registry inspect"

# --- skill dirs ---
for skill in fm-supervise-lanes fm-diagnose-startup-fault fm-away-mode fm-operate-crew-harness \
  fm-update-firstmate fm-manage-project-work fm-adopt-or-reject-change fm-reconcile-home-drift; do
  [ -f "$ROOT/.agents/skills/$skill/SKILL.md" ] || fail "missing skill $skill"
done
for gone in afk crew-supervisor firstmate-bootstrap firstmate-recovery lane-governance \
  lavish-render-delegation firstmate-task-lifecycle updatefirstmate; do
  [ ! -e "$ROOT/.agents/skills/$gone" ] || fail "obsolete skill still present: $gone"
done
pass "skill corpus rename map"

echo "# skill consolidation phase1/phase2 contract checks passed"
