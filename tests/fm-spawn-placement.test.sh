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
    printf '{"result":{"panes":[]}}\n'
    ;;
  'pane current')
    printf '{"result":{"pane":{"pane_id":"w-parent:p1","workspace_id":"w-parent"}}}\n'
    ;;
  'tab create')
    printf '{"result":{"tab":{"tab_id":"w-parent:t2"},"root_pane":{"pane_id":"w-parent:p2"}}}\n'
    ;;
  'agent get')
    exit 1
    ;;
  'agent start')
    last=
    for arg in "$@"; do last=$arg; done
    printf '%s\n' "$last" > "${FM_FAKE_COMMAND_LOG:?}"
    printf '{"result":{"agent":{"pane_id":"w-parent:p3"}}}\n'
    ;;
  'pane close'|'pane rename'|'tab close')
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

secondmate_prefix() {
  local secondmate_home=$1 sq_home
  sq_home=$(fm_shell_quote "$secondmate_home")
  printf 'FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=%s ' "$sq_home"
}

secondmate_role_arg() {
  local secondmate_home=$1 main_home=$2
  (cd "$ROOT" && SECOND_HOME="$secondmate_home" MAIN_HOME_FOR_ROLE="$main_home" bun -e 'import { secondmateRoleContract } from "./.omp/extensions/cli/lib/role-contract.ts"; import { shellQuote } from "./.omp/extensions/cli/lib/spawn.ts"; console.log("--append-system-prompt=" + shellQuote(secondmateRoleContract({ home: process.env.SECOND_HOME, mainHome: process.env.MAIN_HOME_FOR_ROLE })));')
}

crew_role_arg() {
  local supervisor_home=$1 id=$2
  (cd "$ROOT" && SUPERVISOR_HOME="$supervisor_home" CREW_ID="$id" bun -e 'import { crewRoleContract } from "./.omp/extensions/cli/lib/role-contract.ts"; import { shellQuote } from "./.omp/extensions/cli/lib/spawn.ts"; console.log("--append-system-prompt=" + shellQuote(crewRoleContract({ home: process.env.SUPERVISOR_HOME, mainHome: process.env.SUPERVISOR_HOME, crewId: process.env.CREW_ID, launchingSupervisor: "Test Supervisor" })));')
}

test_omp_secondmate_uses_launched_home_overlay_once() {
  local home fakebin secondmate secondmate_abs sq_overlay sq_brief role_arg expected actual count
  home=$(make_supervisor_home positive)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home "overlay mate's home" overlay-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'supervising: true\n' > "$home/config/omp.yml"
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"

  run_spawn "$home" "$fakebin" overlay-mate "$secondmate" omp --secondmate \
    || fail "OMP secondmate spawn with a home overlay failed"

  sq_overlay=$(fm_shell_quote "$secondmate_abs/config/omp.yml")
  sq_brief=$(fm_shell_quote "$secondmate_abs/data/charter.md")
  role_arg=$(secondmate_role_arg "$secondmate_abs" "$home")
  expected="$(secondmate_prefix "$secondmate_abs")omp $role_arg --config $sq_overlay --auto-approve \"\$(cat $sq_brief)\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "OMP secondmate launch did not safely quote the launched home's overlay"
  count=$(printf '%s' "$actual" | grep -o -- '--config' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || fail "OMP secondmate launch included $count --config flags instead of exactly one: $actual"
  case "$actual" in *"$home/config/omp.yml"*) fail "launch used the supervising home's overlay: $actual" ;; esac
  pass "OMP secondmate uses exactly one safely quoted overlay from its launched home"
}

