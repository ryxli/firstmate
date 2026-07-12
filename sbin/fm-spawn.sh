#!/usr/bin/env bash
# Spawn a direct report: a crewmate in a git worktree, or a secondmate in
# its isolated firstmate home.
# Usage: fm-spawn.sh <task-id> <project-dir> [harness|launch-command] [--scout] [--workspace=<id>] [--tab=<id>]
#        fm-spawn.sh <task-id> [<firstmate-home>] [harness|launch-command] --secondmate [--workspace=<id>] [--tab=<id>]
#   With no harness arg, the harness comes from fm-harness.sh crew (config/crew-harness,
#   falling back to firstmate's own harness). A bare adapter name (omp|claude|codex|
#   opencode|pi) overrides it for this spawn. A non-flag string containing whitespace
#   is treated as a RAW launch command - the escape hatch for verifying new adapters.
#   --scout records kind=scout in the task's meta (report deliverable, scratch worktree;
#   see AGENTS.md section 7); --secondmate records kind=secondmate and launches in a
#   provisioned firstmate home; the default is kind=ship.
# Batch dispatch: pass one or more `id=repo` pairs instead of a single <id> <project>:
#     fm-spawn.sh fix-a-k3=projects/foo add-b-q7=projects/bar [--scout]
#   Each pair re-execs this script in single-task mode.
#
# Worktrees are created with `git worktree add` at $FM_WORKTREE_BASE/<id>
# (default: $FM_HOME/worktrees/<id>). herdr agent start launches the crewmate
# directly in the worktree directory. herdr tracks agent status natively, so
# no per-harness turn-end hook files are installed.
#
# On success prints:
#   spawned <id> harness=<name> kind=<ship|scout|secondmate> mode=<mode> yolo=<on|off> pane=<pane-id> worktree=<path>
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_CODE_ROOT_OVERRIDE:-${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
PROJECTS="${FM_PROJECTS_OVERRIDE:-$FM_HOME/projects}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
SUB_HOME_MARKER=".fm-secondmate-home"
# shellcheck source=sbin/fm-identity-lib.sh
. "$SCRIPT_DIR/fm-identity-lib.sh"
# shellcheck source=sbin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"
# shellcheck source=sbin/fm-spawn-lib.sh
. "$SCRIPT_DIR/fm-spawn-lib.sh"
# shellcheck source=sbin/fm-tasks-axi-lib.sh
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"

KIND=ship
WORKSPACE=""
TAB=""
POS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scout) KIND=scout ;;
    --secondmate) KIND=secondmate ;;
    --workspace=*) WORKSPACE=${1#*=} ;;
    --workspace)
      shift
      [ "$#" -gt 0 ] || { echo "error: --workspace requires a value" >&2; exit 2; }
      WORKSPACE=$1
      ;;
    --tab=*) TAB=${1#*=} ;;
    --tab)
      shift
      [ "$#" -gt 0 ] || { echo "error: --tab requires a value" >&2; exit 2; }
      TAB=$1
      ;;
    *) POS+=("$1") ;;
  esac
  shift
done

