#!/usr/bin/env bash
# Behavior tests for ship/scout workspace routing in fm-spawn.sh.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/sbin/fm-spawn.sh"
TMP_ROOT=
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"
}

trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-spawn-workspace.XXXXXX")
BIN_DIR="$TMP_ROOT/fakebin"
FM_TEST_HOME="$TMP_ROOT/fmhome"
PROJECT="$FM_TEST_HOME/projects/app"
HERDR_LOG="$TMP_ROOT/herdr.log"
mkdir -p "$BIN_DIR" "$FM_TEST_HOME/data" "$FM_TEST_HOME/state" "$FM_TEST_HOME/config" "$PROJECT"
: > "$HERDR_LOG"

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
  'pane current')
    if [ -n "${FM_FAKE_HERDR_OWN_WORKSPACE:-}" ]; then
      printf '{"id":"cli:pane:current","result":{"pane":{"pane_id":"w-owner:p1","workspace_id":"%s"}}}\n' "$FM_FAKE_HERDR_OWN_WORKSPACE"
    else
      printf '{"id":"cli:pane:current","result":{"pane":{"pane_id":"w-owner:p1"}}}\n'
    fi
    ;;
  'agent get')
    printf '{"error":{"code":"agent_not_found"}}\n'
    exit 1
    ;;
  'agent start')
    printf '{"id":"cli:agent:start","result":{"agent":{"pane_id":"w-target:p1"}}}\n'
    ;;
  'tab create')
    printf '{"id":"cli:tab:create","result":{"tab":{"tab_id":"w-target:t1"},"root_pane":{"pane_id":"w-target:p0"}}}\n'
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

make_brief() {
  local id=$1
  mkdir -p "$FM_TEST_HOME/data/$id"
  printf 'test brief\n' > "$FM_TEST_HOME/data/$id/brief.md"
}

run_spawn() {
  local own_workspace=$1 env_workspace=$2 id=$3
  shift 3
  make_brief "$id"
  FM_ROOT_OVERRIDE="$ROOT" \
    FM_HOME="$FM_TEST_HOME" \
    FM_STATE_OVERRIDE="$FM_TEST_HOME/state" \
    FM_DATA_OVERRIDE="$FM_TEST_HOME/data" \
    FM_PROJECTS_OVERRIDE="$FM_TEST_HOME/projects" \
    FM_CONFIG_OVERRIDE="$FM_TEST_HOME/config" \
    FM_WORKTREE_BASE="$FM_TEST_HOME/worktrees" \
    FM_SPAWN_NO_GUARD=1 \
    FM_FAKE_HERDR_LOG="$HERDR_LOG" \
    FM_FAKE_HERDR_OWN_WORKSPACE="$own_workspace" \
    FM_SPAWN_WORKSPACE="$env_workspace" \
    PATH="$BIN_DIR:$BASE_PATH" \
    "$SPAWN" "$id" projects/app codex "$@" 2>&1
}

last_tab_create() {
  grep '^herdr tab create ' "$HERDR_LOG" | tail -1
}

reset_herdr_log() {
  : > "$HERDR_LOG"
}

test_spawn_uses_own_workspace() {
  local out tab_create
  reset_herdr_log
  out=$(run_spawn owner-ws '' workspace-own-z1)
  printf '%s\n' "$out" | grep -F 'spawned workspace-own-z1' >/dev/null \
    || fail "ship spawn did not complete: $out"
  tab_create=$(last_tab_create)
  printf '%s\n' "$tab_create" | grep -F -- '--workspace owner-ws' >/dev/null \
    || fail "ship tab did not use owner workspace: $tab_create"
  printf '%s\n' "$tab_create" | grep -F 'focused-ws' >/dev/null \
    && fail "ship tab used focused workspace: $tab_create"
  pass "ship spawn pins its tab to herdr pane current workspace"
}

test_explicit_workspace_overrides_are_honored() {
  local out tab_create
  reset_herdr_log
  out=$(run_spawn owner-ws '' workspace-cli-z2 --workspace cli-ws)
  printf '%s\n' "$out" | grep -F 'spawned workspace-cli-z2' >/dev/null \
    || fail "CLI workspace override spawn did not complete: $out"
  tab_create=$(last_tab_create)
  printf '%s\n' "$tab_create" | grep -F -- '--workspace cli-ws' >/dev/null \
    || fail "--workspace override was not used: $tab_create"
  grep -F 'herdr pane current' "$HERDR_LOG" >/dev/null \
    && fail "--workspace override should not query the owner workspace"

  reset_herdr_log
  out=$(run_spawn owner-ws env-ws workspace-env-z3)
  printf '%s\n' "$out" | grep -F 'spawned workspace-env-z3' >/dev/null \
    || fail "environment workspace override spawn did not complete: $out"
  tab_create=$(last_tab_create)
  printf '%s\n' "$tab_create" | grep -F -- '--workspace env-ws' >/dev/null \
    || fail "FM_SPAWN_WORKSPACE override was not used: $tab_create"
  grep -F 'herdr pane current' "$HERDR_LOG" >/dev/null \
    && fail "FM_SPAWN_WORKSPACE override should not query the owner workspace"
  pass "explicit workspace overrides take precedence over owner workspace"
}

test_spawn_refuses_without_workspace() {
  local out status
  reset_herdr_log
  out=$(run_spawn '' '' workspace-none-z4)
  status=$?
  [ "$status" -ne 0 ] || fail "spawn without a resolvable workspace should fail"
  printf '%s\n' "$out" | grep -F "cannot resolve this firstmate's herdr workspace" >/dev/null \
    || fail "missing workspace failure was unclear: $out"
  grep -F 'herdr tab create' "$HERDR_LOG" >/dev/null \
    && fail "spawn without a workspace created a tab"
  pass "ship spawn refuses before tab creation without an owner workspace"
}

test_spawn_uses_own_workspace
test_explicit_workspace_overrides_are_honored
test_spawn_refuses_without_workspace

echo '# all fm-spawn-workspace tests passed'
