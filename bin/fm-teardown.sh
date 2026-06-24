#!/usr/bin/env bash
# Tear down a finished task: remove the herdr workspace/worktree or retire a
# secondmate home, close the herdr pane, clear volatile state, refresh/prune
# the project's clone for PR-based ship tasks, then print a backlog-refresh
# reminder.
# REFUSES if the worktree holds work not on any remote. A fork counts as a
# remote, so upstream-contribution PRs pushed to a fork satisfy this in any mode.
# local-only projects additionally accept work merged into the local default
# branch (firstmate performs that merge on the captain's approval) as a fallback
# for the common case where there is no remote at all.
# Scout tasks (kind=scout in meta) carve out of that check: their worktree is
# declared scratch and the report at data/<task-id>/report.md is the work
# product - teardown proceeds once the report exists, and refuses without it.
# Secondmates (kind=secondmate in meta) are retired explicitly. Normal
# teardown refuses while their home has in-flight crewmate meta files; --force
# is the approved discard path that prevalidates child removal targets, discards
# child work, kills child panes, and removes the retired home. Removing a
# herdr-managed home calls "herdr worktree remove" to close the workspace and
# prune the git worktree cleanly. A plain-clone home is removed with rm -rf.
# Usage: fm-teardown.sh <task-id> [--force]
#   --force skips the unpushed-work check for ordinary tasks and discards
#   secondmate child work for kind=secondmate. Only use it when the captain has
#   explicitly said to discard the work.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
SECONDMATE_REG="$DATA/secondmates.md"
SUB_HOME_MARKER=".fm-secondmate-home"
# shellcheck source=bin/fm-tasks-axi-lib.sh
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
"$FM_ROOT/bin/fm-guard.sh" || true
ID=$1
FORCE=${2:-}

META="$STATE/$ID.meta"
[ -f "$META" ] || { echo "error: no meta for task $ID at $META" >&2; exit 1; }
WT=$(grep '^worktree=' "$META" | cut -d= -f2-)
PANE=$(grep '^pane=' "$META" | cut -d= -f2-)
PROJ=$(grep '^project=' "$META" | cut -d= -f2-)
HOME_PATH=$(grep '^home=' "$META" | cut -d= -f2- || true)
PR_URL=$(grep '^pr=' "$META" | tail -1 | cut -d= -f2- || true)
WORKSPACE_ID=$(grep '^workspace_id=' "$META" | cut -d= -f2- || true)

KIND=$(grep '^kind=' "$META" | cut -d= -f2- || true)
[ -n "$KIND" ] || KIND=ship
MODE=$(grep '^mode=' "$META" | cut -d= -f2- || true)
[ -n "$MODE" ] || MODE=no-mistakes

default_branch() {
  local ref branch
  ref=$(git -C "$PROJ" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$ref" ]; then
    echo "${ref#origin/}"
    return 0
  fi
  for branch in main master; do
    if git -C "$PROJ" show-ref --verify --quiet "refs/heads/$branch"; then
      echo "$branch"
      return 0
    fi
  done
  return 1
}

meta_value() {
  local meta=$1 key=$2
  grep "^$key=" "$meta" | cut -d= -f2- || true
}

backlog_refresh_reminder() {
  local pr done_cmd report_path
  if fm_tasks_axi_compatible; then
    case "$KIND" in
      scout)
        report_path="data/$ID/report.md"
        done_cmd="tasks-axi done $ID --report $report_path"
        ;;
      secondmate)
        done_cmd="tasks-axi done $ID --note \"retired\""
        ;;
      *)
        if [ "$MODE" = local-only ]; then
          done_cmd="tasks-axi done $ID --note \"local main\""
        else
          pr=$PR_URL
          if [ -n "$pr" ]; then
            done_cmd="tasks-axi done $ID --pr $pr"
          else
            done_cmd="tasks-axi done $ID --pr PR_URL"
          fi
        fi
        ;;
    esac
    printf '%s\n' "Backlog: $ID just finished. Run $done_cmd, then run tasks-axi ready for dependency-cleared candidates, check date gates, and dispatch only work whose blockers are gone and date is due."
  else
    printf '%s\n' "Backlog: $ID just finished. Update data/backlog.md - move $ID to Done, keep Done to the 10 most recent, then re-scan Queued and dispatch only work whose blockers are gone and date is due."
  fi
}

