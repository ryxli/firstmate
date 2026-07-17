#!/usr/bin/env python3
"""
fm-eval-run.py - one-click firstmate deterministic-substrate benchmark runner.

Purpose: given one or more target commits (a cherry-pick, a feature group, or
origin/herdr HEAD), run the deterministic eval substrate in ISOLATED reproducible
checkouts, emit a structured JSON+md artifact per candidate, and delta each
against a baseline. Built for the cherry-pick workflow: test each addition /
group individually and in parallel.

Read-only w.r.t. the system under test; no firstmate-home pollution (gates run
against detached per-slot checkouts and self-clean to temp homes). Artifacts land
in the --out dir only.

Substrate (deterministic, CI-exact):
  - supervision bench     bun benchmarks/run.ts replay   (per-scenario
                          interface_tokens / false_wakes / missed_relevant + verdict; stdout JSON)
  - behavior suite        tests/*.test.sh     (files, assertions, failures)
  - shellcheck            sbin/*.sh tests/*.sh
  - repo invariants       CLAUDE.md symlink, .claude/skills symlink, no tracked fleet paths
  - thinking-efficiency   benchmarks/thinking committed replay demo, when present (ADOPT/REJECT + deltas)

Usage:
  fm-eval-run.py [TARGET ...] [options]
    TARGET            one or more SHAs or refs (default: origin/herdr).
                      Multiple targets run in parallel, each in its own checkout.
  --ref REF           add a target ref (repeatable); same as a positional TARGET.
  --label NAME        label for a single run (default: derived from SHA/subject).
  --labels A,B,..     per-target labels, comma-separated, aligned to TARGET order.
  --jobs N            candidate-level parallelism (default: min(#targets, 4)).
  --suite-jobs N      behavior-suite test-level parallelism inside each run
                      (default: 6; use 1 for CI-exact serial).
  --vs FILE           baseline JSON to delta against (default: the pinned baseline).
  --no-vs             skip the baseline delta.
  --out DIR           output dir (default: data/eval-runner/results).
  --keep-tmp          keep transient tool outputs in the checkout (default: cleaned).
  --json-only         print only the machine summary line.

Exit 0 if all candidates ran; non-zero if any candidate errored.
"""
import argparse, concurrent.futures as cf, glob, json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm_paths

HOME = str(fm_paths.fm_home())  # operational home for data/eval-runner/{results,baseline.json}; FM_HOME overrides
FIRSTMATE_REPO = os.environ.get("FM_EVAL_REPO", str(fm_paths.code_root()))
CHECKOUT_BASE = os.environ.get("FM_EVAL_CHECKOUT_BASE", str(fm_paths.code_root().parent / "fm-eval-checkout"))
DEFAULT_OUT = os.path.join(HOME, "data", "eval-runner", "results")
DEFAULT_BASELINE = os.path.join(HOME, "data", "eval-runner", "results", "baseline.json")

def sh(args, cwd=None, timeout=600, env=None):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                       env=env, stdin=subprocess.DEVNULL)
    return r.returncode, r.stdout, r.stderr

def git(args, cwd, timeout=300):
    return sh(["git", *args], cwd=cwd, timeout=timeout)

def origin_url():
    rc, out, _ = git(["remote", "get-url", "origin"], FIRSTMATE_REPO)
    return out.strip() if rc == 0 else None

def resolve_targets(args):
    """Return list of (raw, sha). Fetch origin once so refs resolve."""
    git(["fetch", "origin", "--quiet"], FIRSTMATE_REPO)
    raws = list(args.targets) + list(args.ref or [])
    if not raws:
        raws = ["origin/herdr"]
    out = []
    for raw in raws:
        rc, o, e = git(["rev-parse", raw], FIRSTMATE_REPO)
        if rc != 0:
            raise SystemExit(f"cannot resolve target '{raw}': {e.strip()}")
        out.append((raw, o.strip()))
    return out

