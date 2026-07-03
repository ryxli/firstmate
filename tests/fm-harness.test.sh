#!/usr/bin/env bash
# Harness detection (fm-harness.sh) and the per-adapter launch templates
# (fm-spawn.sh launch_template). Pins the omp adapter and guards the omp/claude
# ordering regression: omp sets BOTH OMPCODE=1 and CLAUDECODE=1, so detection
# MUST check OMPCODE first or omp misdetects as claude.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT/bin/fm-harness.sh"
SPAWN="$ROOT/bin/fm-spawn.sh"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# Run detection with a clean slate for the harness env markers so the host's
# own environment cannot leak into a case.
detect() {
  env -u OMPCODE -u CLAUDECODE -u PI_CODING_AGENT "$@" "$HARNESS"
}

# --- detection: environment markers -----------------------------------------

test_omp_marker_wins_over_claude() {
  # The regression guard: omp exports OMPCODE and CLAUDECODE together.
  local out
  out=$(detect OMPCODE=1 CLAUDECODE=1)
  [ "$out" = omp ] || fail "omp+claude env misdetected as '$out' (expected omp)"
  pass "OMPCODE wins over CLAUDECODE (omp not misdetected as claude)"
}

test_claude_marker_alone() {
  local out
  out=$(detect CLAUDECODE=1)
  [ "$out" = claude ] || fail "CLAUDECODE-only misdetected as '$out' (expected claude)"
  pass "CLAUDECODE alone detects claude"
}

test_omp_marker_alone() {
  local out
  out=$(detect OMPCODE=1)
  [ "$out" = omp ] || fail "OMPCODE-only misdetected as '$out' (expected omp)"
  pass "OMPCODE alone detects omp"
}

test_pi_marker() {
  local out
  out=$(detect PI_CODING_AGENT=true)
  [ "$out" = pi ] || fail "PI_CODING_AGENT misdetected as '$out' (expected pi)"
  pass "PI_CODING_AGENT detects pi"
}

# --- launch templates --------------------------------------------------------

# Extract just the launch_template function from fm-spawn.sh and source it so we
# can assert the resolved command per adapter without running the full script.
load_launch_template() {
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-launch-template.XXXXXX") || return 1
  awk '/^launch_template\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SPAWN" > "$tmp"
  # shellcheck disable=SC1090
  . "$tmp"
  rm -f "$tmp"
}

test_omp_launch_template() {
  load_launch_template || fail "could not load launch_template from fm-spawn.sh"
  local out
  out=$(launch_template omp)
  # shellcheck disable=SC2016  # the template literally contains $(cat ...) and the flag placeholders; they must stay unexpanded
  [ "$out" = 'omp --auto-approve __MODELFLAG____EFFORTFLAG__"$(cat __BRIEF__)"' ] \
    || fail "omp launch template wrong: '$out'"
  pass "omp launch template uses --auto-approve, the model/effort placeholders, and the brief"
}

