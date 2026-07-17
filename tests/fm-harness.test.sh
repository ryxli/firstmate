#!/usr/bin/env bash
# Harness detection (fm harness) and the per-adapter launch templates
# (fm spawn launch_template). Pins the omp adapter and guards the omp/claude
# ordering regression: omp sets BOTH OMPCODE=1 and CLAUDECODE=1, so detection
# MUST check OMPCODE first or omp misdetects as claude.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FM="$ROOT/sbin/fm"
SPAWN_TS="$ROOT/.omp/extensions/cli/verbs/spawn.ts"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# Run detection with a clean slate for the harness env markers so the host's
# own environment cannot leak into a case.
detect() {
  env -u OMPCODE -u CLAUDECODE -u PI_CODING_AGENT "$@" "$FM" harness
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

test_omp_launch_template() {
  local out
  out=$(bun -e 'import { LAUNCH_TEMPLATES } from "'"$SPAWN_TS"'"; console.log(LAUNCH_TEMPLATES.omp)')
  # shellcheck disable=SC2016 # literal command-substitution text is the expected template
  [ "$out" = 'omp --auto-approve "$(cat __BRIEF__)"' ] \
    || fail "omp launch template wrong: '$out'"
  pass "omp launch template uses --auto-approve and the brief"
}

test_known_templates_resolve() {
  local h out
  for h in omp claude codex opencode pi; do
    out=$(bun -e 'import { LAUNCH_TEMPLATES } from "'"$SPAWN_TS"'"; console.log(LAUNCH_TEMPLATES[process.argv[1]] || "")' "$h")
    [ -n "$out" ] || fail "no launch template for known adapter '$h'"
  done
  pass "every known adapter (omp/claude/codex/opencode/pi) has a launch template"
}

test_unknown_template_fails() {
  local out
  out=$(bun -e 'import { launchTemplate } from "'"$SPAWN_TS"'"; console.log(launchTemplate("definitely-not-a-harness") === null ? "null" : "value")')
  [ "$out" = null ] || fail "launch_template accepted an unknown adapter"
  pass "launch_template rejects an unknown adapter"
}

test_omp_marker_wins_over_claude
test_claude_marker_alone
test_omp_marker_alone
test_pi_marker
test_omp_launch_template
test_known_templates_resolve
test_unknown_template_fails
