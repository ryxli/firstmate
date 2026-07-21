#!/usr/bin/env bash
# Focused launch-command placement tests for fm spawn.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/sbin/fm"
SPAWN_LIB_TS="$ROOT/.omp/extensions/cli/lib/spawn.ts"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-spawn-placement.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

fm_shell_quote() {
  bun -e 'import { shellQuote } from "'"$SPAWN_LIB_TS"'"; console.log(shellQuote(process.argv[1]))' "$1"
}

assert_equal() {
  local expected=$1 actual=$2 message=$3
  [ "$actual" = "$expected" ] || fail "$message\nexpected: $expected\nactual:   $actual"
}

assert_registry_workspace() {
  local home=$1 id=$2 expected=$3
  grep -qF -- "- $id " "$home/data/secondmates.md" \
    || fail "missing registry entry for $id"
  grep -qF -- "workspace: $expected;" "$home/data/secondmates.md" \
    || fail "registry workspace for $id was not $expected"
}

assert_meta_workspace() {
  local home=$1 id=$2 expected=$3
  [ -f "$home/state/$id.meta" ] \
    || fail "missing metadata for $id"
  grep -qx "workspace=$expected" "$home/state/$id.meta" \
    || fail "metadata workspace for $id was not $expected"
}

make_fake_herdr() {
  local dir=$1 fakebin
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:?}"
case "${1:-} ${2:-}" in
  'pane list')
    if [ -n "${FM_FAKE_STALE_HOME:-}" ]; then
      if [ -n "${FM_FAKE_USER_TAB:-}" ]; then
        printf '{"result":{"panes":[{"pane_id":"w-parent:p-old","workspace_id":"w-parent","tab_id":"w-parent:t-old","cwd":"%s"},{"pane_id":"w-parent:p-user","workspace_id":"w-parent","tab_id":"%s","cwd":"%s"}]}}\n' "$FM_FAKE_STALE_HOME" "$FM_FAKE_USER_TAB" "$FM_FAKE_STALE_HOME"
      else
        printf '{"result":{"panes":[{"pane_id":"w-parent:p-old","workspace_id":"w-parent","tab_id":"w-parent:t-old","cwd":"%s"}]}}\n' "$FM_FAKE_STALE_HOME"
      fi
    else
      printf '{"result":{"panes":[]}}\n'
    fi
    ;;
  'workspace get')
    if [ -n "${FM_FAKE_MISSING_WORKSPACE:-}" ]; then
      printf '{"error":{"code":"workspace_not_found"}}\n'
      exit 1
    fi
    printf '{"result":{"workspace":{"workspace_id":"w-parent"}}}\n'
    ;;
  'workspace create')
    if [ -n "${FM_FAKE_HERDR_LOG:-}" ]; then
      for arg in "$@"; do
        if [ "$arg" = "--label" ]; then
          shift
          printf '%s\n' "${1:-}" > "${FM_FAKE_HERDR_LOG}.label"
          break
        fi
        shift || break
      done
    fi
    if [ -n "${FM_FAKE_CREATE_MALFORMED:-}" ]; then
      printf '{"result":{"workspace":{"label":"malformed"}}}\n'
    else
      printf '{"result":{"workspace":{"workspace_id":"%s"}}}\n' "${FM_FAKE_CREATED_WORKSPACE:-w-replacement}"
    fi
    ;;
  'workspace list')
    label=
    [ -f "${FM_FAKE_HERDR_LOG}.label" ] && label=$(cat "${FM_FAKE_HERDR_LOG}.label")
    printf '{"result":{"workspaces":[{"workspace_id":"%s","label":"%s"}]}}\n' \
      "${FM_FAKE_CREATED_WORKSPACE:-w-replacement}" "$label"
    ;;
  'pane current')
    printf '{"result":{"pane":{"pane_id":"w-parent:p1","workspace_id":"w-parent"}}}\n'
    ;;
  'pane process-info')
    printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"zsh"}]}}}\n'
    ;;
  'tab create')
    if [ -n "${FM_FAKE_TAB_CREATE_FAIL:-}" ]; then exit 1; fi
    printf '{"result":{"tab":{"tab_id":"w-parent:t2"},"root_pane":{"pane_id":"w-parent:p2"}}}\n'
    ;;
  'agent get')
    if [ -n "${FM_FAKE_HUSK_REAP_FAIL:-}" ]; then
      printf '{"result":{"agent":{"status":"unknown"}}}\n'
    else
      printf '{"error":{"code":"agent_not_found"}}\n'
    fi
    ;;
  'agent start')
    if [ -n "${FM_FAKE_AGENT_START_FAIL:-}" ]; then exit 1; fi
    if [ -n "${FM_FAKE_METADATA_FAIL:-}" ]; then
      rm -f "${FM_FAKE_META_PATH:?}"
      ln -s "${FM_FAKE_META_TARGET:?}" "${FM_FAKE_META_PATH:?}"
    fi
    last=
    for arg in "$@"; do last=$arg; done
    printf '%s\n' "$last" > "${FM_FAKE_COMMAND_LOG:?}"
    if [ -n "${FM_FAKE_AGENT_START_MALFORMED:-}" ]; then
      printf '{"result":{"agent":{}}}\n'
    else
      printf '{"result":{"agent":{"pane_id":"w-parent:p3"}}}\n'
    fi
    ;;
  'pane close'|'pane rename'|'tab close'|'workspace close')
    ;;
