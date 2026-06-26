#!/usr/bin/env bash
# fm-bench.sh - parameterized, self-cleaning END-TO-END firstmate lifecycle bench.
#
# Exercises the REAL firstmate crewmate lifecycle (the repo's own bin/fm-spawn.sh,
# bin/fm-teardown.sh, bin/fm-lineage.sh, bin/fm-classify-status.sh) against real
# herdr + omp, driving a throwaway generated mini-project under an isolated temp
# FM_HOME, asserting outcomes, then wiping every trace after each iteration.
#
# It NEVER touches the real 'ship' workspace, the repo's state/, or real projects:
# each iteration runs in its own mktemp FM_HOME with FM_WORKTREE_BASE inside it,
# and every herdr workspace it creates is label-prefixed 'fm-bench-<runid>'. A
# trap cleans up on EXIT/INT/TERM; stale fm-bench-* workspaces are swept at start;
# a workspace is only ever closed after re-asserting its 'fm-bench-' label prefix.
#
# Scenarios:
#   concurrency  spawn N crewmates into one mini-project; assert N distinct panes
#                AND tabs, NO agent_name_taken, each meta agent_identity=<harness>,
#                each pane's herdr status binds to a real turn (working/done, not
#                unknown) within a poll window, and fm-lineage lists all N tasks.
#                Fails loudly if any spawn collides or any status stays unknown.
#   supervision  with one crewmate up, write a relevant and an irrelevant line to
#                its state/<id>.status; assert fm-classify-status.sh wakes on the
#                relevant one and suppresses the irrelevant one.
#   teardown     assert fm-teardown.sh refuses a ship crewmate's unlanded work
#                without --force (and removes it with --force), refuses a scout
#                until its report exists (and removes it once it does), and that
#                the pane and worktree are gone afterward.
#
# Usage:
#   fm-bench.sh [--scenario concurrency|supervision|teardown|all]
#               [--workers N|N,M,...] [--harness omp|codex] [--matrix]
#               [--real] [--keep] [--json] [-h]
#
#   --scenario   scenario(s) to run (default: all).
#   --workers    crewmate count(s) for concurrency (default: 2). With --matrix a
#                comma list runs concurrency once per value.
#   --harness    crew harness (default: omp). With --matrix a comma list crosses it.
#   --matrix     run the cross-product scenarios x workers x harness.
#   --real       use a real micro-brief via fm-brief.sh (LLM cost) instead of the
#                default cheap single-turn probe (omp prints a marker, then sleeps).
#   --keep       skip teardown; print the temp paths, task ids, and workspaces.
#   --json       emit a JSON result object instead of the text summary table.
#   -h, --help   show this help.
#
# Cheap vs real: the default cheap probe still launches real omp (so the genuine
# omp<->herdr status binding is what the concurrency scenario asserts) but feeds
# it a trivial "print a marker then sleep" prompt - one minimal turn, no project
# work. --real swaps in a genuine micro-task brief.
#
# Env knobs (mainly for the self-test / CI):
#   FM_BENCH_SPAWN_CMD       spawn script to drive (default: bin/fm-spawn.sh). Point
#                            it at a deliberately broken spawn to prove the bench
#                            catches a regression (e.g. a shared herdr slot).
#   FM_BENCH_SLEEP           seconds the cheap probe sleeps mid-turn (default: 25).
#   FM_BENCH_STATUS_TIMEOUT  seconds to wait for a pane status to bind (default: 75).
#
# Exit status: nonzero if any iteration FAILED (SKIPs do not fail the run).
# bash 3.2 safe; shellcheck clean.
set -u

usage() {
  sed -n '2,57p' "$0" | sed 's/^# \{0,1\}//'
}

# ---- argument parsing ------------------------------------------------------
SCENARIO=all
WORKERS_ARG=2
HARNESS_ARG=omp
MATRIX=0
REAL=0
KEEP=0
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --scenario) shift; SCENARIO="${1:-}" ;;
    --scenario=*) SCENARIO="${1#--scenario=}" ;;
    --workers) shift; WORKERS_ARG="${1:-}" ;;
    --workers=*) WORKERS_ARG="${1#--workers=}" ;;
    --harness) shift; HARNESS_ARG="${1:-}" ;;
    --harness=*) HARNESS_ARG="${1#--harness=}" ;;
    --matrix) MATRIX=1 ;;
    --real) REAL=1 ;;
    --keep) KEEP=1 ;;
    --json) JSON=1 ;;
    *) printf 'error: unknown flag: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$SCENARIO" in
  concurrency|supervision|teardown|all) ;;
  *) printf 'error: invalid --scenario: %s\n' "$SCENARIO" >&2; exit 2 ;;
esac

