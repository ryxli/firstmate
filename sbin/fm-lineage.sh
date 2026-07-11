#!/usr/bin/env bash
# fm-lineage.sh - read-only firstmate identity lineage tree.
#
# Reconstructs the live chain captain task -> state/<id>.meta -> herdr pane
# -> tab -> workspace, and (with --recursive) down into secondmate homes,
# then prints it as a tree, one line per task (--flat), or a normalized JSON
# model (--json).
#
# This tool is strictly READ-ONLY. It NEVER mutates herdr, omp, git, data, or
# state: the only herdr verbs it ever runs are `pane current`, `pane get`,
# `tab get`, `workspace get`, and `agent get`. Human lineage lives on herdr
# workspace/tab/pane DISPLAY labels and firstmate state metadata; the herdr
# agent identity stays the integration identity (omp for OMP panes). This tool
# reports that identity, it never sets or renames it.
#
# State-first by design: it walks state/*.meta (task id = filename stem) and
# resolves each pane's live placement from herdr, grouping by the live
# workspace_id/tab_id rather than by label (labels are not globally unique).
# When herdr is unreachable or a pane is gone it degrades to a state-only tree
# with `?`/unknown markers instead of failing.
#
# All logic is bash 3.2 safe (no associative arrays, mapfile, or ${x^^}).
# Internal records use a non-whitespace unit separator (US, \037) rather than
# TAB so empty fields are preserved (TAB is IFS-whitespace and `read` collapses
# runs of it, which would silently shift columns).
set -eu

usage() {
  printf '%s\n' "usage: fm-lineage.sh [--home <path>] [--flat | --json] [--recursive]" >&2
  printf '%s\n' "  Read-only lineage: state/<id>.meta -> herdr pane/tab/workspace." >&2
  printf '%s\n' "  --home <path>   Start from a specific firstmate home (default: \$FM_HOME or repo root)." >&2
  printf '%s\n' "  --recursive     Recurse into secondmate homes (meta home= and data/secondmates.md)." >&2
  printf '%s\n' "  --flat          One line per task for scripting." >&2
  printf '%s\n' "  --json          Normalized JSON model (stable data source for lavish/tools)." >&2
  printf '%s\n' "  -h, --help      Show this help." >&2
  printf '%s\n' "This tool never mutates herdr, omp, git, data, or state." >&2
}

MODE_OUT=text
RECURSE=0
HOME_OVERRIDE=
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --flat) MODE_OUT=flat ;;
    --json) MODE_OUT=json ;;
    --recursive) RECURSE=1 ;;
    --home)
      shift
      HOME_OVERRIDE="${1:-}"
      [ -n "$HOME_OVERRIDE" ] || { printf 'error: --home requires a path\n' >&2; exit 2; }
      ;;
    --home=*) HOME_OVERRIDE="${1#--home=}" ;;
    --) shift; break ;;
    -*) printf 'error: unknown flag: %s\n' "$1" >&2; usage; exit 2 ;;
    *) printf 'error: unexpected argument: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
if [ -n "$HOME_OVERRIDE" ]; then
  FM_HOME="$HOME_OVERRIDE"
  STATE="$FM_HOME/state"
  CONFIG="$FM_HOME/config"
  DATA="$FM_HOME/data"
else
  FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
  STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
  CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
  DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
fi

# shellcheck source=sbin/fm-identity-lib.sh
. "$SCRIPT_DIR/fm-identity-lib.sh"
# shellcheck source=sbin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

ROOT_HOME="$FM_HOME"
HERDR_OK=0
command -v herdr >/dev/null 2>&1 && HERDR_OK=1 || HERDR_OK=0

SEP=$(printf '\037')   # unit separator for internal records (non-whitespace)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fm-lineage.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
RECORDS="$WORK/records"
HOMES="$WORK/homes"
VISITED="$WORK/visited"
: > "$RECORDS"
: > "$HOMES"
: > "$VISITED"

# emit_row <field>...: append one SEP-joined record line. Joining via IFS keeps
# empty fields intact (printf "$*" inserts SEP, including between empties).
emit_row() { local IFS="$SEP"; printf '%s\n' "$*"; }

# meta_get <file> <key>: print value of key= (first match only).
meta_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }

# _safe <id>: filesystem-safe token for memo cache filenames.
_safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

