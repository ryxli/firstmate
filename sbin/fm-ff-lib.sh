#!/usr/bin/env bash
# fm-ff-lib.sh - shared fast-forward-only git mechanics for firstmate.
#
# Sourced by fm-update.sh (self-update of the firstmate repo + secondmate homes)
# and fm-fleet-sync.sh (refresh of project clones). Both perform the same
# fast-forward-only core: resolve the default branch from cached origin/HEAD,
# fetch origin, confirm the local ref is a clean ancestor of origin, then apply
# `git merge --ff-only`. This library holds exactly that shared core so the two
# callers cannot drift.
#
# It deliberately does NOT hold the parts that legitimately differ between the
# callers - each wrapper keeps its own distinct semantics:
#   - the default-branch FALLBACK when origin/HEAD is not cached (fm-update.sh
#     queries the remote; fm-fleet-sync.sh guesses local main/master);
#   - fetch deduplication across worktrees + origin/HEAD refresh (fm-update.sh);
#   - detached-HEAD / upstream-fixup acceptance (fm-update.sh);
#   - the on-default-branch requirement, project-mode gating, and gone-branch
#     pruning (fm-fleet-sync.sh);
#   - every human-facing status line's wording (each caller formats its own).
#
# All functions are set -u and set -e safe. Result-carrying functions expose
# their outputs through the FF_* globals documented on each function.

# The FF_* result variables are this library's output interface, read by the
# sourcing callers; shellcheck cannot see those cross-file reads.
# shellcheck disable=SC2034

# ff_first_line <text>
# Print the first line of <text> with runs of whitespace collapsed to single
# spaces. Turns multi-line git error output into a one-line skip reason.
ff_first_line() {
  printf '%s\n' "$1" | sed -n '1s/[[:space:]]\{1,\}/ /g;1p'
}

# ff_skip <label> <reason>
# Emit the shared "skipped" status-line format both callers use. The reason
# text is supplied by the caller so each keeps its own wording.
ff_skip() {
  printf '%s: skipped: %s\n' "$1" "$2"
}

# ff_resolve_default_branch <dir>
# Print the default branch resolved from the locally cached origin/HEAD - the
# resolution path that is semantically identical in both callers. Returns 1
# (printing nothing) when origin/HEAD is not cached, leaving the caller to apply
# its own fallback (remote query vs local main/master guess), a deliberately
# distinct per-caller semantic that stays in each wrapper.
ff_resolve_default_branch() {
  local dir=$1 ref
  ref=$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  [ -n "$ref" ] || return 1
  printf '%s\n' "${ref#origin/}"
}

# ff_refresh_origin <dir>
# Fetch origin with --prune --quiet. Returns 0 on success, 1 on failure. The
# combined stdout+stderr of the fetch is left in FF_FETCH_OUTPUT so a caller
# that wants a detailed skip reason can use it (fm-update.sh ignores it).
FF_FETCH_OUTPUT=""
ff_refresh_origin() {
  local dir=$1
  FF_FETCH_OUTPUT=$(git -C "$dir" fetch origin --prune --quiet 2>&1) && return 0
  return 1
}

# ff_safe_fast_forward <dir> <ref> <base>
# Fast-forward <ref> to <base> in <dir> after the clean-ancestor checks, using
# `git merge --ff-only`. This is the pure git core; the caller classifies the
# result via FF_RESULT and formats every status line itself:
#   FF_RESULT=current    -> already up to date                          (return 0)
#   FF_RESULT=updated    -> fast-forwarded; FF_BEFORE/FF_AFTER short shas (return 0)
#   FF_RESULT=diverged   -> <ref> is not an ancestor of <base>          (return 1)
#   FF_RESULT=read-error -> a rev-parse failed; FF_WHICH=local|remote   (return 1)
#   FF_RESULT=ff-failed  -> merge --ff-only failed; FF_DETAIL=one line  (return 1)
FF_RESULT=""
FF_BEFORE=""
FF_AFTER=""
FF_DETAIL=""
FF_WHICH=""
ff_safe_fast_forward() {
  local dir=$1 ref=$2 base=$3 local_rev remote_rev out
  FF_RESULT=""
  FF_BEFORE=""
  FF_AFTER=""
  FF_DETAIL=""
  FF_WHICH=""
  local_rev=$(git -C "$dir" rev-parse "$ref" 2>/dev/null) || {
    FF_RESULT="read-error"
    FF_WHICH="local"
    return 1
  }
  remote_rev=$(git -C "$dir" rev-parse "$base" 2>/dev/null) || {
    FF_RESULT="read-error"
    FF_WHICH="remote"
    return 1
  }
  if [ "$local_rev" = "$remote_rev" ]; then
    FF_RESULT="current"
    return 0
  fi
  if ! git -C "$dir" merge-base --is-ancestor "$ref" "$base" 2>/dev/null; then
    FF_RESULT="diverged"
    return 1
  fi
  FF_BEFORE=$(git -C "$dir" rev-parse --short "$ref")
  if ! out=$(git -C "$dir" merge --ff-only "$base" 2>&1); then
    FF_RESULT="ff-failed"
    FF_DETAIL=$(ff_first_line "$out")
    return 1
  fi
  FF_AFTER=$(git -C "$dir" rev-parse --short "$ref")
  FF_RESULT="updated"
  return 0
}