# Batch dispatch: each positional is an id=repo pair.
idpart=${POS[0]:-}
idpart=${idpart%%=*}
if [ "${#POS[@]}" -gt 0 ] && [ "${POS[0]}" != "$idpart" ] && case "$idpart" in */*) false ;; *) true ;; esac; then
  rc=0
  for pair in "${POS[@]}"; do
    case "$pair" in
      *=*) : ;;
      *) echo "error: batch dispatch expects every argument as id=repo; got '$pair'" >&2; rc=2; continue ;;
    esac
    if [ "$KIND" = secondmate ]; then
      echo "error: batch dispatch does not support --secondmate; spawn each secondmate explicitly" >&2
      rc=2
      continue
    elif [ "$KIND" = scout ]; then
      if FM_SPAWN_NO_GUARD=1 "$FM_ROOT/sbin/fm-spawn.sh" "${pair%%=*}" "${pair#*=}" --scout; then :; else echo "batch: FAILED to spawn ${pair%%=*} (${pair#*=})" >&2; rc=1; fi
    else
      if FM_SPAWN_NO_GUARD=1 "$FM_ROOT/sbin/fm-spawn.sh" "${pair%%=*}" "${pair#*=}"; then :; else echo "batch: FAILED to spawn ${pair%%=*} (${pair#*=})" >&2; rc=1; fi
    fi
  done
  exit "$rc"
fi

ID=${POS[0]}
PROJ=
ARG3=
FIRSTMATE_HOME=

if [ "$KIND" = secondmate ]; then
  case "${POS[1]:-}" in
    ''|omp|claude|codex|opencode|pi)
      ARG3=${POS[1]:-}
      ;;
    *' '*)
      if [ "${#POS[@]}" -gt 2 ] || [ -d "${POS[1]}" ]; then
        FIRSTMATE_HOME=${POS[1]}
        ARG3=${POS[2]:-}
      else
        ARG3=${POS[1]}
      fi
      ;;
    *)
      FIRSTMATE_HOME=${POS[1]}
      ARG3=${POS[2]:-}
      ;;
  esac
else
  PROJ=${POS[1]}
  ARG3=${POS[2]:-}
fi

# Launch templates per adapter. No turn-end hook placeholders needed since
# herdr tracks agent status natively. __BRIEF__ is still used.
launch_template() {
  local harness=$1
  # shellcheck disable=SC2016
  case "$harness" in
    omp)    printf '%s' 'omp --auto-approve "$(cat __BRIEF__)"' ;;
    claude) printf '%s' 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions "$(cat __BRIEF__)"' ;;
    codex)  printf '%s' 'codex --dangerously-bypass-approvals-and-sandbox "$(cat __BRIEF__)"' ;;
    opencode) printf '%s' 'OPENCODE_CONFIG_CONTENT='\''{"permission":{"*":"allow"}}'\'' opencode --prompt "$(cat __BRIEF__)"' ;;
    pi)     printf '%s' 'pi "$(cat __BRIEF__)"' ;;
    *) return 1 ;;
  esac
}

case "$ARG3" in
  *' '*)
    LAUNCH=$ARG3
    HARNESS=""
    for word in $LAUNCH; do
      case "$word" in [A-Za-z_]*=*) continue ;; *) HARNESS=$(basename "$word"); break ;; esac
    done
    ;;
  '')
    HARNESS=$("$FM_ROOT/sbin/fm-harness.sh" crew)
    LAUNCH=$(launch_template "$HARNESS") || { echo "error: no launch template for harness '$HARNESS' (from config/crew-harness or detection); pass a raw launch command to use an unverified adapter" >&2; exit 1; }
    ;;
  *)
    HARNESS=$ARG3
    LAUNCH=$(launch_template "$HARNESS") || { echo "error: unknown harness '$HARNESS'; pass a raw launch command to use an unverified adapter" >&2; exit 1; }
    ;;
esac

secondmate_registry_value() {
  local id=$1 key=$2 reg line value
  reg="$DATA/secondmates.md"
  [ -f "$reg" ] || return 1
  line=$(grep -E "^- $id( |$)" "$reg" | tail -1 || true)
  [ -n "$line" ] || return 1
  case "$key" in
    home) value=$(printf '%s\n' "$line" | sed -n 's/^[^(]*(home: \([^;)]*\).*/\1/p') ;;
    workspace) value=$(printf '%s\n' "$line" | sed -n 's/^[^(]*(home: [^;)]*; workspace: \([^;)]*\).*/\1/p') ;;
    projects) value=$(printf '%s\n' "$line" | sed -n 's/^[^(]*(home: [^;)]*;.*projects: \([^;)]*\); added .*/\1/p') ;;
    *) return 1 ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