# Memoized herdr reads (one herdr call per id for the whole run). Each is a
# pure get; errors are swallowed so a degraded probe never fails the tree.
pane_json() {
  local c; c="$WORK/pane.$(_safe "$1")"
  [ -f "$c" ] || herdr pane get "$1" >"$c" 2>/dev/null || true
  cat "$c" 2>/dev/null || true
}
tab_json() {
  local c; c="$WORK/tab.$(_safe "$1")"
  [ -f "$c" ] || herdr tab get "$1" >"$c" 2>/dev/null || true
  cat "$c" 2>/dev/null || true
}
ws_json() {
  local c; c="$WORK/ws.$(_safe "$1")"
  [ -f "$c" ] || herdr workspace get "$1" >"$c" 2>/dev/null || true
  cat "$c" 2>/dev/null || true
}
agent_json() {
  local c; c="$WORK/agent.$(_safe "$1")"
  [ -f "$c" ] || herdr agent get "$1" >"$c" 2>/dev/null || true
  cat "$c" 2>/dev/null || true
}

# gather_home <home> <parent_home> <parent_task> <availability> <child_harness>
# Appends one homes row and one records row per task. Recurses into secondmate
# homes when --recursive. A visited-set breaks home cycles.
gather_home() {
  local home=$1 parent_home=$2 parent_task=$3 availability=$4 child_harness=${5:-}
  if grep -qxF "$home" "$VISITED" 2>/dev/null; then return 0; fi
  printf '%s\n' "$home" >> "$VISITED"

  local hstate hconfig hdata
  if [ "$home" = "$ROOT_HOME" ]; then
    hstate="$STATE"; hconfig="$CONFIG"; hdata="$DATA"
  else
    hstate="$home/state"; hconfig="$home/config"; hdata="$home/data"
  fi

  local sup role par harness ident curpane ompcfg
  sup=$(fm_supervisor_name "$hconfig")
  role=$(fm_supervisor_role "$hconfig")
  par=$(fm_supervisor_parent "$hconfig")
  curpane=
  ompcfg=
  if [ "$home" = "$ROOT_HOME" ]; then
    harness=$("$SCRIPT_DIR/fm-harness.sh" 2>/dev/null || true)
    if [ "$HERDR_OK" = 1 ]; then
      curpane=$(herdr pane current 2>/dev/null | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1 || true)
    fi
    if command -v omp >/dev/null 2>&1; then
      ompcfg=$(omp config path 2>/dev/null | head -1 || true)
    fi
  else
    harness="$child_harness"
  fi
  [ -n "$harness" ] || harness=firstmate
  if [ "$harness" = omp ]; then ident=omp; else ident="$harness"; fi

  # homes columns: home parent_home parent_task supervisor role parent
  #                harness identity current_pane omp_config_path availability
  emit_row "$home" "$parent_home" "$parent_task" "$sup" "$role" "$par" \
    "$harness" "$ident" "$curpane" "$ompcfg" "$availability" >> "$HOMES"

  local f task_id pane tab_meta kind mode yolo worker domain project worktree
  local task_home projects agent_identity_meta harness_meta ws_meta
  if [ -d "$hstate" ]; then
    for f in "$hstate"/*.meta; do
      [ -e "$f" ] || continue
      task_id=$(basename "$f" .meta)
      pane=$(meta_get "$f" pane)
      tab_meta=$(meta_get "$f" tab)
      kind=$(meta_get "$f" kind)
      mode=$(meta_get "$f" mode)
      yolo=$(meta_get "$f" yolo)
      worker=$(meta_get "$f" worker)
      domain=$(meta_get "$f" domain)
      project=$(meta_get "$f" project)
      worktree=$(meta_get "$f" worktree)
      task_home=$(meta_get "$f" home)
      projects=$(meta_get "$f" projects)
      agent_identity_meta=$(meta_get "$f" agent_identity)
      harness_meta=$(meta_get "$f" harness)
      ws_meta=$(meta_get "$f" workspace)

      local ws_id tab_id pane_id pane_label pane_status ws_label ws_status
      local tab_label tab_status cwd degraded agent_identity
      ws_id=; tab_id=; pane_id="$pane"; pane_label=; pane_status=
      ws_label=; ws_status=; tab_label=; tab_status=; cwd=; degraded=; agent_identity=

      if [ -n "$agent_identity_meta" ]; then
        agent_identity="$agent_identity_meta"
      elif [ "$harness_meta" = omp ]; then
        agent_identity=omp
      elif [ -n "$harness_meta" ]; then
        agent_identity="$harness_meta"
      fi

      if [ "$HERDR_OK" != 1 ]; then
        degraded="herdr-unreachable"
      elif [ -z "$pane" ]; then
        degraded="state-only"
      else
        local pjson live_pid ajson astat
        pjson=$(pane_json "$pane")
        live_pid=$(printf '%s' "$pjson" | fm_json_get result pane pane_id)
        if [ -n "$live_pid" ]; then
          degraded=live
          ws_id=$(printf '%s' "$pjson" | fm_json_get result pane workspace_id)
          tab_id=$(printf '%s' "$pjson" | fm_json_get result pane tab_id)
          pane_label=$(printf '%s' "$pjson" | fm_json_get result pane label)
          cwd=$(printf '%s' "$pjson" | fm_json_get result pane cwd)
          [ -n "$cwd" ] || cwd=$(printf '%s' "$pjson" | fm_json_get result pane foreground_cwd)
          # Prefer agent get for status when the pane is a real agent; tolerate
          # agent_not_found by falling back to the pane's own agent_status.
          ajson=$(agent_json "$pane")
          astat=$(printf '%s' "$ajson" | fm_json_get result agent agent_status)
          [ -n "$astat" ] || astat=$(printf '%s' "$pjson" | fm_json_get result pane agent_status)
          pane_status="$astat"
        else
          degraded="missing-pane"
        fi
      fi

      [ -n "$tab_id" ] || tab_id="$tab_meta"
      [ -n "$pane_label" ] || pane_label="$worker"
      [ -n "$pane_status" ] || pane_status=unknown

      if [ "$HERDR_OK" = 1 ] && [ -n "$tab_id" ]; then
        local tjson
        tjson=$(tab_json "$tab_id")
        tab_label=$(printf '%s' "$tjson" | fm_json_get result tab label)
        tab_status=$(printf '%s' "$tjson" | fm_json_get result tab agent_status)
        [ -n "$ws_id" ] || ws_id=$(printf '%s' "$tjson" | fm_json_get result tab workspace_id)
      fi
      [ -n "$tab_label" ] || tab_label="$worker"

      if [ "$HERDR_OK" = 1 ] && [ -n "$ws_id" ]; then
        local wjson
        wjson=$(ws_json "$ws_id")
        ws_label=$(printf '%s' "$wjson" | fm_json_get result workspace label)
        ws_status=$(printf '%s' "$wjson" | fm_json_get result workspace agent_status)
      fi
      [ -n "$ws_label" ] || ws_label="$ws_meta"

      # records columns: home ws_id ws_label ws_status tab_id tab_label tab_status
      #   pane_id pane_label pane_status agent_identity cwd task_id kind mode yolo
      #   worker domain project worktree task_home projects degraded
      emit_row "$home" "$ws_id" "$ws_label" "$ws_status" "$tab_id" "$tab_label" "$tab_status" \
        "$pane_id" "$pane_label" "$pane_status" "$agent_identity" "$cwd" \
        "$task_id" "$kind" "$mode" "$yolo" "$worker" "$domain" "$project" "$worktree" \
        "$task_home" "$projects" "$degraded" >> "$RECORDS"

      if [ "$RECURSE" = 1 ] && [ "$kind" = secondmate ] && [ -n "$task_home" ]; then
        local childavail childharness
        if [ "$degraded" = live ]; then childavail=running; else childavail=stale; fi
        if [ -n "$harness_meta" ]; then childharness="$harness_meta"; else childharness="$harness"; fi
        if [ -d "$task_home" ]; then
          gather_home "$task_home" "$home" "$task_id" "$childavail" "$childharness"
        elif ! grep -qxF "$task_home" "$VISITED" 2>/dev/null; then
          printf '%s\n' "$task_home" >> "$VISITED"
          emit_row "$task_home" "$home" "$task_id" "?" "?" "?" "$childharness" \
            "${agent_identity:-?}" "" "" unavailable >> "$HOMES"
        fi
      fi
    done
  fi

  # Registered-but-not-live secondmate homes from data/secondmates.md.
  if [ "$RECURSE" = 1 ] && [ -f "$hdata/secondmates.md" ]; then
    local line rhome
    while IFS= read -r line; do
      case "$line" in
        *"(home:"*) : ;;
        *) continue ;;
      esac
      rhome=$(printf '%s\n' "$line" | sed -n 's/.*(home:[[:space:]]*\([^;)]*\).*/\1/p' | head -1)
      rhome=${rhome%"${rhome##*[![:space:]]}"}
      [ -n "$rhome" ] || continue
      if grep -qxF "$rhome" "$VISITED" 2>/dev/null; then continue; fi
      if [ -d "$rhome" ]; then
        gather_home "$rhome" "$home" "-" registered "$harness"
      else
        printf '%s\n' "$rhome" >> "$VISITED"
        emit_row "$rhome" "$home" "-" "?" "?" "?" "?" "?" "" "" unavailable >> "$HOMES"
      fi
    done < "$hdata/secondmates.md"
  fi
  return 0
}

