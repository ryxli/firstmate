#!/usr/bin/env bash
# Verifies generated ship briefs match spawn mechanics: fm-spawn creates the
# worktree already on fm/<id>, so the brief must say so and must not instruct
# the crewmate to run `git checkout -b`.
# shellcheck disable=SC2016  # grep -qF assertions match literal backticks (`peer_send`, `supervisor=`) in generated brief text; single quotes are intentional
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF="$ROOT/sbin/fm-brief.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-brief.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/data"
cat > "$TMP/home/data/projects.md" <<'EOF'
- app - default direct-PR project (added 2026-06-25)
- legacy [no-mistakes] - pipeline-era project (added 2026-06-25)
- local [local-only] - local delivery project (added 2026-06-25)
EOF

scaffold() {
  local id=$1 repo=$2
  FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' FM_STATE_OVERRIDE='' \
    "$BRIEF" "$id" "$repo" >/dev/null 2>&1 || fail "fm-brief.sh failed for $id/$repo"
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
  grep -qF 'Do not proceed with a missing required field.' "$brief" \
    || fail "$brief does not flag incomplete assignment fields"
  grep -qF -- '- Falsifiable goal (exactly one): `{GOAL}`' "$brief" \
    || fail "$brief has no falsifiable goal field"
  grep -qF -- '- Named deliverable path (exactly one): `{DELIVERABLE_PATH}`' "$brief" \
    || fail "$brief has no named deliverable path field"
  grep -qF 'Evidence packet: `{EVIDENCE_PACKET}` - cite stable source references' "$brief" \
    || fail "$brief has no stable-reference evidence packet"
  grep -qF -- '- Acceptance criteria:' "$brief" \
    || fail "$brief has no acceptance criteria field"
  grep -qF -- '- Non-goals: `{NON_GOALS}`' "$brief" \
    || fail "$brief has no non-goals field"
  grep -qF -- '- Stopping point: `{STOPPING_POINT}`' "$brief" \
    || fail "$brief has no stopping point field"
  grep -qF -- '- Method owner: You own the specialist method.' "$brief" \
    || fail "$brief does not assign method ownership"
  grep -qF -- '- Blocker: `{BLOCKER_OR_NONE}`' "$brief" \
    || fail "$brief has no separate blocker field"
  grep -qF -- '- Next action: `{NEXT_ACTION_OR_NONE}`' "$brief" \
    || fail "$brief has no separate next-action field"
  grep -qF 'done: {delivery status}; goal {GOAL}; deliverable {DELIVERABLE_PATH}; evidence {SOURCE_REF,...}; acceptance {criterion=pass|fail,...}; blocker {none|...}; next action {none|...}' "$brief" \
    || fail "$brief has no literal completion return shape"
}

check_assignment_completion() {
  local brief=$1 prefix=$2
  grep -qF "append \`$prefix; goal {GOAL}; deliverable {DELIVERABLE_PATH}; evidence {SOURCE_REF,...}; acceptance {criterion=pass|fail,...}; blocker {none|...}; next action {none|...}\` to the status file, then stop." "$brief" \
    || fail "$brief does not use the assignment completion return"
}

brief=$(scaffold task-a1 app)
check_assignment_contract "$brief"
check_assignment_completion "$brief" 'done: PR {url}'
! grep -qF 'use `peer_send` to send' "$brief" \
  || fail "ordinary ship brief required unavailable peer bus"
check_ship_setup "$brief" task-a1
pass "direct-PR ship brief has the evidence-first assignment contract and status completion"

brief=$(scaffold task-b2 legacy)
check_ship_setup "$brief" task-b2
check_assignment_contract "$brief"
check_assignment_completion "$brief" 'done: PR {url}'
grep -qF 'This project ships **direct-PR**' "$brief" \
  || fail "no-mistakes registry entry did not produce a direct-PR ship brief"
pass "legacy no-mistakes project scaffolds a direct-PR ship brief"

brief=$(scaffold task-local local)
check_assignment_contract "$brief"
check_assignment_completion "$brief" 'done: ready in branch fm/task-local'
! grep -qF 'use `peer_send` to send' "$brief" \
  || fail "local-only brief required unavailable peer bus"
pass "local-only ship brief has the evidence-first assignment contract and status completion"

scout="$TMP/home/data/scout-d4/brief.md"
FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' FM_STATE_OVERRIDE='' \
  "$BRIEF" scout-d4 app --scout >/dev/null 2>&1 \
  || fail "fm-brief.sh failed for scout-d4/app"
check_assignment_contract "$scout"
check_assignment_completion "$scout" "done: report $TMP/home/data/scout-d4/report.md"
! grep -qF 'use `peer_send` to send' "$scout" \
  || fail "scout brief required unavailable peer bus"
pass "scout brief has the evidence-first assignment contract and status completion"

secondmate="$TMP/home/data/secondmate-c3/brief.md"
FM_HOME="$TMP/home" FM_SECONDMATE_CHARTER='operations supervision' \
  "$BRIEF" secondmate-c3 --secondmate app >/dev/null 2>&1 \
  || fail "secondmate charter scaffold failed"
grep -qF 'Supervision is automatic and in-process; there is no watcher, wake-queue, beacon' "$secondmate" \
  || fail "secondmate charter did not describe automatic in-process supervision"
grep -qF 'direct crewmate status-file reporting' "$secondmate" \
  || fail "secondmate charter dropped direct status-file reporting"
grep -qF 'fm-send.sh' "$secondmate" \
  || fail "secondmate charter dropped fm-send.sh pane steering"
grep -qF 'Escalate only captain-actionable transition states' "$secondmate" \
  || fail "secondmate charter did not restrict escalation states"
grep -qF 'through the fleet peer bus' "$secondmate" \
  || fail "secondmate charter dropped peer-bus escalation"
grep -qF 'type /peer send fm "{state}: {one short line}"' "$secondmate" \
  || fail "secondmate charter did not use canonical lowercase routing id"
pass "secondmate charter uses automatic supervision and canonical peer-bus escalation"
