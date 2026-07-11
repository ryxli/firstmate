#!/usr/bin/env bash
# Verifies generated ship briefs match spawn mechanics: fm-spawn creates the
# worktree already on fm/<id>, so the brief must say so and must not instruct
# the crewmate to run `git checkout -b`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF="$ROOT/bin/fm-brief.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-brief.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/data"
cat > "$TMP/home/data/projects.md" <<'EOF'
- app - default direct-PR project (added 2026-06-25)
- legacy [no-mistakes] - pipeline-era project (added 2026-06-25)
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
check_ship_setup "$brief" task-a1
pass "direct-PR ship brief uses the precreated fm/<id> branch"

brief=$(scaffold task-b2 legacy)
check_ship_setup "$brief" task-b2
grep -qF 'This project ships **direct-PR**' "$brief" \
  || fail "no-mistakes registry entry did not produce a direct-PR ship brief"
pass "legacy no-mistakes project scaffolds a direct-PR ship brief"