# render_home_text <home> <base-indent>
render_home_text() {
  local home=$1 base=$2
  local hl _h _ph _pt sup _role par harness ident _cp _omp avail note
  # Pass filesystem-derived values (home/task) via the environment + ENVIRON[]
  # rather than awk -v: awk interprets backslash escapes in -v values, so a path
  # containing a backslash (a legal filename byte) would never match the literal
  # field read from "$HOMES".
  hl=$(FM_AWK_HOME="$home" awk -F"$SEP" '$1==ENVIRON["FM_AWK_HOME"]{print;exit}' "$HOMES")
  [ -n "$hl" ] || return 0
  IFS="$SEP" read -r _h _ph _pt sup _role par harness ident _cp _omp avail <<EOF
$hl
EOF
  note=
  case "$avail" in
    unavailable) note=" (unavailable)" ;;
    registered) note=" (registered, not running)" ;;
    stale) note=" (stale, no live pane)" ;;
  esac
  printf '%s%s session firstmate home=%s supervisor=%s parent=%s identity=%s%s\n' \
    "$base" "$harness" "$home" "$sup" "$par" "$ident" "$note"

  local recf; recf="$WORK/r.$(_safe "$home")"
  FM_AWK_HOME="$home" awk -F"$SEP" -v sep="$SEP" 'BEGIN{k=sprintf("%c",1); h=ENVIRON["FM_AWK_HOME"]} $1==h{
    wsk=($2!=""?$2:"M:"$3); tabk=($5!=""?$5:"M:"$6); pk=($8!=""?$8:"M:"$13);
    print wsk k tabk k pk k $13 sep $0
  }' "$RECORDS" | LC_ALL=C sort | cut -d"$SEP" -f2- > "$recf"

  local rhome ws_id ws_label ws_status tab_id tab_label tab_status pane_id
  local pane_label pane_status agent_identity cwd task_id kind mode yolo
  local worker domain project worktree task_home projects degraded
  local prev_ws prev_tab prev_pane wsk tabk pk wsi tabi pani taski
  local wsline tabline paneline taskline ch
  prev_ws=; prev_tab=; prev_pane=
  wsi="$base  "; tabi="$base    "; pani="$base      "; taski="$base        "
  while IFS="$SEP" read -r rhome ws_id ws_label ws_status tab_id tab_label tab_status pane_id pane_label pane_status agent_identity cwd task_id kind mode yolo worker domain project worktree task_home projects degraded; do
    [ -n "$task_id" ] || continue
    if [ -n "$ws_id" ]; then wsk="$ws_id"; else wsk="M:$ws_label"; fi
    if [ -n "$tab_id" ]; then tabk="$tab_id"; else tabk="M:$tab_label"; fi
    if [ -n "$pane_id" ]; then pk="$pane_id"; else pk="M:$task_id"; fi

    if [ "$wsk" != "$prev_ws" ]; then
      if [ "$degraded" = herdr-unreachable ]; then
        wsline="workspace ${ws_label:-?} [?] herdr=unreachable"
      elif [ -n "$ws_id" ]; then
        wsline="workspace ${ws_label:-?} [$ws_id] status=${ws_status:-unknown}"
      else
        wsline="workspace ${ws_label:-?} [?] from meta"
      fi
      printf '%s%s\n' "$wsi" "$wsline"
      prev_ws="$wsk"; prev_tab=; prev_pane=
    fi

    if [ "$tabk" != "$prev_tab" ]; then
      if [ -n "$tab_id" ] && [ "$degraded" = live ]; then
        tabline="tab ${tab_label:-?} [$tab_id] status=${tab_status:-unknown}"
      elif [ -n "$tab_id" ]; then
        tabline="tab ${tab_label:-?} [$tab_id] from meta"
      else
        tabline="tab ${tab_label:-?} [?] from meta"
      fi
      printf '%s%s\n' "$tabi" "$tabline"
      prev_tab="$tabk"; prev_pane=
    fi

    if [ "$pk" != "$prev_pane" ]; then
      case "$degraded" in
        live) paneline="pane ${pane_label:-?} [${pane_id:-?}] agent=${agent_identity:-?} status=${pane_status:-unknown}${cwd:+ cwd=$cwd}" ;;
        missing-pane) paneline="pane ${pane_label:-?} [${pane_id:-?}] agent=${agent_identity:-?} status=unknown missing-pane" ;;
        herdr-unreachable) paneline="pane ${pane_label:-?} [${pane_id:-?}] status=unknown herdr=unreachable" ;;
        *) paneline="pane ${pane_label:-?} [?] status=unknown no-pane" ;;
      esac
      printf '%s%s\n' "$pani" "$paneline"
      prev_pane="$pk"
    fi

    taskline="task $task_id kind=${kind:-?} mode=${mode:-?}"
    if [ -n "$worker" ]; then taskline="$taskline worker=$worker"; fi
    if [ -n "$domain" ]; then taskline="$taskline domain=$domain"; fi
    if [ -n "$project" ]; then taskline="$taskline project=$project"; fi
    if [ -n "$worktree" ]; then taskline="$taskline worktree=$worktree"; fi
    if [ "$kind" = secondmate ] && [ -n "$task_home" ]; then taskline="$taskline home=$task_home"; fi
    if [ "$kind" = secondmate ] && [ -n "$projects" ]; then taskline="$taskline projects=$projects"; fi
    if [ "$yolo" = on ]; then taskline="$taskline yolo=on"; fi
    printf '%s%s\n' "$taski" "$taskline"

    if [ "$RECURSE" = 1 ] && [ "$kind" = secondmate ] && [ -n "$task_home" ]; then
      ch=$(FM_AWK_HOME="$home" FM_AWK_TASK="$task_id" awk -F"$SEP" '$2==ENVIRON["FM_AWK_HOME"] && $3==ENVIRON["FM_AWK_TASK"]{print $1;exit}' "$HOMES")
      if [ -n "$ch" ]; then render_home_text "$ch" "$base          "; fi
    fi
  done < "$recf"

  if [ "$RECURSE" = 1 ]; then
    while IFS= read -r ch; do
      [ -n "$ch" ] || continue
      render_home_text "$ch" "$base  "
    done < <(FM_AWK_HOME="$home" awk -F"$SEP" '$2==ENVIRON["FM_AWK_HOME"] && $3=="-"{print $1}' "$HOMES")
  fi
  return 0
}

