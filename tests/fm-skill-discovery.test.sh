#!/usr/bin/env bash
# Discovery gate for fm-* skill corpus (candidate + disposable home configs).
# Proves filesystem registry completeness and isolated home-skills selection.
# Does not restart live homes.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-skill-discovery.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

REQUIRED=(
  fm-supervise-lanes
  fm-diagnose-startup-fault
  fm-away-mode
  fm-operate-crew-harness
  fm-update-firstmate
  fm-manage-project-work
  fm-adopt-or-reject-change
  fm-reconcile-home-drift
)
DELETED=(
  afk crew-supervisor firstmate-bootstrap firstmate-recovery lane-governance
  lavish-render-delegation firstmate-task-lifecycle firstmate-harness-adapters
  firstmate-evaluation updatefirstmate reconcile-baseline
)

# 1. Candidate Main: every required skill file exists with matching name frontmatter
for skill in "${REQUIRED[@]}"; do
  f="$ROOT/.agents/skills/$skill/SKILL.md"
  [ -f "$f" ] || fail "missing $skill"
  head -5 "$f" | grep -q "^name: $skill$" || fail "frontmatter name mismatch: $skill"
done
pass "candidate Main has all fm-* skills with matching names"

# 2. Deleted IDs absent
for skill in "${DELETED[@]}"; do
  [ ! -e "$ROOT/.agents/skills/$skill" ] || fail "deleted skill still present: $skill"
done
pass "deleted skill IDs absent from candidate"

# 3. Disposable specialist homes expose only selected shared skills via home-skills
FM="$ROOT/sbin/fm"
for mate in plum kodiak; do
  home="$TMP/$mate"
  mkdir -p "$home/config" "$home/state" "$home/.omp/skills"
  printf '%s\n' "$mate" > "$home/.fm-secondmate-home"
  printf '%s\n' 'fm-manage-project-work' > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  out=$(FM_CODE_ROOT_OVERRIDE="$ROOT" FM_ROOT_OVERRIDE="$ROOT" "$FM" home-skills sync "$home" 2>&1) \
    || fail "$mate home-skills sync failed: $out"
  [ -L "$home/.omp/skills/fm-manage-project-work" ] \
    || fail "$mate missing managed link for selected skill"
  [ ! -e "$home/.omp/skills/fm-operate-crew-harness" ] \
    || fail "$mate leaked unselected shared skill"
  [ ! -e "$home/.agents" ] && [ ! -L "$home/.agents" ] \
    || fail "$mate still has whole-catalog .agents link"
  grep -q 'includeSkills:' "$home/config/omp.yml" || fail "$mate omp.yml missing includeSkills allowlist"
  grep -q 'fm-manage-project-work' "$home/config/omp.yml" || fail "$mate allowlist missing selected skill"
  grep -q 'fm-operate-crew-harness' "$home/config/omp.yml" && fail "$mate allowlist includes unselected skill"
  pass "$mate disposable home-skills exposes only selected shared skills"
done

# 4. Precise absence error for deleted ID (filesystem level)
if [ -e "$ROOT/.agents/skills/crew-supervisor/SKILL.md" ]; then
  fail "crew-supervisor should be gone"
fi
pass "deleted ID crew-supervisor has no SKILL.md (precise absence)"

# 5. Cue-bearing descriptions present
grep -q 'wedged' "$ROOT/.agents/skills/fm-operate-crew-harness/SKILL.md" || fail "operate skill missing wedged cue"
grep -q 'ADOPT' "$ROOT/.agents/skills/fm-adopt-or-reject-change/SKILL.md" || fail "adopt skill missing ADOPT cue"
grep -q '/afk' "$ROOT/.agents/skills/fm-away-mode/SKILL.md" || fail "away-mode missing /afk cue"
pass "natural cue phrases present in descriptions/bodies"

echo "# skill discovery gate (candidate + disposable homes) passed"
