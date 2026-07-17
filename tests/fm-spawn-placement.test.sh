#!/usr/bin/env bash
# Focused launch-command placement tests for fm-spawn.sh.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/sbin/fm-spawn.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-spawn-placement.XXXXXX")
# shellcheck source=sbin/fm-spawn-lib.sh
. "$ROOT/sbin/fm-spawn-lib.sh"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
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
  printf '%s\n' '- demo [direct-PR] - test project' > "$home/data/projects.md"
  printf '%s\n' "$home"
}

make_secondmate_home() {
  local name=$1 id=$2 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/config" "$home/data" "$home/projects" "$home/sbin" "$home/state"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
  printf '# Test secondmate\n' > "$home/AGENTS.md"
  printf 'charter\n' > "$home/data/charter.md"
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
    "$SPAWN" "$@" >/dev/null
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

test_omp_secondmate_uses_launched_home_overlay_once() {
  local home fakebin secondmate secondmate_abs sq_overlay sq_brief expected actual count
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
  expected="$(secondmate_prefix "$secondmate_abs")omp --config $sq_overlay --auto-approve \"\$(cat $sq_brief)\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "OMP secondmate launch did not safely quote the launched home's overlay"
  count=$(printf '%s' "$actual" | grep -o -- '--config' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || fail "OMP secondmate launch included $count --config flags instead of exactly one: $actual"
  case "$actual" in *"$home/config/omp.yml"*) fail "launch used the supervising home's overlay: $actual" ;; esac
  pass "OMP secondmate uses exactly one safely quoted overlay from its launched home"
}

test_omp_secondmate_resume_uses_home_overlay_once() {
  local home fakebin secondmate secondmate_abs sq_overlay expected actual count
  home=$(make_supervisor_home resume)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home resume-secondmate resume-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"
  printf 'home=%s\n' "$secondmate_abs" > "$home/state/resume-mate.meta"

  run_spawn "$home" "$fakebin" resume-mate "$secondmate" omp --secondmate \
    || fail "resumed OMP secondmate spawn with a home overlay failed"

  sq_overlay=$(fm_shell_quote "$secondmate_abs/config/omp.yml")
  expected="$(secondmate_prefix "$secondmate_abs")omp --config $sq_overlay --auto-approve -c; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "OMP secondmate resume lost the home overlay or existing continue behavior"
  count=$(printf '%s' "$actual" | grep -o -- '--config' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || fail "resumed OMP secondmate launch included $count --config flags instead of exactly one: $actual"
  pass "OMP secondmate resume keeps continue behavior and exactly one home overlay"
}

test_omp_secondmate_without_home_overlay_is_exact_baseline() {
  local home fakebin secondmate secondmate_abs sq_brief expected actual
  home=$(make_supervisor_home absent)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home absent-secondmate absent-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'supervising: true\n' > "$home/config/omp.yml"

  run_spawn "$home" "$fakebin" absent-mate "$secondmate" omp --secondmate \
    || fail "OMP secondmate spawn without a home overlay failed"

  sq_brief=$(fm_shell_quote "$secondmate_abs/data/charter.md")
  expected="$(secondmate_prefix "$secondmate_abs")omp --auto-approve \"\$(cat $sq_brief)\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "absent secondmate overlay changed the baseline OMP command"
  pass "absent secondmate overlay leaves the OMP launch byte-for-byte unchanged"
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

test_raw_secondmate_launch_is_exact_baseline() {
  local home fakebin secondmate secondmate_abs raw expected actual
  home=$(make_supervisor_home raw-secondmate)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home raw-secondmate-home raw-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'secondmate: true\n' > "$secondmate/config/omp.yml"
  raw='OMP_MODE=manual omp --model custom/raw "literal raw command"'

  run_spawn "$home" "$fakebin" raw-mate "$secondmate" "$raw" --secondmate \
    || fail "raw OMP secondmate spawn with an overlay failed"

  expected="$(secondmate_prefix "$secondmate_abs")$raw; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "overlay handling changed a raw secondmate command"
  pass "raw secondmate launch remains byte-for-byte unchanged"
}

test_omp_secondmate_fresh_spawn_threads_crew_model() {
  local home fakebin secondmate secondmate_abs sq_model sq_brief expected actual model
  model='anthropic/opus'
  home=$(make_supervisor_home crew-model-fresh)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home crew-model-fresh-secondmate model-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)

  run_spawn "$home" "$fakebin" model-mate "$secondmate" omp --secondmate --crew-model "$model" \
    || fail "OMP secondmate spawn with --crew-model failed"

  sq_model=$(fm_shell_quote "$model")
  sq_brief=$(fm_shell_quote "$secondmate_abs/data/charter.md")
  expected="$(secondmate_prefix "$secondmate_abs")omp --model $sq_model --auto-approve \"\$(cat $sq_brief)\"; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "secondmate fresh spawn dropped the pinned crew model"
  pass "secondmate fresh spawn threads --crew-model into the launch template"
}

test_omp_secondmate_resume_threads_crew_model() {
  local home fakebin secondmate secondmate_abs sq_model expected actual model
  model='anthropic/opus'
  home=$(make_supervisor_home crew-model-resume)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home crew-model-resume-secondmate resume-model-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)
  printf 'home=%s\n' "$secondmate_abs" > "$home/state/resume-model-mate.meta"

  run_spawn "$home" "$fakebin" resume-model-mate "$secondmate" omp --secondmate --crew-model "$model" \
    || fail "resumed OMP secondmate spawn with --crew-model failed"

  sq_model=$(fm_shell_quote "$model")
  expected="$(secondmate_prefix "$secondmate_abs")omp --model $sq_model --auto-approve -c; exec \"\${SHELL:-/bin/zsh}\" -l"
  actual=$(captured_command "$home")
  assert_equal "$expected" "$actual" "secondmate resume dropped the pinned crew model"
  pass "secondmate resume threads --crew-model into the -c relaunch"
}

test_secondmate_meta_records_crew_model() {
  local home fakebin secondmate secondmate_abs model meta_value
  model='anthropic/opus'
  home=$(make_supervisor_home crew-model-meta)
  fakebin=$(make_fake_herdr "$home")
  secondmate=$(make_secondmate_home crew-model-meta-secondmate meta-model-mate)
  secondmate_abs=$(cd "$secondmate" && pwd -P)

  run_spawn "$home" "$fakebin" meta-model-mate "$secondmate" omp --secondmate --crew-model "$model" \
    || fail "OMP secondmate spawn with --crew-model failed"

  meta_value=$(grep '^crew_model=' "$home/state/meta-model-mate.meta" | cut -d= -f2-)
  [ "$meta_value" = "$model" ] || fail "secondmate meta did not record crew_model=$model (got: $meta_value)"
  pass "secondmate meta records the pinned crew model so a later relaunch can restore it"
}

expected_ordinary_template() {
  local harness=$1 model=$2 brief=$3 sq_model sq_brief
  sq_model=$(fm_shell_quote "$model")
  sq_brief=$(fm_shell_quote "$brief")
  case "$harness" in
    omp) printf 'omp --model %s --auto-approve "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    claude) printf 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --model %s --dangerously-skip-permissions "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    codex) printf 'codex --model %s --dangerously-bypass-approvals-and-sandbox "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    opencode) printf 'OPENCODE_CONFIG_CONTENT='"'"'{"permission":{"*":"allow"}}'"'"' opencode --model %s --prompt "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    pi) printf 'pi --model %s "$(cat %s)"' "$sq_model" "$sq_brief" ;;
    *) return 1 ;;
  esac
}

test_all_ordinary_templates_are_exact_baselines() {
  local harness home fakebin project id brief model expected actual
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

    expected="$(expected_ordinary_template "$harness" "$model" "$brief"); exec \"\${SHELL:-/bin/zsh}\" -l"
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

test_omp_secondmate_uses_launched_home_overlay_once
test_omp_secondmate_resume_uses_home_overlay_once
test_omp_secondmate_without_home_overlay_is_exact_baseline
test_non_omp_secondmate_is_exact_baseline
test_raw_secondmate_launch_is_exact_baseline
test_omp_secondmate_fresh_spawn_threads_crew_model
test_omp_secondmate_resume_threads_crew_model
test_secondmate_meta_records_crew_model
test_all_ordinary_templates_are_exact_baselines
test_raw_ordinary_launch_is_exact_baseline