WORKERS_LIST=$(printf '%s' "$WORKERS_ARG" | tr ',' ' ')
HARNESS_LIST=$(printf '%s' "$HARNESS_ARG" | tr ',' ' ')

# shellcheck disable=SC2086
for w in $WORKERS_LIST; do
  case "$w" in
    ''|*[!0-9]*) printf 'error: --workers must be positive integers: %s\n' "$w" >&2; exit 2 ;;
  esac
  [ "$w" -ge 1 ] || { printf 'error: --workers must be >= 1: %s\n' "$w" >&2; exit 2; }
done

# Without --matrix the run is one iteration per scenario: take the first workers
# and harness value only. --matrix expands the full cross-product.
if [ "$MATRIX" = 0 ]; then
  WORKERS_LIST=${WORKERS_LIST%% *}
  HARNESS_LIST=${HARNESS_LIST%% *}
fi

if [ "$SCENARIO" = all ]; then
  SCN_LIST="concurrency supervision teardown"
else
  SCN_LIST="$SCENARIO"
fi

# ---- environment + run-level state -----------------------------------------
command -v herdr >/dev/null 2>&1 || { printf 'error: herdr not found on PATH\n' >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPAWN_CMD="${FM_BENCH_SPAWN_CMD:-$FM_ROOT/bin/fm-spawn.sh}"
SLEEP_SECS="${FM_BENCH_SLEEP:-25}"
STATUS_TIMEOUT="${FM_BENCH_STATUS_TIMEOUT:-75}"

RUNID="$(date +%H%M%S)-$$"
WS_RUN_PREFIX="fm-bench-$RUNID"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
RESULTS_FILE="$(mktemp "$TMP_BASE/fm-bench-results.XXXXXX")"
TMP_DIRS=""
KEEP_NOTES=""
CLEANED=0
ANY_FAIL=0
LEFTOVER_OK=1

# Iteration-scoped globals (reset by new_iter_home).
ITER_HOME=""; ITER_WTBASE=""; ITER_PROJ_DIR=""; ITER_PROJ_NAME=""
ITER_TMP=""; ITERTOKEN=""; ITER_TASK_IDS=""; ITER_PANES=""; ITER_FAIL=0
BOUND=""
ITER_STATS_JSON="{}"

# ---- helpers ---------------------------------------------------------------

# agent_status <pane-id>: current herdr agent status (idle|working|blocked|done|
# unknown) or empty when the pane/agent is gone. Mirrors fm_herdr_agent_status in
# fm-herdr-lib.sh; inlined to keep the bench a self-contained, single-file tool.
agent_status() {
  herdr agent get "$1" 2>/dev/null \
    | grep -o '"agent_status":"[^"]*"' | head -1 \
    | sed 's/.*"agent_status":"\([^"]*\)".*/\1/'
}

# ws_all: one "<workspace_id><TAB><label>" line per live workspace, sorted by id.
# The before/after snapshot used to prove zero leftover.
ws_all() {
  herdr workspace list 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for w in sorted(d.get("result", {}).get("workspaces", []), key=lambda x: x.get("workspace_id", "")):
    print("%s\t%s" % (w.get("workspace_id", ""), w.get("label", "")))
' 2>/dev/null || true
}

# close_prefixed <prefix>: close every live workspace whose label starts with
# <prefix>. Refuses unless <prefix> itself begins with 'fm-bench-', so a bad id
# can never close 'ship' or any real workspace.
close_prefixed() {
  local prefix=$1 id label
  case "$prefix" in
    fm-bench-*) ;;
    *) printf 'WARN: refusing to close non-bench prefix: %s\n' "$prefix" >&2; return 0 ;;
  esac
  ws_all | while IFS="$(printf '\t')" read -r id label; do
    case "$label" in
      "$prefix"*) [ -n "$id" ] && herdr workspace close "$id" >/dev/null 2>&1 || true ;;
    esac
  done
}

# sweep_stale: close fm-bench-* workspaces left by a previous crashed run, but
# never this run's own (WS_RUN_PREFIX).
sweep_stale() {
  local id label
  ws_all | while IFS="$(printf '\t')" read -r id label; do
    case "$label" in
      "$WS_RUN_PREFIX"*) : ;;
      fm-bench-*) [ -n "$id" ] && herdr workspace close "$id" >/dev/null 2>&1 || true ;;
    esac
  done
}

# bench_proc_count: number of live processes carrying this run's unique probe
# marker. Zero before the run (the marker embeds RUNID) and must be zero after.
bench_proc_count() {
  pgrep -f "FM_BENCH_MARKER $RUNID" 2>/dev/null | grep -c . || true
}

