#!/usr/bin/env bash
# Behavior tests for `sbin/fm idle-digest`, the bounded idle-digest loop's state
# machine. The loop replaces a trickle of tiny idle closeouts with ONE running
# digest the first mate relays as a single ~one-screen summary when the cap
# returns. This helper owns the mechanical bounds the documented protocol relies
# on, so these tests pin them down:
#
#   - begin is idempotent: a second begin RESUMES (preserves started/passes), so
#     a restart mid-absence never resets the window or loses folded updates;
#   - fold appends one bullet under a canonical section, dedups exact repeats,
#     and rejects unknown sections (exit 2);
#   - the loop self-terminates: `active`/`pass` stop at the pass cap AND at the
#     time window, and WINDOW=0 / MAX_PASSES=0 disable refinement immediately;
#   - render prints the full digest (empty sections omitted, metadata hidden);
#   - screen caps each section at SECTION_MAX with an overflow pointer but NEVER
#     truncates "Needs you" (the cap must always see pending decisions);
#   - clear removes the running digest, and verbs error cleanly with no digest.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID() { "$ROOT/sbin/fm" idle-digest "$@"; }
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-idle-digest.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

eq() {
  # eq <description> <expected> <actual>
  [ "$2" = "$3" ] || fail "$1: expected [$2], got [$3]"
}

# Each test gets a fresh state dir so a leftover digest never crosses tests.
# Exports FM_STATE_OVERRIDE in the caller's shell (call it bare, not in a
# subshell, then read the global) so each test addresses its own digest file.
fresh_state() {
  FM_STATE_OVERRIDE=$(mktemp -d "$TMP_ROOT/state.XXXXXX")
  export FM_STATE_OVERRIDE
}

DIGEST_OF() { echo "$1/.idle-digest.md"; }

test_begin_creates_and_is_idempotent_resume() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  ID begin "afk" >/dev/null || fail "begin exited non-zero"
  local f; f=$(DIGEST_OF "$s")
  [ -f "$f" ] || fail "begin did not create the running digest"
  grep -q '<!-- fm-idle-digest started=[0-9]\{1,\} passes=0 reason=afk -->' "$f" \
    || fail "begin did not write the metadata header with passes=0"
  grep -q '^# While you were away' "$f" || fail "begin did not write the digest title"
  # All five canonical sections pre-seeded.
  local sec
  for sec in "Needs you" "Landed" "In flight" "Queued & blocked" "Fleet & cost"; do
    grep -qx "## $sec" "$f" || fail "begin did not pre-seed section '$sec'"
  done

  # Advance one pass, then begin again: must RESUME (preserve started + passes),
  # not reset - a restart mid-absence keeps the window and the folded updates.
  ID fold "Landed" "PR #1 merged" || fail "fold before resume failed"
  ID pass >/dev/null || fail "pass before resume failed"
  local started_before passes_before
  started_before=$(sed -n 's/.*started=\([0-9]\{1,\}\).*/\1/p' "$f")
  passes_before=$(sed -n 's/.*passes=\([0-9]\{1,\}\).*/\1/p' "$f")
  local out; out=$(ID begin "silence") || fail "second begin exited non-zero"
  printf '%s' "$out" | grep -q '^resumed:' || fail "second begin did not report a resume"
  local started_after passes_after
  started_after=$(sed -n 's/.*started=\([0-9]\{1,\}\).*/\1/p' "$f")
  passes_after=$(sed -n 's/.*passes=\([0-9]\{1,\}\).*/\1/p' "$f")
  eq "resume preserves started" "$started_before" "$started_after"
  eq "resume preserves passes" "$passes_before" "$passes_after"
  eq "resume keeps the folded bullet" "1" "$(grep -c 'PR #1 merged' "$f")"
  pass "begin creates a seeded digest and a second begin resumes without resetting"
}

test_fold_appends_dedups_and_rejects_unknown() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  ID begin >/dev/null
  local f; f=$(DIGEST_OF "$s")
  ID fold "Needs you" "alpha PR green, awaiting merge" || fail "fold #1 failed"
  ID fold "Landed" "PR #41 merged" || fail "fold #2 failed"
  ID fold "Landed" "PR #41 merged" || fail "fold dup should still exit 0"
  eq "exact-duplicate bullet folded only once" "1" "$(grep -c '^- PR #41 merged$' "$f")"
  # Bullet lands UNDER its own heading, not another.
  local needs_line landed_line bullet_line
  needs_line=$(grep -n '^## Needs you$' "$f" | cut -d: -f1)
  bullet_line=$(grep -n '^- alpha PR green' "$f" | cut -d: -f1)
  landed_line=$(grep -n '^## Landed$' "$f" | cut -d: -f1)
  [ "$bullet_line" -gt "$needs_line" ] && [ "$bullet_line" -lt "$landed_line" ] \
    || fail "Needs-you bullet did not land under its own heading"

  local rc
  ID fold "Bogus" "x" >/dev/null 2>&1; rc=$?
  eq "unknown section rejected with exit 2" "2" "$rc"
  ID fold "Landed" >/dev/null 2>&1; rc=$?
  eq "fold with missing line arg rejected" "2" "$rc"
  pass "fold appends under the right section, dedups exact repeats, rejects unknown sections"
}

