#!/usr/bin/env bash
# fm-demo.sh - one-command, self-cleaning LIVE demo of the firstmate
# fleet-observability + supervision fix.
#
# Spawns real disposable omp crewmate panes in a throwaway 'fm-demo' herdr
# workspace (NEVER 'ship' or your real projects), shows bin/fm-lineage.sh
# rendering them with a BOUND agent_status (working/done, not 'unknown' - the
# fix), shows the exact supervision wake the in-process extension would inject,
# then tears the whole thing down (panes + workspace + temp repo + temp state)
# so the system is left exactly as found. A trap runs cleanup on Ctrl-C/error.
#
# Usage:
#   bin/fm-demo.sh              spawn 2 omp panes, show lineage + wake, auto-clean
#   bin/fm-demo.sh --keep       skip teardown so you can poke at the live panes
#   bin/fm-demo.sh --no-spawn   dry run: build workspace/state, render, clean -
#                               no omp launch, no LLM cost (status reads unknown)
#   bin/fm-demo.sh --workers N  number of omp panes, 1 or 2 (default 2)
set -eu

WS_LABEL=fm-demo
SUPNAME=DemoCaptain
SUP_ROLE="Fleet observability demo supervisor"
KEEP=0
NO_SPAWN=0
WORKERS=2

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"
      exit 0 ;;
    --keep) KEEP=1 ;;
    --no-spawn) NO_SPAWN=1 ;;
    --workers)
      shift; WORKERS="${1:-}"
      case "$WORKERS" in 1|2) ;; *) echo "error: --workers must be 1 or 2" >&2; exit 2 ;; esac ;;
    --workers=*)
      WORKERS="${1#--workers=}"
      case "$WORKERS" in 1|2) ;; *) echo "error: --workers must be 1 or 2" >&2; exit 2 ;; esac ;;
    *) echo "error: unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

command -v herdr >/dev/null 2>&1 || { echo "error: herdr not found on PATH" >&2; exit 1; }
if [ "$NO_SPAWN" != 1 ]; then
  command -v omp >/dev/null 2>&1 || { echo "error: omp not found on PATH (use --no-spawn for a dry run)" >&2; exit 1; }
fi

say() { printf '\n== %s ==\n' "$1"; }

# ws_snapshot: sorted "<workspace_id>\t<label>" for every live workspace. Used to
# prove the before/after fleet is byte-identical (no leaked demo workspace).
ws_snapshot() {
  herdr workspace list 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ws = d.get("result", {}).get("workspaces", [])
for w in sorted(ws, key=lambda x: x.get("workspace_id", "")):
    print("%s\t%s" % (w.get("workspace_id", ""), w.get("label", "")))
' 2>/dev/null || true
}

# State this run created; the trap reads these globals to clean up only its own.
TMP=
REPO=
HOME_DIR=
WSID=
PANES=
CLEANED=0

cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  if [ "$KEEP" = 1 ]; then
    return 0
  fi
  # Close only the panes this run started.
  for p in $PANES; do
    [ -n "$p" ] && herdr pane close "$p" >/dev/null 2>&1 || true
  done
  # Close the demo workspace - but ONLY after re-asserting its label is fm-demo,
  # so a bad id can never close 'ship' or any real workspace.
  if [ -n "$WSID" ]; then
    lbl=$(herdr workspace get "$WSID" 2>/dev/null | herdr_json_get result workspace label)
    if [ "$lbl" = "$WS_LABEL" ]; then
      herdr workspace close "$WSID" >/dev/null 2>&1 || true
    elif [ -n "$lbl" ]; then
      printf 'WARN: not closing workspace %s - label is "%s", not "%s"\n' "$WSID" "$lbl" "$WS_LABEL" >&2
    fi
  fi
  [ -n "$TMP" ] && rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# wait_bound: block until every demo pane is actively WORKING (turn started, so
# its marker has printed and the status is the strong, bound proof) - accepting
# done/blocked as terminal turn states. omp reports a brief pre-turn 'idle', so
# plain non-unknown is too eager; we hold out for a real turn. Returns 1 on
# timeout, after which the caller renders whatever bound status it has anyway.
wait_bound() {
  local deadline p s allok
  deadline=$(( $(date +%s) + 45 ))
  while :; do
    allok=1
    for p in $PANES; do
      s=$(fm_herdr_agent_status "$p")
      case "$s" in working|done|blocked) ;; *) allok=0 ;; esac
    done
    [ "$allok" = 1 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 1
  done
}