esac
SH
  chmod +x "$fakebin/herdr"
  for harness in omp claude codex opencode pi; do
    cat > "$fakebin/$harness" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod +x "$fakebin/$harness"
  done
  printf '%s\n' "$fakebin"
}

make_supervisor_home() {
  local name=$1 home
  home="$TMP_ROOT/$name-supervisor"
  mkdir -p "$home/config" "$home/data" "$home/projects" "$home/state" "$home/worktrees"
  printf 'name=Test Supervisor\n' > "$home/config/identity"
  printf '%s\n' '- demo [pr] - test project' > "$home/data/projects.md"
  printf '%s\n' "$home"
}

make_secondmate_home() {
  local name=$1 id=$2 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/config" "$home/data" "$home/projects" "$home/sbin" "$home/state" "$home/.omp"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
  printf '# Test secondmate\n' > "$home/AGENTS.md"
  printf 'charter\n' > "$home/data/charter.md"
  : > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  printf '%s\n' "$home"
}

make_project() {
  local home=$1 project
  project="$home/projects/demo"
  mkdir -p "$project"
  git -C "$project" init -q
  git -C "$project" config user.name 'Spawn Tests'
  git -C "$project" config user.email 'spawn-tests@example.invalid'
  printf 'seed\n' > "$project/seed.txt"
  git -C "$project" add seed.txt
  git -C "$project" commit -qm initial
  printf '%s\n' "$project"
}

run_spawn() {
  local home=$1 fakebin=$2; shift 2
  : > "$home/herdr.log"
  rm -f "$home/command.log"
  PATH="$fakebin:$PATH" \
    FM_HOME="$home" \
    FM_STATE_OVERRIDE='' FM_DATA_OVERRIDE='' FM_PROJECTS_OVERRIDE='' FM_CONFIG_OVERRIDE='' \
    FM_FAKE_HERDR_LOG="$home/herdr.log" \
    FM_FAKE_COMMAND_LOG="$home/command.log" \
    FM_HUSK_REAP_SETTLE=0 \
    "$SPAWN" spawn "$@" >/dev/null
}

captured_command() {
  local home=$1
  [ -f "$home/command.log" ] || fail "spawn did not capture an agent launch command"
  cat "$home/command.log"
}

crew_role_arg() {
  local supervisor_home=$1 id=$2
  (cd "$ROOT" && SUPERVISOR_HOME="$supervisor_home" CREW_ID="$id" bun -e 'import { crewRoleContract } from "./.omp/extensions/cli/lib/role-contract.ts"; import { shellQuote } from "./.omp/extensions/cli/lib/spawn.ts"; console.log("--append-system-prompt=" + shellQuote(crewRoleContract({ home: process.env.SUPERVISOR_HOME, mainHome: process.env.SUPERVISOR_HOME, crewId: process.env.CREW_ID, launchingSupervisor: "Test Supervisor" })));')
}