# shellcheck disable=SC2329  # invoked indirectly via trap on EXIT/INT/TERM
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  [ "$KEEP" = 1 ] && return 0
  close_prefixed "$WS_RUN_PREFIX"
  pkill -f "FM_BENCH_MARKER $RUNID" 2>/dev/null || true
  local d
  # shellcheck disable=SC2086
  for d in $TMP_DIRS; do [ -n "$d" ] && rm -rf "$d" 2>/dev/null || true; done
  rm -f "$RESULTS_FILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# new_iter_home: mktemp an isolated FM_HOME with identity (BenchCaptain/captain),
# a local-only projects registry, empty data/state, FM_WORKTREE_BASE in-tree, and
# a freshly generated local git mini-project under projects/.
new_iter_home() {
  ITER_TMP=$(mktemp -d "$TMP_BASE/fm-bench.XXXXXX")
  TMP_DIRS="$TMP_DIRS $ITER_TMP"
  ITERTOKEN=${ITER_TMP##*.}
  ITER_HOME="$ITER_TMP/home"
  ITER_WTBASE="$ITER_HOME/worktrees"
  ITER_PROJ_NAME="$WS_RUN_PREFIX-$ITERTOKEN"
  ITER_PROJ_DIR="$ITER_HOME/projects/$ITER_PROJ_NAME"
  ITER_TASK_IDS=""
  ITER_PANES=""
  ITER_FAIL=0
  mkdir -p "$ITER_HOME/state" "$ITER_HOME/data" "$ITER_HOME/config" \
           "$ITER_PROJ_DIR" "$ITER_WTBASE"
  {
    printf 'name=BenchCaptain\n'
    printf 'role=Firstmate end-to-end bench supervisor\n'
    printf 'parent=captain\n'
  } > "$ITER_HOME/config/identity"
  {
    printf '# Projects registry (bench)\n'
    printf -- '- %s [local-only] - bench mini-project (added %s)\n' \
      "$ITER_PROJ_NAME" "$(date +%Y-%m-%d)"
  } > "$ITER_HOME/data/projects.md"
  git -c init.defaultBranch=main init -q "$ITER_PROJ_DIR" 2>/dev/null
  printf '# %s\n\nThrowaway bench mini-project.\n' "$ITER_PROJ_NAME" > "$ITER_PROJ_DIR/README.md"
  printf 'seed\n' > "$ITER_PROJ_DIR/file.txt"
  git -C "$ITER_PROJ_DIR" add -A 2>/dev/null
  git -C "$ITER_PROJ_DIR" -c user.email=bench@fm-bench -c user.name=fm-bench \
    commit -q -m "bench seed" 2>/dev/null
  git -C "$ITER_PROJ_DIR" branch -M main 2>/dev/null
}

# run_fm: invoke a real firstmate bin/ script with every FM_* path pinned to the
# isolated temp home, so the bench can never read or write the real fleet state.
run_fm() {
  FM_HOME="$ITER_HOME" \
  FM_STATE_OVERRIDE="$ITER_HOME/state" \
  FM_DATA_OVERRIDE="$ITER_HOME/data" \
  FM_PROJECTS_OVERRIDE="$ITER_HOME/projects" \
  FM_CONFIG_OVERRIDE="$ITER_HOME/config" \
  FM_WORKTREE_BASE="$ITER_WTBASE" \
    "$@"
}

# write_brief <id> [ship|scout]: place data/<id>/brief.md. Cheap mode writes a
# trivial probe prompt (marker + sleep) that drives a single real omp turn at no
# project cost; --real scaffolds a genuine micro-brief via fm-brief.sh.
write_brief() {
  local id=$1 kind=${2:-ship} dir bf task
  dir="$ITER_HOME/data/$id"
  bf="$dir/brief.md"
  mkdir -p "$dir"
  if [ "$REAL" = 1 ]; then
    rm -f "$bf" 2>/dev/null || true
    if [ "$kind" = scout ]; then
      run_fm "$FM_ROOT/bin/fm-brief.sh" "$id" "$ITER_PROJ_NAME" --scout >/dev/null 2>&1 || true
    else
      run_fm "$FM_ROOT/bin/fm-brief.sh" "$id" "$ITER_PROJ_NAME" >/dev/null 2>&1 || true
    fi
    if [ -f "$bf" ]; then
      task="Append the line 'bench touched by $id ($RUNID)' to NOTES.txt at the repo root, then run: git add NOTES.txt && git commit -m 'bench: notes'. Then append the line 'done: ready in branch' to your status file and stop."
      FM_BF="$bf" FM_TASKTXT="$task" python3 -c '
import os
p = os.environ["FM_BF"]
open(p, "w").write(open(p).read().replace("{TASK}", os.environ["FM_TASKTXT"]))
' 2>/dev/null || true
      return 0
    fi
  fi
  printf '%s\n' "Bench probe $RUNID/$id. Do exactly this and nothing else, then stop: run the single shell command  printf 'FM_BENCH_MARKER $RUNID $id\\n' && sleep $SLEEP_SECS  -- do not edit files, do not git commit, do not write any status file." > "$bf"
}

# spawn_field <spawn-output> <key>: extract key=value (e.g. pane, tab, worktree)
# from an fm-spawn 'spawned ...' line.
spawn_field() {
  printf '%s\n' "$1" | grep -o "$2=[^ ]*" | head -1 | cut -d= -f2-
}

chk_pass() { printf '  PASS  %s\n' "$1"; }
chk_fail() { printf '  FAIL  %s\n' "$1"; ITER_FAIL=$((ITER_FAIL + 1)); }
chk_info() { printf '  INFO  %s\n' "$1"; }

# poll_bound <space-separated panes>: block until every pane has reached a real
# turn status (working|done|blocked) at least once, or STATUS_TIMEOUT elapses.
# Records the bound panes in the global BOUND.
poll_bound() {
  local panes=$1 deadline p s allok
  deadline=$(( $(date +%s) + STATUS_TIMEOUT ))
  BOUND=""
  while :; do
    # shellcheck disable=SC2086
    for p in $panes; do
      case " $BOUND " in *" $p "*) continue ;; esac
      s=$(agent_status "$p")
      case "$s" in working|done|blocked) BOUND="$BOUND $p" ;; esac
    done
    allok=1
    # shellcheck disable=SC2086
    for p in $panes; do
      case " $BOUND " in *" $p "*) ;; *) allok=0 ;; esac
    done
    [ "$allok" = 1 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 2
  done
}