replace_registered_secondmate_workspace() {
  local id=$1 old_workspace=$2 new_workspace=$3 reg tmp
  reg="$DATA/secondmates.md"
  [ -f "$reg" ] || { echo "error: no secondmate registry at $reg" >&2; return 1; }
  tmp=$(mktemp "${reg}.XXXXXX") || return 1
  if ! awk -v id="$id" -v old_workspace="$old_workspace" -v new_workspace="$new_workspace" '
    BEGIN {
      prefix = "- " id " "
      needle = "workspace: " old_workspace ";"
      replacement = "workspace: " new_workspace ";"
    }
    index($0, prefix) == 1 {
      if (updated++) exit 2
      position = index($0, needle)
      if (!position) exit 3
      $0 = substr($0, 1, position - 1) replacement substr($0, position + length(needle))
    }
    { print }

    END {
      if (!updated) exit 4
    }
  ' "$reg" > "$tmp"; then
    rm -f "$tmp"
    echo "error: could not update workspace registration for secondmate $id" >&2
    return 1
  fi
  mv "$tmp" "$reg"
}

# append_backlog_inflight <id> <repo> <kind>
#
# Record a dispatched ship/scout task before returning success. A task that
# survives a process restart must not depend on the operator remembering a
# separate backlog mutation. Prefer tasks-axi when the active home is
# configured for it; retain the documented Markdown fallback otherwise.
# Backlog bookkeeping is intentionally best-effort because a live pane and its
# metadata are more important than a local status record that can be repaired.
append_backlog_inflight() {
  local id=$1 repo=$2 kind=$3 backlog today line tmp
  backlog="$DATA/backlog.md"
  today=$(date +%Y-%m-%d)

  mkdir -p "$DATA" 2>/dev/null || return 0
  if [ ! -f "$backlog" ]; then
    printf '## In flight\n\n## Queued\n\n## Done\n' > "$backlog" || return 0
  fi

  # Idempotent across a retry after pane launch or a repaired status record.
  grep -Eq -- "^- (\\[ \\] |\\*\\*)$id( |\\*|-|$)" "$backlog" && return 0

  if [ -f "$FM_HOME/.tasks.toml" ] && fm_tasks_axi_compatible 2>/dev/null; then
    (cd "$FM_HOME" && tasks-axi add "$id" "$kind task" --kind "$kind" --repo "$repo" --start >/dev/null 2>&1) && return 0
  fi

  line="- [ ] $id - $kind task (repo: $repo, since $today)"
  if grep -q '^## In flight$' "$backlog"; then
    tmp=$(mktemp "$DATA/.backlog.XXXXXX") || return 0
    if awk -v line="$line" '
      { print }
      /^## In flight$/ && !inserted { print line; inserted=1 }
    ' "$backlog" > "$tmp"; then
      mv "$tmp" "$backlog" || rm -f "$tmp"
    else
      rm -f "$tmp"
    fi
  else
    printf '## In flight\n%s\n' "$line" >> "$backlog" || true
  fi
}

replace_secondmate_meta_workspace() {
  local id=$1 workspace=$2 meta tmp
  meta="$STATE/$id.meta"
  [ -f "$meta" ] || return 0
  tmp=$(mktemp "${meta}.XXXXXX") || return 1
  if ! awk -v workspace="$workspace" '
    /^workspace=/ {
      if (updated++) exit 2
      print "workspace=" workspace
      next
    }
    { print }
    END {
      if (!updated) print "workspace=" workspace
    }
  ' "$meta" > "$tmp"; then
    rm -f "$tmp"
    echo "error: could not update workspace metadata for secondmate $id" >&2
    return 1
  fi
  mv "$tmp" "$meta"
}

