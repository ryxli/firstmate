#!/usr/bin/env bash
# Spawn a direct report: a crewmate in a git worktree, or a secondmate in
# its isolated firstmate home.
# Usage: fm-spawn.sh <task-id> <project-dir> [harness|launch-command] [--model <name>] [--effort <level>] [--scout]
#        fm-spawn.sh <task-id> [<firstmate-home>] [harness|launch-command] [--model <name>] [--effort <level>] --secondmate
#   With no harness arg, the harness comes from fm-harness.sh crew (config/crew-harness,
#   falling back to firstmate's own harness); a --secondmate spawn resolves it from
#   fm-harness.sh secondmate (config/secondmate-harness -> crew -> own). A bare adapter
#   name (omp|claude|codex|opencode|pi) overrides it for this spawn. A non-flag string
#   containing whitespace is treated as a RAW launch command - the escape hatch for
#   verifying new adapters (model/effort flags are NOT injected into a raw command).
#   --model <name> pins a concrete model for the crewmate/secondmate (fuzzy where the
#   harness supports it, e.g. omp "opus" or "gpt-5.4-mini"); --effort <low|medium|high|
#   xhigh|max> pins reasoning effort. Each axis is threaded only into harnesses whose
#   CLI was verified to accept it (omp: --model + --thinking), omitted otherwise. For a
#   --secondmate spawn resolved from config/secondmate-harness, that file's optional
#   "<harness> [<model>] [<effort>]" tokens supply model/effort durably across respawns
#   unless an explicit --model/--effort flag overrides them.
#   --scout records kind=scout in the task's meta (report deliverable, scratch worktree;
#   see AGENTS.md section 7); --secondmate records kind=secondmate and launches in a
#   provisioned firstmate home; the default is kind=ship.
# Batch dispatch: pass one or more `id=repo` pairs instead of a single <id> <project>:
#     fm-spawn.sh fix-a-k3=projects/foo add-b-q7=projects/bar [--scout]
#   Each pair re-execs this script in single-task mode; a shared --scout/--model/--effort
#   applies to every pair.
#
# Git worktrees are created with `git worktree add` at $FM_WORKTREE_BASE/<id>
# (default: $FM_HOME/worktrees/<id>) for crewmate git isolation; secondmates launch
# in their persistent home instead. A crewmate is placed in its OWN new tab inside
# the SPAWNER'S CURRENT herdr workspace (firstmate's own workspace for main-home
# crew, the secondmate's home workspace for a secondmate's crew) - never a
# separate per-project workspace. A secondmate itself still gets its own named
# home workspace. Placement uses `herdr tab create` + `herdr agent start --tab`.
# herdr tracks agent status natively, so no per-harness turn-end hook files are installed.
#
# On success prints:
#   spawned <id> harness=<name> kind=<ship|scout|secondmate> mode=<mode> yolo=<on|off> pane=<pane-id> tab=<tab-id> workspace=<label> worker=<label> worktree=<path>
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
# shellcheck source=bin/fm-spawn-lib.sh
. "$SCRIPT_DIR/fm-spawn-lib.sh"
# shellcheck source=bin/fm-tasks-axi-lib.sh
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"

KIND=ship
MODEL=
EFFORT=
MODEL_SET=0
EFFORT_SET=0
POS=()
want_value=
EMERGENCY_FLAG="${FM_STATE_OVERRIDE:-$FM_HOME/state}/emergency-limit-mode"
for a in "$@"; do
  if [ -n "$want_value" ]; then
    case "$want_value" in
      model) MODEL=$a; MODEL_SET=1 ;;
      effort) EFFORT=$a; EFFORT_SET=1 ;;
    esac
    want_value=
    continue
  fi
  case "$a" in
    --scout) KIND=scout ;;
    --secondmate) KIND=secondmate ;;
    --model) want_value=model ;;
    --model=*) MODEL=${a#--model=}; MODEL_SET=1 ;;
    --effort) want_value=effort ;;
    --effort=*) EFFORT=${a#--effort=}; EFFORT_SET=1 ;;
    *) POS+=("$a") ;;
  esac
done
[ -z "$want_value" ] || { echo "error: --$want_value requires a value" >&2; exit 1; }
[ "$MODEL_SET" -eq 0 ] || [ -n "$MODEL" ] || { echo "error: --model requires a non-empty value" >&2; exit 1; }
[ "$EFFORT_SET" -eq 0 ] || [ -n "$EFFORT" ] || { echo "error: --effort requires a non-empty value" >&2; exit 1; }
case "$EFFORT" in
  ''|low|medium|high|xhigh|max) ;;
  *) echo "error: --effort must be one of low, medium, high, xhigh, max" >&2; exit 1 ;;