# pane_gone <pane-id>: 0 once herdr no longer knows the pane (polls briefly).
pane_gone() {
  local p=$1 i=0
  while [ "$i" -lt 5 ]; do
    herdr pane get "$p" >/dev/null 2>&1 || return 0
    i=$((i + 1)); sleep 1
  done
  herdr pane get "$p" >/dev/null 2>&1 && return 1
  return 0
}

register_pane() { [ -n "${1:-}" ] && ITER_PANES="$ITER_PANES $1"; return 0; }

# settle_turns: wait until no iteration pane is still mid-turn (working), capped at
# STATUS_TIMEOUT, so omp has flushed its session before stats are read. Used under
# --real where a representative whole-turn cost/cache figure is wanted.
settle_turns() {
  local deadline p any
  deadline=$(( $(date +%s) + STATUS_TIMEOUT ))
  while :; do
    any=0
    # shellcheck disable=SC2086
    for p in $ITER_PANES; do
      [ "$(agent_status "$p")" = working ] && any=1
    done
    [ "$any" = 0 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 0
    sleep 2
  done
}

# capture_stats: read effectiveness metrics for THIS iteration's omp activity from
# `omp stats --json` (the authoritative omp cost/cache/error model - never a
# reinvented tokenizer). omp keys byFolder[] on each agent cwd with '/' replaced
# by '-', so every per-task worktree under the iteration temp shares the unique
# substring "fm-bench.<itertoken>"; we sum the matching folders. Cost/tokens are
# only meaningful under --real (a cheap probe is one trivial turn). Sets the
# global ITER_STATS_JSON (a JSON object) used by both reporters.
capture_stats() {
  local attempts tries=0
  if [ "$REAL" = 1 ]; then attempts=4; else attempts=1; fi
  while :; do
    tries=$((tries + 1))
    ITER_STATS_JSON=$(FM_MATCH="fm-bench.$ITERTOKEN" python3 -c '
import os, subprocess, json
match = os.environ["FM_MATCH"]
try:
    raw = subprocess.run(["omp", "stats", "--json"], capture_output=True,
                         text=True, timeout=30).stdout
    d = json.loads(raw[raw.find("{"):])
    bf = d.get("byFolder", []) or []
except Exception:
    bf = []
m = [e for e in bf if match in str(e.get("folder", ""))]
cost = sum(e.get("totalCost", 0) or 0 for e in m)
itok = sum(e.get("totalInputTokens", 0) or 0 for e in m)
otok = sum(e.get("totalOutputTokens", 0) or 0 for e in m)
cread = sum(e.get("totalCacheReadTokens", 0) or 0 for e in m)
req = sum(e.get("totalRequests", 0) or 0 for e in m)
fail = sum(e.get("failedRequests", 0) or 0 for e in m)
durw = sum((e.get("avgDuration", 0) or 0) * (e.get("totalRequests", 0) or 0) for e in m)
cache = (cread / (cread + itok)) if (cread + itok) > 0 else 0.0
err = (fail / req) if req > 0 else 0.0
dur = (durw / req) if req > 0 else 0.0
print(json.dumps({"folders": len(m), "totalCost": round(cost, 6),
                  "totalInputTokens": itok, "totalOutputTokens": otok,
                  "cacheRate": round(cache, 6), "missedCacheRate": round(1 - cache, 6),
                  "errorRate": round(err, 6), "avgDuration": round(dur, 2)}))
' 2>/dev/null)
    [ -n "$ITER_STATS_JSON" ] || ITER_STATS_JSON='{"folders":0,"totalCost":0,"totalInputTokens":0,"totalOutputTokens":0,"cacheRate":0,"missedCacheRate":0,"errorRate":0,"avgDuration":0}'
    case "$ITER_STATS_JSON" in
      *'"folders": 0'*|*'"folders":0'*) : ;;
      *) break ;;
    esac
    [ "$tries" -ge "$attempts" ] && break
    sleep 3
  done
}