def prepare_checkout(slot, sha):
    """Reusable per-slot checkout, reset clean and detached at sha. Fast after first clone."""
    path = f"{CHECKOUT_BASE}-{slot}"
    url = origin_url()
    if not os.path.isdir(os.path.join(path, ".git")):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        rc, o, e = sh(["git", "clone", "--quiet", FIRSTMATE_REPO, path], timeout=600)
        if rc != 0:
            raise RuntimeError(f"clone failed for slot {slot}: {e}")
        if url:
            git(["remote", "set-url", "origin", url], path)
    # fetch the authoritative origin; tolerate offline by falling back to local repo
    rc, _, _ = git(["fetch", "origin", "--quiet"], path)
    if rc != 0:
        git(["fetch", FIRSTMATE_REPO, "--quiet", "+refs/heads/*:refs/remotes/localfm/*"], path)
    git(["reset", "--hard", "--quiet"], path)
    git(["clean", "-fdq"], path)
    rc, o, e = git(["checkout", "--quiet", "--detach", sha], path)
    if rc != 0:
        # try fetching the specific object from the local canonical repo, then retry
        git(["fetch", FIRSTMATE_REPO, "--quiet", sha], path)
        rc, o, e = git(["checkout", "--quiet", "--detach", sha], path)
        if rc != 0:
            raise RuntimeError(f"checkout {sha[:12]} failed in slot {slot}: {e}")
    rc, head, _ = git(["rev-parse", "HEAD"], path)
    assert head.strip() == sha, f"checkout HEAD {head.strip()} != {sha}"
    return path

# ---- gates ----------------------------------------------------------------
def gate_supervision(co):
    # Current substrate: supervision replay is bun benchmarks/run.ts (via sbin/fm-bench.sh),
    # emitting the report as stdout JSON and writing no artifacts.
    t = time.time()
    rc, out, err = sh(["bun", "benchmarks/run.ts", "replay"], cwd=co, timeout=300)
    secs = round(time.time() - t, 1)
    if rc != 0:
        return {"present": True, "ok": False, "error": (out + err)[-400:], "secs": secs}
    try:
        data = json.loads(out)
    except Exception:
        return {"present": True, "ok": False, "error": "unparseable replay JSON: " + (out + err)[-300:], "secs": secs}
    scen = []
    for s in data.get("scenarios", []):
        scen.append({"scenario": s["scenario"], "feature": s.get("feature", ""),
                     "old_tokens": s["old"]["interface_tokens"], "new_tokens": s["new"]["interface_tokens"],
                     "old_false": s["old"]["false_wakes"], "new_false": s["new"]["false_wakes"],
                     "old_missed": s["old"]["missed_relevant"], "new_missed": s["new"]["missed_relevant"]})
    to, tn = data["totals"]["old"], data["totals"]["new"]
    tot = {"old_tokens": to["interface_tokens"], "new_tokens": tn["interface_tokens"],
           "old_false": to["false_wakes"], "new_false": tn["false_wakes"],
           "old_missed": to["missed_relevant"], "new_missed": tn["missed_relevant"]}
    red = round((tot["old_tokens"] - tot["new_tokens"]) / tot["old_tokens"] * 100, 1) if tot["old_tokens"] else 0
    return {"present": True, "ok": True, "secs": secs, "tokenizer": data.get("tokenizer"),
            "verdict": data.get("verdict", "?"), "reduction_pct": red, "totals": tot, "scenarios": scen}

def gate_shellcheck(co):
    files = sorted(glob.glob(os.path.join(co, "sbin", "*.sh"))) + sorted(glob.glob(os.path.join(co, "tests", "*.sh")))
    if not files:
        return {"present": False}
    t = time.time()
    rc, out, err = sh(["shellcheck", *files], cwd=co, timeout=180)
    return {"present": True, "ok": rc == 0, "files": len(files), "secs": round(time.time() - t, 1),
            "findings": "" if rc == 0 else (out + err)[-800:]}

def gate_invariants(co):
    def rl(p):
        try:
            return os.readlink(os.path.join(co, p))
        except OSError:
            return None
    cl, sk = rl("CLAUDE.md"), rl(".claude/skills")
    rc, tr, _ = git(["ls-files", "--", "data", "state", "config", "projects"], co)
    ok = (cl == "AGENTS.md") and (sk == "../.agents/skills") and (not tr.strip())
    return {"present": True, "ok": ok, "claude_md": cl, "claude_skills": sk,
            "tracked_private": tr.strip() or "none"}