recover_missing_registered_secondmate_workspace() {
  local registered_workspace workspace_get replacement_json replacement_workspace
  [ "$KIND" = secondmate ] || return 0
  [ -n "$WORKSPACE" ] || return 0
  registered_workspace=$(secondmate_registry_value "$ID" workspace || true)
  [ "$WORKSPACE" = "$registered_workspace" ] || return 0

  workspace_get=$(herdr workspace get "$WORKSPACE" 2>&1) && return 0
  if ! printf '%s' "$workspace_get" | grep -Eq '"code":"workspace_not_found"|workspace .+ not found'; then
    echo "error: could not verify registered workspace $WORKSPACE for secondmate $ID" >&2
    echo "$workspace_get" >&2
    return 1
  fi

  replacement_json=$(herdr workspace create --cwd "$PROJ_ABS" --label "$WORKER_LABEL" --no-focus 2>&1) || {
    echo "error: herdr workspace create failed while recovering secondmate $ID" >&2
    echo "$replacement_json" >&2
    return 1
  }
  replacement_workspace=$(printf '%s' "$replacement_json" | fm_json_get result workspace workspace_id)
  [ -n "$replacement_workspace" ] || {
    echo "error: herdr workspace create did not return a workspace_id while recovering secondmate $ID" >&2
    echo "$replacement_json" >&2
    return 1
  }

  replace_registered_secondmate_workspace "$ID" "$WORKSPACE" "$replacement_workspace" || return 1
  if ! replace_secondmate_meta_workspace "$ID" "$replacement_workspace"; then
    replace_registered_secondmate_workspace "$ID" "$replacement_workspace" "$WORKSPACE" || true
    return 1
  fi
  WORKSPACE=$replacement_workspace
}


resolved_existing_dir() {
  local path=$1
  [ -d "$path" ] || { echo "error: firstmate home does not exist or is not a directory: $path" >&2; return 1; }
  cd "$path" && pwd -P
}