test_secondmate_uses_fm_start_payload() {
  local home fakebin secondmate secondmate_abs sq_home expected actual
  home=$(make_supervisor_home fm-start)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home "fm start mate's home" fm-start-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'supervising: true\n' > "$home/config/omp.yml"
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"

  run_spawn "$home" "$fakebin" fm-start-mate "$secondmate" omp --secondmate \
    || fail "secondmate fm start spawn failed"

  sq_home=$(fm_shell_quote "$secondmate_abs")
  expected="FM_HOME=$sq_home ${sq_home}/sbin/fm start; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "secondmate did not launch through its home-local fm start"
  case "$actual" in
    *'omp --auto-approve'*|*' -c'*|*'--config'*|*'--append-system-prompt='*)
      fail "secondmate fm start payload contains direct OMP launch options: $actual"
      ;;
  esac
  grep -qx 'harness=omp' "$home/state/fm-start-mate.meta" \
    || fail "secondmate metadata did not record harness=omp"
  grep -qx 'agent_identity=omp' "$home/state/fm-start-mate.meta" \
    || fail "secondmate metadata did not record agent_identity=omp"
  pass "secondmate launches through an exact FM_HOME-scoped fm start payload"
}

test_secondmate_without_explicit_harness_uses_fm_start() {
  local home fakebin secondmate secondmate_abs sq_home expected actual
  home=$(make_supervisor_home fm-start-default)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home fm-start-default-home fm-start-default-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'claude\n' > "$home/config/crew-harness"

  run_spawn "$home" "$fakebin" fm-start-default-mate "$secondmate" --secondmate \
    || fail "secondmate default fm start spawn failed"

  sq_home=$(fm_shell_quote "$secondmate_abs")
  expected="FM_HOME=$sq_home ${sq_home}/sbin/fm start; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "secondmate default launch did not use fm start"
  pass "secondmate ignores the configured crew harness and uses fm start"
}

test_secondmate_closes_stale_shell_tab() {
  local home fakebin secondmate
  home=$(make_supervisor_home stale-shell-tab)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home stale-shell-tab-home stale-shell-mate)
  printf 'tab=w-parent:t-old\nworkspace=w-parent\n' > "$home/state/stale-shell-mate.meta"

  FM_FAKE_STALE_HOME="$(cd "$secondmate" && pwd -P)" \
    FM_FAKE_USER_TAB=w-parent:t-user \
    run_spawn "$home" "$fakebin" stale-shell-mate "$secondmate" --workspace=w-parent --secondmate \
    || fail "secondmate spawn with a stale shell tab failed"

  grep -qF 'herdr tab close w-parent:t-old' "$home/herdr.log" \
    || fail "secondmate spawn left the recorded stale shell tab in its registered workspace"
  if grep -qF 'herdr tab close w-parent:t-user' "$home/herdr.log"; then
    fail "secondmate spawn closed a same-CWD user shell tab"
  fi
  pass "secondmate spawn closes only the recorded shell tab and preserves user shells"
}

test_recovery_closes_workspace_on_registry_update_failure() {
  local home fakebin secondmate out
  home=$(make_supervisor_home recovery-registry-failure)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home recovery-registry-home recovery-registry-mate)
  printf '%s\n' \
    '- recovery-registry-mate mate (home: '"$secondmate"'; workspace: w-old; name: Mate; scope: test; projects: (none); added 2026-07-20)' \
    '- recovery-registry-mate duplicate (home: '"$secondmate"'; workspace: w-old; name: Mate; scope: test; projects: (none); added 2026-07-20)' \
    > "$home/data/secondmates.md"

  out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE=w-recovery-registry \
    run_spawn "$home" "$fakebin" recovery-registry-mate "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
    || fail "registry update failure unexpectedly succeeded"
  grep -qF 'herdr workspace close w-recovery-registry' "$home/herdr.log" \
    || fail "registry update failure did not close the created workspace"
  if grep -qF 'herdr tab create' "$home/herdr.log"; then
    fail "registry update failure created a tab after recovery failed"
  fi
  pass "registry update failure closes exactly the created recovery workspace"
}