esac

# Batch dispatch: each positional is an id=repo pair.
idpart=${POS[0]:-}
idpart=${idpart%%=*}
if [ "${#POS[@]}" -gt 0 ] && [ "${POS[0]}" != "$idpart" ] && case "$idpart" in */*) false ;; *) true ;; esac; then
  rc=0
  # Shared axes threaded onto every pair's single-task re-exec (kept out when
  # unset so a plain batch stays byte-identical to before this knob existed).
  batch_shared=()
  [ "$KIND" != scout ] || batch_shared+=(--scout)
  [ -z "$MODEL" ] || batch_shared+=(--model "$MODEL")
  [ -z "$EFFORT" ] || batch_shared+=(--effort "$EFFORT")
  for pair in "${POS[@]}"; do
    case "$pair" in
      *=*) : ;;
      *) echo "error: batch dispatch expects every argument as id=repo; got '$pair'" >&2; rc=2; continue ;;
    esac
    if [ "$KIND" = secondmate ]; then
      echo "error: batch dispatch does not support --secondmate; spawn each secondmate explicitly" >&2
      rc=2
      continue
    fi
    if FM_SPAWN_NO_GUARD=1 "$FM_ROOT/bin/fm-spawn.sh" "${pair%%=*}" "${pair#*=}" ${batch_shared[@]+"${batch_shared[@]}"}; then :; else echo "batch: FAILED to spawn ${pair%%=*} (${pair#*=})" >&2; rc=1; fi
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
limit_mode_active=0
if [ -f "$EMERGENCY_FLAG" ]; then
  limit_mode_active=1
fi

if [ "$limit_mode_active" -eq 1 ]; then
  case "${ARG3:-}" in
    *' '*)
      mkdir -p "$STATE"
      "$FM_ROOT/bin/fm-report.sh" "$STATE/$ID.status" "blocked: emergency limit-mode - raw launch commands are disabled; remove $(basename "$EMERGENCY_FLAG") or use OpenAI Codex via omp"
      printf 'error: emergency limit-mode - raw launch commands are disabled; remove %s or use OpenAI Codex via omp\n' "$(basename "$EMERGENCY_FLAG")" >&2
      exit 1
      ;;
  esac
fi

if [ "$limit_mode_active" -eq 1 ] && ! command -v omp >/dev/null 2>&1; then
  mkdir -p "$STATE"
  "$FM_ROOT/bin/fm-report.sh" "$STATE/$ID.status" "blocked: emergency limit-mode - omp command not found; install omp or remove $(basename "$EMERGENCY_FLAG")"
  printf 'error: emergency limit-mode - omp command not found; install omp or remove %s\n' "$(basename "$EMERGENCY_FLAG")" >&2
  exit 1
fi


if [ "$KIND" != secondmate ]; then
  "$FM_ROOT/bin/fm-resolve-spawn.sh" "$PROJ" "$ARG3"
fi

# Launch templates per adapter. No turn-end hook placeholders needed since
# herdr tracks agent status natively. __BRIEF__ is still used, and
# __MODELFLAG__/__EFFORTFLAG__ are filled from --model/--effort (or a secondmate
# pin) at build time - each collapses to nothing when its axis is unset, so a
# plain spawn's command is byte-identical to before this knob existed.
launch_template() {
  local harness=$1
  # shellcheck disable=SC2016
  case "$harness" in
    omp)    printf '%s' 'omp --auto-approve __MODELFLAG____EFFORTFLAG__"$(cat __BRIEF__)"' ;;
    claude) printf '%s' 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions __MODELFLAG____EFFORTFLAG__"$(cat __BRIEF__)"' ;;
    codex)  printf '%s' 'codex __MODELFLAG____EFFORTFLAG__--dangerously-bypass-approvals-and-sandbox "$(cat __BRIEF__)"' ;;
    opencode) printf '%s' 'OPENCODE_CONFIG_CONTENT='\''{"permission":{"*":"allow"}}'\'' opencode __MODELFLAG__--prompt "$(cat __BRIEF__)"' ;;
    pi)     printf '%s' 'pi __MODELFLAG____EFFORTFLAG__"$(cat __BRIEF__)"' ;;
    *) return 1 ;;
  esac
}

# model_flag_for_harness <harness> <model>: CLI flag fragment (trailing space) that
# pins <model> for <harness>, or nothing when <model> is empty/"default". Every
# supported adapter accepts `--model`; omp resolves it fuzzily itself (verified:
# `omp --help` documents `--model` fuzzy match, e.g. "opus" or "gpt-5.2").
model_flag_for_harness() {
  local harness=$1 model=$2
  [ -n "$model" ] && [ "$model" != default ] || return 0
  case "$harness" in
    omp|claude|codex|opencode|pi)
      printf -- '--model %s ' "$(fm_shell_quote "$model")"
      ;;
  esac
}

# effort_flag_for_harness <harness> <effort>: CLI flag fragment (trailing space)
# that pins reasoning effort for <harness>, or nothing. Threaded only into
# harnesses whose installed CLI was verified to accept the axis; an unsupported
# axis is omitted rather than guessed. Shared vocabulary: low|medium|high|xhigh|max.
effort_flag_for_harness() {
  local harness=$1 effort=$2
  [ -n "$effort" ] && [ "$effort" != default ] || return 0
  case "$harness" in
    omp)
      # omp (oh-my-pi) exposes --thinking off|minimal|low|medium|high|xhigh|auto
      # (verified: `omp --help`). It has no `max`, so map max to xhigh (its top).
      case "$effort" in
        low|medium|high|xhigh) printf -- '--thinking %s ' "$(fm_shell_quote "$effort")" ;;
        max) printf -- '--thinking xhigh ' ;;
      esac
      ;;
    pi)
      # pi accepts --thinking low|medium|high|xhigh; it warns and ignores max, so
      # omit max rather than passing a flag the installed CLI rejects.
      case "$effort" in
        low|medium|high|xhigh) printf -- '--thinking %s ' "$(fm_shell_quote "$effort")" ;;
      esac
      ;;
    claude)
      case "$effort" in
        low|medium|high|xhigh|max) printf -- '--effort %s ' "$(fm_shell_quote "$effort")" ;;
      esac
      ;;
    codex)
      # codex config schema uses model_reasoning_effort low|medium|high|xhigh; omit max.
      case "$effort" in
        low|medium|high|xhigh) printf -- '-c %s ' "$(fm_shell_quote "model_reasoning_effort=\"$effort\"")" ;;
      esac
      ;;
    # opencode's `opencode --prompt` launch has a verified --model flag but no
    # verified effort flag, so effort is omitted for opencode.
  esac
}

# apply_omp_overlay <launch-command> <cwd>
# When a fresh OMP spawn starts in a directory carrying config/omp-overlay.yml,
# inject it immediately after --auto-approve. Non-template/raw launch commands
# that do not start with the canonical prefix are left unchanged.
apply_omp_overlay() {
  local launch=$1 cwd=$2 overlay sq_overlay
  overlay="$cwd/config/omp-overlay.yml"
  if [ ! -f "$overlay" ]; then
    printf '%s' "$launch"
    return 0
  fi
  case "$launch" in
    'omp --auto-approve '*)
      sq_overlay=$(fm_shell_quote "$overlay")
      printf '%s' "${launch/omp --auto-approve /omp --auto-approve --config $sq_overlay }"
      ;;
    *)
      printf '%s' "$launch"
      ;;
  esac
}

case "$ARG3" in
  *' '*)
    LAUNCH=$ARG3
    HARNESS=$(fm_first_command_word "$LAUNCH" || true)
    ;;
  '')
    if [ "$KIND" = secondmate ]; then
      HARNESS=$("$FM_ROOT/bin/fm-harness.sh" secondmate)
    else
      HARNESS=$("$FM_ROOT/bin/fm-harness.sh" crew)
    fi
    LAUNCH=$(launch_template "$HARNESS") || { echo "error: no launch template for harness '$HARNESS' (from config/crew-harness or detection); pass a raw launch command to use an unverified adapter" >&2; exit 1; }
    ;;
  *)
    HARNESS=$ARG3
    LAUNCH=$(launch_template "$HARNESS") || { echo "error: unknown harness '$HARNESS'; pass a raw launch command to use an unverified adapter" >&2; exit 1; }
    ;;
esac

if [ "$limit_mode_active" -eq 1 ]; then
  HARNESS=omp
  LAUNCH=$(launch_template "$HARNESS") || { echo "error: emergency limit-mode requires an omp launch template" >&2; exit 1; }
  MODEL=openai-codex/gpt-5.4-mini
  EFFORT=low
fi
if [ "$KIND" = secondmate ] && [ -z "$ARG3" ]; then
  if [ "$MODEL_SET" -eq 0 ]; then
    SM_MODEL=$("$FM_ROOT/bin/fm-harness.sh" secondmate-model)
    [ -z "$SM_MODEL" ] || MODEL=$SM_MODEL
  fi
  if [ "$EFFORT_SET" -eq 0 ]; then
    SM_EFFORT=$("$FM_ROOT/bin/fm-harness.sh" secondmate-effort)
    if [ -n "$SM_EFFORT" ]; then
      case "$SM_EFFORT" in
        low|medium|high|xhigh|max) EFFORT=$SM_EFFORT ;;
        *) echo "warning: config/secondmate-harness effort token '$SM_EFFORT' is not one of low, medium, high, xhigh, max; ignoring" >&2 ;;
      esac
    fi
  fi
fi

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

# herdr_current_workspace_id: print the workspace id the SPAWNER is currently in,
# resolved live from herdr (its own pane's workspace_id), falling back to the
# HERDR_WORKSPACE_ID env its pane inherited. Empty when running outside herdr.
# This is the anchor for the parent-workspace placement rule: a crewmate lands in
# whatever workspace its spawner is in, so main-home crew nest under firstmate's
# own workspace and a secondmate's crew nest under the secondmate's home.
herdr_current_workspace_id() {
  local wsid
  wsid=$(herdr pane current 2>/dev/null | herdr_json_get result pane workspace_id)
  [ -n "$wsid" ] || wsid="${HERDR_WORKSPACE_ID:-}"
  printf '%s' "$wsid"
}

# herdr_workspace_label_for_id <id>: print the display label of a workspace id,
# or nothing. Used only to record a human-readable workspace=/domain= in meta
# when a crewmate lands in the spawner's current workspace.
herdr_workspace_label_for_id() {
  [ -n "${1:-}" ] || return 0
  herdr workspace get "$1" 2>/dev/null | herdr_json_get result workspace label
}

# herdr_resolve_workspace <label> <cwd>: resolve the domain/project workspace
# labelled <label>, creating it (rooted at <cwd>, unfocused) when it does not
# exist. The same label always resolves to the same workspace, so every task of a
# domain/project shares one. Prints two parse-able lines on stdout:
#   workspace=<workspace_id>
#   init_pane=<pane_id>   the freshly-created workspace's own default shell pane,
#                         which the caller closes after the agent tab is placed so
#                         a new workspace is not left with an orphan root shell;
#                         EMPTY when an existing workspace was reused (no orphan).
#
# list+create runs under a label-keyed advisory lock so concurrent same-repo
# spawns serialize: the loser re-lists and reuses the winner's workspace rather
# than racing to create a duplicate. A lock older than the staleness window is
# reclaimed so a crashed spawn cannot wedge the next one. Max contention wait is
# ~10s (100 x 0.1s); a stale lock is reclaimed on sight, well before that.
herdr_resolve_workspace() {
  local label=$1 cwd=$2 wsid init_pane='' create_json create_err='' lockdir i mtime now
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
    # The freshly-created workspace ships with its own default tab + root shell
    # pane; capture it so the caller can close that orphan once the agent lands in
    # its own separate tab. Only populated on the create path - a reused workspace
    # has no orphan to close.
    init_pane=$(printf '%s' "$create_json" | herdr_json_get result root_pane pane_id)
    [ -n "$wsid" ] || wsid=$(herdr_workspace_id_for_label "$label")
  fi

  rmdir "$lockdir" 2>/dev/null || true

  if [ -z "$wsid" ]; then
    echo "error: could not resolve or create herdr workspace for label '$label'" >&2
    [ -z "$create_err" ] || echo "$create_err" >&2
    return 1
  fi
  printf 'workspace=%s\n' "$wsid"
  printf 'init_pane=%s\n' "$init_pane"
}

# herdr_place_agent_tab <wsid> <display-label> <cwd> <slot> <launch-cmd>:
# create a dedicated tab in <wsid>, start the agent in it under a UNIQUE herdr
# agent SLOT name, and close the tab's leftover root shell so the tab holds only
# the agent. The human <display-label> goes ONLY on display surfaces (the tab
# label and the pane label). <slot> is herdr's agent registration handle and MUST
# be unique per herdr session (herdr rejects a duplicate agent name with
# agent_name_taken), so it is the task id, NEVER the harness name - a shared slot
# would cap a session at one concurrent crewmate. The omp<->herdr integration
# self-reports its identity ("omp") over the socket, so agent_status binds
# regardless of the slot name; that identity is recorded separately in meta and is
# NEVER set via `herdr agent rename`. This makes a worker land as its own tab
# rather than a split of the focused tab. Prints two parse-able lines on stdout:
#   pane=<pane_id>
#   tab=<tab_id>
herdr_place_agent_tab() {
  local wsid=$1 display_label=$2 cwd=$3 slot=$4 cmd=$5 tab_json tab_id root_pane start_json pane
  tab_json=$(herdr tab create --workspace "$wsid" --label "$display_label" --cwd "$cwd" --no-focus 2>&1) || {
    echo "error: herdr tab create failed in workspace $wsid" >&2
    echo "$tab_json" >&2
    return 1
  }
  tab_id=$(printf '%s' "$tab_json" | herdr_json_get result tab tab_id)
  root_pane=$(printf '%s' "$tab_json" | herdr_json_get result root_pane pane_id)
  [ -n "$tab_id" ] || { echo "error: herdr tab create did not return a tab_id" >&2; echo "$tab_json" >&2; return 1; }
  # The herdr daemon's PATH may not include the harness binary's dir, and the
  # child needs HERDR_SOCKET_PATH to report status. Pass firstmate's own PATH (and
  # the socket when set) so omp/codex/etc. resolve and bind; without this the agent
  # dies instantly with "command not found".
  local -a start_env
  start_env=(--env "PATH=$PATH")
  # Don't let python litter __pycache__/*.pyc into agent work dirs - reading
  # generated bytecode in file scans is pure token waste. Propagates to the
  # agent's python subprocesses (and crewmates it spawns).
  start_env+=(--env "PYTHONDONTWRITEBYTECODE=1")
  if [ -n "${HERDR_SOCKET_PATH:-}" ]; then
    start_env+=(--env "HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH")
  fi
  # Idempotent respawn: a herdr session restore can bring this task's tab back as
  # a husk (pane restored, agent process gone) while its agent SLOT stays
  # registered, so `herdr agent start "$slot"` would fail agent_name_taken and
  # need a manual close. The replacement tab above already exists, so reaping the
  # husk here cannot take the workspace down even if the husk was its only tab.
  # Only a CONFIRMED husk is reaped; a live or unclassifiable slot refuses (no
  # concurrent-crew guard regression) and we release the just-created tab.
  if ! fm_herdr_reap_husk_slot "$slot"; then
    herdr tab close "$tab_id" >/dev/null 2>&1 || true
    return 1
  fi
  start_json=$(herdr agent start "$slot" --tab "$tab_id" --cwd "$cwd" --no-focus "${start_env[@]}" -- sh -c "$cmd" 2>&1) || {
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
  # Display-only label so the pane shows its worker name. NEVER `herdr agent rename`:
  # that overwrites the agent identity and breaks the omp<->herdr status integration
  # (it reports as agent `omp` and only binds while the identity is intact).
  herdr pane rename "$pane" "$display_label" >/dev/null 2>&1 || true
  printf 'pane=%s\n' "$pane"
  printf 'tab=%s\n' "$tab_id"
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
  # AGENTS.md, CLAUDE.md, or bin/ is auto-repaired rather than forcing a
  # manual fix. Safe here because the marker check above already confirmed
  # this is the seeded home for exactly this id.
  [ -L "$abs_home/AGENTS.md" ] && [ ! -e "$abs_home/AGENTS.md" ] && rm -f "$abs_home/AGENTS.md" 2>/dev/null || true
  if [ ! -e "$abs_home/AGENTS.md" ] && [ -f "$abs_root/AGENTS.md" ]; then
    ln -s "$abs_root/AGENTS.md" "$abs_home/AGENTS.md" 2>/dev/null || true
  fi
  [ -L "$abs_home/bin" ] && [ ! -e "$abs_home/bin" ] && rm -f "$abs_home/bin" 2>/dev/null || true
  if [ ! -e "$abs_home/bin" ] && [ -d "$abs_root/bin" ]; then
    ln -s "$abs_root/bin" "$abs_home/bin" 2>/dev/null || true
  fi
  if [ -f "$abs_home/CLAUDE.md" ] && [ ! -L "$abs_home/CLAUDE.md" ] && [ ! -s "$abs_home/CLAUDE.md" ]; then
    rm -f "$abs_home/CLAUDE.md"
  fi
  [ -L "$abs_home/CLAUDE.md" ] && [ ! -e "$abs_home/CLAUDE.md" ] && rm -f "$abs_home/CLAUDE.md" 2>/dev/null || true
  if [ ! -e "$abs_home/CLAUDE.md" ] && [ -e "$abs_home/AGENTS.md" ]; then
    ln -s "AGENTS.md" "$abs_home/CLAUDE.md" 2>/dev/null || true
  fi
  if [ ! -e "$abs_home/AGENTS.md" ]; then
    echo "error: $home is not a firstmate home (missing AGENTS.md, auto-link failed)" >&2; return 1
  fi
  if [ ! -e "$abs_home/bin" ]; then
    echo "error: $home is not a firstmate home (missing bin/, auto-link failed)" >&2; return 1
  fi
  if [ ! -e "$abs_home/CLAUDE.md" ]; then
    echo "error: $home is not a firstmate home (missing CLAUDE.md, auto-link failed)" >&2; return 1
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
#   workspace label = for a crewmate, the spawner's CURRENT workspace label (main-home crew: firstmate's own workspace; secondmate crew: the mate's home) - resolved from the live workspace below, not from the project; for a secondmate, its own name (its home space)
#   worker label    = the task slug for a crewmate, or "home" for a secondmate
#                     (its workspace already carries the mate's name, so the tab
#                     need not repeat it); the random task id stays in meta only.
if [ "$KIND" = secondmate ]; then
  SM_NAME=$(fm_identity_value "$PROJ_ABS/config" name 2>/dev/null || true)
  [ -n "$SM_NAME" ] || SM_NAME=$ID
  WORKSPACE_LABEL="$SM_NAME"
  # The workspace is already named after the mate; label its own tab "home" so
  # the space reads "<Name> . home" rather than the duplicate "<Name> . <Name>".
  WORKER_LABEL=home
  WORKSPACE_CWD="$PROJ_ABS"
  DOMAIN="$WORKSPACE_LABEL"
else
  # Crew land in the SPAWNER'S CURRENT herdr workspace - firstmate's own for
  # main-home crew, the secondmate's home for a secondmate's crew - as a new tab
  # there. This is deterministic from the spawner's live workspace, so no
  # per-project workspace is ever created (that sprawl was the old behavior).
  WORKER_LABEL=$(fm_worker_label "$CONFIG" "$ID" "${FM_TASK_LABEL:-}")
  WORKSPACE_ID_DIRECT=$(herdr_current_workspace_id)
  if [ -n "$WORKSPACE_ID_DIRECT" ]; then
    DOMAIN=$(herdr_workspace_label_for_id "$WORKSPACE_ID_DIRECT")
    [ -n "$DOMAIN" ] || DOMAIN="$WORKSPACE_ID_DIRECT"
    WORKSPACE_LABEL="$DOMAIN"
    WORKSPACE_CWD="$PROJ_ABS"
  else
    # Fallback (spawned outside herdr, no live workspace): synthesize the old
    # per-project label so the workspace is still sensibly named. Secondmate-home
    # crew fall back to the home's name, ordinary crew to the project name.
    if [ -f "$FM_HOME/$SUB_HOME_MARKER" ]; then
      sm_name=$(fm_identity_value "$CONFIG" name 2>/dev/null || true)
      DOMAIN="${FM_TASK_DOMAIN:-${sm_name:-$(basename "$FM_HOME")}}"
      WORKSPACE_CWD="$FM_HOME"
    else
      DOMAIN="${FM_TASK_DOMAIN:-$(basename "$PROJ_ABS")}"
      WORKSPACE_CWD="$PROJ_ABS"
    fi
    WORKSPACE_LABEL="$DOMAIN"
  fi
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

# Build the launch command with placeholders filled. Model/effort flag fragments
# are empty unless the axis was set, so an unpinned spawn's command is unchanged.
sq_brief=$(fm_shell_quote "$BRIEF")
MODELFLAG=$(model_flag_for_harness "$HARNESS" "$MODEL")
EFFORTFLAG=$(effort_flag_for_harness "$HARNESS" "$EFFORT")
LAUNCH_CMD=${LAUNCH//__BRIEF__/$sq_brief}
LAUNCH_CMD=${LAUNCH_CMD//__MODELFLAG__/$MODELFLAG}
LAUNCH_CMD=${LAUNCH_CMD//__EFFORTFLAG__/$EFFORTFLAG}
if [ "$HARNESS" = omp ] && [ "$KIND" = secondmate ]; then
  LAUNCH_CMD=$(apply_omp_overlay "$LAUNCH_CMD" "$PROJ_ABS")
  LAUNCH_CMD=${LAUNCH_CMD/omp --auto-approve /omp --auto-approve --approval-mode=write }
fi


if [ "$KIND" = secondmate ]; then
  sq_home=$(fm_shell_quote "$PROJ_ABS")
  LAUNCH_CMD="FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=$sq_home $LAUNCH_CMD"
fi

spawn_cleanup_worktree() {
  if [ -n "${WORKSPACE_INIT_PANE:-}" ] && [ "${WORKSPACE_INIT_PANE:-}" != "${PANE:-}" ]; then
    herdr pane close "$WORKSPACE_INIT_PANE" >/dev/null 2>&1 || true
  fi
  [ "$KIND" = secondmate ] && return 0
  if [ -d "$WT" ]; then
    git -C "$PROJ_ABS" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
    git -C "$PROJ_ABS" branch -D "fm/$ID" 2>/dev/null || true
  fi
}

# append_backlog_inflight <id> <repo> <kind>: idempotently record a dispatched
# ship/scout task under "## In flight" in data/backlog.md, so a dispatch is never
# lost from the backlog if the session restarts before the operator logs it.
# Routes through tasks-axi when compatible (AGENTS.md section 10), else hand-appends.
# Best-effort: a backlog write must never fail or block the spawn.
append_backlog_inflight() {
  local id=$1 repo=$2 kind=$3 backlog today line
  backlog="$DATA/backlog.md"
  today=$(date +%Y-%m-%d)
  mkdir -p "$DATA" 2>/dev/null || return 0
  if [ ! -f "$backlog" ]; then
    printf '## In flight\n\n## Queued\n\n## Done\n' > "$backlog"
  fi
  # idempotent: skip if an In-flight-style entry for this id already exists.
  if grep -qE -- "^- (\[ \] |\*\*)$id( |\*|-|$)" "$backlog"; then
    return 0
  fi
  if fm_tasks_axi_compatible 2>/dev/null; then
    if tasks-axi add "$id" "$kind task" --kind "$kind" --repo "$repo" --start >/dev/null 2>&1; then
      return 0
    fi
  fi
  line="- [ ] $id - $kind task (repo: $repo, since $today)"
  if grep -q '^## In flight' "$backlog"; then
    if awk -v l="$line" '{print} /^## In flight$/ && !d {print l; d=1}' "$backlog" > "$backlog.tmp" 2>/dev/null; then
      mv "$backlog.tmp" "$backlog"
    fi
  else
    printf '%s\n%s\n' '## In flight' "$line" >> "$backlog"
  fi
  return 0
}

# Worktree-isolation guard: a crewmate must NEVER branch or commit in the primary
# project checkout. Before launching, prove the just-created worktree is a real
# git worktree root whose top-level resolves to the disposable worktree and is
# distinct from projects/<name>; refuse otherwise so we never tangle the primary
# checkout. ship and scout both get a worktree; secondmates run in their home.
if [ "$KIND" != secondmate ]; then
  wt_top=$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null || true)
  wt_real=$(cd "$WT" 2>/dev/null && pwd -P || true)
  proj_real=$(cd "$PROJ_ABS" 2>/dev/null && pwd -P || true)
  if [ -z "$wt_top" ] || [ "$wt_top" != "$wt_real" ] || [ "$wt_top" = "$proj_real" ]; then
    echo "error: refusing to launch $ID to avoid working in the primary checkout: worktree $WT did not resolve to a disposable git worktree distinct from $PROJ_ABS (toplevel='$wt_top')" >&2
    spawn_cleanup_worktree
    exit 1
  fi
fi

# Deterministic placement. For a crewmate, WORKSPACE_ID_DIRECT already holds the
# spawner's live current workspace, so we place the agent tab straight into it -
# no create, no lock, no orphan shell (the workspace already exists and is in
# use). For a secondmate (or the out-of-herdr fallback), resolve/create the named
# workspace as before. The worker label is a DISPLAY label only (workspace/tab/
# pane); the herdr agent identity stays the integration-safe key (omp for OMP
# panes, otherwise the harness name) so the omp<->herdr status binding survives.
# No workspace_id is recorded in meta: the workspace is shared, so teardown must
# clean up only this task's pane + git worktree, never the whole workspace.
WORKSPACE_ID=
# init_pane is the freshly-created workspace's own default shell pane, non-empty
# only when this spawn CREATED the workspace; it is closed below after the agent
# tab is placed so a new workspace is not left with an orphan root shell. On the
# parent-workspace path there is no fresh workspace, hence no orphan.
WORKSPACE_INIT_PANE=
if [ -n "${WORKSPACE_ID_DIRECT:-}" ]; then
  WORKSPACE_ID="$WORKSPACE_ID_DIRECT"
else
  WS_RESOLVE=$(herdr_resolve_workspace "$WORKSPACE_LABEL" "$WORKSPACE_CWD") || { spawn_cleanup_worktree; exit 1; }
  while IFS= read -r _ws_line; do
    case "$_ws_line" in
      workspace=*) WORKSPACE_ID=${_ws_line#workspace=} ;;
      init_pane=*) WORKSPACE_INIT_PANE=${_ws_line#init_pane=} ;;
    esac
  done <<EOF
$WS_RESOLVE
EOF
  [ -n "$WORKSPACE_ID" ] || { echo "error: herdr_resolve_workspace did not return a workspace id" >&2; spawn_cleanup_worktree; exit 1; }
fi
# Slot name (herdr agent registration handle) must be unique per session: use the
# task id. agent_identity (recorded in meta) is the harness integration key that
# status binds to via the socket, independent of the slot name.
AGENT_IDENTITY="$HARNESS"
PLACEMENT=$(herdr_place_agent_tab "$WORKSPACE_ID" "$WORKER_LABEL" "$WT" "$ID" "$LAUNCH_CMD") || { spawn_cleanup_worktree; exit 1; }
PANE=
TAB_ID=
while IFS= read -r _placement_line; do
  case "$_placement_line" in
    pane=*) PANE=${_placement_line#pane=} ;;
    tab=*)  TAB_ID=${_placement_line#tab=} ;;
  esac
done <<EOF
$PLACEMENT
EOF
[ -n "$PANE" ] || { echo "error: herdr placement did not return a pane id" >&2; spawn_cleanup_worktree; exit 1; }

# Close the freshly-created workspace's orphan root shell now that the agent lives
# in its own tab. Only on the create path (init_pane set), and never the agent's
# own pane. Best-effort: a stray shell must never fail an otherwise-good spawn.
if [ -n "$WORKSPACE_INIT_PANE" ] && [ "$WORKSPACE_INIT_PANE" != "$PANE" ]; then
  herdr pane close "$WORKSPACE_INIT_PANE" >/dev/null 2>&1 || true
fi

mkdir -p "$STATE"
{
  echo "pane=$PANE"
  echo "tab=$TAB_ID"
  echo "worktree=$WT"
  echo "project=$PROJ_ABS"
  echo "harness=$HARNESS"
  echo "model=${MODEL:-default}"
  echo "effort=${EFFORT:-default}"
  echo "kind=$KIND"
  echo "mode=$MODE"
  echo "yolo=$YOLO"
  echo "domain=$DOMAIN"
  echo "workspace=$WORKSPACE_LABEL"
  echo "worker=$WORKER_LABEL"
  echo "supervisor=$(fm_supervisor_name "$CONFIG")"
  echo "agent_identity=$AGENT_IDENTITY"
  if [ "$KIND" = secondmate ]; then
    echo "home=$PROJ_ABS"
    echo "projects=$SECONDMATE_PROJECTS"
  fi
} > "$STATE/$ID.meta"

# Auto-log the dispatch to the backlog (ship/scout only; secondmates are persistent
# and tracked via data/secondmates.md). Best-effort: never fail the spawn over it.
if [ "$KIND" != secondmate ]; then
  append_backlog_inflight "$ID" "$(basename "$PROJ_ABS")" "$KIND" || true
fi

echo "spawned $ID harness=$HARNESS kind=$KIND mode=$MODE yolo=$YOLO pane=$PANE tab=$TAB_ID workspace=$WORKSPACE_LABEL worker=$WORKER_LABEL worktree=$WT"