# iter_cleanup: tear down this iteration's tasks via the REAL fm-teardown.sh,
# close any panes + the iteration's own workspace, and remove the temp home.
iter_cleanup() {
  [ "$KEEP" = 1 ] && return 0
  local id p
  # shellcheck disable=SC2086
  for id in $ITER_TASK_IDS; do
    [ -f "$ITER_HOME/state/$id.meta" ] && \
      run_fm "$FM_ROOT/bin/fm-teardown.sh" "$id" --force >/dev/null 2>&1 || true
  done
  # shellcheck disable=SC2086
  for p in $ITER_PANES; do
    [ -n "$p" ] && herdr pane close "$p" >/dev/null 2>&1 || true
  done
  close_prefixed "$ITER_PROJ_NAME"
  [ -n "$ITER_TMP" ] && rm -rf "$ITER_TMP" 2>/dev/null || true
}

# ---- scenarios -------------------------------------------------------------

# scn_concurrency <nworkers> <harness>
scn_concurrency() {
  local nworkers=$1 harness=$2
  local i id out rc pane tab panes="" tabs="" ids="" npanes ntabs lflat ltasks s
  i=1
  while [ "$i" -le "$nworkers" ]; do
    id="bench-$ITERTOKEN-c$i"
    ITER_TASK_IDS="$ITER_TASK_IDS $id"
    write_brief "$id" ship
    out=$(run_fm "$SPAWN_CMD" "$id" "$ITER_PROJ_DIR" "$harness" 2>&1); rc=$?
    if printf '%s\n' "$out" | grep -qi agent_name_taken; then
      chk_fail "agent_name_taken while spawning $id (slot collision regression)"
    fi
    if [ "$rc" -ne 0 ]; then
      chk_fail "spawn $id exited $rc"
      printf '%s\n' "$out" | sed 's/^/        /' | head -3
    else
      pane=$(spawn_field "$out" pane)
      tab=$(spawn_field "$out" tab)
      register_pane "$pane"
      panes="$panes $pane"; tabs="$tabs $tab"; ids="$ids $id"
    fi
    i=$((i + 1))
  done

  # shellcheck disable=SC2086
  npanes=$(printf '%s\n' $panes | sed '/^$/d' | sort -u | grep -c .)
  # shellcheck disable=SC2086
  ntabs=$(printf '%s\n' $tabs | sed '/^$/d' | sort -u | grep -c .)
  if [ "$npanes" = "$nworkers" ]; then chk_pass "N distinct panes ($npanes)"; else chk_fail "distinct panes: got $npanes want $nworkers"; fi
  if [ "$ntabs" = "$nworkers" ]; then chk_pass "N distinct tabs ($ntabs)"; else chk_fail "distinct tabs: got $ntabs want $nworkers"; fi

  # shellcheck disable=SC2086
  for id in $ids; do
    if grep -q "^agent_identity=$harness$" "$ITER_HOME/state/$id.meta" 2>/dev/null; then
      chk_pass "meta agent_identity=$harness ($id)"
    else
      chk_fail "meta agent_identity not $harness ($id)"
    fi
  done

  if [ -n "$panes" ]; then
    poll_bound "$panes" || true
    # shellcheck disable=SC2086
    for pane in $panes; do
      case " $BOUND " in
        *" $pane "*) chk_pass "status bound to a real turn (pane $pane)" ;;
        *)
          s=$(agent_status "$pane")
          if [ "$harness" = omp ]; then
            chk_fail "status never bound for pane $pane (last='${s:-gone}')"
          else
            chk_info "status not bound for non-omp pane $pane (last='${s:-gone}')"
          fi
          ;;
      esac
    done
  fi

  lflat=$(run_fm "$FM_ROOT/bin/fm-lineage.sh" --home "$ITER_HOME" --flat 2>/dev/null)
  ltasks=$(printf '%s\n' "$lflat" | grep -c '^task=' || true)
  if [ "$ltasks" = "$nworkers" ]; then chk_pass "lineage lists all $ltasks task(s)"; else chk_fail "lineage lists $ltasks task(s), want $nworkers"; fi
  # shellcheck disable=SC2086
  for id in $ids; do
    if printf '%s\n' "$lflat" | grep -q "^task=$id "; then chk_pass "lineage has $id"; else chk_fail "lineage missing $id"; fi
  done
}