# The placeholders must collapse to nothing when neither axis is set, so an
# unpinned omp spawn's command is byte-identical to before this knob existed.
test_omp_template_collapses_without_flags() {
  load_launch_template || fail "could not load launch_template from fm-spawn.sh"
  local out
  out=$(launch_template omp)
  out=${out//__MODELFLAG__/}
  out=${out//__EFFORTFLAG__/}
  # shellcheck disable=SC2016
  [ "$out" = 'omp --auto-approve "$(cat __BRIEF__)"' ] \
    || fail "omp template did not collapse to the baseline command: '$out'"
  pass "empty model/effort collapse the omp template to the unchanged baseline"
}

test_known_templates_resolve() {
  load_launch_template || fail "could not load launch_template from fm-spawn.sh"
  local h
  for h in omp claude codex opencode pi; do
    launch_template "$h" >/dev/null || fail "no launch template for known adapter '$h'"
  done
  pass "every known adapter (omp/claude/codex/opencode/pi) has a launch template"
}

test_unknown_template_fails() {
  load_launch_template || fail "could not load launch_template from fm-spawn.sh"
  if launch_template definitely-not-a-harness >/dev/null 2>&1; then
    fail "launch_template accepted an unknown adapter"
  fi
  pass "launch_template rejects an unknown adapter"
}
# --- model/effort flag mappers -----------------------------------------------

# Source the fm_shell_quote dependency plus the two flag-mapper functions from
# fm-spawn.sh so we can assert the per-harness CLI fragments in isolation.
load_flag_mappers() {
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-flag-mappers.XXXXXX") || return 1
  # shellcheck disable=SC1090
  . "$ROOT/bin/fm-spawn-lib.sh"
  awk '/^model_flag_for_harness\(\) \{/{f=1} /^effort_flag_for_harness\(\) \{/{f=1} f{print} f&&/^\}/{f=0}' "$SPAWN" > "$tmp"
  # shellcheck disable=SC1090
  . "$tmp"
  rm -f "$tmp"
}

test_model_flag_omp_fuzzy_passthrough() {
  load_flag_mappers || fail "could not load flag mappers"
  [ "$(model_flag_for_harness omp opus)" = "--model 'opus' " ] \
    || fail "omp model flag wrong: '$(model_flag_for_harness omp opus)'"
  [ "$(model_flag_for_harness omp gpt-5.4-mini)" = "--model 'gpt-5.4-mini' " ] \
    || fail "omp fuzzy model flag wrong: '$(model_flag_for_harness omp gpt-5.4-mini)'"
  pass "model flag passes a fuzzy model through to --model for omp"
}

test_model_flag_empty_and_default_are_omitted() {
  load_flag_mappers || fail "could not load flag mappers"
  [ -z "$(model_flag_for_harness omp '')" ] || fail "empty model should produce no flag"
  [ -z "$(model_flag_for_harness omp default)" ] || fail "'default' model should produce no flag"
  pass "empty or 'default' model produces no --model flag"
}

test_effort_flag_omp_maps_to_thinking() {
  load_flag_mappers || fail "could not load flag mappers"
  [ "$(effort_flag_for_harness omp low)" = "--thinking 'low' " ] \
    || fail "omp low effort wrong: '$(effort_flag_for_harness omp low)'"
  [ "$(effort_flag_for_harness omp xhigh)" = "--thinking 'xhigh' " ] \
    || fail "omp xhigh effort wrong"
  # omp has no 'max' thinking level; max maps to its top concrete level, xhigh.
  [ "$(effort_flag_for_harness omp max)" = '--thinking xhigh ' ] \
    || fail "omp max effort should map to --thinking xhigh, got '$(effort_flag_for_harness omp max)'"
  pass "effort maps to omp --thinking (max -> xhigh)"
}

test_effort_flag_codex_uses_reasoning_config_and_omits_max() {
  load_flag_mappers || fail "could not load flag mappers"
  [ "$(effort_flag_for_harness codex high)" = "-c 'model_reasoning_effort=\"high\"' " ] \
    || fail "codex effort wrong: '$(effort_flag_for_harness codex high)'"
  [ -z "$(effort_flag_for_harness codex max)" ] \
    || fail "codex has no max reasoning level; it should be omitted"
  pass "codex effort uses model_reasoning_effort and omits max"
}

test_effort_flag_opencode_omitted() {
  load_flag_mappers || fail "could not load flag mappers"
  [ -z "$(effort_flag_for_harness opencode high)" ] \
    || fail "opencode has no verified effort flag; it should be omitted"
  pass "opencode effort is omitted (no verified flag)"
}

# --- secondmate harness/model/effort resolution ------------------------------

# Run fm-harness.sh against a scratch config home holding a given
# config/secondmate-harness line (or none). Echoes stdout.
sm_harness() {
  local content=$1 sub=$2 home
  home=$(mktemp -d "${TMPDIR:-/tmp}/fm-sm-harness.XXXXXX") || return 1
  mkdir -p "$home/config"
  [ "$content" = __NONE__ ] || printf '%s\n' "$content" > "$home/config/secondmate-harness"
  env -u OMPCODE -u CLAUDECODE -u PI_CODING_AGENT \
    FM_HOME="$home" FM_CONFIG_OVERRIDE="$home/config" "$HARNESS" "$sub"
  rm -rf "$home"
}

test_secondmate_pins_harness_model_effort() {
  [ "$(sm_harness 'codex gpt-5.4-mini high' secondmate)" = codex ] \
    || fail "secondmate harness token not resolved"
  [ "$(sm_harness 'codex gpt-5.4-mini high' secondmate-model)" = gpt-5.4-mini ] \
    || fail "secondmate model token not resolved"
  [ "$(sm_harness 'codex gpt-5.4-mini high' secondmate-effort)" = high ] \
    || fail "secondmate effort token not resolved"
  pass "config/secondmate-harness pins harness, model, and effort"
}

test_secondmate_harness_only_leaves_model_effort_empty() {
  # A bare "<harness>" (with comments/blank lines) behaves as harness-only.
  [ "$(sm_harness $'# pin\n\n  opus  ' secondmate)" = opus ] \
    || fail "harness-only line not resolved/trimmed"
  [ -z "$(sm_harness $'# pin\n\n  opus  ' secondmate-model)" ] \
    || fail "harness-only line should have no model token"
  [ -z "$(sm_harness $'# pin\n\n  opus  ' secondmate-effort)" ] \
    || fail "harness-only line should have no effort token"
  pass "a harness-only secondmate-harness line yields no model/effort"
}

test_secondmate_absent_or_default_yields_no_model() {
  [ -z "$(sm_harness __NONE__ secondmate-model)" ] \
    || fail "absent secondmate-harness should yield no model"
  [ -z "$(sm_harness 'default sonnet low' secondmate-model)" ] \
    || fail "'default' harness token should yield no model (defers to crew)"
  pass "absent or 'default' secondmate-harness yields no model pin"
}

test_omp_marker_wins_over_claude
test_claude_marker_alone
test_omp_marker_alone
test_pi_marker
test_omp_launch_template
test_omp_template_collapses_without_flags
test_known_templates_resolve
test_unknown_template_fails
test_model_flag_omp_fuzzy_passthrough
test_model_flag_empty_and_default_are_omitted
test_effort_flag_omp_maps_to_thinking
test_effort_flag_codex_uses_reasoning_config_and_omits_max
test_effort_flag_opencode_omitted
test_secondmate_pins_harness_model_effort
test_secondmate_harness_only_leaves_model_effort_empty
test_secondmate_absent_or_default_yields_no_model