test_atomic_registry_replace_failure_preserves_registry() {
  local home fakebin secondmate out rc registry_before registry workspace_closes temp
  home=$(make_supervisor_home atomic-registry-failure)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home atomic-registry-home atomic-registry-mate)
  registry="$home/data/secondmates.md"
  printf '%s\n' '- atomic-registry-mate mate (home: '"$secondmate"'; workspace: w-old; name: Mate; scope: test; projects: (none); added 2026-07-20)' \
    > "$registry"
  registry_before="$home/registry.before"
  cp "$registry" "$registry_before"

  # A readonly parent blocks creation of the sibling temp, while the
  # existing registry remains readable and therefore byte-for-byte checkable.
  chmod 0555 "$home/data" || fail "could not make the registry parent readonly"
  out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE=w-atomic-registry \
    run_spawn "$home" "$fakebin" atomic-registry-mate "$secondmate" --workspace=w-old --secondmate 2>&1); rc=$?
  chmod 0755 "$home/data" || fail "could not restore registry parent permissions"
  [ "$rc" -ne 0 ] || fail "atomic registry replacement failure unexpectedly succeeded"
  cmp -s "$registry_before" "$registry" \
    || fail "atomic registry replacement failure changed the prior registry bytes"

  for temp in "$home"/data/secondmates.md.tmp-*; do
    [ -e "$temp" ] || continue
    fail "atomic registry replacement left a sibling temp file: $temp"
  done
  workspace_closes=$(grep '^herdr workspace close ' "$home/herdr.log" || true)
  assert_equal 'herdr workspace close w-atomic-registry' "$workspace_closes" \
    "atomic registry failure closed more than its correlated replacement workspace"
  if printf '%s\n' "$workspace_closes" | grep -qF 'herdr workspace close w-old'; then
    fail "atomic registry failure closed the prior registered workspace"
  fi
  pass "atomic registry replacement failure preserves bytes and closes only its replacement"
}

test_recovery_closes_workspace_on_meta_update_failure() {
  local home fakebin secondmate out
  home=$(make_supervisor_home recovery-meta-failure)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home recovery-meta-home recovery-meta-mate)
  printf '%s\n' '- recovery-meta-mate mate (home: '"$secondmate"'; workspace: w-old; name: Mate; scope: test; projects: (none); added 2026-07-20)' \
    > "$home/data/secondmates.md"
  mkdir -p "$home/state/meta-target"
  ln -s "$home/state/meta-target" "$home/state/recovery-meta-mate.meta"

  out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE=w-recovery-meta \
    run_spawn "$home" "$fakebin" recovery-meta-mate "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
    || fail "meta update failure unexpectedly succeeded"
  if grep -qF 'herdr workspace close w-recovery-meta' "$home/herdr.log"; then
    fail "meta update failure closed a workspace while durable metadata rollback was uncertain"
  fi
  assert_registry_workspace "$home" recovery-meta-mate w-recovery-meta
  if grep -qF 'herdr tab create' "$home/herdr.log"; then
    fail "meta update failure created a tab after recovery failed"
  fi
  pass "meta update failure retains the replacement when metadata rollback is unsafe"
}
test_spawn_failure_rolls_back_recovered_workspace() {
  local mode home fakebin secondmate out created id meta_target
  for mode in tab husk agent malformed final; do
    home=$(make_supervisor_home "recovery-$mode-failure")
    fakebin=$(make_fake_herdr "$home")
    secondmate=$(make_secondmate_home "recovery-$mode-home" "recovery-$mode-mate")
    id="recovery-$mode-mate"
    printf '%s\n' "- $id mate (home: $secondmate; workspace: w-old; name: Mate; scope: test; projects: (none); added 2026-07-20)" \
      > "$home/data/secondmates.md"
    printf 'workspace=w-old\n' > "$home/state/$id.meta"
    created="w-recovery-$mode"
    case "$mode" in
      tab)
        out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE="$created" FM_FAKE_TAB_CREATE_FAIL=1 \
          run_spawn "$home" "$fakebin" "$id" "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
          || fail "tab creation failure unexpectedly succeeded"
        ;;
      husk)
        out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE="$created" FM_FAKE_HUSK_REAP_FAIL=1 \
          run_spawn "$home" "$fakebin" "$id" "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
          || fail "husk reap failure unexpectedly succeeded"
        ;;
      agent)
        out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE="$created" FM_FAKE_AGENT_START_FAIL=1 \
          run_spawn "$home" "$fakebin" "$id" "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
          || fail "agent start failure unexpectedly succeeded"
        ;;
      malformed)
        out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE="$created" FM_FAKE_AGENT_START_MALFORMED=1 \
          run_spawn "$home" "$fakebin" "$id" "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
          || fail "malformed agent start unexpectedly succeeded"
        ;;
      final)
        meta_target="$home/state/meta-final-target"
        mkdir -p "$meta_target"
        out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATED_WORKSPACE="$created" \
          FM_FAKE_METADATA_FAIL=1 FM_FAKE_META_PATH="$home/state/$id.meta" FM_FAKE_META_TARGET="$meta_target" \
          run_spawn "$home" "$fakebin" "$id" "$secondmate" --workspace=w-old --secondmate 2>&1); [ "$?" -ne 0 ] \
          || fail "final metadata failure unexpectedly succeeded"
        if grep -qF "herdr workspace close $created" "$home/herdr.log"; then
          fail "final metadata failure closed a workspace while rollback was uncertain"
        fi
        assert_registry_workspace "$home" "$id" "$created"
        continue
        ;;
    esac
    grep -qF "herdr workspace close $created" "$home/herdr.log" \
      || fail "$mode failure did not close exactly the created recovery workspace"
    assert_registry_workspace "$home" "$id" w-old
    assert_meta_workspace "$home" "$id" w-old
  done
  pass "post-recovery failures roll back registry and metadata before closing"
}
test_malformed_create_recovers_from_unique_inventory_match() {
  local home fakebin secondmate out
  home=$(make_supervisor_home malformed-create)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home malformed-create-home malformed-create-mate)
  printf '%s\n' '- malformed-create-mate mate (home: '"$secondmate"'; workspace: w-old; name: Mate; scope: test; projects: (none); added 2026-07-20)' \
    > "$home/data/secondmates.md"
  printf 'workspace=w-old\n' > "$home/state/malformed-create-mate.meta"

  out=$(FM_FAKE_MISSING_WORKSPACE=1 FM_FAKE_CREATE_MALFORMED=1 FM_FAKE_CREATED_WORKSPACE=w-inventory \
    run_spawn "$home" "$fakebin" malformed-create-mate "$secondmate" --workspace=w-old --secondmate 2>&1) \
    || fail "malformed create output did not recover from workspace inventory: $out"
  grep -qF 'herdr workspace list' "$home/herdr.log" \
    || fail "malformed create output did not trigger workspace inventory lookup"
  grep -qF 'herdr workspace rename w-inventory Mate' "$home/herdr.log" \
    || fail "inventory-established workspace was not renamed before durable updates"
  assert_registry_workspace "$home" malformed-create-mate w-inventory
  assert_meta_workspace "$home" malformed-create-mate w-inventory
  pass "malformed create output recovers exactly one temporary-label workspace"
}