def _run_one_test(path, cwd, timeout=250):
    t = time.time()
    rc, out, err = sh([path], cwd=cwd, timeout=timeout)
    asserts = len(re.findall(r'(?mi)^\s*(?:ok|pass)\b', out))
    return os.path.basename(path), rc, asserts, round(time.time() - t, 1)

def gate_behavior(co, jobs):
    tests = sorted(glob.glob(os.path.join(co, "tests", "*.test.sh")))
    if not tests:
        return {"present": False}
    t = time.time()
    per = {}
    if jobs <= 1:
        for tp in tests:
            n, rc, a, s = _run_one_test(tp, co); per[n] = {"rc": rc, "assertions": a, "secs": s}
    else:
        with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
            for n, rc, a, s in ex.map(lambda tp: _run_one_test(tp, co), tests):
                per[n] = {"rc": rc, "assertions": a, "secs": s}
    fails = [n for n, v in per.items() if v["rc"] != 0]
    return {"present": True, "ok": not fails, "files": len(per),
            "assertions": sum(v["assertions"] for v in per.values()),
            "failures": fails, "secs": round(time.time() - t, 1), "jobs": jobs, "per_file": per}

def gate_thinking(co):
    tdir = os.path.join(co, "benchmarks", "thinking", "results")
    js = [f for f in sorted(glob.glob(os.path.join(tdir, "*.json"))) if not f.endswith(".runs.json")]
    if not js:
        return {"present": False}
    d = json.load(open(js[-1]))
    agg = {a["variant"]: a for a in d["aggregates"]}
    b, c = d["baseline"], d["candidate"]
    dec = d["decision"]
    return {"present": True, "ok": True, "note": "replay-deterministic committed demo (not re-measured live)",
            "model": d.get("model"), "n_per_variant": agg[b]["thinking"]["n"],
            "verdict": "ADOPT" if dec["adopt"] else "REJECT",
            "thinking_median_baseline": agg[b]["thinking"]["median"],
            "thinking_median_candidate": agg[c]["thinking"]["median"],
            "thinking_reduction_pct": dec["thinkingTokenDeltaPct"],
            "quality_baseline": agg[b]["quality_pass_rate"], "quality_candidate": agg[c]["quality_pass_rate"],
            "latency_reduction_pct": dec["latencyDeltaPct"]}


# ---- compose / render / delta --------------------------------------------
def subject_of(sha):
    rc, o, _ = git(["log", "-1", "--format=%s", sha], FIRSTMATE_REPO)
    return o.strip() if rc == 0 else ""

def run_candidate(raw, sha, slot, args):
    co = prepare_checkout(slot, sha)
    art = {"artifact": "firstmate-eval-run", "captured_utc": datetime.now(timezone.utc).isoformat(),
           "target": raw, "sha": sha, "subject": subject_of(sha),
           "checkout": f"{co} (detached @ {sha[:12]}; reproduce: git checkout {sha[:12]})",
           "read_only": True, "home_pollution": "none",
           "supervision_bench": gate_supervision(co),
           "gates": {"behavior_suite": gate_behavior(co, args.suite_jobs),
                     "shellcheck": gate_shellcheck(co),
                     "repo_invariants": gate_invariants(co)},
           "thinking_efficiency": gate_thinking(co)}
    if not args.keep_tmp:
        rd = os.path.join(co, "benchmarks", "results")
        git(["clean", "-fdq", "--", "benchmarks/results", "benchmarks/thinking/results"], co)
        git(["checkout", "--quiet", "--", "benchmarks/results", "benchmarks/thinking/results"], co)
    return art

GREEN = lambda ok: "PASS" if ok else "FAIL"

def headline(a):
    s = a["supervision_bench"]; g = a["gates"]; b = g["behavior_suite"]; sc = g["shellcheck"]; inv = g["repo_invariants"]; th = a["thinking_efficiency"]
    parts = [f"sup {s.get('verdict','?')} {s.get('totals',{}).get('old_tokens','?')}->{s.get('totals',{}).get('new_tokens','?')} ({-s.get('reduction_pct',0)}%)"
             if s.get("ok") else "sup FAIL",
             f"behavior {'PASS' if b.get('ok') else 'FAIL'} {b.get('files','?')}f/{b.get('assertions','?')}a" + (f" fails={b['failures']}" if b.get("failures") else ""),
             f"shellcheck {GREEN(sc.get('ok'))} {sc.get('files','?')}",
             f"invariants {GREEN(inv.get('ok'))}",
             f"thinking {th.get('verdict','n/a')}" + (f" -{th.get('thinking_reduction_pct')}%" if th.get('ok') else "")]
    return " | ".join(parts)

