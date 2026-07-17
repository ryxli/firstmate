#!/usr/bin/env python3
"""crew-metrics: PASSIVE harness side-effect metrics on the REAL crew.

The opposite of a synthetic benchmark: it spends ZERO tokens and runs NO agents.
It only harvests signals the harness already produces as a byproduct of operating -
signals no agent sees or optimizes for, so they cannot be gamed:

  - cost / output-tokens / requests / avg-duration / cache / error   (omp stats byFolder)
  - per-task attribution                                              (state/<id>.meta worktree -> folder)
  - supervisor attention: wakes (cap-relevant status) vs suppressed (state/.status-internal.log)
  - cycle time: estimated-vs-actual per task                         (state/timeline.log)
  - outcomes: landed / in-flight / queued                            (data/backlog.md)

This closes the three gaps fm-kpi.sh names "not faked" (exact per-task cost, escalation
signal, cycle time) and fixes fm-kpi's silent $0: omp stats byFolder now has hundreds of
folders and a PIPE capture truncates at 64KB -> JSON parse fails -> empty. We capture to a
FILE instead.

Usage: crew-metrics.py [--json] [--state <dir>] [--home <fm-home>] [--backlog <file>]
Honest caveats are emitted, never hidden (see "gaps").
"""
import argparse, glob, json, os, re, statistics, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm_paths

ESC_RE = re.compile(r"done:|blocked:|failed:|needs-decision:|PR ready|checks green|ready in branch|merged")
EPHEMERAL = ("actbench", "fm-bench", "fm-demo", "fmplain")


def omp_stats(omp="omp"):
    """omp stats --json, captured to a FILE (byFolder is unbounded; a pipe truncates at 64KB)."""
    fd, path = tempfile.mkstemp(suffix=".ompstats.json")
    try:
        with os.fdopen(fd, "w") as fh:
            subprocess.run([omp, "stats", "--json"], stdout=fh, stderr=subprocess.DEVNULL, timeout=300, stdin=subprocess.DEVNULL)
        raw = open(path).read()
    finally:
        os.remove(path)
    return json.loads(raw[raw.index("{"):]) if "{" in raw else {}


def folder_of(path, user):
    p = path[len(user):] if user and path.startswith(user) else path
    return p.replace("/", "-")


def classify(folder, home_folder):
    if folder == home_folder:
        return "supervisor"
    if "-fm-sm-" in folder:
        return "secondmate"
    if folder.startswith("-tmp-") or any(t in folder for t in EPHEMERAL):
        return "ephemeral"
    if "-worktrees-" in folder:
        return "crew"
    return "other"


def count_lines(path, pred):
    if not os.path.exists(path):
        return 0
    return sum(1 for l in open(path).read().splitlines() if pred(l))


def collect(state, home, backlog, user, omp="omp"):
    data = omp_stats(omp)
    folders = data.get("byFolder", []) or []
    fmap = {f.get("folder", ""): f for f in folders}
    home_folder = folder_of(home, user)

    # suppressed events (supervisor saw, did NOT wake the cap), per task
    supp = {}
    il = os.path.join(state, ".status-internal.log")
    if os.path.exists(il):
        for l in open(il).read().splitlines():
            m = re.match(r"\[.*?\]\s+(\S+?)\.status:", l)
            if m:
                supp[m.group(1)] = supp.get(m.group(1), 0) + 1

    tasks = []
    for meta in sorted(glob.glob(os.path.join(state, "*.meta"))):
        tid = os.path.basename(meta)[:-5]
        d = dict(l.split("=", 1) for l in open(meta).read().splitlines() if "=" in l)
        f = fmap.get(folder_of(d.get("worktree", ""), user), {})
        sp = os.path.join(state, f"{tid}.status")
        tasks.append({
            "task": tid, "worker": d.get("worker", tid), "supervisor": d.get("supervisor", "?"),
            "model": d.get("model", "?"), "kind": d.get("kind", "?"), "mode": d.get("mode", "?"),
            "cost_usd": round(f.get("totalCost", 0) or 0, 2), "out_tokens": f.get("totalOutputTokens", 0) or 0,
            "requests": f.get("totalRequests", 0) or 0, "avg_duration_s": round((f.get("avgDuration", 0) or 0) / 1000, 1),
            "error_rate": round(f.get("errorRate", 0) or 0, 3), "cache_rate": round(f.get("cacheRate", 0) or 0, 3),
            "wakes": count_lines(sp, lambda l: bool(ESC_RE.search(l))),
            "status_lines": count_lines(sp, lambda l: bool(l.strip())),
            "suppressed": supp.get(tid, 0),
            "joined_stats": bool(f),
        })

    # role rollup over ALL folders (lifetime)
    roll = {}
    for f in folders:
        c = classify(f.get("folder", ""), home_folder)
        r = roll.setdefault(c, {"cost_usd": 0.0, "out_tokens": 0, "requests": 0})
        r["cost_usd"] += f.get("totalCost", 0) or 0
        r["out_tokens"] += f.get("totalOutputTokens", 0) or 0
        r["requests"] += f.get("totalRequests", 0) or 0
    for r in roll.values():
        r["cost_usd"] = round(r["cost_usd"], 2)

    productive = round(sum(roll.get(k, {}).get("cost_usd", 0) for k in ("supervisor", "secondmate", "crew")), 2)
    supervisor = roll.get("supervisor", {}).get("cost_usd", 0)
    ephemeral = roll.get("ephemeral", {}).get("cost_usd", 0)
    total_spend = round(sum(r["cost_usd"] for r in roll.values()), 2)

    # cycle time from timeline.log (actual minutes)
    cyc = []
    tl = os.path.join(state, "timeline.log")
    if os.path.exists(tl):
        for l in open(tl).read().splitlines():
            parts = l.split(None, 2)
            if len(parts) >= 3:
                m = re.search(r"actual=~?(\d+)\s*min", parts[2])
                if m:
                    cyc.append(int(m.group(1)))

    # outcomes from backlog
    landed = inflight = queued = 0
    section = None
    if os.path.exists(backlog):
        for line in open(backlog):
            low = line.strip().lower()
            if low.startswith("## in flight"): section = "f"; continue
            if low.startswith("## queued"): section = "q"; continue
            if low.startswith("## done"): section = "d"; continue
            if low.startswith("##"): section = None; continue
            if line.strip().startswith("- "):
                inflight += section == "f"; queued += section == "q"; landed += section == "d"

    wakes = sum(t["wakes"] for t in tasks)
    suppressed = sum(t["suppressed"] for t in tasks)
    return {
        "schema": "crew-metrics/1", "source": "omp stats byFolder + state/{meta,status,.status-internal.log,timeline.log} + backlog",
        "cost": {"productive_usd": productive, "supervisor_overhead_pct": round(100 * supervisor / productive, 1) if productive else None,
                 "ephemeral_tests_usd": ephemeral, "ephemeral_share_of_all_pct": round(100 * ephemeral / total_spend, 1) if total_spend else None,
                 "total_spend_usd": total_spend, "by_role": roll},
        "supervision": {"wakes": wakes, "suppressed": suppressed,
                        "escalation_rate_pct": round(100 * wakes / (wakes + suppressed), 1) if (wakes + suppressed) else None},
        "cycle_time_min": {"n": len(cyc), "median": statistics.median(cyc) if cyc else None,
                           "min": min(cyc) if cyc else None, "max": max(cyc) if cyc else None},
        "outcomes": {"landed": landed, "in_flight": inflight, "queued": queued},
        "tasks": sorted(tasks, key=lambda x: -x["cost_usd"]),
        "gaps": [
            "wakes are counted from the cumulative <id>.status file, so long-lived agents (supervisor/secondmate) over-count vs short crew tasks; window by task epoch for precision.",
            "escalation_rate needs a NECESSITY label per wake for true precision/recall; this is the raw reached-cap fraction, and .status-internal.log is new so 'suppressed' is still sparse.",
            "cycle_time depends on timeline.log entries, which only exist for tasks that logged an actual; coverage grows as more tasks close.",
        ],
    }