test_secondmate_rejects_non_omp_harness_and_raw_command() {
  local home fakebin secondmate out rc expected
  expected='error: fm spawn --secondmate uses fm start and does not accept a harness or launch command'

  home=$(make_supervisor_home reject-harness)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home reject-harness-home reject-harness-mate)
  out=$(run_spawn "$home" "$fakebin" reject-harness-mate "$secondmate" codex --secondmate 2>&1); rc=$?
  [ "$rc" -ne 0 ] || fail "non-OMP secondmate harness was accepted"
  assert_equal "$expected" "$out" "non-OMP secondmate harness error changed"

  home=$(make_supervisor_home reject-raw)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home reject-raw-home reject-raw-mate)
  out=$(run_spawn "$home" "$fakebin" reject-raw-mate "$secondmate" 'omp --auto-approve' --secondmate 2>&1); rc=$?
  [ "$rc" -ne 0 ] || fail "raw secondmate launch command was accepted"
  assert_equal "$expected" "$out" "raw secondmate launch error changed"
  pass "secondmate rejects non-OMP harnesses and raw launch commands"
}

expected_ordinary_template() {
  local harness=$1 model=$2 brief=$3 role_arg=${4:-} sq_model sq_brief
  sq_model=$(fm_shell_quote "$model")
  sq_brief=$(fm_shell_quote "$brief")
  case "$harness" in
    omp) printf 'omp %s --model %s --auto-approve "$(cat %s)"' "$role_arg" "$sq_model" "$sq_brief" ;;
    claude) printf 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --model %s --dangerously-skip-permissions "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    codex) printf 'codex --model %s --dangerously-bypass-approvals-and-sandbox "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    opencode) printf 'OPENCODE_CONFIG_CONTENT='"'"'{"permission":{"*":"allow"}}'"'"' opencode --model %s --prompt "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    pi) printf 'pi --model %s "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    *) return 1 ;;
  esac
}

test_all_ordinary_templates_are_exact_baselines() {
  local harness home fakebin project id brief model role_arg expected actual
  model='openai/gpt-5'
  for harness in omp claude codex opencode pi; do
    home=$(make_supervisor_home "ordinary-$harness")
    fakebin=$(make_fake_herdr "$home")
    project=$(make_project "$home")
    printf 'supervising: true\n' > "$home/config/omp.yml"
    id="ordinary-$harness"
    brief="$home/data/$id/brief.md"
    mkdir -p "$(dirname "$brief")"
    printf 'ordinary brief\n' > "$brief"

    run_spawn "$home" "$fakebin" "$id" "$project" "$harness" --crew-model "$model" \
      || fail "ordinary $harness spawn failed"

    role_arg=""
    [ "$harness" = omp ] && role_arg=$(crew_role_arg "$home" "$id")
    expected="$(expected_ordinary_template "$harness" "$model" "$brief" "$role_arg"); exec \"\${SHELL:-/bin/zsh}\" -l"
    actual=$(captured_command "$home")
    assert_equal "$expected" "$actual" "home overlay changed the ordinary $harness launch or its model handling"
  done
  pass "all ordinary launch templates and model handling remain byte-for-byte unchanged"
}

