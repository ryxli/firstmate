#!/usr/bin/env bash
# Tests for fm-lint-shared-text.sh: the guard that keeps firstmate's persona and
# the em-dash out of shared, semi-public text (PR/commit/issue bodies).
#
# Contract under test:
#   - clean engineering prose passes (exit 0), including legitimate project nouns
#     (firstmate, lavish, worktree, steward) that must NOT be flagged;
#   - persona/nautical vocabulary fails (exit 1) and is named;
#   - a real em-dash (U+2014) fails - critically, this must hold under macOS
#     bash 3.2 where $'\u2014' does not expand, so we feed a real em-dash byte;
#   - possessive forms (captain's) are caught;
#   - both file and stdin inputs work; bad usage exits 2.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINT="$ROOT/bin/fm-lint-shared-text.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-lint.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# A real em-dash byte sequence (U+2014, UTF-8 E2 80 94), built portably.
EMDASH=$(printf '\342\200\224')

run() { # stdin text -> runs linter, echoes nothing; sets global RC/OUT
  OUT=$(printf '%s' "$1" | "$LINT" - 2>&1); RC=$?
}

test_clean_prose_passes() {
  run "Added a steward worker that owns the lavish-axi poll for an artifact.
The firstmate repo gains bin/fm-lavish-open.sh; worktrees are unaffected."
  [ "$RC" -eq 0 ] || fail "clean prose should pass (rc=$RC): $OUT"
  pass "clean engineering prose passes (project nouns not flagged)"
}

test_persona_fails() {
  run "Captain, the crewmate shipped it."
  [ "$RC" -eq 1 ] || fail "persona text should fail (rc=$RC)"
  printf '%s\n' "$OUT" | grep -qi 'captain' || fail "did not name the offender: $OUT"
  pass "persona/nautical vocabulary fails and is named"
}

test_emdash_fails() {
  run "clean line
has em ${EMDASH} dash"
  [ "$RC" -eq 1 ] || fail "em-dash should fail (rc=$RC): $OUT"
  printf '%s\n' "$OUT" | grep -qi 'em-dash' || fail "did not report em-dash: $OUT"
  pass "real em-dash (U+2014) is caught"
}

test_possessive_caught() {
  run "never lose the captain's direction"
  [ "$RC" -eq 1 ] || fail "possessive persona should fail (rc=$RC)"
  pass "possessive persona form (captain's) is caught"
}

test_phrase_caught() {
  run "all hands: the rollout is ready"
  [ "$RC" -eq 1 ] || fail "persona phrase should fail (rc=$RC)"
  pass "multi-word persona phrase is caught"
}

test_file_input_works() {
  printf 'Captain speaking.\n' > "$TMP_ROOT/bad.md"
  OUT=$("$LINT" "$TMP_ROOT/bad.md" 2>&1); RC=$?
  [ "$RC" -eq 1 ] || fail "file input with persona should fail (rc=$RC)"
  printf 'plain engineering prose here.\n' > "$TMP_ROOT/good.md"
  OUT=$("$LINT" "$TMP_ROOT/good.md" 2>&1); RC=$?
  [ "$RC" -eq 0 ] || fail "file input clean should pass (rc=$RC): $OUT"
  pass "file input works for both bad and good bodies"
}

test_bad_usage_exits_2() {
  "$LINT" a b >/dev/null 2>&1; [ "$?" -eq 2 ] || fail "too many args should exit 2"
  "$LINT" "$TMP_ROOT/does-not-exist.md" >/dev/null 2>&1; [ "$?" -eq 2 ] \
    || fail "missing file should exit 2"
  pass "bad usage / missing file exits 2"
}

test_clean_prose_passes
test_persona_fails
test_emdash_fails
test_possessive_caught
test_phrase_caught
test_file_input_works
test_bad_usage_exits_2
