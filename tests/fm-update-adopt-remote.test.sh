#!/usr/bin/env bash
# Tests for sbin/fm-update.sh --adopt-remote: the captain-approved recovery
# verb the OTHER machine runs after a sanctioned force-with-lease history
# rewrite of a harness-layer repo.
#
# The guarantees under test:
#   - When origin's default branch history was REWRITTEN (local and
#     origin/<default> diverged), the working tree is clean, and every local
#     commit was already published on origin, the local default branch is
#     hard-reset to origin/<default>.
#   - EVERY other case refuses with a one-line reason and moves nothing:
#     unpushed local commits, a dirty working tree, and a not-diverged target
#     (where the normal fast-forward applies) are all preserved untouched.
#   - Default mode behavior is completely unchanged: without --adopt-remote a
#     diverged target is still skipped, never reset.
#   - A detached secondmate home adopts the same way and is nudged.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATE="$ROOT/sbin/fm-update.sh"
TMP_ROOT=

# Deterministic, isolated git identity and config for fixture commits.
export GIT_AUTHOR_NAME=fmtest GIT_AUTHOR_EMAIL=fmtest@example.com
export GIT_COMMITTER_NAME=fmtest GIT_COMMITTER_EMAIL=fmtest@example.com

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  if [ -n "${TMP_ROOT:-}" ]; then
    rm -rf "$TMP_ROOT"
  fi
}

trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-update-adopt-tests.XXXXXX")

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3 (unexpected: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
    *) : ;;
  esac
}

# Build a fresh world: a bare origin seeded with one commit, a firstmate repo
# clone checked out on main, and a home dir with state/ and data/. Echoes the
# world dir. Files seeded: AGENTS.md, README.md, sbin/tool.sh, a skill note.
new_world() {
  local name=$1 w
  w="$TMP_ROOT/$name"
  mkdir -p "$w/home/state" "$w/home/data"

  git init -q --bare "$w/origin.git"
  git -C "$w/origin.git" symbolic-ref HEAD refs/heads/main
  git clone -q "$w/origin.git" "$w/seed" 2>/dev/null

  printf 'v1\n' > "$w/seed/AGENTS.md"
  printf 'r1\n' > "$w/seed/README.md"
  mkdir -p "$w/seed/sbin" "$w/seed/.agents/skills"
  printf 'echo a\n' > "$w/seed/sbin/tool.sh"
  printf 's1\n' > "$w/seed/.agents/skills/note.md"
  git -C "$w/seed" add -A
  git -C "$w/seed" commit -qm c1
  git -C "$w/seed" push -q origin main

  git clone -q "$w/origin.git" "$w/main"
  git -C "$w/main" remote set-head origin main >/dev/null 2>&1 || true

  printf '%s\n' "$w"
}

# Add a secondmate home as a DETACHED worktree of the firstmate repo (matching
# how treehouse leases a secondmate home), plus its state meta. Args: world id.
add_sm() {
  local w=$1 id=$2
  git -C "$w/main" worktree add -q --detach "$w/$id" main
  {
    printf 'pane=w1:p1\n'
    printf 'kind=secondmate\n'
    printf 'home=%s/%s\n' "$w" "$id"
  } > "$w/home/state/$id.meta"
  printf '%s\n' "$id" > "$w/$id/.fm-secondmate-home"
}

# Advance origin by one instruction-surface commit (c2).
bump_origin() {
  local w=$1
  git -C "$w/seed" pull -q origin main >/dev/null 2>&1 || true
  printf 'v2\n' > "$w/seed/AGENTS.md"
  printf 'r2\n' >> "$w/seed/README.md"
  git -C "$w/seed" add -A
  git -C "$w/seed" commit -qm c2
  git -C "$w/seed" push -q origin main
}

# Bring the local firstmate clone up to the current origin tip (a normal,
# fully published local state - what the other laptop looks like pre-rewrite).
pull_main() {
  local w=$1
  git -C "$w/main" fetch -q origin
  git -C "$w/main" merge -q --ff-only origin/main
}

# REWRITE origin history: amend the tip commit and force-push, so a local
# clone that had pulled the old tip is now diverged from origin/main.
rewrite_origin() {
  local w=$1
  git -C "$w/seed" pull -q origin main >/dev/null 2>&1 || true
  printf 'v2-rewritten\n' > "$w/seed/AGENTS.md"
  git -C "$w/seed" add -A
  git -C "$w/seed" commit -q --amend -m c2-rewritten
  git -C "$w/seed" push -q --force origin main
}

run_update() {
  local w=$1
  FM_ROOT_OVERRIDE="$w/main" FM_HOME="$w/home" "$UPDATE" 2>/dev/null
}

run_adopt() {
  local w=$1
  FM_ROOT_OVERRIDE="$w/main" FM_HOME="$w/home" "$UPDATE" --adopt-remote 2>/dev/null
}

