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
  (cd "$home" && pwd -P)
}

run_brief() {
  local home=$1; shift
  FM_ROOT_OVERRIDE='' \
    FM_HOME="$home" \
    FM_STATE_OVERRIDE='' FM_DATA_OVERRIDE='' FM_PROJECTS_OVERRIDE='' FM_CONFIG_OVERRIDE='' \
    "$BRIEF" "$@" 2>&1
}

test_ship_brief_has_identity_context() {
  local home out brief
  home=$(make_home ship)
  out=$(run_brief "$home" fix-login-k3 myproj) || fail "scaffold failed: $out"
  brief="$home/data/fix-login-k3/brief.md"
  [ -f "$brief" ] || fail "no ship brief written"
  grep -qF '# Identity context' "$brief" || fail "ship brief missing identity context"
  grep -qF 'Supervisor: Mate (Main firstmate crew supervisor)' "$brief" \
    || fail "ship brief missing supervisor name/role"
  grep -qF 'captain > Mate > fix-login' "$brief" \
    || fail "ship brief missing supervision chain"
  grep -qF 'Domain/project workspace: myproj' "$brief" \
    || fail "ship brief missing domain/project workspace"
  grep -qF 'Your visible herdr tab and pane label: fix-login' "$brief" \
    || fail "ship brief missing worker visible label"
  grep -qF "$home/state/fix-login-k3.status" "$brief" \
    || fail "ship brief missing report-back target"
  grep -qF 'verify isolation' "$brief" \
    || fail "ship brief missing worktree-isolation assertion"
  grep -qF 'git rev-parse --show-toplevel' "$brief" \
    || fail "ship brief missing the show-toplevel isolation check"
  grep -qF 'git branch --show-current' "$brief" \
    || fail "ship brief missing the branch-name isolation check"
  # The brief must state the crewmate is ALREADY on its fm/<id> branch (fm-spawn
  # created the worktree with `git worktree add -b`), and must NOT instruct branch
  # creation - the old "git checkout -b fm/<id>" text made every crewmate hit
  # "a branch named fm/<id> already exists". This is the anti-regression guard.
  # shellcheck disable=SC2016  # literal backticks in the expected brief text
  grep -qF 'already on your own `fm/fix-login-k3` branch' "$brief" \
    || fail "ship brief must say the crewmate is already on its fm/<id> branch"
  grep -qF 'do not create or switch branches' "$brief" \
    || fail "ship brief must tell the crewmate not to create/switch branches"
  ! grep -qF 'git checkout -b fm/' "$brief" \
    || fail "ship brief must NOT instruct branch creation (git checkout -b fm/<id>)"
  pass "ship brief says already-on-branch and does not instruct branch creation"
}

test_scout_brief_has_identity_context() {
  local home out brief
  home=$(make_home scout)
  out=$(run_brief "$home" probe-z1 myproj --scout) || fail "scout scaffold failed: $out"
  brief="$home/data/probe-z1/brief.md"
  [ -f "$brief" ] || fail "no scout brief written"
  grep -qF '# Identity context' "$brief" || fail "scout brief missing identity context"
  grep -qF 'Your visible herdr tab and pane label: probe' "$brief" \
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
  grep -qF 'Your visible herdr tab and pane label: fix-x' "$brief" \
    || fail "default worker label (task slug) not used"
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
  # Ship and scout briefs must route status through the fm-report.sh helper, never
  # a raw `echo ... >> <status file>` redirect: the omp bash tool blocks an agent's
  # own redirection. The secondmate charter instead escalates captain-relevant
  # outcomes to the main firstmate through the fleet peer bus (not the report helper).
  local home out brief

  home=$(make_home report-ship)
  out=$(run_brief "$home" rep-ship-k1 myproj) || fail "ship scaffold failed: $out"
  brief="$home/data/rep-ship-k1/brief.md"
  [ -f "$brief" ] || fail "no ship brief written"
  grep -qF 'bin/fm-report.sh' "$brief" \
    || fail "ship brief does not instruct status via fm-report.sh"
  grep -qF '"{state}: {one short line}"' "$brief" \
    || fail "ship brief lost the {state}: {one short line} status idiom"
  grep -qF 'state the diagnostic intent first, then send short human-legible expert commands one by one' "$brief" \
    || fail "ship brief missing visible-pane command discipline"
  grep -qF 'Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane' "$brief" \
    || fail "ship brief missing noisy visible-pane command guard"
  grep -qF '>> ' "$brief" \
    && fail "ship brief still contains a raw >> status redirect"

  home=$(make_home report-scout)
  out=$(run_brief "$home" rep-scout-z1 myproj --scout) || fail "scout scaffold failed: $out"
  brief="$home/data/rep-scout-z1/brief.md"
  grep -qF 'bin/fm-report.sh' "$brief" \
    || fail "scout brief does not instruct status via fm-report.sh"
  grep -qF '>> ' "$brief" && fail "scout brief still contains a raw >> status redirect"
  grep -qF 'state the diagnostic intent first, then send short human-legible expert commands one by one' "$brief" \
    || fail "scout brief missing visible-pane command discipline"
  grep -qF 'Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane' "$brief" \
    || fail "scout brief missing noisy visible-pane command guard"

  home=$(make_home report-secondmate)
  out=$(FM_SECONDMATE_CHARTER='Own the dashboard domain.' \
        run_brief "$home" rep-anchor --secondmate dashboard) \
    || fail "secondmate scaffold failed: $out"
  brief="$home/data/rep-anchor/brief.md"
  grep -qF 'through the fleet peer bus' "$brief" \
    || fail "secondmate charter does not instruct peer-bus escalation"
  grep -qF 'bin/fm-report.sh' "$brief" \
    && fail "secondmate charter still routes escalation through the retired report helper"
  grep -qF '>> ' "$brief" && fail "secondmate charter still contains a raw >> status redirect"
  ! grep -qF 'state the diagnostic intent first, then send short human-legible expert commands one by one' "$brief" \
    || fail "secondmate charter should not copy visible-pane discipline from fleet-wide rules"

  pass "ship/scout briefs report status via fm-report.sh; secondmate charter escalates via the fleet peer bus"
}

test_ship_brief_has_identity_context
test_scout_brief_has_identity_context
test_brief_identity_defaults_without_config
test_charter_has_manager_mode_defaults
test_briefs_report_status_via_helper
