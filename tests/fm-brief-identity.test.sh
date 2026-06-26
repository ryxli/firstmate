#!/usr/bin/env bash
# Behavior tests for fm-brief.sh: identity-context propagation into generated
# ship/scout briefs, and the manager-mode delegation defaults in the secondmate
# charter. fm-brief writes files only, so these need no herdr/git stubs.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF="$ROOT/bin/fm-brief.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-brief-identity.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# A home with a Mate identity so the supervisor name/slug are deterministic.
make_home() {
  local name=$1 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/data" "$home/state" "$home/config"
  printf 'name=Mate\nrole=Main firstmate crew supervisor\nparent=captain\n' > "$home/config/identity"
  printf '%s\n' "$home"
}

run_brief() {
  local home=$1; shift
  FM_ROOT_OVERRIDE='' \
    FM_HOME="$home" \
    FM_STATE_OVERRIDE='' FM_DATA_OVERRIDE='' FM_PROJECTS_OVERRIDE='' FM_CONFIG_OVERRIDE='' \
    "$BRIEF" "$@" 2>&1
}

test_ship_brief_has_identity_context() {
  local home out brief iso_line branch_line
  home=$(make_home ship)
  out=$(run_brief "$home" fix-login-k3 myproj) || fail "scaffold failed: $out"
  brief="$home/data/fix-login-k3/brief.md"
  [ -f "$brief" ] || fail "no ship brief written"
  grep -qF '# Identity context' "$brief" || fail "ship brief missing identity context"
  grep -qF 'Supervisor: Mate (Main firstmate crew supervisor)' "$brief" \
    || fail "ship brief missing supervisor name/role"
  grep -qF 'captain > Mate > mate/fix-login' "$brief" \
    || fail "ship brief missing supervision chain"
  grep -qF 'Domain/project workspace: myproj' "$brief" \
    || fail "ship brief missing domain/project workspace"
  grep -qF 'Your visible herdr tab and pane label: mate/fix-login' "$brief" \
    || fail "ship brief missing worker visible label"
  grep -qF "$home/state/fix-login-k3.status" "$brief" \
    || fail "ship brief missing report-back target"
  grep -qF 'Verify isolation before anything else' "$brief" \
    || fail "ship brief missing worktree-isolation assertion"
  grep -qF 'git rev-parse --show-toplevel' "$brief" \
    || fail "ship brief missing the show-toplevel isolation check"
  grep -qF 'do not branch or commit here' "$brief" \
    || fail "ship brief isolation assertion does not tell the crewmate to stop before branching"
  # The isolation assertion comes BEFORE the branch step.
  iso_line=$(grep -n 'Verify isolation before anything else' "$brief" | head -1 | cut -d: -f1)
  branch_line=$(grep -n 'git checkout -b fm/' "$brief" | head -1 | cut -d: -f1)
  [ -n "$iso_line" ] && [ -n "$branch_line" ] && [ "$iso_line" -lt "$branch_line" ] \
    || fail "isolation assertion must precede the branch-creation step"
  pass "ship brief carries the isolation-first assertion before the branch step"
}

test_scout_brief_has_identity_context() {
  local home out brief
  home=$(make_home scout)
  out=$(run_brief "$home" probe-z1 myproj --scout) || fail "scout scaffold failed: $out"
  brief="$home/data/probe-z1/brief.md"
  [ -f "$brief" ] || fail "no scout brief written"
  grep -qF '# Identity context' "$brief" || fail "scout brief missing identity context"
  grep -qF 'Your visible herdr tab and pane label: mate/probe' "$brief" \
    || fail "scout brief missing worker visible label"
  pass "scout brief also propagates identity context"
}

test_brief_identity_defaults_without_config() {
  local home out brief
  home="$TMP_ROOT/noid"
  mkdir -p "$home/data" "$home/state" "$home/config"
  out=$(run_brief "$home" fix-x-k3 myproj) || fail "scaffold failed: $out"
  brief="$home/data/fix-x-k3/brief.md"
  grep -qF 'Supervisor: firstmate' "$brief" || fail "default supervisor name not used"
  grep -qF 'Your visible herdr tab and pane label: fm/fix-x' "$brief" \
    || fail "default worker label (fm/<slug>) not used"
  pass "brief uses neutral identity defaults when no config/identity"
}

test_charter_has_manager_mode_defaults() {
  local home out brief
  home=$(make_home charter)
  out=$(FM_SECONDMATE_CHARTER='Own the dashboard domain.' run_brief "$home" anchor --secondmate dashboard) \
    || fail "charter scaffold failed: $out"
  brief="$home/data/anchor/brief.md"
  [ -f "$brief" ] || fail "no charter written"
  grep -qF '# Manager mode (default)' "$brief" || fail "charter missing manager-mode section"
  grep -qiF 'delegate execution' "$brief" || fail "charter does not say delegate execution by default"
  grep -qiF 'disposable crewmate' "$brief" || fail "charter does not mention disposable crewmates"
  grep -qiF 'responsive' "$brief" || fail "charter does not say stay responsive as supervisor"
  grep -qiF 'serialized lane' "$brief" \
    || fail "charter missing the serialized shared-resource exception"
  pass "secondmate charter encodes manager-mode delegation defaults"
}

test_briefs_report_status_via_helper() {
  # The status-append idiom must be the fm-report.sh helper invocation, never a
  # raw `echo ... >> <status file>` redirect: the omp bash tool blocks an
  # agent's own redirection, so the brief routes status through the helper.
  local home out brief

  home=$(make_home report-ship)
  out=$(run_brief "$home" rep-ship-k1 myproj) || fail "ship scaffold failed: $out"
  brief="$home/data/rep-ship-k1/brief.md"
  [ -f "$brief" ] || fail "no ship brief written"
  grep -qF 'bin/fm-report.sh' "$brief" \
    || fail "ship brief does not instruct status via fm-report.sh"
  grep -qF '"{state}: {one short line}"' "$brief" \
    || fail "ship brief lost the {state}: {one short line} status idiom"
  grep -qF '>> ' "$brief" \
    && fail "ship brief still contains a raw >> status redirect"

  home=$(make_home report-scout)
  out=$(run_brief "$home" rep-scout-z1 myproj --scout) || fail "scout scaffold failed: $out"
  brief="$home/data/rep-scout-z1/brief.md"
  grep -qF 'bin/fm-report.sh' "$brief" \
    || fail "scout brief does not instruct status via fm-report.sh"
  grep -qF '>> ' "$brief" && fail "scout brief still contains a raw >> status redirect"

  home=$(make_home report-secondmate)
  out=$(FM_SECONDMATE_CHARTER='Own the dashboard domain.' \
        run_brief "$home" rep-anchor --secondmate dashboard) \
    || fail "secondmate scaffold failed: $out"
  brief="$home/data/rep-anchor/brief.md"
  grep -qF 'bin/fm-report.sh' "$brief" \
    || fail "secondmate charter does not instruct status via fm-report.sh"
  grep -qF '>> ' "$brief" && fail "secondmate charter still contains a raw >> status redirect"

  pass "ship/scout/secondmate briefs report status via fm-report.sh, not a raw >> redirect"
}

test_ship_brief_has_identity_context
test_scout_brief_has_identity_context
test_brief_identity_defaults_without_config
test_charter_has_manager_mode_defaults
test_briefs_report_status_via_helper
