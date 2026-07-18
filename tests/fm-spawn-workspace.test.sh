#!/usr/bin/env bash
# Behavior tests for ship/scout workspace routing in fm spawn.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/sbin/fm"
TMP_ROOT=
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}
# sbin/fm runs under bun; expose ONLY the real bun binary (not the mise shim
# dir, which would leak every other shimmed tool into the sandbox).
BUNBIN=$(mktemp -d "${TMPDIR:-/tmp}/fm-bunbin.XXXXXX")
ln -s "$(bun -e 'console.log(process.execPath)')" "$BUNBIN/bun"
BASE_PATH="$BASE_PATH:$BUNBIN"

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

for harness_bin in omp claude codex opencode pi; do
  cat > "$BIN_DIR/$harness_bin" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$BIN_DIR/$harness_bin"
done
printf 'codex\n' > "$FM_TEST_HOME/config/crew-harness"

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

run_spawn_harness() {
  local own_workspace=$1 env_workspace=$2 id=$3 harness=$4
  shift 4
  make_brief "$id"
  FM_ROOT_OVERRIDE="$ROOT" \
    FM_HOME="$FM_TEST_HOME" \
    FM_STATE_OVERRIDE="$FM_TEST_HOME/state" \
    FM_DATA_OVERRIDE="$FM_TEST_HOME/data" \
    FM_PROJECTS_OVERRIDE="$FM_TEST_HOME/projects" \
    FM_CONFIG_OVERRIDE="$FM_TEST_HOME/config" \
    FM_WORKTREE_BASE="$FM_TEST_HOME/worktrees" \
    FM_SPAWN_NO_GUARD=1 \
    FM_CREW_MODEL="${FM_TEST_CREW_MODEL:-}" \
    FM_FAKE_HERDR_LOG="$HERDR_LOG" \
    FM_FAKE_HERDR_OWN_WORKSPACE="$own_workspace" \
    FM_SPAWN_WORKSPACE="$env_workspace" \
    PATH="$BIN_DIR:$BASE_PATH" \
    "$SPAWN" spawn "$id" projects/app "$harness" "$@" 2>&1
}

run_spawn() {
  local own_workspace=$1 env_workspace=$2 id=$3
  shift 3
  run_spawn_harness "$own_workspace" "$env_workspace" "$id" codex "$@"
}

run_batch_spawn() {
  local own_workspace=$1 env_workspace=$2
  shift 2
  FM_ROOT_OVERRIDE="$ROOT" \
    FM_HOME="$FM_TEST_HOME" \
    FM_STATE_OVERRIDE="$FM_TEST_HOME/state" \
    FM_DATA_OVERRIDE="$FM_TEST_HOME/data" \
    FM_PROJECTS_OVERRIDE="$FM_TEST_HOME/projects" \
    FM_CONFIG_OVERRIDE="$FM_TEST_HOME/config" \
    FM_WORKTREE_BASE="$FM_TEST_HOME/worktrees" \
    FM_SPAWN_NO_GUARD=1 \
    FM_CREW_MODEL="${FM_TEST_CREW_MODEL:-}" \
    FM_FAKE_HERDR_LOG="$HERDR_LOG" \
    FM_FAKE_HERDR_OWN_WORKSPACE="$own_workspace" \
    FM_SPAWN_WORKSPACE="$env_workspace" \
    PATH="$BIN_DIR:$BASE_PATH" \
    "$SPAWN" spawn "$@" 2>&1
}

last_tab_create() {
  grep '^herdr tab create ' "$HERDR_LOG" | tail -1
}

last_agent_start() {
  grep '^herdr agent start ' "$HERDR_LOG" | tail -1
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

test_crew_model_flag_injected_for_template_harnesses() {
  local harness id out agent_start expected
  for harness in omp claude codex opencode pi; do
    reset_herdr_log
    id="model-${harness}-z5"
    out=$(run_spawn_harness owner-ws '' "$id" "$harness" --crew-model openai/gpt-5)
    printf '%s\n' "$out" | grep -F "spawned $id" >/dev/null \
      || fail "$harness spawn with --crew-model did not complete: $out"
    agent_start=$(last_agent_start)
    case "$harness" in
      omp) expected="omp --append-system-prompt=" ;;
      claude) expected="claude --model 'openai/gpt-5' --dangerously-skip-permissions" ;;
      codex) expected="codex --model 'openai/gpt-5' --dangerously-bypass-approvals-and-sandbox" ;;
      opencode) expected="opencode --model 'openai/gpt-5' --prompt" ;;
      pi) expected="pi --model 'openai/gpt-5' \"\$(cat" ;;
      *) fail "unexpected harness in test: $harness" ;;
    esac
    printf '%s\n' "$agent_start" | grep -F -- "$expected" >/dev/null \
      || fail "$harness launch did not include quoted crew model at the harness-specific location: $agent_start"
    if [ "$harness" = omp ]; then
      grep -F -- " --model 'openai/gpt-5' --auto-approve" "$HERDR_LOG" >/dev/null \
        || fail "omp launch did not preserve crew model placement after the role contract: $(cat "$HERDR_LOG")"
    fi
    grep -F "crew_model=openai/gpt-5" "$FM_TEST_HOME/state/$id.meta" >/dev/null \
      || fail "$harness spawn did not record crew_model metadata"
  done
  pass "--crew-model is injected for omp, claude, codex, opencode, and pi templates"
}

