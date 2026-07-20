#!/usr/bin/env bash
# Verifies generated ship briefs match spawn mechanics: fm-spawn creates the
# worktree already on fm/<id>, so the brief must say so and must not instruct
# the crewmate to run `git checkout -b`.
# shellcheck disable=SC2016
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF=("$ROOT/sbin/fm" brief)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-brief.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/data"
cat > "$TMP/home/data/projects.md" <<'EOF'
- app - default pr project (added 2026-06-25)
- collab [pr] - collaborative project (added 2026-06-25)
- local [trunk] - trunk delivery project (added 2026-06-25)
EOF

scaffold() {
  local id=$1 repo=$2
  FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' FM_STATE_OVERRIDE='' \
    "${BRIEF[@]}" "$id" "$repo" >/dev/null 2>&1 || fail "fm brief failed for $id/$repo"
  printf '%s\n' "$TMP/home/data/$id/brief.md"
}

check_ship_setup() {
  local brief=$1 id=$2
  grep -qF "already on your branch \`fm/$id\`" "$brief" \
    || fail "$brief does not say the worktree is already on fm/$id"
  ! grep -qF 'git checkout -b' "$brief" \
    || fail "$brief still instructs git checkout -b"
}

check_assignment_contract() {
  local brief=$1
  grep -qF '# Assignment contract' "$brief" \
    || fail "$brief has no assignment contract"
  grep -qF 'only required pre-spawn substitution is `{TASK}`' "$brief" \
    || fail "$brief did not preserve the documented single substitution"
  grep -qF -- '- Falsifiable goal (exactly one): state one measurable outcome' "$brief" \
    || fail "$brief has no falsifiable goal guidance"
  grep -qF -- '- Named deliverable path (exactly one): state the file, report, branch, or PR' "$brief" \
    || fail "$brief has no named deliverable guidance"
  grep -qF 'Evidence packet: cite stable source references' "$brief" \
    || fail "$brief has no stable-reference evidence packet"
  grep -qF -- '- Acceptance criteria:' "$brief" \
    || fail "$brief has no acceptance criteria guidance"
  grep -qF -- '- Non-goals: honor explicit exclusions' "$brief" \
    || fail "$brief has no non-goals guidance"
  grep -qF -- '- Stopping point: stop only after the acceptance criteria are verified.' "$brief" \
    || fail "$brief has no stopping-point guidance"
  grep -qF -- '- Method owner: You own the specialist method.' "$brief" \
    || fail "$brief does not assign method ownership"
  grep -qF -- '- Blocker: report `none` unless a real blocker' "$brief" \
    || fail "$brief has no blocker guidance"
  grep -qF -- '- Next action: report the next concrete action' "$brief" \
    || fail "$brief has no next-action guidance"
  grep -qF 'Completion return shape:' "$brief" \
    || fail "$brief has no completion return shape"
  grep -qF 'done: <delivery status>; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>' "$brief" \
    || fail "$brief has no evidence-first completion return shape"
  ! grep -Eq '\{(GOAL|DELIVERABLE_PATH|EVIDENCE_PACKET|ACCEPTANCE_CRITERION|NON_GOALS|STOPPING_POINT|BLOCKER_OR_NONE|NEXT_ACTION_OR_NONE|SOURCE_REF)\}' "$brief" \
    || fail "$brief still has legacy assignment placeholders"
}

check_assignment_completion() {
  local brief=$1 prefix=$2
  grep -qF "append \`$prefix; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop." "$brief" \
    || fail "$brief does not use the assignment completion return"
}

check_house_blocks() {
  local brief=$1
  grep -qF '# Lean-loop discipline' "$brief" \
    || fail "$brief is missing the Lean-loop discipline block"
  grep -qF '# House tooling conventions' "$brief" \
    || fail "$brief is missing the House tooling conventions block"
  grep -qF 'Use bun/bunx' "$brief" \
    || fail "$brief House tooling conventions block did not name bun/bunx"
  grep -qF 'gh-axi, chrome-devtools-axi, lavish-axi' "$brief" \
    || fail "$brief House tooling conventions block did not name the axi-family CLIs"
}

brief=$(scaffold task-a1 app)
check_assignment_contract "$brief"
check_assignment_completion "$brief" 'done: PR {url}'
! grep -qF 'use `peer_send` to send' "$brief" \
  || fail "ordinary ship brief required unavailable peer bus"
check_ship_setup "$brief" task-a1
check_house_blocks "$brief"
grep -qF 'This project ships **pr**' "$brief" || fail "default project did not produce a pr ship brief"
pass "pr ship brief has the evidence-first assignment contract and status completion"

brief=$(scaffold task-b2 collab)
check_ship_setup "$brief" task-b2
check_assignment_contract "$brief"
check_assignment_completion "$brief" 'done: PR {url}'
grep -qF 'This project ships **pr**' "$brief" || fail "pr registry entry did not produce a pr ship brief"
pass "explicit pr project scaffolds a pr ship brief"

brief=$(scaffold task-local local)
check_assignment_contract "$brief"
check_assignment_completion "$brief" 'done: ready in branch fm/task-local'
grep -qF 'This project ships **trunk**' "$brief" || fail "trunk registry entry did not produce a trunk ship brief"
! grep -qF 'use `peer_send` to send' "$brief" \
  || fail "trunk brief required unavailable peer bus"
pass "trunk ship brief has the evidence-first assignment contract and status completion"

scout="$TMP/home/data/scout-d4/brief.md"
FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' FM_STATE_OVERRIDE='' \
  "${BRIEF[@]}" scout-d4 app --scout >/dev/null 2>&1 \
  || fail "fm brief failed for scout-d4/app"
check_assignment_contract "$scout"
check_assignment_completion "$scout" "done: report $TMP/home/data/scout-d4/report.md"
! grep -qF 'use `peer_send` to send' "$scout" \
  || fail "scout brief required unavailable peer bus"
check_house_blocks "$scout"
pass "scout brief has the evidence-first assignment contract and status completion"
