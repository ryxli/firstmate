#!/usr/bin/env bash
# Proves the documented fm-brief -> {TASK} fill -> fm-spawn preparation path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-brief-spawn.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

HOME_DIR="$TMP_ROOT/home"
PROJECT="$HOME_DIR/projects/app"
BIN_DIR="$TMP_ROOT/bin"
HERDR_LOG="$TMP_ROOT/herdr.log"
mkdir -p "$HOME_DIR/data" "$HOME_DIR/state" "$HOME_DIR/config" "$PROJECT" "$BIN_DIR"
: > "$HERDR_LOG"
printf '%s\n' '- app [pr] - test app (added 2026-07-14)' > "$HOME_DIR/data/projects.md"

git -C "$PROJECT" init -q
git -C "$PROJECT" config user.name 'Firstmate Tests'
git -C "$PROJECT" config user.email 'tests@example.invalid'
printf '# app\n' > "$PROJECT/README.md"
git -C "$PROJECT" add README.md
git -C "$PROJECT" commit -qm initial

cat > "$BIN_DIR/codex" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$BIN_DIR/codex"

cat > "$BIN_DIR/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:?}"
case "${1:-} ${2:-}" in
  'agent get')
    printf '{"error":{"code":"agent_not_found"}}\n'
    exit 1
    ;;
  'tab create')
    printf '{"id":"cli:tab:create","result":{"tab":{"tab_id":"w-test:t1"},"root_pane":{"pane_id":"w-test:p0"}}}\n'
    ;;
  'agent start')
    printf '{"id":"cli:agent:start","result":{"agent":{"pane_id":"w-test:p1"}}}\n'
    ;;
  'tab close'|'pane close'|'pane rename')
    ;;
  *)
    printf 'unexpected fake herdr command: %s\n' "$*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$BIN_DIR/herdr"

fill_task() {
  local brief=$1
  TASK_TEXT=$2 python3 - "$brief" <<'PY'
from pathlib import Path
import os
import sys

path = Path(sys.argv[1])
path.write_text(path.read_text().replace('{TASK}', os.environ['TASK_TEXT']))
PY
}

assert_filled() {
  local brief=$1
  ! grep -Eq '\{(GOAL|DELIVERABLE_PATH|EVIDENCE_PACKET|ACCEPTANCE_CRITERION|NON_GOALS|STOPPING_POINT|BLOCKER_OR_NONE|NEXT_ACTION_OR_NONE|SOURCE_REF)\}' "$brief" \
    || fail "$brief still contains an unresolved assignment field"
  ! grep -qF '{TASK}' "$brief" \
    || fail "$brief still contains the task placeholder"
}

scaffold_and_fill() {
  local id=$1 kind=$2 task=$3 brief
  if [ "$kind" = scout ]; then
    FM_HOME="$HOME_DIR" "$ROOT/sbin/fm" brief "$id" app --scout >/dev/null \
      || fail "scout scaffold failed for $id"
  else
    FM_HOME="$HOME_DIR" "$ROOT/sbin/fm" brief "$id" app >/dev/null \
      || fail "ship scaffold failed for $id"
  fi
  brief="$HOME_DIR/data/$id/brief.md"
  fill_task "$brief" "$task"
  assert_filled "$brief"
}

scaffold_and_fill ship-e1 ship 'Implement the ship-path regression and prove the generated brief is spawnable.'
scaffold_and_fill scout-e2 scout 'Investigate the scaffold lifecycle and report stable evidence from the generated brief.'

spawn_one() {
  local id=$1 kind=$2
  local args=("$id" projects/app codex)
  [ "$kind" = scout ] && args+=(--scout)
  FM_ROOT_OVERRIDE="$ROOT" \
    FM_HOME="$HOME_DIR" \
    FM_STATE_OVERRIDE="$HOME_DIR/state" \
    FM_DATA_OVERRIDE="$HOME_DIR/data" \
    FM_CONFIG_OVERRIDE="$HOME_DIR/config" \
    FM_PROJECTS_OVERRIDE="$HOME_DIR/projects" \
    FM_WORKTREE_BASE="$HOME_DIR/worktrees" \
    FM_SPAWN_NO_GUARD=1 \
    FM_SPAWN_WORKSPACE=w-test \
    FM_FAKE_HERDR_LOG="$HERDR_LOG" \
    PATH="$BIN_DIR:$(dirname "$(command -v bun)"):/usr/bin:/bin" \
    "$ROOT/sbin/fm" spawn "${args[@]}" 2>&1
}

ship_output=$(spawn_one ship-e1 ship) || fail "filled ship brief did not reach spawn"
printf '%s\n' "$ship_output" | grep -F 'spawned ship-e1' >/dev/null \
  || fail "ship spawn did not report success"
scout_output=$(spawn_one scout-e2 scout) || fail "filled scout brief did not reach spawn"
printf '%s\n' "$scout_output" | grep -F 'spawned scout-e2' >/dev/null \
  || fail "scout spawn did not report success"

grep -F "cat '$HOME_DIR/data/ship-e1/brief.md'" "$HERDR_LOG" >/dev/null \
  || fail "ship spawn did not launch with its filled brief"
grep -F "cat '$HOME_DIR/data/scout-e2/brief.md'" "$HERDR_LOG" >/dev/null \
  || fail "scout spawn did not launch with its filled brief"
[ -f "$HOME_DIR/state/ship-e1.meta" ] || fail "ship spawn did not write metadata"
[ -f "$HOME_DIR/state/scout-e2.meta" ] || fail "scout spawn did not write metadata"
pass "ship and scout briefs fill with {TASK} alone and reach fm-spawn"
