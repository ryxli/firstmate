#!/usr/bin/env bash
# fm-kpi.sh - firstmate workflow KPIs from one source of truth.
#
# Schema-first dual surface (mirrors fm-lineage.sh -> fm-fleet-view.sh):
#   --json     machine surface: the canonical KPI object agents call for any metric
#   (default)  human surface: a terse terminal table rendered from the same object
#   --snapshot append the current KPI line to data/kpi-history.jsonl (the trend log)
#   --history  summarize the trend from that log
#
# Sources (extend, never fork): `omp stats --json` byFolder for cost/tokens/cache,
# data/backlog.md for landed/in-flight/queued outcomes. Folders are classified by
# ROLE (supervisor / secondmate / crew / ephemeral / other) so productive metrics
# are not polluted by fm-demo/fm-bench self-test scaffolds. Every record is tagged
# with a `workspace` (config/workspace or hostname) so a second machine's numbers
# aggregate without overfitting one laptop. KPIs that need instrumentation we do not
# have yet (exact per-task cost, live escalation precision/recall, cycle time) are
# emitted under "gaps" rather than faked. See data/kpi-analysis.md for the rationale.
#
# Usage: fm-kpi.sh [--json|--snapshot|--history] [--stats-file <f>] [--home <h>]
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-root-lib.sh
. "$SCRIPT_DIR/fm-root-lib.sh"
fm_init_roots "${BASH_SOURCE[0]}"

MODE=text
STATS_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) MODE=json; shift ;;
    --snapshot) MODE=snapshot; shift ;;
    --history) MODE=history; shift ;;
    --stats-file) STATS_FILE="${2:-}"; [ -n "$STATS_FILE" ] || { echo "fm-kpi: --stats-file needs a path" >&2; exit 2; }; shift 2 ;;
    --home) FM_HOME="${2:-}"; [ -n "$FM_HOME" ] || { echo "fm-kpi: --home needs a path" >&2; exit 2; }; DATA="$FM_HOME/data"; CONFIG="$FM_HOME/config"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "fm-kpi: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

WORKSPACE="$(cat "$CONFIG/workspace" 2>/dev/null || true)"
[ -n "$WORKSPACE" ] || WORKSPACE="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"
GENERATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WORKTREE_BASE="${FM_WORKTREE_BASE:-$FM_HOME/worktrees}"
HISTORY="$DATA/kpi-history.jsonl"
BACKLOG="$DATA/backlog.md"
# Secondmate home paths (semicolon-joined) so their folders classify as secondmate.
SM_HOMES="$(sed -n 's/.*home:[[:space:]]*\([^;)]*\).*/\1/p' "$DATA/secondmates.md" 2>/dev/null | tr '\n' ';' || true)"

if [ "$MODE" = history ]; then
  HISTFILE="$HISTORY" python3 -c '
import os, sys, json, signal
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
path = os.environ["HISTFILE"]
rows = []
try:
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try: rows.append(json.loads(line))
                except ValueError: pass
except FileNotFoundError:
    print("fm-kpi: no history yet at %s (run --snapshot first)" % path); sys.exit(0)
if not rows:
    print("fm-kpi: history empty"); sys.exit(0)
print("KPI trend (%d snapshots, workspace-tagged)" % len(rows))
print("%-20s %-10s %10s %9s %8s %7s %7s" % ("when(UTC)","workspace","cost$","cache","overhd","landed","cpl$"))
for r in rows[-20:]:
    print("%-20s %-10s %10.2f %8.1f%% %7.1f%% %7s %7s" % (
        (r.get("generated","")[:19]), (r.get("workspace","")[:10]),
        r.get("cost_usd_productive",0.0), 100*r.get("cache_hit_rate",0.0),
        100*r.get("supervisor_overhead_cost",0.0), r.get("tasks_landed",0),
        ("%.2f"%r["cost_per_landed_usd"]) if r.get("cost_per_landed_usd") is not None else "n/a"))
'
  exit 0
fi

get_stats() {
  if [ -n "$STATS_FILE" ]; then
    sed -n '/^{/,$p' "$STATS_FILE"
  else
    omp stats --json 2>/dev/null | sed -n '/^{/,$p'
  fi
}