# --- T1: rewritten origin, clean fully-pushed local -> adopted --------------
test_adopts_rewritten_history() {
  local w out
  w=$(new_world t1)
  bump_origin "$w"
  pull_main "$w"          # local main is exactly the pre-rewrite origin tip
  rewrite_origin "$w"

  out=$(run_adopt "$w")

  assert_contains "$out" "firstmate: adopted " "diverged-by-rewrite firstmate adopted"
  assert_contains "$out" "reread-firstmate: yes" "rewritten instruction surface triggers reread"
  [ "$(git -C "$w/main" rev-parse HEAD)" = "$(git -C "$w/main" rev-parse origin/main)" ] \
    || fail "firstmate HEAD not hard-reset to origin/main"
  [ "$(git -C "$w/main" symbolic-ref --short HEAD 2>/dev/null)" = "main" ] \
    || fail "firstmate left its default branch"
  [ -z "$(git -C "$w/main" status --porcelain)" ] \
    || fail "working tree not clean after adopt"
  grep -q 'v2-rewritten' "$w/main/AGENTS.md" \
    || fail "adopted checkout does not carry the rewritten content"
  pass "T1 rewritten origin adopted: hard reset to origin/main"
}

# --- T2: unpushed local commit -> refused, commit preserved -----------------
test_refuses_unpushed_local_commits() {
  local w out before
  w=$(new_world t2)
  bump_origin "$w"
  pull_main "$w"
  printf 'never pushed\n' > "$w/main/local-note.md"
  git -C "$w/main" add -A
  git -C "$w/main" commit -qm local-only
  before=$(git -C "$w/main" rev-parse HEAD)
  rewrite_origin "$w"

  out=$(run_adopt "$w")

  assert_contains "$out" "firstmate: skipped: local-only commits present, refusing to discard" \
    "unpushed local commit refused"
  assert_not_contains "$out" "firstmate: adopted" "no adopt despite divergence"
  [ "$(git -C "$w/main" rev-parse HEAD)" = "$before" ] \
    || fail "refused firstmate HEAD moved (unpushed work at risk)"
  [ -f "$w/main/local-note.md" ] || fail "unpushed local file discarded"
  pass "T2 unpushed local commit refused, work preserved"
}

# --- T3: dirty working tree -> refused, edit preserved ----------------------
test_refuses_dirty_tree() {
  local w out before
  w=$(new_world t3)
  bump_origin "$w"
  pull_main "$w"
  rewrite_origin "$w"
  printf 'uncommitted local edit\n' >> "$w/main/README.md"
  before=$(git -C "$w/main" rev-parse HEAD)

  out=$(run_adopt "$w")

  assert_contains "$out" "firstmate: skipped: dirty working tree" "dirty tree refused"
  assert_not_contains "$out" "firstmate: adopted" "no adopt with a dirty tree"
  [ "$(git -C "$w/main" rev-parse HEAD)" = "$before" ] \
    || fail "refused firstmate HEAD moved"
  grep -q 'uncommitted local edit' "$w/main/README.md" \
    || fail "dirty edit was discarded"
  pass "T3 dirty working tree refused, edit preserved"
}

# --- T4: not diverged (merely behind) -> refused, normal ff applies ---------
test_refuses_when_not_diverged() {
  local w out before
  w=$(new_world t4)
  bump_origin "$w"        # local at c1, origin at c2: behind, not diverged
  before=$(git -C "$w/main" rev-parse HEAD)

  out=$(run_adopt "$w")

  assert_contains "$out" "firstmate: skipped: not diverged from origin/main, normal fast-forward applies" \
    "behind-only target refused"
  [ "$(git -C "$w/main" rev-parse HEAD)" = "$before" ] \
    || fail "adopt mode moved a not-diverged target"
  pass "T4 not-diverged target refused, deferred to normal fast-forward"
}

# --- T5: default mode unchanged: diverged target still skipped --------------
test_default_mode_unchanged_on_divergence() {
  local w out before
  w=$(new_world t5)
  bump_origin "$w"
  pull_main "$w"
  rewrite_origin "$w"
  before=$(git -C "$w/main" rev-parse HEAD)

  out=$(run_update "$w")  # NO --adopt-remote

  assert_contains "$out" "firstmate: skipped: diverged from origin/main" \
    "default mode still skips a diverged target"
  assert_not_contains "$out" "adopted" "default mode never adopts"
  [ "$(git -C "$w/main" rev-parse HEAD)" = "$before" ] \
    || fail "default mode moved a diverged target"
  pass "T5 default mode unchanged: diverged target skipped, never reset"
}

# --- T6: detached secondmate home adopts too, and is nudged -----------------
test_secondmate_adopts_and_is_nudged() {
  local w out
  w=$(new_world t6)
  bump_origin "$w"
  pull_main "$w"
  add_sm "$w" sm1         # detached worktree leased at the pre-rewrite tip
  rewrite_origin "$w"

  out=$(run_adopt "$w")

  assert_contains "$out" "firstmate: adopted " "firstmate adopted"
  assert_contains "$out" "secondmate sm1: adopted " "secondmate adopted"
  assert_contains "$out" "nudge-secondmates: fm-sm1" "adopted secondmate is nudged"
  [ "$(git -C "$w/sm1" rev-parse HEAD)" = "$(git -C "$w/sm1" rev-parse origin/main)" ] \
    || fail "secondmate HEAD not hard-reset to origin/main"
  git -C "$w/sm1" symbolic-ref -q HEAD >/dev/null \
    && fail "secondmate worktree is no longer detached"
  pass "T6 detached secondmate home adopted and nudged"
}

test_adopts_rewritten_history
test_refuses_unpushed_local_commits
test_refuses_dirty_tree
test_refuses_when_not_diverged
test_default_mode_unchanged_on_divergence
test_secondmate_adopts_and_is_nudged

echo "# all fm-update adopt-remote tests passed"
