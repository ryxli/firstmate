#!/usr/bin/env bash
# Tests for fm-tooling-lint.sh: the guard that keeps non-bun JS invocation out
# of firstmate's own shipped tooling surfaces (README, CONTRIBUTING, SKILL.md,
# sbin help text).
#
# Contract under test:
#   - a clean surface using bunx passes (exit 0);
#   - `npx` (whole word), `node <path-with-dist>`, and a raw `./sbin/*.js`
#     command each fail (exit 1) and are named with their file;
#   - the two convention-definers (fm-tooling-lint.sh, fm-brief.sh) are exempt
#     even when they contain the forbidden forms as prohibition text;
#   - a line carrying `fm-tooling-lint: allow` is exempt;
#   - the real repo passes (regression guard against the convention rotting in);
#   - a missing root exits 2.
# Fixture bodies embed literal markdown backticks inside single-quoted printf
# format strings on purpose; SC2016 (no expansion in single quotes) is exactly
# the intended behavior here, not a bug.
# shellcheck disable=SC2016
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$ROOT/sbin/fm-tooling-lint.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-tooling-lint.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# fixture <name> builds an isolated scan root under TMP_ROOT and echoes its path.
fixture() {
  local d="$TMP_ROOT/$1"
  mkdir -p "$d/sbin" "$d/.agents/skills/demo"
  printf '%s\n' "$d"
}

test_clean_bunx_passes() {
  local d; d=$(fixture clean)
  printf 'Install and run with `bunx demo-axi`.\n' > "$d/README.md"
  printf '# demo\nStart it via `bunx demo-axi start`.\n' > "$d/.agents/skills/demo/SKILL.md"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 0 ] || fail "clean bunx surface should pass (rc=$RC): $OUT"
  pass "clean surface using bunx passes"
}

test_npx_fails() {
  local d; d=$(fixture npx)
  printf 'Install with `npx create-foo`.\n' > "$d/README.md"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 1 ] || fail "npx should fail (rc=$RC): $OUT"
  printf '%s\n' "$OUT" | grep -q 'README.md' || fail "did not name the offending file: $OUT"
  printf '%s\n' "$OUT" | grep -qi 'npx' || fail "did not report npx: $OUT"
  pass "npx invocation fails and is named with its file"
}

test_npx_word_boundary() {
  # A word that merely contains the letters n-p-x must NOT trip the guard.
  local d; d=$(fixture npxword)
  printf 'The `linpxatch` helper is fine.\n' > "$d/README.md"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 0 ] || fail "npx-as-substring should pass (rc=$RC): $OUT"
  pass "npx matches only as a whole word"
}

test_node_dist_fails() {
  local d; d=$(fixture nodedist)
  printf 'Run `node dist/cli.js` to start.\n' > "$d/README.md"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 1 ] || fail "node dist should fail (rc=$RC): $OUT"
  printf '%s\n' "$OUT" | grep -qi 'node dist' || fail "did not report node dist: $OUT"
  pass "node dist invocation fails"
}

test_binjs_fails() {
  local d; d=$(fixture binjs)
  printf 'Also `./sbin/tool.js run` works.\n' > "$d/README.md"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 1 ] || fail "sbin/*.js should fail (rc=$RC): $OUT"
  printf '%s\n' "$OUT" | grep -qi '.js script' || fail "did not report .js script: $OUT"
  pass "raw ./sbin/*.js command fails"
}

test_help_text_in_sbin_fails() {
  local d; d=$(fixture helptext)
  printf '#!/usr/bin/env bash\necho "run: npx foo"\n' > "$d/sbin/demo.sh"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 1 ] || fail "npx in sbin help text should fail (rc=$RC): $OUT"
  printf '%s\n' "$OUT" | grep -q 'demo.sh' || fail "did not name the sbin file: $OUT"
  pass "npx in sbin/*.sh help text is caught"
}

test_definers_exempt() {
  # Both convention-definers name the forbidden forms as prohibition text and
  # must not be flagged, even though they contain the literal tokens.
  local d; d=$(fixture definers)
  printf '#!/usr/bin/env bash\n# never npx, never node dist/x, never ./sbin/x.js\n' > "$d/sbin/fm-brief.sh"
  printf '#!/usr/bin/env bash\n# scans for npx and node dist and ./sbin/x.js\n' > "$d/sbin/fm-tooling-lint.sh"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 0 ] || fail "convention-definers should be exempt (rc=$RC): $OUT"
  pass "fm-brief.sh and fm-tooling-lint.sh are exempt"
}

test_allow_marker_exempt() {
  local d; d=$(fixture allow)
  printf 'Never do `npx x` here (fm-tooling-lint: allow)\n' > "$d/README.md"
  OUT=$("$GUARD" "$d" 2>&1); RC=$?
  [ "$RC" -eq 0 ] || fail "allow-marker line should be exempt (rc=$RC): $OUT"
  pass "fm-tooling-lint: allow marker exempts a line"
}

test_real_repo_passes() {
  OUT=$("$GUARD" 2>&1); RC=$?
  [ "$RC" -eq 0 ] || fail "the real repo must pass the tooling guard (rc=$RC): $OUT"
  pass "the real firstmate repo passes (regression guard)"
}

test_missing_root_exits_2() {
  "$GUARD" "$TMP_ROOT/does-not-exist" >/dev/null 2>&1; [ "$?" -eq 2 ] \
    || fail "missing root should exit 2"
  "$GUARD" a b >/dev/null 2>&1; [ "$?" -eq 2 ] || fail "too many args should exit 2"
  pass "missing root / bad usage exits 2"
}

test_clean_bunx_passes
test_npx_fails
test_npx_word_boundary
test_node_dist_fails
test_binjs_fails
test_help_text_in_sbin_fails
test_definers_exempt
test_allow_marker_exempt
test_real_repo_passes
test_missing_root_exits_2