# scn_supervision <harness>
scn_supervision() {
  local harness=$1 id out rc pane sf rel irr crc cout
  id="bench-$ITERTOKEN-sup"
  ITER_TASK_IDS="$ITER_TASK_IDS $id"
  write_brief "$id" ship
  out=$(run_fm "$SPAWN_CMD" "$id" "$ITER_PROJ_DIR" "$harness" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    chk_fail "spawn $id exited $rc"
    printf '%s\n' "$out" | sed 's/^/        /' | head -3
  else
    pane=$(spawn_field "$out" pane)
    register_pane "$pane"
    chk_pass "crewmate up (pane ${pane:-?})"
  fi

  sf="$ITER_HOME/state/$id.status"
  rel="done: PR ready"
  irr="still exploring the codebase, no decision yet"
  printf '%s\n' "$rel" >> "$sf"
  printf '%s\n' "$irr" >> "$sf"

  cout=$("$FM_ROOT/bin/fm-classify-status.sh" "$rel" 2>/dev/null); crc=$?
  if [ "$crc" -eq 0 ] && [ "$cout" = captain ]; then
    chk_pass "relevant line wakes captain ('$rel' -> $cout)"
  else
    chk_fail "relevant line not wake-worthy (rc=$crc out=$cout)"
  fi

  cout=$("$FM_ROOT/bin/fm-classify-status.sh" "$irr" 2>/dev/null); crc=$?
  if [ "$crc" -ne 0 ] && [ "$cout" = internal ]; then
    chk_pass "irrelevant line suppressed ('$irr' -> $cout)"
  else
    chk_fail "irrelevant line not suppressed (rc=$crc out=$cout)"
  fi

  if [ -f "$sf" ] && grep -q '^done: PR ready$' "$sf"; then
    chk_pass "supervised status file holds the relevant line"
  else
    chk_fail "supervised status file missing the relevant line"
  fi
}

# scn_teardown <harness>
scn_teardown() {
  local harness=$1 ship_id scout_id out rc wt pane td
  # --- ship crewmate: unlanded work must be refused without --force ---
  ship_id="bench-$ITERTOKEN-ship"
  ITER_TASK_IDS="$ITER_TASK_IDS $ship_id"
  write_brief "$ship_id" ship
  out=$(run_fm "$SPAWN_CMD" "$ship_id" "$ITER_PROJ_DIR" "$harness" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    chk_fail "ship spawn exited $rc"
    printf '%s\n' "$out" | sed 's/^/        /' | head -3
    return 0
  fi
  wt=$(spawn_field "$out" worktree)
  pane=$(spawn_field "$out" pane)
  register_pane "$pane"
  printf 'bench change\n' >> "$wt/file.txt"
  git -C "$wt" -c user.email=bench@fm-bench -c user.name=fm-bench \
    commit -aqm "bench unlanded change" 2>/dev/null

  td=$(run_fm "$FM_ROOT/bin/fm-teardown.sh" "$ship_id" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s\n' "$td" | grep -qi REFUSED; then
    chk_pass "ship teardown refuses unlanded work without --force"
  else
    chk_fail "ship teardown did NOT refuse unlanded work (rc=$rc)"
    printf '%s\n' "$td" | sed 's/^/        /' | head -3
  fi
  if [ -d "$wt" ]; then chk_pass "worktree preserved after refusal"; else chk_fail "worktree removed despite refusal"; fi

  td=$(run_fm "$FM_ROOT/bin/fm-teardown.sh" "$ship_id" --force 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then chk_pass "ship teardown --force succeeds"; else chk_fail "ship teardown --force failed (rc=$rc)"; printf '%s\n' "$td" | sed 's/^/        /' | head -3; fi
  if [ ! -d "$wt" ]; then chk_pass "worktree removed after --force"; else chk_fail "worktree still present after --force"; fi
  if [ -z "$pane" ]; then
    chk_info "no pane recorded for ship task"
  elif pane_gone "$pane"; then
    chk_pass "pane gone after --force"
  else
    chk_fail "pane still present after --force"
  fi
  if [ ! -f "$ITER_HOME/state/$ship_id.meta" ]; then chk_pass "ship meta removed"; else chk_fail "ship meta still present"; fi

  # --- scout: scratch worktree removed only once the report exists ---
  scout_id="bench-$ITERTOKEN-scout"
  ITER_TASK_IDS="$ITER_TASK_IDS $scout_id"
  write_brief "$scout_id" scout
  out=$(run_fm "$SPAWN_CMD" "$scout_id" "$ITER_PROJ_DIR" "$harness" --scout 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    chk_fail "scout spawn exited $rc"
    printf '%s\n' "$out" | sed 's/^/        /' | head -3
    return 0
  fi
  wt=$(spawn_field "$out" worktree)
  pane=$(spawn_field "$out" pane)
  register_pane "$pane"

  td=$(run_fm "$FM_ROOT/bin/fm-teardown.sh" "$scout_id" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s\n' "$td" | grep -qi REFUSED; then
    chk_pass "scout teardown refuses without a report"
  else
    chk_fail "scout teardown did NOT refuse without a report (rc=$rc)"
    printf '%s\n' "$td" | sed 's/^/        /' | head -3
  fi
  if [ -d "$wt" ]; then chk_pass "scout worktree preserved before report"; else chk_fail "scout worktree removed before report"; fi

  mkdir -p "$ITER_HOME/data/$scout_id"
  printf 'bench scout report\n' > "$ITER_HOME/data/$scout_id/report.md"
  td=$(run_fm "$FM_ROOT/bin/fm-teardown.sh" "$scout_id" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then chk_pass "scout teardown succeeds once report exists"; else chk_fail "scout teardown failed with report (rc=$rc)"; printf '%s\n' "$td" | sed 's/^/        /' | head -3; fi
  if [ ! -d "$wt" ]; then chk_pass "scout worktree removed after teardown"; else chk_fail "scout worktree still present"; fi
  if [ -z "$pane" ]; then
    chk_info "no pane recorded for scout task"
  elif pane_gone "$pane"; then
    chk_pass "scout pane gone after teardown"
  else
    chk_fail "scout pane still present after teardown"
  fi
}

# ---- iteration driver ------------------------------------------------------
run_iteration() {
  local scn=$1 wk=$2 hrn=$3 status detail
  if ! command -v "$hrn" >/dev/null 2>&1; then
    printf '\n== %s (workers=%s harness=%s): SKIP - harness binary not on PATH ==\n' "$scn" "$wk" "$hrn"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$scn" "$wk" "$hrn" SKIP "harness $hrn not on PATH" '{}' >> "$RESULTS_FILE"
    return 0
  fi
  printf '\n== %s (workers=%s harness=%s) ==\n' "$scn" "$wk" "$hrn"
  new_iter_home
  printf '  home=%s\n  project=%s\n' "$ITER_HOME" "$ITER_PROJ_NAME"
  ITER_STATS_JSON="{}"
  case "$scn" in
    concurrency) scn_concurrency "$wk" "$hrn" ;;
    supervision) scn_supervision "$hrn" ;;
    teardown)    scn_teardown "$hrn" ;;
  esac
  [ "$REAL" = 1 ] && settle_turns
  capture_stats
  if [ "$ITER_FAIL" -eq 0 ]; then
    status=PASS; detail="all checks passed"
  else
    status=FAIL; detail="$ITER_FAIL check(s) failed"; ANY_FAIL=1
  fi
  printf '  -> %s (%s)\n' "$status" "$detail"
  printf '%s' "$ITER_STATS_JSON" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("  stats(omp): cost(USD)=%(totalCost)s in=%(totalInputTokens)s out=%(totalOutputTokens)s cacheRate=%(cacheRate)s missedCacheRate=%(missedCacheRate)s errorRate=%(errorRate)s avgDuration=%(avgDuration)sms folders=%(folders)s" % d)
' 2>/dev/null || true
  [ "$REAL" = 1 ] || printf '  stats note: cheap probe is a single trivial omp turn - cost/cache/token figures reflect only that turn, not real task work; use --real for representative effectiveness metrics\n'
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$scn" "$wk" "$hrn" "$status" "$detail" "$ITER_STATS_JSON" >> "$RESULTS_FILE"
  if [ "$KEEP" = 1 ]; then
    KEEP_NOTES="$KEEP_NOTES
  [$scn wk=$wk $hrn] home=$ITER_HOME ids=$ITER_TASK_IDS workspace=$ITER_PROJ_NAME"
  else
    iter_cleanup
  fi
}

# ---- reporting -------------------------------------------------------------
emit_table() {
  printf '\n== summary (run %s) ==\n' "$RUNID"
  printf '  %-12s %-8s %-8s %-6s %s\n' SCENARIO WORKERS HARNESS RESULT DETAIL
  while IFS="$(printf '\t')" read -r scn wk hrn st detail stats; do
    printf '  %-12s %-8s %-8s %-6s %s\n' "$scn" "$wk" "$hrn" "$st" "$detail"
    [ -n "${stats:-}" ] && [ "$stats" != '{}' ] && printf '%s' "$stats" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print("               stats: cost(USD)=%(totalCost)s in=%(totalInputTokens)s out=%(totalOutputTokens)s cacheRate=%(cacheRate)s missedCacheRate=%(missedCacheRate)s errorRate=%(errorRate)s avgDuration=%(avgDuration)sms folders=%(folders)s" % d)
' 2>/dev/null || true
  done < "$RESULTS_FILE"
  printf '\n'
  if [ "$KEEP" = 1 ]; then
    printf 'kept (teardown skipped):%s\n' "$KEEP_NOTES"
    printf 'live workspaces now:\n'; printf '%s\n' "$AFTER" | sed 's/^/  /'
    return 0
  fi
  if [ "$BEFORE" = "$AFTER" ]; then
    printf 'leftover check: herdr workspaces byte-identical before==after (PASS)\n'
  else
    printf 'leftover check: herdr workspaces DIFFER before!=after (FAIL)\n'
    printf -- '--- before ---\n%s\n--- after ---\n%s\n' "$BEFORE" "$AFTER"
  fi
  printf 'leftover check: bench probe processes before=%s after=%s\n' "$BEFORE_PROCS" "$AFTER_PROCS"
}

emit_json() {
  FM_RESULTS="$RESULTS_FILE" FM_RUNID="$RUNID" \
  FM_BEFORE="$BEFORE" FM_AFTER="$AFTER" \
  FM_BPROCS="$BEFORE_PROCS" FM_APROCS="$AFTER_PROCS" \
  FM_KEEP="$KEEP" FM_LEFTOVER_OK="$LEFTOVER_OK" \
  python3 -c '
import os, json
rows = []
with open(os.environ["FM_RESULTS"]) as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        p = line.split("\t")
        while len(p) < 6:
            p.append("")
        try:
            stats = json.loads(p[5]) if p[5] else {}
        except Exception:
            stats = {}
        rows.append({"scenario": p[0], "workers": p[1], "harness": p[2],
                     "result": p[3], "detail": p[4], "stats": stats})
keep = os.environ["FM_KEEP"] == "1"
out = {
    "run": os.environ["FM_RUNID"],
    "iterations": rows,
    "passed": sum(1 for r in rows if r["result"] == "PASS"),
    "failed": sum(1 for r in rows if r["result"] == "FAIL"),
    "skipped": sum(1 for r in rows if r["result"] == "SKIP"),
    "leftover_clean": None if keep else (os.environ["FM_LEFTOVER_OK"] == "1"),
    "procs_before": os.environ["FM_BPROCS"],
    "procs_after": os.environ["FM_APROCS"],
}
print(json.dumps(out, indent=2))
'
}

# ---- main ------------------------------------------------------------------
sweep_stale
BEFORE=$(ws_all)
BEFORE_PROCS=$(bench_proc_count)

if [ "$JSON" != 1 ]; then
  printf '== fm-bench run %s ==\n' "$RUNID"
  printf 'scenarios=[%s] workers=[%s] harness=[%s] matrix=%s real=%s keep=%s\n' \
    "$SCN_LIST" "$WORKERS_LIST" "$HARNESS_LIST" "$MATRIX" "$REAL" "$KEEP"
  printf 'baseline workspaces:\n'; printf '%s\n' "$BEFORE" | sed 's/^/  /'
fi

# shellcheck disable=SC2086
for hrn in $HARNESS_LIST; do
  # shellcheck disable=SC2086
  for scn in $SCN_LIST; do
    if [ "$scn" = concurrency ]; then
      # shellcheck disable=SC2086
      for wk in $WORKERS_LIST; do
        run_iteration "$scn" "$wk" "$hrn"
      done
    else
      run_iteration "$scn" "-" "$hrn"
    fi
  done
done

sleep 1
AFTER=$(ws_all)
AFTER_PROCS=$(bench_proc_count)

if [ "$KEEP" != 1 ]; then
  [ "$BEFORE" = "$AFTER" ] || LEFTOVER_OK=0
  [ "$AFTER_PROCS" = 0 ] || LEFTOVER_OK=0
  [ "$LEFTOVER_OK" = 1 ] || ANY_FAIL=1
fi

if [ "$JSON" = 1 ]; then
  emit_json
else
  emit_table
fi

exit "$ANY_FAIL"