def delta_vs(cur, base):
    if not base:
        return None
    d = {}
    cs, bs = cur["supervision_bench"], base.get("supervision_bench", {})
    if cs.get("ok") and bs.get("ok"):
        d["supervision_tokens"] = cs["totals"]["new_tokens"] - bs["totals"]["new_tokens"]
        d["supervision_verdict"] = f"{bs.get('verdict')} -> {cs.get('verdict')}"
    cb, bb = cur["gates"]["behavior_suite"], base.get("gates", {}).get("behavior_suite", {})
    if cb.get("present") and bb.get("present"):
        d["behavior_files"] = cb["files"] - bb["files"]
        d["behavior_assertions"] = cb["assertions"] - bb["assertions"]
        d["behavior_new_failures"] = sorted(set(cb.get("failures", [])) - set(bb.get("failures", [])))
        d["behavior_fixed"] = sorted(set(bb.get("failures", [])) - set(cb.get("failures", [])))
    d["baseline_sha"] = base.get("sha")
    return d

def render_md(a, d):
    s = a["supervision_bench"]; g = a["gates"]; b = g["behavior_suite"]; sc = g["shellcheck"]; inv = g["repo_invariants"]; th = a["thinking_efficiency"]
    L = [f"# Eval run - {a.get('subject','')}",
         "",
         f"- **SHA**: `{a['sha']}` (target `{a['target']}`)",
         f"- **Captured**: {a['captured_utc']}",
         f"- **Checkout**: `{a['checkout']}`",
         "", "## Headline", "| gate | result |", "|---|---|"]
    if s.get("ok"):
        t = s["totals"]
        L.append(f"| Supervision bench | **{s['verdict']}** tokens {t['old_tokens']}->{t['new_tokens']} (-{s['reduction_pct']}%), false {t['old_false']}->{t['new_false']}, missed {t['old_missed']}->{t['new_missed']} |")
    else:
        L.append(f"| Supervision bench | FAIL: {s.get('error','')} |")
    if b.get("present"):
        L.append(f"| Behavior suite | {GREEN(b['ok'])} {b['files']} files / {b['assertions']} assertions" + (f", fails: {b['failures']}" if b['failures'] else ", 0 failures") + f" ({b['secs']}s, jobs={b['jobs']}) |")
    L.append(f"| Shellcheck | {GREEN(sc.get('ok'))} {sc.get('files','?')} scripts |")
    L.append(f"| Repo invariants | {GREEN(inv.get('ok'))} |")
    if th.get("present"):
        L.append(f"| Thinking-efficiency | {th['verdict']} thinking -{th['thinking_reduction_pct']}%, quality {th['quality_baseline']*100:.0f}%->{th['quality_candidate']*100:.0f}%, latency -{th['latency_reduction_pct']}% (n={th['n_per_variant']} replay) |")
    if s.get("ok"):
        L += ["", "## Supervision - per scenario (old->new tokens)", "| scenario | tokens | false | missed |", "|---|---|---|---|"]
        for x in s["scenarios"]:
            L.append(f"| {x['scenario']} | {x['old_tokens']}->{x['new_tokens']} | {x['old_false']}->{x['new_false']} | {x['old_missed']}->{x['new_missed']} |")
    if d:
        L += ["", f"## Delta vs baseline `{str(d.get('baseline_sha'))[:12]}`", "```", json.dumps(d, indent=1), "```"]
    return "\n".join(L) + "\n"

