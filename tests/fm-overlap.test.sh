#!/usr/bin/env bash
# Tests for bin/fm-overlap.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

TMP_ROOT=
cleanup() { [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-overlap-tests.XXXXXX")
DATA="$TMP_ROOT/data"
STATE="$TMP_ROOT/state"
mkdir -p "$DATA" "$STATE"

# Run fm-overlap.sh with fixture overrides.
RUN() {
  FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
    FM_ROOT_OVERRIDE="$ROOT" "$ROOT/bin/fm-overlap.sh" "$@"
}

# --- fixture helpers ---

# make_meta <id> <project-path>
make_meta() {
  printf 'project=%s\n' "$2" > "$STATE/$1.meta"
}

# make_brief <id> <path>...   (writes # Scope-paths section with given paths)
make_brief() {
  local id="$1"; shift
  mkdir -p "$DATA/$id"
  printf '# Task\nsome task\n\n# Scope-paths\n' > "$DATA/$id/brief.md"
  for p in "$@"; do printf '%s\n' "$p"; done >> "$DATA/$id/brief.md"
}

# ---- syntax check ----

test_bash_syntax() {
  bash -n "$ROOT/bin/fm-overlap.sh" || fail "bash -n failed"
  pass "bash -n passes"
}

# ---- --paths mode ----

test_paths_mode_prefix_overlap() {
  local out rc=0
  out=$(RUN --paths "src/foo,src/bar" --paths "src/foo/baz") || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q '^overlap:' || fail "expected 'overlap:' line; got: $out"
  printf '%s\n' "$out" | grep -q 'src/foo'   || fail "expected shared path 'src/foo'; got: $out"
  pass "paths mode: prefix overlap exits 1 with overlap line"
}

test_paths_mode_exact_match() {
  local out rc=0
  out=$(RUN --paths "src/widget.ts" --paths "lib/util.ts,src/widget.ts") || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q 'src/widget.ts' || fail "expected shared path; got: $out"
  pass "paths mode: exact path match is an overlap"
}

test_paths_mode_disjoint() {
  local out rc=0
  out=$(RUN --paths "src/foo,src/bar" --paths "src/baz,src/qux") || rc=$?
  [ "$rc" -eq 0 ] || fail "expected exit 0, got $rc; output: $out"
  [ -z "$out" ]   || fail "expected no output; got: $out"
  pass "paths mode: disjoint sets exit 0 with no output"
}

test_paths_mode_three_sets_one_overlap() {
  local out rc=0
  out=$(RUN --paths "a/one" --paths "b/two" --paths "a/one/sub") || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q 'paths1.*paths3\|paths3.*paths1' || \
    fail "expected overlap between sets 1 and 3; got: $out"
  pass "paths mode: three sets, only the overlapping pair reported"
}

# ---- task-id mode: path overlap ----

test_task_path_prefix_overlap() {
  make_brief "tp1" "src/auth" "src/shared"
  make_brief "tp2" "src/auth/login.ts"
  make_meta  "tp1" "/code/myrepo"
  make_meta  "tp2" "/code/myrepo"
  local out rc=0
  out=$(RUN tp1 tp2) || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q '^overlap: tp1 tp2 src/auth' || \
    fail "expected 'overlap: tp1 tp2 src/auth'; got: $out"
  pass "task path overlap: declared Scope-paths conflict exits 1"
}

test_task_path_exact_overlap() {
  make_brief "te1" "bin/fm-spawn.sh"
  make_brief "te2" "README.md" "bin/fm-spawn.sh"
  make_meta  "te1" "/code/firstmate"
  make_meta  "te2" "/code/firstmate"
  local out rc=0
  out=$(RUN te1 te2) || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q 'bin/fm-spawn.sh' || fail "expected shared path; got: $out"
  pass "task path overlap: exact path match exits 1"
}

# ---- task-id mode: coarse overlap ----

test_task_coarse_same_repo_no_paths() {
  make_meta "co1" "/code/repo-x"
  make_meta "co2" "/code/repo-x"
  local out rc=0
  out=$(RUN co1 co2) || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q '^overlap: co1 co2 ' || fail "expected overlap line; got: $out"
  printf '%s\n' "$out" | grep -q 'repo-x'             || fail "expected repo name in shared field; got: $out"
  pass "coarse overlap: same repo + no Scope-paths exits 1"
}

test_task_coarse_one_has_paths() {
  # One task is coarse (meta only), other has declared paths; same repo -> overlap.
  make_meta  "cx1" "/code/repo-y"
  make_brief "cx2" "src/lib"
  make_meta  "cx2" "/code/repo-y"
  local out rc=0
  out=$(RUN cx1 cx2) || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q '^overlap: cx1 cx2 ' || fail "expected overlap line; got: $out"
  pass "coarse overlap: coarse task + paths task in same repo exits 1"
}

# ---- task-id mode: disjoint / clean ----

test_task_disjoint_paths_same_repo() {
  make_brief "dj1" "src/auth"
  make_brief "dj2" "src/billing"
  make_meta  "dj1" "/code/shared-repo"
  make_meta  "dj2" "/code/shared-repo"
  local out rc=0
  out=$(RUN dj1 dj2) || rc=$?
  [ "$rc" -eq 0 ] || fail "expected exit 0, got $rc; output: $out"
  [ -z "$out" ]   || fail "expected no output; got: $out"
  pass "disjoint: same repo non-overlapping Scope-paths exits 0"
}

test_task_cross_repo_no_overlap() {
  make_meta "cr1" "/code/frontend"
  make_meta "cr2" "/code/backend"
  local out rc=0
  out=$(RUN cr1 cr2) || rc=$?
  [ "$rc" -eq 0 ] || fail "expected exit 0, got $rc; output: $out"
  [ -z "$out" ]   || fail "cross-repo: expected no output; got: $out"
  pass "cross-repo: different repos are always disjoint exits 0"
}

test_task_cross_repo_with_paths() {
  # Even if both tasks declare the same relative paths, different repos = no overlap.
  make_brief "xp1" "src/core"
  make_brief "xp2" "src/core"
  make_meta  "xp1" "/code/service-a"
  make_meta  "xp2" "/code/service-b"
  local out rc=0
  out=$(RUN xp1 xp2) || rc=$?
  [ "$rc" -eq 0 ] || fail "expected exit 0, got $rc; output: $out"
  [ -z "$out" ]   || fail "expected no output; got: $out"
  pass "cross-repo: same Scope-paths in different repos exits 0"
}

# ---- task-id mode: three tasks ----

test_three_tasks_one_overlap() {
  make_brief "tr1" "src/core"
  make_brief "tr2" "tests/unit"
  make_brief "tr3" "src/core/utils"
  make_meta  "tr1" "/code/proj"
  make_meta  "tr2" "/code/proj"
  make_meta  "tr3" "/code/proj"
  local out rc=0
  out=$(RUN tr1 tr2 tr3) || rc=$?
  [ "$rc" -eq 1 ] || fail "expected exit 1, got $rc"
  printf '%s\n' "$out" | grep -q '^overlap: tr1 tr3' || fail "expected tr1/tr3 overlap; got: $out"
  local extra
  extra=$(printf '%s\n' "$out" | grep '^overlap:' | grep -v '^overlap: tr1 tr3') || true
  [ -z "$extra" ] || fail "unexpected extra overlap lines: $extra"
  pass "three tasks: only the overlapping pair reported"
}

# ---- error cases ----

test_missing_scope_exits_nonzero() {
  local rc=0
  RUN nosuchid1 nosuchid2 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "expected non-zero exit for missing scope, got 0"
  pass "missing scope: exits non-zero with error"
}

test_usage_too_few_args() {
  local rc=0
  RUN singleid 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "expected non-zero for too few args, got 0"
  pass "usage: too few args exits non-zero"
}

test_paths_mode_too_few_sets() {
  local rc=0
  RUN --paths "src/foo" 2>/dev/null || rc=$?
  [ "$rc" -ne 0 ] || fail "expected non-zero for single --paths set, got 0"
  pass "usage: single --paths set exits non-zero"
}

# ---- run all ----

test_bash_syntax
test_paths_mode_prefix_overlap
test_paths_mode_exact_match
test_paths_mode_disjoint
test_paths_mode_three_sets_one_overlap
test_task_path_prefix_overlap
test_task_path_exact_overlap
test_task_coarse_same_repo_no_paths
test_task_coarse_one_has_paths
test_task_disjoint_paths_same_repo
test_task_cross_repo_no_overlap
test_task_cross_repo_with_paths
test_three_tasks_one_overlap
test_missing_scope_exits_nonzero
test_usage_too_few_args
test_paths_mode_too_few_sets