resolve_project_dir_arg() {
  local path=$1
  case "$path" in
    projects/*) printf '%s/%s\n' "$PROJECTS" "${path#projects/}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}

path_is_ancestor_of() {
  local ancestor=$1 path=$2
  [ -n "$ancestor" ] || return 1
  [ -n "$path" ] || return 1
  [ "$ancestor" != "$path" ] || return 1
  case "$path" in "$ancestor"/*) return 0 ;; esac
  return 1
}

home_has_shared_code_links() {
  local home=$1
  [ -L "$home/AGENTS.md" ] || [ -L "$home/sbin" ]
}

home_needs_shared_code_repair() {
  local home=$1
  home_has_shared_code_links "$home" && return 0
  { [ ! -e "$home/AGENTS.md" ] || [ ! -e "$home/sbin" ]; } \
    && [ -f "$home/config/identity" ]
}

validate_firstmate_home_for_spawn() {
  local id=$1 home=$2 abs_home abs_active_home abs_root marker_id
  abs_home=$(resolved_existing_dir "$home") || return 1
  abs_active_home=$(resolved_existing_dir "$FM_HOME")
  abs_root=$(resolved_existing_dir "$FM_ROOT")
  if [ "$abs_home" = "/" ]; then
    echo "error: secondmate home cannot be the filesystem root: $home" >&2; return 1
  fi
  if [ "$abs_home" = "$abs_active_home" ]; then
    echo "error: secondmate home cannot be the active firstmate home: $home" >&2; return 1
  fi
  if [ "$abs_home" = "$abs_root" ]; then
    echo "error: secondmate home cannot be the firstmate repo: $home" >&2; return 1
  fi
  if path_is_ancestor_of "$abs_active_home" "$abs_home"; then
    echo "error: secondmate home cannot be inside the active firstmate home: $home" >&2; return 1
  fi
  if path_is_ancestor_of "$abs_root" "$abs_home"; then
    echo "error: secondmate home cannot be inside the firstmate repo: $home" >&2; return 1
  fi
  if path_is_ancestor_of "$abs_home" "$abs_active_home"; then
    echo "error: secondmate home cannot be an ancestor of the active firstmate home: $home" >&2; return 1
  fi
  if path_is_ancestor_of "$abs_home" "$abs_root"; then
    echo "error: secondmate home cannot be an ancestor of the firstmate repo: $home" >&2; return 1
  fi
  validate_firstmate_operational_dirs "$abs_home" "$abs_active_home" "$abs_root" || return 1
  if [ ! -f "$abs_home/$SUB_HOME_MARKER" ]; then
    echo "error: firstmate home $home is not a seeded secondmate home" >&2; return 1
  fi
  marker_id=$(cat "$abs_home/$SUB_HOME_MARKER" 2>/dev/null || true)
  if [ "$marker_id" != "$id" ]; then
    echo "error: firstmate home $home is marked for secondmate ${marker_id:-unknown}, expected $id" >&2; return 1
  fi
  # Symlink-backed homes retain only operational directories. Repair their shared
  # instruction/tool links before launch. A non-git legacy home with both
  # AGENTS.md and sbin/ as real paths is self-contained, not a partial link home.
  if ! git -C "$abs_home" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && home_needs_shared_code_repair "$abs_home"; then
    "$FM_ROOT/sbin/fm-home-link.sh" "$abs_home" --repair >/dev/null || {
      echo "error: failed to repair shared-code links in secondmate home $home" >&2
      return 1
    }
  fi
  if [ ! -e "$abs_home/AGENTS.md" ]; then
    echo "error: $home is not a firstmate home (missing AGENTS.md)" >&2; return 1
  fi
  if [ ! -d "$abs_home/sbin" ] && [ ! -L "$abs_home/sbin" ]; then
    echo "error: $home is not a firstmate home (missing sbin/)" >&2; return 1
  fi
  if home_has_shared_code_links "$abs_home" && [ ! -e "$abs_home/CLAUDE.md" ]; then
    echo "error: $home is not a firstmate home (missing CLAUDE.md)" >&2; return 1
  fi
  printf '%s\n' "$abs_home"
}

validate_firstmate_operational_dirs() {
  local abs_home=$1 abs_active_home=$2 abs_root=$3 name dir abs_dir
  for name in data state config projects; do
    dir="$abs_home/$name"
    if [ -L "$dir" ] && [ ! -e "$dir" ]; then
      echo "error: secondmate $name directory must resolve inside the secondmate home: $dir" >&2; return 1
    fi
    if [ -d "$dir" ]; then
      abs_dir=$(cd "$dir" && pwd -P)
    elif [ -e "$dir" ]; then
      echo "error: secondmate $name path is not a directory: $dir" >&2; return 1
    else
      abs_dir="$abs_home/$name"
    fi
    if ! path_is_ancestor_of "$abs_home" "$abs_dir"; then
      echo "error: secondmate $name directory must resolve inside the secondmate home: $dir" >&2; return 1
    fi
    if [ "$abs_dir" = "$abs_active_home" ] || path_is_ancestor_of "$abs_active_home" "$abs_dir"; then
      echo "error: secondmate $name directory cannot be inside the active firstmate home: $dir" >&2; return 1
    fi
    if [ "$abs_dir" = "$abs_root" ] || path_is_ancestor_of "$abs_root" "$abs_dir"; then
      echo "error: secondmate $name directory cannot be inside the firstmate repo: $dir" >&2; return 1
    fi
  done
}

SECONDMATE_RESUME=0
if [ "$KIND" = secondmate ]; then
  if [ -f "$STATE/$ID.meta" ]; then
    SECONDMATE_RESUME=1
  fi
  if [ -z "$FIRSTMATE_HOME" ] && [ "$SECONDMATE_RESUME" -eq 1 ]; then
    FIRSTMATE_HOME=$(grep '^home=' "$STATE/$ID.meta" | cut -d= -f2- || true)
  fi
  if [ -z "$FIRSTMATE_HOME" ]; then
    FIRSTMATE_HOME=$(secondmate_registry_value "$ID" home || true)
  fi
  if [ -z "$WORKSPACE" ]; then
    WORKSPACE=$(secondmate_registry_value "$ID" workspace || true)
  fi
fi

if [ "$KIND" = secondmate ]; then
  [ -n "$FIRSTMATE_HOME" ] || { echo "error: no firstmate home supplied or registered for $ID" >&2; exit 1; }
  PROJ_ABS=$(validate_firstmate_home_for_spawn "$ID" "$FIRSTMATE_HOME")
  WT="$PROJ_ABS"
  if [ -f "$PROJ_ABS/data/charter.md" ]; then
    BRIEF="$PROJ_ABS/data/charter.md"
  else
    BRIEF="$DATA/$ID/brief.md"
  fi
else
  PROJ_ABS="$(cd "$(resolve_project_dir_arg "$PROJ")" && pwd)"
  WT=""
  BRIEF="$DATA/$ID/brief.md"
fi

# Pre-spawn guard: refuse if any herdr pane already has cwd == the secondmate home.
# Prevents duplicate spawns when an existing session is alive but hook-less (agent_status=unknown).
if [ "$KIND" = secondmate ] && [ -z "${FM_SPAWN_FORCE:-}" ]; then
  _guard_pane=$(herdr pane list 2>/dev/null | python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
home = sys.argv[1]
for p in data.get("result", {}).get("panes", []):
    if p.get("cwd", "") == home:
        print(p.get("pane_id", ""))
        break
' "$WT" 2>/dev/null || true)
  if [ -n "$_guard_pane" ]; then
    echo "error: secondmate $ID already has a live pane at $WT (pane $_guard_pane); set FM_SPAWN_FORCE=1 to override" >&2
    exit 1
  fi
fi

[ -f "$BRIEF" ] || { echo "error: no brief at $BRIEF" >&2; exit 1; }

# Preflight: validate harness binary and worktree base before creating anything.
if [ "$KIND" != secondmate ]; then
  "$SCRIPT_DIR/fm-resolve-spawn.sh" "$PROJ_ABS" "$HARNESS" || exit $?
fi

# Create a git worktree for ship/scout tasks.
WTBASE="${FM_WORKTREE_BASE:-$FM_HOME/worktrees}"
if [ "$KIND" != secondmate ]; then
  mkdir -p "$WTBASE"
  WT="$WTBASE/$ID"
  if [ -d "$WT" ]; then
    echo "error: worktree $WT already exists" >&2; exit 1
  fi
  git -C "$PROJ_ABS" worktree add -b "fm/$ID" "$WT" HEAD 2>/dev/null \
    || git -C "$PROJ_ABS" worktree add "$WT" HEAD 2>/dev/null \
    || { echo "error: git worktree add failed for $PROJ_ABS -> $WT" >&2; exit 1; }
fi

# Per-project delivery mode + yolo flag.
SECONDMATE_PROJECTS=
if [ "$KIND" = secondmate ]; then
  MODE=secondmate
  YOLO=off
  SECONDMATE_PROJECTS=$(secondmate_registry_value "$ID" projects || true)
else
  PROJ_NAME=$(basename "$PROJ_ABS")
  read -r MODE YOLO <<EOF
$("$FM_ROOT/sbin/fm-project-mode.sh" "$PROJ_NAME")
EOF
fi

# Build the launch command. A secondmate OMP respawn continues its persisted
# session rather than injecting the charter as a new prompt.
sq_brief=$(fm_shell_quote "$BRIEF")
if [ "$HARNESS" = omp ] && [ "$KIND" = secondmate ] && [ "$SECONDMATE_RESUME" -eq 1 ]; then
  LAUNCH_CMD="omp --auto-approve -c"
else
  LAUNCH_CMD=${LAUNCH//__BRIEF__/$sq_brief}
fi
if [ "$KIND" = secondmate ]; then
  sq_home=$(fm_shell_quote "$PROJ_ABS")
  LAUNCH_CMD="FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=$sq_home $LAUNCH_CMD"
fi
PANE_CMD="$LAUNCH_CMD; exec \"\${SHELL:-/bin/zsh}\" -l"

# The tab and pane label are display-only. The unique task id is the durable
# herdr registration slot, while the harness keeps its integration identity.
if [ "$KIND" = secondmate ]; then
  WORKER_LABEL=home
else
  WORKER_LABEL=$(fm_worker_label "$CONFIG" "$ID" "${FM_TASK_LABEL:-}")
fi
AGENT_SLOT=$ID
AGENT_IDENTITY=$HARNESS

recover_missing_registered_secondmate_workspace || exit 1

cleanup_failed_spawn() {
  if [ "${CREATED_TAB:-0}" = 1 ] && [ -n "${TAB_ID:-}" ]; then
    herdr tab close "$TAB_ID" >/dev/null 2>&1 || true
  fi
  if [ "$KIND" != secondmate ] && [ -d "$WT" ]; then
    git -C "$PROJ_ABS" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
  fi
}

# Create a replacement tab before reaping a restored husk. A caller-supplied
# tab is already an explicit replacement surface; otherwise this keeps a husk
# from ever being the workspace's last tab.
TAB_ID=$TAB
ROOT_PANE=
CREATED_TAB=0
if [ -z "$TAB_ID" ]; then
  TAB_ARGS=()
  if [ -n "$WORKSPACE" ]; then TAB_ARGS+=(--workspace "$WORKSPACE"); fi
  TAB_JSON=$(herdr tab create ${TAB_ARGS[@]+"${TAB_ARGS[@]}"} --label "$WORKER_LABEL" --cwd "$WT" --no-focus 2>&1) || {
    cleanup_failed_spawn
    echo "error: herdr tab create failed for $ID" >&2
    echo "$TAB_JSON" >&2
    exit 1
  }
  TAB_ID=$(printf '%s' "$TAB_JSON" | fm_json_get result tab tab_id)
  ROOT_PANE=$(printf '%s' "$TAB_JSON" | fm_json_get result root_pane pane_id)
  [ -n "$TAB_ID" ] || {
    cleanup_failed_spawn
    echo "error: herdr tab create did not return a tab_id for $ID" >&2
    echo "$TAB_JSON" >&2
    exit 1
  }
  CREATED_TAB=1
fi

if ! fm_herdr_reap_husk_slot "$AGENT_SLOT"; then
  cleanup_failed_spawn
  exit 1
fi

LAUNCH_JSON=$(herdr agent start "$AGENT_SLOT" --cwd "$WT" --tab "$TAB_ID" --no-focus -- sh -c "$PANE_CMD" 2>&1) || {
  cleanup_failed_spawn
  echo "error: herdr agent start failed for $ID" >&2
  echo "$LAUNCH_JSON" >&2
  exit 1
}
PANE=$(printf '%s' "$LAUNCH_JSON" | fm_json_get result agent pane_id)
[ -n "$PANE" ] || {
  cleanup_failed_spawn
  echo "error: herdr agent start did not return a pane_id for $ID" >&2
  echo "$LAUNCH_JSON" >&2
  exit 1
}
if [ -n "$ROOT_PANE" ] && [ "$ROOT_PANE" != "$PANE" ]; then
  herdr pane close "$ROOT_PANE" >/dev/null 2>&1 || true
fi
herdr pane rename "$PANE" "$WORKER_LABEL" >/dev/null 2>&1 || true

mkdir -p "$STATE"
{
  echo "pane=$PANE"
  echo "worktree=$WT"
  echo "project=$PROJ_ABS"
  echo "harness=$HARNESS"
  echo "kind=$KIND"
  echo "mode=$MODE"
  echo "yolo=$YOLO"
  echo "tab=$TAB_ID"
  echo "worker=$WORKER_LABEL"
  echo "supervisor=$(fm_supervisor_name "$CONFIG")"
  echo "agent_slot=$AGENT_SLOT"
  echo "agent_identity=$AGENT_IDENTITY"
  if [ "$KIND" = secondmate ]; then
    echo "home=$PROJ_ABS"
    echo "projects=$SECONDMATE_PROJECTS"
    if [ -n "$WORKSPACE" ]; then echo "workspace=$WORKSPACE"; fi
  fi
} > "$STATE/$ID.meta"

if [ "$KIND" != secondmate ]; then
  append_backlog_inflight "$ID" "$(basename "$PROJ_ABS")" "$KIND" || true
fi

echo "spawned $ID harness=$HARNESS kind=$KIND mode=$MODE yolo=$YOLO pane=$PANE worktree=$WT"