def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("targets", nargs="*")
    ap.add_argument("--ref", action="append")
    ap.add_argument("--label"); ap.add_argument("--labels")
    ap.add_argument("--jobs", type=int, default=0)
    ap.add_argument("--suite-jobs", type=int, default=6)
    ap.add_argument("--vs", default=DEFAULT_BASELINE); ap.add_argument("--no-vs", action="store_true")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--keep-tmp", action="store_true")
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    targets = resolve_targets(args)
    labels = (args.labels.split(",") if args.labels else ([args.label] if args.label else []))
    os.makedirs(args.out, exist_ok=True)
    base = None
    if not args.no_vs and os.path.isfile(args.vs):
        base = json.load(open(args.vs))

    jobs = args.jobs or min(len(targets), 4)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    started = time.time()

    def work(i_rt):
        i, (raw, sha) = i_rt
        art = run_candidate(raw, sha, i % jobs, args)
        d = delta_vs(art, base)
        lbl = labels[i] if i < len(labels) and labels[i] else (art.get("subject", "") or raw).strip()
        slug = re.sub(r'[^a-zA-Z0-9]+', '-', lbl).strip('-')[:40] or sha[:8]
        stem = os.path.join(args.out, f"{slug}-{sha[:8]}-{ts}")
        json.dump({**art, "delta_vs_baseline": d}, open(stem + ".json", "w"), indent=2)
        open(stem + ".md", "w").write(render_md(art, d))
        return {"raw": raw, "sha": sha, "label": lbl, "json": stem + ".json", "md": stem + ".md",
                "headline": headline(art), "delta": d, "ok_all": _all_ok(art)}

    results = [None] * len(targets)
    errors = 0
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(work, (i, rt)): i for i, rt in enumerate(targets)}
        for fut in cf.as_completed(futs):
            i = futs[fut]
            try:
                results[i] = fut.result()
            except Exception as e:
                errors += 1
                results[i] = {"raw": targets[i][0], "sha": targets[i][1], "error": repr(e)}

    matrix_path = None
    if len(results) > 1:
        matrix_path = os.path.join(args.out, f"_matrix-{ts}.md")
        ML = [f"# Eval comparison matrix ({ts})", ""]
        if base:
            ML.append(f"baseline: `{base.get('sha','?')[:12]}` - {base.get('subject','')}")
        ML += ["", "| candidate | sha | sup tokens | Δtok vs base | behavior | shellcheck | invariants | thinking |",
               "|---|---|---|---|---|---|---|---|"]
        for r in results:
            if r.get("error"):
                ML.append(f"| {r['raw']} | {r['sha'][:8]} | ERROR | | | | | |"); continue
            a = json.load(open(r["json"])); s = a["supervision_bench"]; b = a["gates"]["behavior_suite"]
            dt = (r["delta"] or {}).get("supervision_tokens")
            ML.append(f"| {r['label'][:28]} | {r['sha'][:8]} | {s.get('totals',{}).get('new_tokens','?') if s.get('ok') else 'FAIL'} | {dt if dt is not None else ''} | {'PASS' if b.get('ok') else 'FAIL '+str(b.get('failures'))} | {GREEN(a['gates']['shellcheck'].get('ok'))} | {GREEN(a['gates']['repo_invariants'].get('ok'))} | {a['thinking_efficiency'].get('verdict','n/a')} |")
        open(matrix_path, "w").write("\n".join(ML) + "\n")

    elapsed = round(time.time() - started, 1)
    if args.json_only:
        print(json.dumps({"results": results, "matrix": matrix_path, "elapsed_s": elapsed}))
    else:
        print(f"=== fm-eval-run: {len(results)} candidate(s), {elapsed}s wall, jobs={jobs}, suite-jobs={args.suite_jobs} ===")
        for r in results:
            if r.get("error"):
                print(f"  ! {r['raw']} ({r['sha'][:8]}): ERROR {r['error']}"); continue
            print(f"  * {r['label']} ({r['sha'][:8]})")
            print(f"      {r['headline']}")
            if r.get("delta") and r["delta"].get("supervision_tokens") is not None:
                print(f"      delta vs baseline: sup tokens {r['delta']['supervision_tokens']:+d}, behavior assertions {r['delta'].get('behavior_assertions',0):+d}, new failures {r['delta'].get('behavior_new_failures') or 'none'}")
            print(f"      json: {r['json']}")
        if matrix_path:
            print(f"  matrix: {matrix_path}")
    sys.exit(1 if errors else 0)

def _all_ok(a):
    s = a["supervision_bench"].get("ok"); g = a["gates"]
    return bool(s and g["behavior_suite"].get("ok") and g["shellcheck"].get("ok") and g["repo_invariants"].get("ok"))

if __name__ == "__main__":
    main()