test_raw_ordinary_launch_is_exact_baseline() {
  local home fakebin project id brief raw expected actual
  home=$(make_supervisor_home raw-ordinary)
  fakebin=$(make_fake_herdr "$home")
  project=$(make_project "$home")
  printf 'supervising: true\n' > "$home/config/omp.yml"
  id=ordinary-raw
  brief="$home/data/$id/brief.md"
  mkdir -p "$(dirname "$brief")"
  printf 'ordinary brief\n' > "$brief"
  raw='OMP_MODE=manual omp --model custom/raw "literal raw command"'

  run_spawn "$home" "$fakebin" "$id" "$project" "$raw" \
    || fail "raw ordinary spawn failed"

  expected="$raw; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "overlay handling changed a raw ordinary command"
  pass "raw ordinary launch remains byte-for-byte unchanged"
}

test_agent_start_sets_pythondontwritebytecode() {
  local home fakebin project id brief agent_start_line secondmate secondmate_abs
  home=$(make_supervisor_home pyc-ordinary)
  fakebin=$(make_fake_herdr "$home")
  project=$(make_project "$home")
  printf 'supervising: true\n' > "$home/config/omp.yml"
  id=pyc-ordinary
  brief="$home/data/$id/brief.md"
  mkdir -p "$(dirname "$brief")"
  printf 'ordinary brief\n' > "$brief"

  run_spawn "$home" "$fakebin" "$id" "$project" omp \
    || fail "ordinary spawn for pyc env assertion failed"

  agent_start_line=$(grep '^herdr agent start ' "$home/herdr.log" | tail -1)
  case "$agent_start_line" in
    *' --env PYTHONDONTWRITEBYTECODE=1 '*) : ;;
    *) fail "ordinary agent start did not set PYTHONDONTWRITEBYTECODE: $agent_start_line" ;;
  esac
  case "$agent_start_line" in
    *' --env FM_AGENT_SLOT=pyc-ordinary '*) : ;;
    *) fail "ordinary agent start did not expose its canonical slot: $agent_start_line" ;;
  esac
  pass "ordinary agent start sets PYTHONDONTWRITEBYTECODE=1 to keep worktrees pyc-free"

  home=$(make_supervisor_home pyc-secondmate)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home pyc-secondmate-home pyc-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"

  run_spawn "$home" "$fakebin" pyc-mate "$secondmate" omp --secondmate \
    || fail "secondmate spawn for pyc env assertion failed"

  agent_start_line=$(grep '^herdr agent start ' "$home/herdr.log" | tail -1)
  case "$agent_start_line" in
    *' --env PYTHONDONTWRITEBYTECODE=1 '*) : ;;
    *) fail "secondmate agent start did not set PYTHONDONTWRITEBYTECODE: $agent_start_line" ;;
  esac
  case "$agent_start_line" in
    *' --env FM_AGENT_SLOT=pyc-mate '*) : ;;
    *) fail "secondmate agent start did not expose its canonical slot: $agent_start_line" ;;
  esac
  [ -n "$secondmate_abs" ] || fail "secondmate home resolution failed"
  pass "secondmate agent start sets PYTHONDONTWRITEBYTECODE=1 to keep its home pyc-free"
}

test_secondmate_uses_fm_start_payload
test_secondmate_without_explicit_harness_uses_fm_start
test_secondmate_closes_stale_shell_tab
test_recovery_closes_workspace_on_registry_update_failure
test_atomic_registry_replace_failure_preserves_registry
test_recovery_closes_workspace_on_meta_update_failure
test_spawn_failure_rolls_back_recovered_workspace
test_malformed_create_recovers_from_unique_inventory_match
test_secondmate_rejects_non_omp_harness_and_raw_command
test_all_ordinary_templates_are_exact_baselines
test_raw_ordinary_launch_is_exact_baseline
test_agent_start_sets_pythondontwritebytecode