get_stats | MODE="$MODE" FM_HOME="$FM_HOME" HOMEDIR="$HOME" WTBASE="$WORKTREE_BASE" \
  SM_HOMES="$SM_HOMES" BACKLOG="$BACKLOG" WORKSPACE="$WORKSPACE" GENERATED="$GENERATED" \
  HISTORY="$HISTORY" python3 -c '
import os, sys, json

mode = os.environ["MODE"]
fm_home = os.environ["FM_HOME"]
homedir = os.environ["HOMEDIR"]
wtbase = os.environ["WTBASE"]
sm_homes = [h for h in os.environ.get("SM_HOMES","").split(";") if h]
backlog = os.environ["BACKLOG"]
workspace = os.environ["WORKSPACE"]
generated = os.environ["GENERATED"]
history = os.environ["HISTORY"]

raw = sys.stdin.read().strip()
try:
    stats = json.loads(raw) if raw else {}
except ValueError:
    stats = {}

def folder_of(path):
    p = path
    if homedir and p.startswith(homedir):
        p = p[len(homedir):]
    return p.replace("/", "-")

home_folder = folder_of(fm_home)
wt_folder = folder_of(wtbase)
sm_folders = set(folder_of(h) for h in sm_homes)

def classify(folder):
    if folder == home_folder: return "supervisor"
    if folder in sm_folders or "-fm-sm-" in folder: return "secondmate"
    if any(t in folder for t in ("fm-demo", "fm-bench", "fmplain")): return "ephemeral"
    if wt_folder and wt_folder in folder: return "crew"
    return "other"

by_folder = []
for f in stats.get("byFolder", []) or []:
    folder = f.get("folder", "")
    intok = f.get("totalInputTokens", 0) or 0
    outok = f.get("totalOutputTokens", 0) or 0
    by_folder.append({
        "folder": folder,
        "role": classify(folder),
        "cost_usd": round(f.get("totalCost", 0.0) or 0.0, 4),
        "tokens": intok + outok,
        "cache_hit_rate": round(f.get("cacheRate", 0.0) or 0.0, 4),
        "error_rate": round(f.get("errorRate", 0.0) or 0.0, 4),
        "requests": f.get("totalRequests", 0) or 0,
    })

PRODUCTIVE = ("supervisor", "secondmate", "crew")
def agg(roles):
    cost = sum(x["cost_usd"] for x in by_folder if x["role"] in roles)
    tok = sum(x["tokens"] for x in by_folder if x["role"] in roles)
    req = sum(x["requests"] for x in by_folder if x["role"] in roles)
    cread = sum((f.get("totalCacheReadTokens",0) or 0) for f in stats.get("byFolder",[]) if classify(f.get("folder","")) in roles)
    cwrite = sum((f.get("totalCacheWriteTokens",0) or 0) for f in stats.get("byFolder",[]) if classify(f.get("folder","")) in roles)
    intok = sum((f.get("totalInputTokens",0) or 0) for f in stats.get("byFolder",[]) if classify(f.get("folder","")) in roles)
    fail = sum((f.get("failedRequests",0) or 0) for f in stats.get("byFolder",[]) if classify(f.get("folder","")) in roles)
    denom = intok + cread + cwrite
    return {
        "cost_usd": round(cost, 4), "tokens": tok, "requests": req,
        "cache_hit_rate": round(cread/denom, 4) if denom else 0.0,
        "error_rate": round(fail/req, 4) if req else 0.0,
    }

prod = agg(PRODUCTIVE)
sup = agg(("supervisor",))
cost_share = round(sup["cost_usd"]/prod["cost_usd"], 4) if prod["cost_usd"] else None
tok_share = round(sup["tokens"]/prod["tokens"], 4) if prod["tokens"] else None

# Outcomes from backlog: count item lines per section.
landed = inflight = queued = 0
section = None
try:
    with open(backlog) as fh:
        for line in fh:
            s = line.strip()
            low = s.lower()
            if low.startswith("## in flight"): section = "f"; continue
            if low.startswith("## queued"): section = "q"; continue
            if low.startswith("## done"): section = "d"; continue
            if low.startswith("##"): section = None; continue
            if s.startswith("- ") or s.startswith("- ["):
                if section == "f": inflight += 1
                elif section == "q": queued += 1
                elif section == "d": landed += 1