test_omp_secondmate_resume_uses_home_overlay_once() {
  local home fakebin secondmate secondmate_abs sq_overlay role_arg expected actual count
  home=$(make_supervisor_home resume)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home resume-secondmate resume-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"
  printf 'home=%s\n' "$secondmate_abs" > "$home/state/resume-mate.meta"

  run_spawn "$home" "$fakebin" resume-mate "$secondmate" omp --secondmate \
    || fail "resumed OMP secondmate spawn with a home overlay failed"

  sq_overlay=$(fm_shell_quote "$secondmate_abs/config/omp.yml")
  role_arg=$(secondmate_role_arg "$secondmate_abs" "$home")
  expected="$(secondmate_prefix "$secondmate_abs")omp $role_arg --config $sq_overlay --auto-approve -c; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "OMP secondmate resume lost the home overlay or existing continue behavior"
  count=$(printf '%s' "$actual" | grep -o -- '--config' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || fail "resumed OMP secondmate launch included $count --config flags instead of exactly one: $actual"
  pass "OMP secondmate resume keeps continue behavior and exactly one home overlay"
}

test_omp_secondmate_without_home_overlay_is_exact_baseline() {
  local home fakebin secondmate secondmate_abs sq_brief sq_overlay role_arg expected actual
  home=$(make_supervisor_home absent)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home absent-secondmate absent-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'supervising: true\n' > "$home/config/omp.yml"
  # No pre-seeded omp.yml: home-skills sync creates the canonical overlay before launch.

  run_spawn "$home" "$fakebin" absent-mate "$secondmate" omp --secondmate \
    || fail "OMP secondmate spawn without a pre-seeded home overlay failed"

  sq_brief=$(fm_shell_quote "$secondmate_abs/data/charter.md")
  sq_overlay=$(fm_shell_quote "$secondmate_abs/config/omp.yml")
  role_arg=$(secondmate_role_arg "$secondmate_abs" "$home")
  expected="$(secondmate_prefix "$secondmate_abs")omp $role_arg --config $sq_overlay --auto-approve \"\$(cat $sq_brief)\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "generated secondmate overlay was not injected into the OMP command"
  [ -f "$secondmate_abs/config/omp.yml" ] || fail "home-skills did not create config/omp.yml before launch"
  pass "secondmate launch always passes the canonical home overlay created by home-skills"
}

test_non_omp_secondmate_is_exact_baseline() {
  local home fakebin secondmate secondmate_abs sq_brief expected actual
  home=$(make_supervisor_home non-omp)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home non-omp-secondmate codex-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"

  run_spawn "$home" "$fakebin" codex-mate "$secondmate" codex --secondmate \
    || fail "non-OMP secondmate spawn with an overlay failed"

  sq_brief=$(fm_shell_quote "$secondmate_abs/data/charter.md")
  expected="$(secondmate_prefix "$secondmate_abs")codex --dangerously-bypass-approvals-and-sandbox \"\$(cat $sq_brief)\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "OMP overlay changed a non-OMP secondmate command"
  pass "non-OMP secondmate launch remains byte-for-byte unchanged"
}

# Raw OMP secondmate commands are an operator-owned escape hatch: spawn does
# not inject --config. Isolation is the caller's responsibility when using raw.
test_raw_secondmate_launch_is_exact_baseline() {
  local home fakebin secondmate secondmate_abs raw expected actual
  home=$(make_supervisor_home raw-secondmate)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home raw-secondmate-home raw-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"
  raw='OMP_MODE=manual omp --model custom/raw "literal raw command"'

  run_spawn "$home" "$fakebin" raw-mate "$secondmate" "$raw" --secondmate \
    || fail "raw OMP secondmate spawn failed"

  expected="$(secondmate_prefix "$secondmate_abs")$raw; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "raw escape hatch unexpectedly gained --config injection"
  pass "raw secondmate launch stays operator-owned (no automatic --config)"
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
  [ -n "$secondmate_abs" ] || fail "secondmate home resolution failed"
  pass "secondmate agent start sets PYTHONDONTWRITEBYTECODE=1 to keep its home pyc-free"
}

test_omp_secondmate_uses_launched_home_overlay_once
test_omp_secondmate_resume_uses_home_overlay_once
test_omp_secondmate_without_home_overlay_is_exact_baseline
test_non_omp_secondmate_is_exact_baseline
test_raw_secondmate_launch_is_exact_baseline
test_all_ordinary_templates_are_exact_baselines
test_raw_ordinary_launch_is_exact_baseline
test_agent_start_sets_pythondontwritebytecode
