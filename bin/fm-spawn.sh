#!/usr/bin/env bash
# Spawn a direct report: a crewmate in a git worktree, or a secondmate in
# its isolated firstmate home.
# Usage: fm-spawn.sh <task-id> <project-dir> [harness|launch-command] [--scout]
#        fm-spawn.sh <task-id> [<firstmate-home>] [harness|launch-command] --secondmate
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
# Git worktrees are created with `git worktree add` at $FM_WORKTREE_BASE/<id>
# (default: $FM_HOME/worktrees/<id>) for crewmate git isolation; secondmates launch
# in their persistent home instead. Each project/domain gets a single shared herdr
# workspace (label = project name), and each agent is placed in its own tab inside
# that workspace via `herdr tab create` + `herdr agent start --tab`.
# herdr tracks agent status natively, so no per-harness turn-end hook files are installed.
#
# On success prints:
#   spawned <id> harness=<name> kind=<ship|scout|secondmate> mode=<mode> yolo=<on|off> pane=<pane-id> workspace=<label> worker=<label> worktree=<path>
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
PROJECTS="${FM_PROJECTS_OVERRIDE:-$FM_HOME/projects}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
SUB_HOME_MARKER=".fm-secondmate-home"
# shellcheck source=bin/fm-identity-lib.sh
. "$SCRIPT_DIR/fm-identity-lib.sh"
# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"
[ -n "${FM_SPAWN_NO_GUARD:-}" ] || "$FM_ROOT/bin/fm-guard.sh" || true

KIND=ship
POS=()
for a in "$@"; do
  case "$a" in
    --scout) KIND=scout ;;
    --secondmate) KIND=secondmate ;;
    *) POS+=("$a") ;;
  esac
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
      if FM_SPAWN_NO_GUARD=1 "$FM_ROOT/bin/fm-spawn.sh" "${pair%%=*}" "${pair#*=}" --scout; then :; else echo "batch: FAILED to spawn ${pair%%=*} (${pair#*=})" >&2; rc=1; fi
    else
      if FM_SPAWN_NO_GUARD=1 "$FM_ROOT/bin/fm-spawn.sh" "${pair%%=*}" "${pair#*=}"; then :; else echo "batch: FAILED to spawn ${pair%%=*} (${pair#*=})" >&2; rc=1; fi
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
    HARNESS=$("$FM_ROOT/bin/fm-harness.sh" crew)
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
    home) value=$(printf '%s\n' "$line" | sed -n 's/^[^(]*(home: \([^;)]*\);.*/\1/p') ;;
    workspace_id) value=$(printf '%s\n' "$line" | sed -n 's/^[^(]*(home: [^;)]*; workspace: \([^;)]*\);.*/\1/p') ;;
    projects) value=$(printf '%s\n' "$line" | sed -n 's/^.*; projects: \([^;)]*\); added .*/\1/p') ;;
    *) return 1 ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
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

# herdr_workspace_id_for_label <label>: print the id of the herdr workspace whose
# label matches <label>, or nothing. herdr does not enforce label uniqueness, so
# the first match wins deterministically.
herdr_workspace_id_for_label() {
  herdr workspace list 2>/dev/null | python3 -c '
import sys, json
label = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for w in d.get("result", {}).get("workspaces", []):
    if w.get("label") == label:
        print(w.get("workspace_id", ""))
        break
' "$1" 2>/dev/null || true
}

# herdr_resolve_workspace <label> <cwd>: return the id of the domain/project
# workspace labelled <label>, creating it (rooted at <cwd>, unfocused) when it
# does not exist. The same label always resolves to the same workspace, so every
# task of a domain/project shares one.
#
# list+create runs under a label-keyed advisory lock so concurrent same-repo
# spawns serialize: the loser re-lists and reuses the winner's workspace rather
# than racing to create a duplicate. A lock older than the staleness window is
# reclaimed so a crashed spawn cannot wedge the next one. Max contention wait is
# ~10s (100 x 0.1s); a stale lock is reclaimed on sight, well before that.
herdr_resolve_workspace() {
  local label=$1 cwd=$2 wsid create_json create_err='' lockdir i mtime now
  lockdir="$STATE/.wslock-$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')"
  mkdir -p "$STATE"
  i=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 100 ]; then
      echo "error: timed out acquiring workspace lock for '$label'" >&2
      return 1
    fi
    mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ $((now - mtime)) -gt 30 ]; then
      rmdir "$lockdir" 2>/dev/null || true
    fi
    sleep 0.1
  done

  wsid=$(herdr_workspace_id_for_label "$label")
  if [ -z "$wsid" ]; then
    create_json=$(herdr workspace create --label "$label" --cwd "$cwd" --no-focus 2>&1) || create_err=$create_json
    wsid=$(printf '%s' "$create_json" | herdr_json_get result workspace workspace_id)
    [ -n "$wsid" ] || wsid=$(herdr_workspace_id_for_label "$label")
  fi

  rmdir "$lockdir" 2>/dev/null || true

  if [ -z "$wsid" ]; then
    echo "error: could not resolve or create herdr workspace for label '$label'" >&2
    [ -z "$create_err" ] || echo "$create_err" >&2
    return 1
  fi
  printf '%s\n' "$wsid"
}