except FileNotFoundError:
    pass

cpl = round(prod["cost_usd"]/landed, 4) if landed else None
tpl = round(prod["tokens"]/landed) if landed else None

kpi = {
    "schema": "fm-kpi/1",
    "workspace": workspace,
    "generated": generated,
    "source": "omp stats --json + backlog",
    "window": "cumulative (omp stats lifetime)",
    "cost_usd_productive": prod["cost_usd"],
    "tokens_productive": prod["tokens"],
    "cache_hit_rate": prod["cache_hit_rate"],
    "error_rate": prod["error_rate"],
    "supervisor_overhead_cost": cost_share,
    "supervisor_overhead_tokens": tok_share,
    "tasks_landed": landed,
    "tasks_in_flight": inflight,
    "tasks_queued": queued,
    "cost_per_landed_usd": cpl,
    "tokens_per_landed": tpl,
    "by_role": {r: agg((r,))["cost_usd"] for r in ("supervisor","secondmate","crew","ephemeral","other")},
    "by_folder": by_folder,
    "by_agent_type": [
        {"agent_type": a.get("agentType",""), "cost_usd": round(a.get("totalCost",0.0) or 0.0,4),
         "tokens": (a.get("totalInputTokens",0) or 0)+(a.get("totalOutputTokens",0) or 0)}
        for a in (stats.get("byAgentType",[]) or [])
    ],
    "gaps": [
        "exact per-task cost (needs task->folder->landed join)",
        "live escalation precision/recall (needs an escalation log; available in benchmarks/ today)",
        "cycle time + autonomous task horizon (needs dispatch/landed timestamps)",
    ],
}

def pct(x):
    return "n/a" if x is None else ("%.1f%%" % (100*x))

def render_text():
    out = []
    out.append("firstmate KPIs   workspace=%s   %s" % (workspace, generated))
    out.append("source: omp stats --json (cumulative) + backlog; productive = supervisor+secondmate+crew (ephemeral test scaffolds excluded)")
    out.append("")
    out.append("EFFICIENCY")
    out.append("  productive cost        $%.2f" % kpi["cost_usd_productive"])
    out.append("  productive tokens      %s" % "{:,}".format(kpi["tokens_productive"]))
    out.append("  cache hit rate         %s" % pct(kpi["cache_hit_rate"]))
    out.append("  error rate             %s" % pct(kpi["error_rate"]))
    out.append("  supervisor overhead    %s of productive cost" % pct(kpi["supervisor_overhead_cost"]))
    out.append("  cost by role           " + ", ".join("%s $%.2f" % (r, c) for r, c in kpi["by_role"].items() if c))
    out.append("")
    out.append("OUTCOMES (backlog)")
    out.append("  landed / in-flight / queued    %d / %d / %d" % (kpi["tasks_landed"], kpi["tasks_in_flight"], kpi["tasks_queued"]))
    out.append("")
    out.append("NORTH STAR (coarse: cumulative cost / landed; exact per-task is a named gap)")
    out.append("  cost per landed task   %s" % ("$%.2f" % kpi["cost_per_landed_usd"] if kpi["cost_per_landed_usd"] is not None else "n/a (0 landed)"))
    out.append("  tokens per landed task %s" % ("{:,}".format(kpi["tokens_per_landed"]) if kpi["tokens_per_landed"] is not None else "n/a"))
    out.append("")
    out.append("GAPS (not faked): " + "; ".join(kpi["gaps"]))
    return "\n".join(out)

if mode == "json":
    print(json.dumps(kpi, indent=2))
elif mode == "snapshot":
    rec = {k: kpi[k] for k in ("schema","workspace","generated","cost_usd_productive","tokens_productive",
            "cache_hit_rate","error_rate","supervisor_overhead_cost","tasks_landed","tasks_in_flight",
            "tasks_queued","cost_per_landed_usd")}
    os.makedirs(os.path.dirname(history), exist_ok=True)
    with open(history, "a") as fh:
        fh.write(json.dumps(rec) + "\n")
    print("fm-kpi: snapshot appended to %s" % history)
    print(render_text())
else:
    print(render_text())
'