# demo_wake <pane> <task> <worker>: render the captain wake digest a relevant
# status line would inject, via the SAME classifyAndDigest export the live
# supervision extension calls (pure, no I/O).
demo_wake() {
  local pane=$1 task=$2 worker=$3 ext="$FM_ROOT/.omp/extensions/fm-supervisor.ts"
  if ! command -v bun >/dev/null 2>&1 || [ ! -f "$ext" ]; then
    printf '[wake] %s %s %s - done: demo task complete (digest format; bun/extension unavailable)\n' \
      "$task" "$worker" "$pane"
    return 0
  fi
  FM_EXT="$ext" FM_PANE="$pane" FM_TASK="$task" FM_WORKER="$worker" \
    bun -e 'const m = await import(process.env.FM_EXT);
const e = { t: Date.now(), kind: "status", pane: process.env.FM_PANE, task: process.env.FM_TASK, worker: process.env.FM_WORKER, status_line: "done: demo task complete", relevant: true };
const r = m.classifyAndDigest([e]);
console.log(r.digests[0] || "(no wake)");' 2>/dev/null \
    || printf '[wake] %s %s %s - done: demo task complete (digest render failed)\n' "$task" "$worker" "$pane"
}

# --- resolve the herdr socket so launched omp panes find their integration ---
SOCK="${HERDR_SOCKET_PATH:-}"
if [ -z "$SOCK" ]; then
  SOCK=$(herdr session list --json 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for s in d.get("sessions", []):
    if s.get("default"):
        print(s.get("socket_path", "")); break
' 2>/dev/null || true)
fi

say "Before: live herdr workspaces"
BEFORE=$(ws_snapshot)
printf '%s\n' "$BEFORE"

# Warn (do not touch) if a prior crash left an fm-demo workspace behind.
if printf '%s\n' "$BEFORE" | grep -q "	$WS_LABEL$"; then
  printf 'WARN: a pre-existing "%s" workspace is present (likely a prior crashed run).\n' "$WS_LABEL" >&2
  printf '      This run will not touch it; close it manually if it is stale.\n' >&2
fi

# --- temp git repo + temp FM_HOME-style state dir (mktemp; never the real ones) ---
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
TMP="$(mktemp -d "$TMP_BASE/fm-demo.XXXXXX")"
REPO="$TMP/repo"
HOME_DIR="$TMP/home"
RUNTOKEN="${TMP##*.}"   # unique per run; scopes herdr agent slot names
mkdir -p "$REPO" "$HOME_DIR/state" "$HOME_DIR/config" "$HOME_DIR/data"
git init -q "$REPO"
( cd "$REPO" && git -c user.email=demo@fm-demo -c user.name=fm-demo commit -q --allow-empty -m "fm-demo seed" ) >/dev/null 2>&1 || true
{
  printf 'name=%s\n' "$SUPNAME"
  printf 'role=%s\n' "$SUP_ROLE"
  printf 'parent=captain\n'
} > "$HOME_DIR/config/identity"

# --- throwaway 'fm-demo' workspace ---
say "Creating throwaway '$WS_LABEL' workspace"
CJ=$(herdr workspace create --label "$WS_LABEL" --cwd "$REPO" --no-focus 2>&1) \
  || { echo "error: workspace create failed: $CJ" >&2; exit 1; }
WSID=$(printf '%s' "$CJ" | herdr_json_get result workspace workspace_id)
[ -n "$WSID" ] || { echo "error: workspace create returned no workspace_id" >&2; exit 1; }
printf 'workspace %s = %s\n' "$WS_LABEL" "$WSID"

# --- spawn N omp panes, each in its own tab (the fm-spawn herdr placement
#     pattern: tab create -> agent start with --env -> drop root shell -> pane
#     rename for the DISPLAY label). The human name lives only on the tab/pane
#     display label; a matching state meta lets fm-lineage join the pane.
#
#     herdr agent (slot) names are GLOBALLY unique per session, and a real 'omp'
#     crewmate in the captain's live session may already hold the name 'omp'. So
#     each demo pane registers under a unique demo-scoped slot (omp-demo-<run>-N)
#     - never the bare 'omp' - to avoid clobbering a real agent and to allow more
#     than one pane. The OMP->herdr INTEGRATION identity that agent_status binds
#     to is still 'omp' (the omp process self-reports it over HERDR_SOCKET_PATH),
#     which is what we record as agent_identity=omp. We NEVER 'herdr agent rename'
#     (that overwrites the identity and pins agent_status to unknown - the bug).
say "Spawning $WORKERS omp pane(s) in $WS_LABEL"
i=1
while [ "$i" -le "$WORKERS" ]; do
  TASK="demo-marker-$i"
  LABEL="demo/worker-$i"
  TJ=$(herdr tab create --workspace "$WSID" --label "$LABEL" --cwd "$REPO" --no-focus 2>&1) \
    || { echo "error: tab create failed: $TJ" >&2; exit 1; }
  TAB=$(printf '%s' "$TJ" | herdr_json_get result tab tab_id)
  ROOT=$(printf '%s' "$TJ" | herdr_json_get result root_pane pane_id)
  [ -n "$TAB" ] || { echo "error: tab create returned no tab_id" >&2; exit 1; }

  if [ "$NO_SPAWN" = 1 ]; then
    # Dry mechanics: no omp launch. The tab's plain root shell stands in; its
    # status will read 'unknown' (exactly the contrast the real spawn fixes).
    PANE="$ROOT"
  else
    SLOT="omp-demo-$RUNTOKEN-$i"   # globally-unique herdr slot; identity stays omp
    PROMPT="Run exactly these two shell commands then stop with no other action: 1) printf 'FM_DEMO_MARKER $TASK\\n'  2) sleep 20"
    SJ=$(herdr agent start "$SLOT" --tab "$TAB" --cwd "$REPO" --no-focus \
      --env "PATH=$PATH" --env "HERDR_SOCKET_PATH=$SOCK" --env "HOME=$HOME" \
      -- omp --auto-approve "$PROMPT" 2>&1) \
      || { echo "error: agent start failed: $SJ" >&2; exit 1; }
    PANE=$(printf '%s' "$SJ" | herdr_json_get result agent pane_id)
    [ -n "$PANE" ] || { echo "error: agent start returned no pane_id" >&2; exit 1; }
    # Drop the tab's leftover root shell so the tab holds only the agent.
    [ -n "$ROOT" ] && [ "$ROOT" != "$PANE" ] && herdr pane close "$ROOT" >/dev/null 2>&1 || true
  fi
  PANES="$PANES $PANE"

  # Display-only label. NEVER 'herdr agent rename': that overwrites the agent
  # identity and pins agent_status to unknown (the bug this demo proves fixed).
  herdr pane rename "$PANE" "$LABEL" >/dev/null 2>&1 || true

  {
    printf 'pane=%s\n' "$PANE"
    printf 'tab=%s\n' "$TAB"
    printf 'worktree=%s\n' "$REPO"
    printf 'project=%s\n' "$REPO"
    printf 'harness=omp\n'
    printf 'kind=ship\n'
    printf 'mode=pr\n'
    printf 'yolo=off\n'
    printf 'domain=%s\n' "$WS_LABEL"
    printf 'workspace=%s\n' "$WS_LABEL"
    printf 'worker=%s\n' "$LABEL"
    printf 'supervisor=%s\n' "$SUPNAME"
    printf 'supervisor_slug=demo\n'
    printf 'supervisor_role=%s\n' "$SUP_ROLE"
    printf 'supervisor_parent=captain\n'
    printf 'agent_identity=omp\n'
  } > "$HOME_DIR/state/$TASK.meta"
  printf 'task %s -> pane %s tab %s (label %s)\n' "$TASK" "$PANE" "$TAB" "$LABEL"
  i=$(( i + 1 ))
done

# --- wait for the omp integration to bind a live status, then the money shot ---
if [ "$NO_SPAWN" != 1 ]; then
  printf 'waiting for omp status to bind...\n'
  if wait_bound; then printf 'status bound.\n'; else printf 'WARN: status did not bind before timeout; rendering anyway.\n' >&2; fi
fi

say "LIVE lineage tree (bin/fm-lineage.sh)"
"$FM_ROOT/bin/fm-lineage.sh" --home "$HOME_DIR" || true

# --- prove the agents really ran (marker in pane scrollback) ---
if [ "$NO_SPAWN" != 1 ]; then
  say "Pane scrollback proof (FM_DEMO_MARKER)"
  # omp flips to 'working' the instant its turn starts, a beat before the printf
  # tool actually runs, so poll each pane briefly for the real output line.
  mdeadline=$(( $(date +%s) + 15 ))
  for p in $PANES; do
    line=
    while :; do
      # Strip box-border chars (U+2502; printf emits its bytes since BSD tr does
      # not read \ooo escapes) and surrounding whitespace, then take a line that
      # is EXACTLY the marker output. The echoed prompt and the `$ printf ...`
      # command line carry extra text, so the anchored form isolates real output.
      line=$(herdr pane read "$p" 2>/dev/null | tr -d "$(printf '\342\224\202')" \
        | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
        | grep -E '^FM_DEMO_MARKER [a-z0-9-]+$' | tail -1 || true)
      [ -n "$line" ] && break
      [ "$(date +%s)" -ge "$mdeadline" ] && break
      sleep 1
    done
    printf '%s: %s\n' "$p" "${line:-<marker pending>}"
  done
fi

# --- supervision signal: the exact captain wake a relevant status injects ---
say "Supervision signal (wake digest the extension would inject)"
FIRST_PANE=$(printf '%s' "$PANES" | awk '{print $1}')
DEMO_STATUS="done: demo task complete"
printf '%s\n' "$DEMO_STATUS" > "$HOME_DIR/state/demo-marker-1.status"
printf 'A crewmate writes to state/demo-marker-1.status:  %s\n' "$DEMO_STATUS"
printf 'The in-process supervisor (fs.watch on state/<id>.status) feeds it to\n'
printf 'classifyAndDigest() and injects ONE captain wake:\n\n'
demo_wake "${FIRST_PANE:-w?:p?}" "demo-marker-1" "demo/worker-1"

# --- explainer ---
say "What you just saw"
cat <<EXPLAIN
- A throwaway '$WS_LABEL' herdr workspace held $WORKERS real omp agent pane(s):
  each registers under a unique herdr slot (omp-demo-<run>-N) so it never
  clobbers a real 'omp' crewmate, but the OMP->herdr integration identity that
  agent_status binds to stays 'omp' (recorded as agent_identity=omp). The human
  name (demo/worker-N) lives ONLY on the tab/pane DISPLAY labels.
- fm-lineage.sh joined firstmate state metas to the LIVE herdr pane/tab/workspace
  and reported agent_status bound to those panes - working/done, NOT 'unknown'.
  That binding IS the fix: status binds to the omp integration identity, and human
  names never go through 'herdr agent rename' (which would pin status to unknown).
- The wake digest above comes from the SAME classifyAndDigest export the live
  in-process supervision extension calls; a matching state/<id>.status line is
  exactly what makes it inject that one-line captain wake.
EXPLAIN
if [ "$NO_SPAWN" = 1 ]; then
  printf '(--no-spawn: no omp was launched, so status reads unknown above - the\n contrast the real spawn fixes. Run without --no-spawn for the live status.)\n'
fi

say "Re-run"
cat <<'RERUN'
  bin/fm-demo.sh             # full live demo, auto-clean
  bin/fm-demo.sh --keep      # leave it running to inspect (prints ids + cleanup)
  bin/fm-demo.sh --no-spawn  # dry mechanics + teardown, no omp launch
RERUN

# --- teardown (or keep) ---
if [ "$KEEP" = 1 ]; then
  say "Kept (no teardown)"
  printf 'workspace %s = %s\n' "$WS_LABEL" "$WSID"
  printf 'panes:%s\n' "$PANES"
  printf 'temp repo: %s\n' "$REPO"
  printf 'temp home: %s\n' "$HOME_DIR"
  printf '\nClean up manually (verify the label first):\n'
  printf '  herdr workspace close %s\n' "$WSID"
  printf '  rm -rf %s\n' "$TMP"
  exit 0
fi

say "Tearing down (panes + workspace + temp repo + temp state)"
cleanup
AFTER=$(ws_snapshot)

say "After: live herdr workspaces"
printf '%s\n' "$AFTER"

say "Result"
if [ "$BEFORE" = "$AFTER" ]; then
  printf 'PASS: workspace list identical before and after (zero leftover).\n'
else
  printf 'FAIL: workspace list changed - leftover detected!\n'
  printf -- '--- before ---\n%s\n--- after ---\n%s\n' "$BEFORE" "$AFTER"
  exit 1
fi