render_flat() {
  local home ws_id ws_label ws_status tab_id tab_label tab_status pane_id
  local pane_label pane_status agent_identity cwd task_id kind mode yolo
  local worker domain project worktree task_home projects degraded
  while IFS="$SEP" read -r home ws_id ws_label ws_status tab_id tab_label tab_status pane_id pane_label pane_status agent_identity cwd task_id kind mode yolo worker domain project worktree task_home projects degraded; do
    [ -n "$task_id" ] || continue
    printf 'task=%s kind=%s mode=%s worker=%s pane=%s status=%s tab=%s workspace=%s ws_id=%s agent=%s domain=%s degraded=%s home=%s\n' \
      "$task_id" "${kind:-?}" "${mode:-?}" "${worker:-?}" "${pane_id:-?}" "${pane_status:-unknown}" \
      "${tab_id:-?}" "${ws_label:-?}" "${ws_id:-?}" "${agent_identity:-?}" "${domain:-?}" "$degraded" "$home"
  done < "$RECORDS"
  return 0
}

emit_json() {
  python3 -c '
import sys, json

records_path, homes_path, root_home = sys.argv[1], sys.argv[2], sys.argv[3]
recurse = sys.argv[4] == "1"
SEP = "\x1f"

REC_COLS = ["home","ws_id","ws_label","ws_status","tab_id","tab_label","tab_status",
            "pane_id","pane_label","pane_status","agent_identity","cwd","task_id","kind",
            "mode","yolo","worker","domain","project","worktree","task_home","projects","degraded"]
HOME_COLS = ["home","parent_home","parent_task","supervisor","role","parent","harness",
             "identity","current_pane","omp_config_path","availability"]

def load(path, cols):
    rows = []
    try:
        with open(path) as fh:
            for line in fh:
                line = line.rstrip("\n")
                if line == "":
                    continue
                parts = line.split(SEP)
                parts += [""] * (len(cols) - len(parts))
                rows.append(dict(zip(cols, parts[:len(cols)])))
    except FileNotFoundError:
        pass
    return rows

records = load(records_path, REC_COLS)
homes = load(homes_path, HOME_COLS)

homes_by_path = {}
for h in homes:
    homes_by_path.setdefault(h["home"], h)

children = {}
registry = {}
for h in homes:
    ph, pt = h["parent_home"], h["parent_task"]
    if ph == "-":
        continue
    if pt == "-":
        registry.setdefault(ph, []).append(h["home"])
    else:
        children.setdefault((ph, pt), []).append(h["home"])

recs_by_home = {}
for r in records:
    recs_by_home.setdefault(r["home"], []).append(r)

def q(v):
    return v if v else "?"

def wsk(r):
    return r["ws_id"] or ("M:" + r["ws_label"])
def tabk(r):
    return r["tab_id"] or ("M:" + r["tab_label"])
def pk(r):
    return r["pane_id"] or ("M:" + r["task_id"])

def build_home(home_path):
    hm = homes_by_path.get(home_path, {})
    node = {
        "home": home_path,
        "supervisor": hm.get("supervisor", ""),
        "role": hm.get("role", ""),
        "parent": hm.get("parent", ""),
        "harness": hm.get("harness", ""),
        "availability": hm.get("availability", ""),
        "session": {
            "omp_config_path": hm.get("omp_config_path", ""),
            "current_pane": hm.get("current_pane", ""),
        },
        "workspaces": [],
    }
    recs = sorted(recs_by_home.get(home_path, []), key=lambda r: (wsk(r), tabk(r), pk(r), r["task_id"]))
    ws_index = {}
    tab_index = {}
    for r in recs:
        wk = wsk(r)
        if wk not in ws_index:
            ws_obj = {"id": q(r["ws_id"]), "label": q(r["ws_label"]),
                      "status": r["ws_status"] or "unknown", "tabs": []}
            ws_index[wk] = ws_obj
            node["workspaces"].append(ws_obj)
        ws_obj = ws_index[wk]
        tk = (wk, tabk(r))
        if tk not in tab_index:
            tab_obj = {"id": q(r["tab_id"]), "label": q(r["tab_label"]),
                       "status": r["tab_status"] or "unknown", "panes": []}
            tab_index[tk] = tab_obj
            ws_obj["tabs"].append(tab_obj)
        tab_obj = tab_index[tk]
        task = {
            "id": r["task_id"], "kind": r["kind"], "mode": r["mode"], "yolo": r["yolo"],
            "worker": r["worker"], "domain": r["domain"], "project": r["project"],
            "worktree": r["worktree"], "home": r["task_home"], "projects": r["projects"],
            "degraded": r["degraded"],
        }
        if recurse and r["kind"] == "secondmate":
            kids = children.get((home_path, r["task_id"]), [])
            if kids:
                task["secondmate"] = build_home(kids[0])
        pane_obj = {
            "id": q(r["pane_id"]), "label": q(r["pane_label"]),
            "agent_identity": q(r["agent_identity"]),
            "agent_status": r["pane_status"] or "unknown",
            "cwd": r["cwd"], "task": task,
        }
        tab_obj["panes"].append(pane_obj)
    if recurse:
        reg = registry.get(home_path, [])
        if reg:
            node["registered_secondmates"] = [build_home(k) for k in reg]
    return node

print(json.dumps(build_home(root_home), indent=2))
' "$RECORDS" "$HOMES" "$ROOT_HOME" "$RECURSE"
}

gather_home "$ROOT_HOME" "-" "-" running ""

case "$MODE_OUT" in
  text) render_home_text "$ROOT_HOME" "" ;;
  flat) render_flat ;;
  json) emit_json ;;
esac
