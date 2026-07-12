#!/usr/bin/env bash
# Verifies generated ship briefs match spawn mechanics: fm-spawn creates the
# worktree already on fm/<id>, so the brief must say so and must not instruct
# the crewmate to run `git checkout -b`.
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

brief=$(scaffold task-a1 app)
grep -qF 'use `peer_send` to send `done: PR {url}` to that supervisor, then stop.' "$brief" \
  || fail "direct-PR ship brief did not instruct supervisor peer completion"
check_ship_setup "$brief" task-a1
pass "direct-PR ship brief uses the precreated fm/<id> branch"
pass "direct-PR ship brief sends completion to its recorded supervisor"

brief=$(scaffold task-b2 legacy)
check_ship_setup "$brief" task-b2
grep -qF 'This project ships **direct-PR**' "$brief" \
  || fail "no-mistakes registry entry did not produce a direct-PR ship brief"
pass "legacy no-mistakes project scaffolds a direct-PR ship brief"

brief=$(scaffold task-local local)
grep -qF 'use `peer_send` to send `done: ready in branch fm/task-local` to that supervisor, then stop.' "$brief" \
  || fail "local-only ship brief did not instruct supervisor peer completion"
pass "local-only ship brief sends completion to its recorded supervisor"

scout="$TMP/home/data/scout-d4/brief.md"
FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' FM_STATE_OVERRIDE='' \
  "$BRIEF" scout-d4 app --scout >/dev/null 2>&1 \
  || fail "fm-brief.sh failed for scout-d4/app"
grep -qF 'read `supervisor=` from' "$scout" \
  || fail "scout brief did not read its recorded supervisor"
grep -qF 'use `peer_send` to send `done: {one-line conclusion}` to that supervisor, then stop.' "$scout" \
  || fail "scout brief did not instruct supervisor peer completion"
pass "scout brief sends completion to its recorded supervisor"

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
grep -qF 'States: needs-decision, blocked, done, failed.' "$secondmate" \
  || fail "secondmate charter listed non-actionable escalation states"
pass "secondmate charter uses automatic supervision and captain-actionable peer-bus escalation"