registry_home_for_line() {
  sed -n 's/^[^(]*(home: \([^;)]*\);.*/\1/p'
}

path_is_ancestor_of() {
  local ancestor=$1 path=$2
  [ -n "$ancestor" ] || return 1
  [ -n "$path" ] || return 1
  [ "$ancestor" != "$path" ] || return 1
  case "$path" in
    "$ancestor"/*) return 0 ;;
  esac
  return 1
}

removal_target_abs_path() {
  local target=$1
  if [ -d "$target" ]; then
    cd "$target" && pwd -P
  else
    cd "$(dirname "$target")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$target")"
  fi
}

registry_workspace_id_for_id() {
  local id=$1 reg=$2
  [ -f "$reg" ] || return 0
  sed -n "s/^- $id [^(]*(.*workspace: \\([^;)]*\\).*/\\1/p" "$reg" | head -1
}

worktree_registered_for_project() {
  local project=$1 target=$2 abs_target listed line listed_abs
  [ -n "$project" ] || return 1
  [ -d "$project" ] || return 1
  git -C "$project" rev-parse --git-dir >/dev/null 2>&1 || return 1
  abs_target=$(removal_target_abs_path "$target")
  listed=$(git -C "$project" -c core.quotePath=false worktree list --porcelain 2>/dev/null) || return 1
  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        listed_abs=$(removal_target_abs_path "${line#worktree }" 2>/dev/null || true)
        [ "$listed_abs" = "$abs_target" ] && return 0
        ;;
    esac
  done <<EOF
$listed
EOF
  return 1
}

validate_removal_target() {
  local target=$1 label=$2 abs_target abs_home abs_root
  [ -n "$target" ] || return 0
  [ -e "$target" ] || return 0
  abs_target=$(removal_target_abs_path "$target")
  if abs_home=$(cd "$FM_HOME" 2>/dev/null && pwd -P); then
    :
  else
    abs_home=
  fi
  abs_root=$(cd "$FM_ROOT" && pwd -P)
  case "$abs_target" in
    ''|/) echo "REFUSED: unsafe $label removal target $target" >&2; return 1 ;;
  esac
  if [ -n "$abs_home" ] && [ "$abs_target" = "$abs_home" ]; then
    echo "REFUSED: unsafe $label removal target $target is the active firstmate home" >&2
    return 1
  fi
  if [ "$abs_target" = "$abs_root" ]; then
    echo "REFUSED: unsafe $label removal target $target is the firstmate repo" >&2
    return 1
  fi
  if [ -n "$abs_home" ] && path_is_ancestor_of "$abs_target" "$abs_home"; then
    echo "REFUSED: unsafe $label removal target $target is an ancestor of the active firstmate home" >&2
    return 1
  fi
  if path_is_ancestor_of "$abs_target" "$abs_root"; then
    echo "REFUSED: unsafe $label removal target $target is an ancestor of the firstmate repo" >&2
    return 1
  fi
  if [ -n "$abs_home" ] && path_is_ancestor_of "$abs_home" "$abs_target"; then
    echo "REFUSED: unsafe $label removal target $target is inside the active firstmate home" >&2
    return 1
  fi
  if path_is_ancestor_of "$abs_root" "$abs_target"; then
    echo "REFUSED: unsafe $label removal target $target is inside the firstmate repo" >&2
    return 1
  fi
  printf '%s\n' "$abs_target"
}