def render(k):
    L = [f"crew-metrics (passive; zero-cost)   source: {k['source']}", ""]
    c = k["cost"]
    L += ["COST (omp stats lifetime; productive = supervisor+secondmate+crew, tests excluded)",
          f"  productive          ${c['productive_usd']:.2f}",
          f"  supervisor overhead {c['supervisor_overhead_pct']}% of productive" if c["supervisor_overhead_pct"] is not None else "  supervisor overhead n/a",
          f"  tests (ephemeral)   ${c['ephemeral_tests_usd']:.2f}  ({c['ephemeral_share_of_all_pct']}% of ALL spend ${c['total_spend_usd']:.2f})",
          "  by role             " + ", ".join(f"{r} ${v['cost_usd']:.2f}" for r, v in sorted(c["by_role"].items(), key=lambda x: -x[1]["cost_usd"]) if v["cost_usd"]),
          ""]
    s = k["supervision"]
    L += ["SUPERVISION (harness side-effect: what the crew needed from the supervisor)",
          f"  wakes {s['wakes']} vs suppressed {s['suppressed']}  ->  escalation rate {s['escalation_rate_pct']}% reached cap", ""]
    ct = k["cycle_time_min"]
    L += ["CYCLE TIME (timeline.log actuals)",
          f"  n={ct['n']}  median {ct['median']}min  range {ct['min']}-{ct['max']}min" if ct["n"] else "  n=0 (no closed-task actuals logged yet)", ""]
    o = k["outcomes"]
    L += [f"OUTCOMES  landed {o['landed']} / in-flight {o['in_flight']} / queued {o['queued']}", "",
          "PER-TASK", f"  {'task':16}{'sup':8}{'cost':>7}{'out_tok':>9}{'req':>5}{'avgS':>6}{'wake':>5}{'supp':>5}"]
    for t in k["tasks"]:
        L.append(f"  {t['task'][:15]:16}{t['supervisor'][:7]:8}{('$'+str(t['cost_usd'])):>7}{t['out_tokens']:>9}{t['requests']:>5}{t['avg_duration_s']:>6}{t['wakes']:>5}{t['suppressed']:>5}")
    L += ["", "GAPS (not faked): " + " | ".join(k["gaps"])]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=str(fm_paths.fm_home()))
    ap.add_argument("--state", default=None)
    ap.add_argument("--backlog", default=None)
    ap.add_argument("--user", default=os.path.expanduser("~"))
    ap.add_argument("--omp", default="omp")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    state = a.state or os.path.join(a.home, "state")
    backlog = a.backlog or os.path.join(a.home, "data", "backlog.md")
    k = collect(state, a.home, backlog, a.user, a.omp)
    print(json.dumps(k, indent=2) if a.json else render(k))


if __name__ == "__main__":
    main()