# herdr_place_agent_tab <wsid> <tab-label> <cwd> <agent-name> <launch-cmd>:
# create a dedicated tab in <wsid>, start the named agent in it, and close the
# tab's leftover root shell so the tab holds only the agent. Prints the agent
# pane id. This is what makes a worker land as "its own tab/agent" rather than
# a split of the focused tab.
herdr_place_agent_tab() {
  local wsid=$1 label=$2 cwd=$3 name=$4 cmd=$5 tab_json tab_id root_pane start_json pane
  tab_json=$(herdr tab create --workspace "$wsid" --label "$label" --cwd "$cwd" --no-focus 2>&1) || {
    echo "error: herdr tab create failed in workspace $wsid" >&2
    echo "$tab_json" >&2
    return 1
  }
  tab_id=$(printf '%s' "$tab_json" | herdr_json_get result tab tab_id)
  root_pane=$(printf '%s' "$tab_json" | herdr_json_get result root_pane pane_id)
  [ -n "$tab_id" ] || { echo "error: herdr tab create did not return a tab_id" >&2; echo "$tab_json" >&2; return 1; }
  start_json=$(herdr agent start "$name" --tab "$tab_id" --cwd "$cwd" --no-focus -- sh -c "$cmd" 2>&1) || {
    echo "error: herdr agent start failed in tab $tab_id" >&2
    echo "$start_json" >&2
    herdr tab close "$tab_id" >/dev/null 2>&1 || true
    return 1
  }
  pane=$(printf '%s' "$start_json" | herdr_json_get result agent pane_id)
  [ -n "$pane" ] || { herdr tab close "$tab_id" >/dev/null 2>&1 || true; echo "error: herdr agent start did not return a pane_id" >&2; return 1; }
  if [ -z "$root_pane" ]; then
    echo "warn: herdr tab create returned no root_pane for tab $tab_id; leaving its initial shell open" >&2
  elif [ "$root_pane" != "$pane" ]; then
    herdr pane close "$root_pane" >/dev/null 2>&1 || true
  fi
  printf '%s\n' "$pane"
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
  # Valid by construction: a seeded home that is missing the shared firstmate
  # AGENTS.md or bin/ is auto-repaired by symlinking them from the firstmate
  # repo rather than forcing a manual fix. Safe here because the marker check
  # above already confirmed this is the seeded home for exactly this id.
  if [ ! -e "$abs_home/AGENTS.md" ] && [ -f "$abs_root/AGENTS.md" ]; then
    ln -s "$abs_root/AGENTS.md" "$abs_home/AGENTS.md" 2>/dev/null || true
  fi
  if [ ! -e "$abs_home/bin" ] && [ -d "$abs_root/bin" ]; then
    ln -s "$abs_root/bin" "$abs_home/bin" 2>/dev/null || true
  fi
  if [ ! -e "$abs_home/AGENTS.md" ]; then
    echo "error: $home is not a firstmate home (missing AGENTS.md, auto-link failed)" >&2; return 1
  fi
  if [ ! -e "$abs_home/bin" ]; then
    echo "error: $home is not a firstmate home (missing bin/, auto-link failed)" >&2; return 1
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

if [ "$KIND" = secondmate ]; then
  if [ -z "$FIRSTMATE_HOME" ] && [ -f "$STATE/$ID.meta" ]; then
    FIRSTMATE_HOME=$(grep '^home=' "$STATE/$ID.meta" | cut -d= -f2- || true)
  fi
  if [ -z "$FIRSTMATE_HOME" ]; then
    FIRSTMATE_HOME=$(secondmate_registry_value "$ID" home || true)
  fi
fi

if [ "$KIND" = secondmate ]; then
  [ -n "$FIRSTMATE_HOME" ] || { echo "error: no firstmate home supplied or registered for $ID" >&2; exit 1; }
  PROJ_ABS=$(validate_firstmate_home_for_spawn "$ID" "$FIRSTMATE_HOME")
  if [ -f "$PROJ_ABS/data/charter.md" ]; then
    BRIEF="$PROJ_ABS/data/charter.md"
  else
    BRIEF="$DATA/$ID/brief.md"
  fi
else
  PROJ_ABS="$(cd "$(resolve_project_dir_arg "$PROJ")" && pwd)"
  BRIEF="$DATA/$ID/brief.md"
fi
[ -f "$BRIEF" ] || { echo "error: no brief at $BRIEF" >&2; exit 1; }

# Resolve identity-driven placement labels.
#   workspace label = the domain/project (shared by every task of that domain)
#   worker label    = "<supervisor>/<task>" for a crewmate, the mate's own name
#                     for a named mate; the random task id stays in meta only.
if [ "$KIND" = secondmate ]; then
  WORKER_LABEL=$(fm_identity_value "$PROJ_ABS/config" name 2>/dev/null || true)
  [ -n "$WORKER_LABEL" ] || WORKER_LABEL=$ID
  WORKSPACE_LABEL="${FM_SHIP_WORKSPACE_LABEL:-ship}"
  WORKSPACE_CWD="$FM_HOME"
  DOMAIN="$WORKSPACE_LABEL"
else
  DOMAIN="${FM_TASK_DOMAIN:-$(basename "$PROJ_ABS")}"
  WORKSPACE_LABEL="$DOMAIN"
  WORKSPACE_CWD="$PROJ_ABS"
  WORKER_LABEL=$(fm_worker_label "$CONFIG" "$ID" "${FM_TASK_LABEL:-}")
fi

# Create the isolated git worktree for ship/scout tasks. herdr placement (below)
# is the workspace/tab layer; the git worktree is a plain per-task checkout so a
# domain workspace can hold many tasks without their teardowns colliding.
WTBASE="${FM_WORKTREE_BASE:-$FM_HOME/worktrees}"
if [ "$KIND" != secondmate ]; then
  mkdir -p "$WTBASE"
  WT="$WTBASE/$ID"
  if [ -d "$WT" ]; then
    echo "error: worktree $WT already exists" >&2; exit 1
  fi
  _add_out=$(git -C "$PROJ_ABS" worktree add -b "fm/$ID" "$WT" HEAD 2>&1) || {
    echo "error: git worktree add failed for $PROJ_ABS -> $WT" >&2
    echo "$_add_out" >&2
    exit 1
  }
else
  WT="$PROJ_ABS"
fi

# Per-project delivery mode + yolo flag.
SECONDMATE_PROJECTS=
if [ "$KIND" = secondmate ]; then
  MODE=secondmate
  YOLO=off
  SECONDMATE_PROJECTS=$(secondmate_registry_value "$ID" projects || true)
else
  read -r MODE YOLO <<EOF
$("$FM_ROOT/bin/fm-project-mode.sh" "$(basename "$PROJ_ABS")")
EOF
fi

# Build the launch command with placeholders filled.
sq_brief=$(shell_quote "$BRIEF")
LAUNCH_CMD=${LAUNCH//__BRIEF__/$sq_brief}

if [ "$KIND" = secondmate ]; then
  sq_home=$(shell_quote "$PROJ_ABS")
  LAUNCH_CMD="FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=$sq_home $LAUNCH_CMD"
fi

spawn_cleanup_worktree() {
  [ "$KIND" = secondmate ] && return 0
  if [ -d "$WT" ]; then
    git -C "$PROJ_ABS" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
    git -C "$PROJ_ABS" branch -D "fm/$ID" 2>/dev/null || true
  fi
}

# Deterministic placement: resolve the domain/project workspace (creating it
# when absent), then start the agent in its own tab inside that workspace so it
# never lands as a split in whatever tab happens to be focused. No workspace_id
# is recorded in meta: the workspace is shared, so teardown must clean up only
# this task's pane + git worktree, never the whole workspace.
WORKSPACE_ID=$(herdr_resolve_workspace "$WORKSPACE_LABEL" "$WORKSPACE_CWD") || { spawn_cleanup_worktree; exit 1; }
AGENT_NAME="$WORKER_LABEL"
PANE=$(herdr_place_agent_tab "$WORKSPACE_ID" "$WORKER_LABEL" "$WT" "$AGENT_NAME" "$LAUNCH_CMD") || { spawn_cleanup_worktree; exit 1; }

mkdir -p "$STATE"
{
  echo "pane=$PANE"
  echo "worktree=$WT"
  echo "project=$PROJ_ABS"
  echo "harness=$HARNESS"
  echo "kind=$KIND"
  echo "mode=$MODE"
  echo "yolo=$YOLO"
  echo "domain=$DOMAIN"
  echo "workspace=$WORKSPACE_LABEL"
  echo "worker=$WORKER_LABEL"
  if [ "$KIND" = secondmate ]; then
    echo "home=$PROJ_ABS"
    echo "projects=$SECONDMATE_PROJECTS"
  fi
} > "$STATE/$ID.meta"

echo "spawned $ID harness=$HARNESS kind=$KIND mode=$MODE yolo=$YOLO pane=$PANE workspace=$WORKSPACE_LABEL worker=$WORKER_LABEL worktree=$WT"