test_no_model_keeps_existing_command_untouched() {
  local id out agent_start expected
  reset_herdr_log
  id=model-none-z10
  out=$(run_spawn owner-ws '' "$id")
  printf '%s\n' "$out" | grep -F "spawned $id" >/dev/null \
    || fail "spawn without a crew model did not complete: $out"
  agent_start=$(last_agent_start)
  expected="codex --dangerously-bypass-approvals-and-sandbox \"\$(cat '$FM_TEST_HOME/data/$id/brief.md')\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  printf '%s\n' "$agent_start" | grep -F -- "$expected" >/dev/null \
    || fail "no-model codex launch command changed: $agent_start"
  printf '%s\n' "$agent_start" | grep -F -- '--model' >/dev/null \
    && fail "no-model codex launch unexpectedly included --model: $agent_start"
  grep -F 'crew_model=' "$FM_TEST_HOME/state/$id.meta" >/dev/null \
    && fail "no-model spawn unexpectedly recorded crew_model metadata"
  pass "omitting a crew model leaves the existing launch command and metadata untouched"
}

test_fm_crew_model_default_is_used() {
  local id out agent_start
  reset_herdr_log
  id=model-env-z11
  out=$(FM_TEST_CREW_MODEL=env/default-model run_spawn owner-ws '' "$id")
  printf '%s\n' "$out" | grep -F "spawned $id" >/dev/null \
    || fail "spawn with FM_CREW_MODEL default did not complete: $out"
  agent_start=$(last_agent_start)
  printf '%s\n' "$agent_start" | grep -F "codex --model 'env/default-model' --dangerously-bypass-approvals-and-sandbox" >/dev/null \
    || fail "FM_CREW_MODEL default was not injected into codex command: $agent_start"
  grep -F 'crew_model=env/default-model' "$FM_TEST_HOME/state/$id.meta" >/dev/null \
    || fail "FM_CREW_MODEL default was not recorded in task metadata"
  pass "FM_CREW_MODEL defaults the ordinary crewmate model when the flag is absent"
}

test_slash_containing_model_stays_intact() {
  local id out agent_start
  reset_herdr_log
  id=model-slash-z12
  out=$(run_spawn_harness owner-ws '' "$id" opencode --crew-model=provider/team/model-v1)
  printf '%s\n' "$out" | grep -F "spawned $id" >/dev/null \
    || fail "spawn with slash-containing crew model did not complete: $out"
  agent_start=$(last_agent_start)
  printf '%s\n' "$agent_start" | grep -F "opencode --model 'provider/team/model-v1' --prompt" >/dev/null \
    || fail "slash-containing crew model was not preserved as one quoted opencode value: $agent_start"
  grep -F 'crew_model=provider/team/model-v1' "$FM_TEST_HOME/state/$id.meta" >/dev/null \
    || fail "slash-containing crew model was not recorded intact"
  pass "slash-containing crew model values stay intact and shell-quoted"
}

test_batch_spawn_forwards_crew_model() {
  local id out agent_start
  reset_herdr_log
  id=model-batch-z13
  make_brief "$id"
  out=$(run_batch_spawn owner-ws '' "$id=projects/app" --crew-model batch/model)
  printf '%s\n' "$out" | grep -F "spawned $id" >/dev/null \
    || fail "batch spawn with --crew-model did not complete: $out"
  agent_start=$(last_agent_start)
  printf '%s\n' "$agent_start" | grep -F "codex --model 'batch/model' --dangerously-bypass-approvals-and-sandbox" >/dev/null \
    || fail "batch re-exec did not forward --crew-model to the ordinary spawn: $agent_start"
  grep -F 'crew_model=batch/model' "$FM_TEST_HOME/state/$id.meta" >/dev/null \
    || fail "batch-forwarded crew model was not recorded in metadata"
  pass "batch id=repo dispatch forwards --crew-model to the re-execed spawn"
}

test_crew_model_flag_injected_for_template_harnesses
test_no_model_keeps_existing_command_untouched
test_fm_crew_model_default_is_used
test_slash_containing_model_stays_intact
test_batch_spawn_forwards_crew_model
test_spawn_uses_own_workspace
test_explicit_workspace_overrides_are_honored
test_spawn_refuses_without_workspace

echo '# all fm-spawn-workspace tests passed'