registered_descendant_home_for_removal() {
  local reg=$1 target=$2 line id registered_home registered_abs
  [ -f "$reg" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "- "*)
        id=${line#- }
        id=${id%% *}
        registered_home=$(printf '%s\n' "$line" | registry_home_for_line)
        [ -n "$registered_home" ] || continue
        registered_abs=$(removal_target_abs_path "$registered_home" 2>/dev/null || true)
        [ -n "$registered_abs" ] || continue
        [ "$registered_abs" = "$target" ] && continue
        if path_is_ancestor_of "$target" "$registered_abs"; then
          printf '%s\t%s\n' "$id" "$registered_abs"
          return 0
        fi
        ;;
    esac
  done < "$reg"
  return 1
}

validate_firstmate_operational_dirs_for_removal() {
  local home=$1 label=$2 name dir abs_home abs_dir
  abs_home=$(removal_target_abs_path "$home")
  for name in data state config projects; do
    dir="$home/$name"
    [ -e "$dir" ] || [ -L "$dir" ] || continue
    if [ -L "$dir" ] && [ ! -e "$dir" ]; then
      echo "REFUSED: unsafe $label $name directory $dir resolves outside the secondmate home" >&2
      return 1
    fi
    if [ -d "$dir" ]; then
      abs_dir=$(cd "$dir" && pwd -P)
    elif [ -e "$dir" ]; then
      echo "REFUSED: unsafe $label $name path $dir is not a directory" >&2
      return 1
    else
      abs_dir=
    fi
    if [ -z "$abs_dir" ] || ! path_is_ancestor_of "$abs_home" "$abs_dir"; then
      echo "REFUSED: unsafe $label $name directory $dir resolves outside the secondmate home" >&2
      return 1
    fi
  done
}

validate_child_worktree_for_removal() {
  local target=$1 project=$2 abs_target abs_home abs_root
  [ -n "$target" ] || return 0
  [ -e "$target" ] || return 0
  abs_target=$(validate_removal_target "$target" "child worktree") || return 1
  if abs_home=$(cd "$FM_HOME" 2>/dev/null && pwd -P); then
    if path_is_ancestor_of "$abs_home" "$abs_target"; then
      echo "REFUSED: unsafe child worktree removal target $target is inside the active firstmate home" >&2
      return 1
    fi
  fi
  abs_root=$(cd "$FM_ROOT" && pwd -P)
  if path_is_ancestor_of "$abs_root" "$abs_target"; then
    echo "REFUSED: unsafe child worktree removal target $target is inside the firstmate repo" >&2
    return 1
  fi
  if ! worktree_registered_for_project "$project" "$target"; then
    echo "REFUSED: unsafe child worktree removal target $target is not a git worktree for ${project:-the recorded project}" >&2
    return 1
  fi
  printf '%s\n' "$abs_target"
}

safe_rm_rf() {
  local target=$1 label=$2
  validate_removal_target "$target" "$label" >/dev/null || return 1
  rm -rf -- "$target"
}

safe_rm_rf_child_worktree() {
  local target=$1 project=$2
  validate_child_worktree_for_removal "$target" "$project" >/dev/null || return 1
  rm -rf -- "$target"
}

validate_firstmate_home_for_removal() {
  local home=$1 label=$2 expected_id=${3:-} abs_home_path marker_id conflict child_id child_home
  [ -n "$home" ] || return 0
  [ -e "$home" ] || return 0
  abs_home_path=$(validate_removal_target "$home" "$label") || return 1
  if [ ! -f "$abs_home_path/$SUB_HOME_MARKER" ]; then
    echo "REFUSED: unsafe $label removal target $home is not a seeded secondmate home" >&2
    return 1
  fi
  if [ -n "$expected_id" ]; then
    marker_id=$(cat "$abs_home_path/$SUB_HOME_MARKER" 2>/dev/null || true)
    if [ "$marker_id" != "$expected_id" ]; then
      echo "REFUSED: unsafe $label removal target $home is marked for secondmate ${marker_id:-unknown}, expected $expected_id" >&2
      return 1
    fi
  fi
  validate_firstmate_operational_dirs_for_removal "$abs_home_path" "$label" || return 1
  conflict=$(registered_descendant_home_for_removal "$SECONDMATE_REG" "$abs_home_path" || true)
  if [ -z "$conflict" ]; then
    conflict=$(registered_descendant_home_for_removal "$abs_home_path/data/secondmates.md" "$abs_home_path" || true)
  fi
  if [ -n "$conflict" ]; then
    IFS=$'\t' read -r child_id child_home <<EOF
$conflict
EOF
    echo "REFUSED: unsafe $label removal target $home contains registered secondmate home $child_home for $child_id" >&2
    return 1
  fi
  printf '%s\n' "$abs_home_path"
}

remove_firstmate_home() {
  local home=$1 label=$2 expected_id=${3:-} abs_home_path workspace_id
  [ -n "$home" ] || return 0
  [ -e "$home" ] || return 0
  abs_home_path=$(validate_firstmate_home_for_removal "$home" "$label" "$expected_id") || return 1
  [ -n "$abs_home_path" ] || return 0
  workspace_id=$(registry_workspace_id_for_id "$expected_id" "$SECONDMATE_REG")
  if [ -n "$workspace_id" ]; then
    herdr worktree remove --workspace "$workspace_id" --force >/dev/null 2>&1 || {
      echo "error: herdr worktree remove failed for $label workspace $workspace_id; workspace may still exist" >&2
      return 1
    }
    return 0
  fi
  safe_rm_rf "$abs_home_path" "$label"
}

validate_firstmate_home_children_removal() {
  local home=$1 sub_state child_meta child_id child_wt child_proj child_kind child_home
  sub_state="$home/state"
  [ -d "$sub_state" ] || return 0
  for child_meta in "$sub_state"/*.meta; do
    [ -e "$child_meta" ] || continue
    child_id=$(basename "$child_meta" .meta)
    child_wt=$(meta_value "$child_meta" worktree)
    child_kind=$(meta_value "$child_meta" kind)
    [ -n "$child_kind" ] || child_kind=ship
    if [ "$child_kind" = secondmate ]; then
      child_home=$(meta_value "$child_meta" home)
      [ -n "$child_home" ] || child_home=$child_wt
      validate_firstmate_home_for_removal "$child_home" "child firstmate home" "$child_id" >/dev/null || return 1
      validate_firstmate_home_children_removal "$child_home" || return 1
    elif [ -n "$child_wt" ] && [ -d "$child_wt" ]; then
      child_proj=$(meta_value "$child_meta" project)
      validate_child_worktree_for_removal "$child_wt" "$child_proj" >/dev/null || return 1
    fi
  done
}

cleanup_firstmate_home_children() {
  local home=$1 sub_state child_meta child_id child_t child_wt child_proj child_kind child_home
  sub_state="$home/state"
  [ -d "$sub_state" ] || return 0
  for child_meta in "$sub_state"/*.meta; do
    [ -e "$child_meta" ] || continue
    child_id=$(basename "$child_meta" .meta)
    child_wt=$(meta_value "$child_meta" worktree)
    child_proj=$(meta_value "$child_meta" project)
    child_kind=$(meta_value "$child_meta" kind)
    [ -n "$child_kind" ] || child_kind=ship
    local child_pane
    child_pane=$(meta_value "$child_meta" pane)
    if [ -n "$child_pane" ]; then
      herdr pane close "$child_pane" 2>/dev/null || true
    fi
    if [ "$child_kind" = secondmate ]; then
      child_home=$(meta_value "$child_meta" home)
      [ -n "$child_home" ] || child_home=$child_wt
      if [ -n "$child_home" ] && [ -d "$child_home" ]; then
        cleanup_firstmate_home_children "$child_home"
        remove_firstmate_home "$child_home" "child firstmate home" "$child_id"
      fi
    elif [ -n "$child_wt" ] && [ -d "$child_wt" ]; then
      local child_workspace_id
      child_workspace_id=$(meta_value "$child_meta" workspace_id)
      validate_child_worktree_for_removal "$child_wt" "$child_proj" >/dev/null || return 1
      if [ -n "$child_workspace_id" ]; then
        herdr worktree remove --workspace "$child_workspace_id" --force 2>/dev/null || true
        [ -n "$child_proj" ] && [ -d "$child_proj" ] && git -C "$child_proj" branch -D "fm/$child_id" 2>/dev/null || true
      elif [ -n "$child_proj" ] && [ -d "$child_proj" ]; then
        git -C "$child_proj" worktree remove --force "$child_wt" 2>/dev/null || safe_rm_rf_child_worktree "$child_wt" "$child_proj"
        git -C "$child_proj" branch -D "fm/$child_id" 2>/dev/null || true
      else
        safe_rm_rf_child_worktree "$child_wt" "$child_proj"
      fi
    fi
    local ck
    ck=$(printf '%s' "$(meta_value "$child_meta" pane)" | tr ':' '_')
    rm -f "$sub_state/$child_id.status" "$sub_state/$child_id.check.sh" "$sub_state/$child_id.meta"
    rm -f "$sub_state/.herdr-prev-status-$ck" "$sub_state/.herdr-idle-count-$ck" "$sub_state/.herdr-turn-$ck" "$sub_state/.stale-$ck"
  done
}

remove_secondmate_registry_entry() {
  local id=$1 tmp
  [ -f "$SECONDMATE_REG" ] || return 0
  tmp="$SECONDMATE_REG.tmp.$$"
  grep -vE "^- $id( |$)" "$SECONDMATE_REG" > "$tmp" || true
  mv "$tmp" "$SECONDMATE_REG"
}

if [ "$KIND" = secondmate ]; then
  [ -n "$HOME_PATH" ] || HOME_PATH=$WT
  validate_firstmate_home_for_removal "$HOME_PATH" "secondmate home" "$ID" >/dev/null || exit 1
  if [ "$FORCE" = "--force" ]; then
    validate_firstmate_home_children_removal "$HOME_PATH" || exit 1
  fi
fi

if [ "$KIND" = secondmate ] && [ "$FORCE" != "--force" ]; then
  SUB_STATE="$HOME_PATH/state"
  if [ -d "$SUB_STATE" ]; then
    for child_meta in "$SUB_STATE"/*.meta; do
      [ -e "$child_meta" ] || continue
      echo "REFUSED: secondmate $ID still has in-flight work in $SUB_STATE." >&2
      echo "Found $(basename "$child_meta"). Let that home finish or explicitly discard with --force." >&2
      exit 1
    done
  fi
fi

if [ "$KIND" = secondmate ] && [ "$FORCE" = "--force" ]; then
  cleanup_firstmate_home_children "$HOME_PATH"
fi

if [ -d "$WT" ] && [ "$FORCE" != "--force" ]; then
  if [ "$KIND" = secondmate ]; then
    :
  elif [ "$KIND" = scout ]; then
    # Scout worktrees are scratch by contract, but only once the deliverable exists.
    REPORT="$DATA/$ID/report.md"
    if [ ! -f "$REPORT" ]; then
      echo "REFUSED: scout task $ID has no report at $REPORT." >&2
      echo "The report is the work product. Have the crewmate write it (or get the captain's explicit OK to discard, then --force)." >&2
      exit 1
    fi
  else
    # The fm-spawn hook file is ours, never work product; ignore it in the dirty check.
    dirty=$(git -C "$WT" status --porcelain 2>/dev/null | grep -vE '^\?\? \.claude/' | head -1 || true)
    # A worktree's work is "safely on a remote" once HEAD is reachable from ANY
    # remote-tracking branch (empty result here). A fork is a remote too, so
    # upstream-contribution PRs pushed to a fork satisfy this regardless of mode.
    unpushed=$(git -C "$WT" log --oneline HEAD --not --remotes -- 2>/dev/null | head -5 || true)
    if [ -n "$unpushed" ] && [ "$MODE" = local-only ]; then
      # local-only ships have no remote in the common case, so the "on a remote"
      # test above is expected to be non-empty. The work is safe once it is merged
      # into the local default branch (firstmate does that merge on the captain's
      # approval). Refuse until then.
      DEFAULT=$(default_branch) || { echo "REFUSED: cannot determine default branch for $PROJ; expected origin/HEAD, main, or master." >&2; exit 1; }
      unmerged=$(git -C "$WT" log --oneline HEAD --not "$DEFAULT" -- 2>/dev/null | head -5 || true)
      if [ -n "$dirty" ] || [ -n "$unmerged" ]; then
        echo "REFUSED: local-only worktree $WT has work not yet merged into $DEFAULT and not on any remote." >&2
        [ -n "$dirty" ] && echo "uncommitted changes present" >&2
        [ -n "$unmerged" ] && printf 'commits not yet on %s:\n%s\n' "$DEFAULT" "$unmerged" >&2
        echo "Merge the branch into local $DEFAULT first (bin/fm-merge-local.sh after the captain approves), or push to a fork/remote, or get the captain's explicit OK to discard, then --force." >&2
        exit 1
      fi
    elif [ -n "$dirty" ] || [ -n "$unpushed" ]; then
      echo "REFUSED: worktree $WT has work not on any remote." >&2
      [ -n "$dirty" ] && echo "uncommitted changes present" >&2
      [ -n "$unpushed" ] && printf 'unpushed commits:\n%s\n' "$unpushed" >&2
      echo "Push the branch (or get the captain's explicit OK to discard, then --force)." >&2
      exit 1
    fi
  fi
fi

# Close the recorded agent pane explicitly before any worktree/workspace
# removal. "herdr worktree remove --workspace" is not reliable on its own: it
# can leave the agent pane alive (and the worktree held as the agent's cwd)
# when the workspace has non-agent panes or the agent still occupies the
# directory. Closing only the recorded pane= leaves any non-agent panes in the
# workspace intact.
[ -n "$PANE" ] && herdr pane close "$PANE" 2>/dev/null || true

if [ "$KIND" != secondmate ]; then
  if [ -n "$WORKSPACE_ID" ]; then
    herdr worktree remove --workspace "$WORKSPACE_ID" --force 2>/dev/null || true
    [ -n "$PROJ" ] && [ -d "$PROJ" ] && git -C "$PROJ" branch -D "fm/$ID" 2>/dev/null || true
  elif [ -d "$WT" ]; then
    if [ -n "$PROJ" ] && [ -d "$PROJ" ]; then
      git -C "$PROJ" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
      git -C "$PROJ" branch -D "fm/$ID" 2>/dev/null || true
    else
      rm -rf "$WT"
    fi
  fi
  # Defensive: if the worktree directory survived the herdr/git cleanup above
  # (a partial workspace removal, or the agent still holding it as cwd), remove
  # it directly so teardown never leaves the directory behind.
  if [ -n "$WT" ] && [ -d "$WT" ]; then
    if [ -n "$PROJ" ] && [ -d "$PROJ" ]; then
      git -C "$PROJ" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
    else
      rm -rf "$WT"
    fi
  fi
fi
if [ "$KIND" = secondmate ]; then
  [ -n "$HOME_PATH" ] || HOME_PATH=$WT
  remove_firstmate_home "$HOME_PATH" "secondmate home" "$ID"
  remove_secondmate_registry_entry "$ID"
fi
PANE_KEY=$(printf '%s' "$PANE" | tr ':' '_')
rm -f "$STATE/$ID.status" "$STATE/$ID.check.sh" "$STATE/$ID.meta"
rm -f "$STATE/.herdr-prev-status-$PANE_KEY" "$STATE/.herdr-idle-count-$PANE_KEY" "$STATE/.herdr-turn-$PANE_KEY" "$STATE/.stale-$PANE_KEY"
if [ "$KIND" != scout ] && [ "$KIND" != secondmate ] && [ "$MODE" != local-only ]; then
  "$FM_ROOT/bin/fm-fleet-sync.sh" "$PROJ" || true
fi
echo "teardown $ID complete (pane $PANE, worktree $WT)"
backlog_refresh_reminder