test_loop_terminates_at_pass_cap() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  FM_IDLE_DIGEST_MAX_PASSES=3 ID begin >/dev/null
  local n=0
  while FM_IDLE_DIGEST_MAX_PASSES=3 ID active >/dev/null 2>&1; do
    FM_IDLE_DIGEST_MAX_PASSES=3 ID pass >/dev/null 2>&1 || true
    n=$((n + 1))
    [ "$n" -gt 20 ] && fail "loop did not terminate at the pass cap (runaway)"
  done
  eq "loop ran exactly MAX_PASSES times" "3" "$n"
  # pass returns non-zero on the call that reaches the cap.
  local rc; FM_IDLE_DIGEST_MAX_PASSES=3 ID pass >/dev/null 2>&1; rc=$?
  eq "pass past the cap signals stop (exit 1)" "1" "$rc"
  pass "active/pass self-terminate the loop at the pass cap"
}

test_window_and_maxpasses_zero_disable_refinement() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  local rc
  FM_IDLE_DIGEST_WINDOW_SECS=0 ID begin >/dev/null
  FM_IDLE_DIGEST_WINDOW_SECS=0 ID active >/dev/null 2>&1; rc=$?
  eq "WINDOW=0 stops refinement immediately" "1" "$rc"
  ID clear >/dev/null
  FM_IDLE_DIGEST_MAX_PASSES=0 ID begin >/dev/null
  FM_IDLE_DIGEST_MAX_PASSES=0 ID active >/dev/null 2>&1; rc=$?
  eq "MAX_PASSES=0 stops refinement immediately" "1" "$rc"
  pass "WINDOW=0 and MAX_PASSES=0 disable the refinement loop"
}

test_render_full_omits_empty_sections_and_metadata() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  ID begin >/dev/null
  ID fold "Needs you" "decision A" >/dev/null
  ID fold "Landed" "PR #1 merged" >/dev/null
  local out; out=$(ID render)
  printf '%s' "$out" | grep -q '^# While you were away' || fail "render dropped the title"
  printf '%s' "$out" | grep -q '^## Needs you$' || fail "render dropped a populated section"
  printf '%s' "$out" | grep -q '^- decision A$' || fail "render dropped a bullet"
  printf '%s' "$out" | grep -q 'fm-idle-digest' && fail "render leaked the metadata comment"
  # Empty sections (In flight, Queued & blocked, Fleet & cost) are omitted.
  printf '%s' "$out" | grep -q '^## In flight$' && fail "render printed an empty section"
  pass "render prints populated sections only and hides the metadata header"
}

test_screen_caps_sections_but_never_needs_you() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  ID begin >/dev/null
  # Eight pending decisions + eight landed PRs.
  local i
  for i in $(seq 1 8); do ID fold "Needs you" "decision $i" >/dev/null; done
  for i in $(seq 1 8); do ID fold "Landed" "PR #$i merged" >/dev/null; done
  local out; out=$(FM_IDLE_DIGEST_SECTION_MAX=3 ID screen)
  # Needs you is NEVER capped: all 8 decisions present, no overflow line under it.
  eq "Needs you shows all decisions uncapped" "8" "$(printf '%s\n' "$out" | grep -c '^- decision ')"
  # Landed capped at 3 with an overflow pointer for the remaining 5.
  eq "Landed capped at SECTION_MAX" "3" "$(printf '%s\n' "$out" | grep -c '^- PR #')"
  printf '%s' "$out" | grep -q '(+5 more' || fail "screen did not emit the overflow pointer for the capped section"
  # The overflow pointer must NOT appear in the Needs-you section.
  local needs_block
  needs_block=$(printf '%s\n' "$out" | awk '/^## Needs you$/{f=1;next} /^## /{f=0} f')
  printf '%s' "$needs_block" | grep -q 'more)' && fail "Needs you was truncated with an overflow pointer"
  pass "screen caps other sections with an overflow pointer but never truncates Needs you"
}

test_fold_into_last_canonical_section() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  ID begin >/dev/null
  local f; f=$(DIGEST_OF "$s")
  ID fold "Fleet & cost" "3 jobs running, \$0.42 spent" || fail "fold into Fleet & cost failed"
  local out; out=$(ID render) || fail "render failed"
  printf '%s\n' "$out" | grep -q '^## Fleet & cost$' || fail "Fleet & cost heading missing from render"
  printf '%s\n' "$out" | grep -q '^\- 3 jobs running' || fail "Fleet & cost bullet missing from render"
  pass "fold into the last canonical section appears correctly via render (END path)"
}

test_clear_and_missing_digest_errors() {
  fresh_state; local s="$FM_STATE_OVERRIDE"
  ID begin >/dev/null
  local f; f=$(DIGEST_OF "$s")
  [ -f "$f" ] || fail "precondition: digest should exist after begin"
  ID clear >/dev/null || fail "clear exited non-zero"
  [ -e "$f" ] && fail "clear did not remove the running digest"
  local rc
  ID active >/dev/null 2>&1; rc=$?
  eq "active with no digest exits 3" "3" "$rc"
  ID render >/dev/null 2>&1; rc=$?
  eq "render with no digest exits 3" "3" "$rc"
  ID status >/dev/null 2>&1; rc=$?
  eq "status with no digest exits 3" "3" "$rc"
  pass "clear removes the digest and verbs error cleanly when none exists"
}

test_usage_and_unknown_subcommand() {
  local rc
  ID >/dev/null 2>&1; rc=$?
  eq "no subcommand exits 2" "2" "$rc"
  ID frobnicate >/dev/null 2>&1; rc=$?
  eq "unknown subcommand exits 2" "2" "$rc"
  pass "missing or unknown subcommand prints usage and exits 2"
}

test_begin_creates_and_is_idempotent_resume
test_fold_appends_dedups_and_rejects_unknown
test_loop_terminates_at_pass_cap
test_window_and_maxpasses_zero_disable_refinement
test_render_full_omits_empty_sections_and_metadata
test_screen_caps_sections_but_never_needs_you
test_fold_into_last_canonical_section
test_clear_and_missing_digest_errors
test_usage_and_unknown_subcommand
