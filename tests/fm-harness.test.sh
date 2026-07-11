#!/usr/bin/env bash
# Harness detection (fm-harness.sh) and the per-adapter launch templates
# (fm-spawn.sh launch_template). Pins the omp adapter and guards the omp/claude
# ordering regression: omp sets BOTH OMPCODE=1 and CLAUDECODE=1, so detection
# MUST check OMPCODE first or omp misdetects as claude.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT/sbin/fm-harness.sh"
SPAWN="$ROOT/sbin/fm-spawn.sh"

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
  # shellcheck disable=SC2016 # literal command-substitution text is the expected template
  [ "$out" = 'omp --auto-approve "$(cat __BRIEF__)"' ] \
    || fail "omp launch template wrong: '$out'"
  pass "omp launch template uses --auto-approve and the brief"
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

test_omp_marker_wins_over_claude
test_claude_marker_alone
test_omp_marker_alone
test_pi_marker
test_omp_launch_template
test_known_templates_resolve
test_unknown_template_fails
