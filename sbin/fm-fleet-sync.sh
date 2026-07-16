#!/usr/bin/env bash
# Refresh project clones: fast-forward the checked-out local default branch to
# origin/<default> when safe, and prune local branches whose upstream tracking
# branch is gone (the remote branch was deleted, i.e. its PR merged) and that no
# worktree still needs.
# Skips local-only/no-origin projects, dirty clones, non-default checkouts,
# diverged branches, and fetch/fast-forward failures without forcing or stashing.
# Pruning never deletes the checked-out branch or a branch that still has a
# worktree, so it cannot discard unlanded work; set FM_FLEET_PRUNE=0 to disable it.
# Usage: fm-fleet-sync.sh [<project-dir>]
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
PROJECTS="${FM_PROJECTS_OVERRIDE:-$FM_HOME/projects}"

# shellcheck source=sbin/fm-ff-lib.sh
. "$SCRIPT_DIR/fm-ff-lib.sh"

usage() {
  echo "usage: fm-fleet-sync.sh [<project-dir>]" >&2
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
[ $# -le 1 ] || { usage; exit 1; }

project_label() {
  case "$PROJ" in
    "$PROJECTS"/*) basename "$PROJ" ;;
    projects/*) basename "$PROJ" ;;
    *) printf '%s\n' "$PROJ" ;;
  esac
}

default_branch() {
  local branch
  # Shared core: the locally cached origin/HEAD (identical in both callers).
  ff_resolve_default_branch "$PROJ" && return 0
  # Distinct fallback: origin/HEAD not cached; guess the local default branch.
  for branch in main master; do
    if git -C "$PROJ" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "$branch"
      return 0
    fi
  done
  return 1
}

prune_gone_branches() {
  # Delete local branches whose upstream tracking branch is gone - the remote
  # branch was deleted, which in this fleet means its PR merged - as long as
  # nothing still needs them. Never the checked-out branch, and never a branch
  # that still has a worktree (a live or not-yet-torn-down task). "Gone" plus
  # "no worktree" already proves the work landed: teardown removes a branch's
  # worktree only after confirming the work reached the remote. We deliberately
  # do NOT also require the branch to be an ancestor of origin/<default> - PRs in
  # this fleet are squash-merged, so a merged branch is never an ancestor and
  # such a check would prune nothing. The no-worktree guard is the real safety
  # net. Set FM_FLEET_PRUNE=0 to skip pruning entirely.
  [ "${FM_FLEET_PRUNE:-1}" != "0" ] || return 0

  local worktree_branches current refline branch track
  worktree_branches=$(git -C "$PROJ" worktree list --porcelain 2>/dev/null \
    | sed -n 's#^branch refs/heads/##p')
  current=$(git -C "$PROJ" symbolic-ref --quiet --short HEAD 2>/dev/null || true)

  while IFS= read -r refline; do
    branch=${refline%% *}
    track=${refline#* }
    [ "$track" = "[gone]" ] || continue
    [ -n "$branch" ] || continue
    [ "$branch" != "$current" ] || continue
    if printf '%s\n' "$worktree_branches" | grep -Fxq -- "$branch"; then
      continue
    fi
    if git -C "$PROJ" branch -D -- "$branch" >/dev/null 2>&1; then
      echo "$label: pruned $branch"
    fi
  done < <(git -C "$PROJ" for-each-ref \
    --format='%(refname:short) %(upstream:track)' refs/heads 2>/dev/null)
}

sync_project() {
  PROJ=$1
  label=$(project_label)

  if [ ! -d "$PROJ" ]; then
    echo "$label: skipped: not a directory"
    return 0
  fi
  if ! git -C "$PROJ" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$label: skipped: not a git repo"
    return 0
  fi
  mode_line=$("$FM_ROOT/sbin/fm-project-mode.sh" "$label" 2>/dev/null || echo "direct-PR off")
  mode=${mode_line%% *}
  if [ "$mode" = "local-only" ]; then
    echo "$label: skipped: local-only project"
    return 0
  fi
  if ! git -C "$PROJ" remote get-url origin >/dev/null 2>&1; then
    echo "$label: skipped: no origin remote"
    return 0
  fi

  if ! ff_refresh_origin "$PROJ"; then
    reason="fetch failed"
    if [ -n "$FF_FETCH_OUTPUT" ]; then
      reason="$reason: $(ff_first_line "$FF_FETCH_OUTPUT")"
    fi
    ff_skip "$label" "$reason"
    return 0
  fi

  prune_gone_branches || true

  DEFAULT=$(default_branch) || {
    echo "$label: skipped: cannot determine default branch"
    return 0
  }
  BASE="origin/$DEFAULT"
  if ! git -C "$PROJ" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
    echo "$label: skipped: $BASE does not exist"
    return 0
  fi

  cur=$(git -C "$PROJ" symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [ "$cur" != "$DEFAULT" ]; then
    [ -n "$cur" ] || cur="detached HEAD"
    echo "$label: skipped: on $cur, expected $DEFAULT"
    return 0
  fi
  if [ -n "$(git -C "$PROJ" status --porcelain 2>/dev/null | head -1)" ]; then
    echo "$label: skipped: dirty working tree"
    return 0
  fi
  if ! git -C "$PROJ" rev-parse --verify --quiet "$DEFAULT^{commit}" >/dev/null; then
    echo "$label: skipped: local $DEFAULT does not exist"
    return 0
  fi

  ff_safe_fast_forward "$PROJ" "$DEFAULT" "$BASE" || true
  case "$FF_RESULT" in
    read-error)
      if [ "$FF_WHICH" = local ]; then
        ff_skip "$label" "cannot read local $DEFAULT"
      else
        ff_skip "$label" "cannot read $BASE"
      fi
      return 0
      ;;
    current)
      echo "$label: already current"
      return 0
      ;;
    diverged)
      ff_skip "$label" "local $DEFAULT has diverged from $BASE"
      return 0
      ;;
    ff-failed)
      reason="fast-forward failed"
      if [ -n "$FF_DETAIL" ]; then
        reason="$reason: $FF_DETAIL"
      fi
      ff_skip "$label" "$reason"
      return 0
      ;;
  esac
  echo "$label: synced $FF_BEFORE..$FF_AFTER"
  return 0
}

if [ $# -eq 1 ]; then
  sync_project "$1"
  exit 0
fi

[ -d "$PROJECTS" ] || exit 0
for proj in "$PROJECTS"/*; do
  [ -e "$proj" ] || continue
  [ -d "$proj" ] || continue
  sync_project "$proj"
done
