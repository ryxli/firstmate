#!/usr/bin/env python3
"""ab-lab - A/B experiment rig for harness changes.

Spins up a matched pair of throwaway omp agent sessions in herdr panes - a TEST
arm and a CONTROL arm - that differ by exactly ONE variable (a config overlay
applied only to control), driven with an identical workload, with per-arm
session + state isolation so a metric extractor reads each arm cleanly.

The whole point: turn "does this harness change actually help?" into a
controlled, reproducible measurement instead of a vibe. Same model, same
prompts, one variable, raw data preserved.

Subcommands:
  up      <run>  --control-config <yml> [--model M] [--state-env NAME]
                 [--preamble TEXT] [--base-pane P]
  drive   <run>  --workload <file> [--runs N] [--interval S]
  measure <run>  --extractor <path.py>        (extractor defines analyze(dir)->dict)
  status  <run>
  down    <run>                                (quit + close both panes; data kept)

Runs live under ~/.omp/agent/ab-lab/runs/<run>/ (persisted for reproducibility):
  config.json, panes.env, test-sessions/, control-sessions/,
  test-state/, control-state/, driver.log

Design notes:
- The variable is a CONTROL-only config overlay (--control-config): this covers
  extension on/off (disabledExtensions), model knobs, any config.yml field. The
  test arm runs the harness as-is; control runs with the overlay = the change
  removed (or vice-versa - you decide which side is the overlay).
- --state-env NAME sets NAME=<run>/<arm>-state per arm, so an extension that
  writes state/metrics via that env var keeps the two arms' data separate
  (e.g. THINKING_TAG_GUARD_STATE, FLEET_BUS_STATE_ROOT).
- measure is pluggable because the metric differs per experiment; the extractor
  is a tiny python file exposing analyze(session_dir)->dict. See
  ~/.omp/agent/ab-lab/extractors/ for worked examples.
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

LAB = Path.home() / ".omp" / "agent" / "ab-lab"
RUNS = LAB / "runs"
DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_PREAMBLE = (
    "You are an A/B reasoning test bot. For each puzzle I send: think it through, "
    "then run a bash command echoing your final answer, then state the answer in "
    "one line. Nothing else."
)


def herdr(*args, timeout=15):
    """Run a herdr CLI command, return parsed JSON result dict (or {} on failure)."""
    try:
        out = subprocess.run(["herdr", *args], capture_output=True, text=True, timeout=timeout)
    except Exception:
        return {}
    try:
        return json.loads(out.stdout)
    except Exception:
        return {}


def current_pane():
    d = herdr("pane", "current")
    return (d.get("result", {}).get("pane", {}) or {}).get("pane_id")


def split(pane, direction):
    """Split `pane` in `direction`, return the new pane id."""
    d = herdr("pane", "split", pane, "--direction", direction, "--no-focus")
    return (d.get("result", {}).get("pane", {}) or {}).get("pane_id")


def run_in(pane, command):
    herdr("pane", "run", pane, command)


def pane_status(pane):
    d = herdr("pane", "get", pane)
    return (d.get("result", {}).get("pane", {}) or {}).get("agent_status", "unknown")


def run_dir(name):
    return RUNS / name


def load_cfg(name):
    p = run_dir(name) / "config.json"
    if not p.exists():
        sys.exit(f"ab-lab: no run '{name}' (missing {p})")
    return json.loads(p.read_text())


def build_launch(arm, cfg, session_dir, state_dir):
    """Build the omp launch command string for one arm."""
    env = ""
    if cfg.get("state_env"):
        env = f"{cfg['state_env']}={state_dir} "
    parts = [
        f"{env}omp",
        f"--model {cfg['model']}",
        f"--session-dir {session_dir}",
        "--auto-approve",
    ]
    if arm == "control" and cfg.get("control_config"):
        parts.insert(3, f"--config {cfg['control_config']}")
    preamble = cfg["preamble"].replace('"', '\\"')
    parts.append(f'"{preamble}"')
    return " ".join(parts)


def cmd_up(a):
    rd = run_dir(a.run)
    if (rd / "config.json").exists():
        sys.exit(f"ab-lab: run '{a.run}' already exists at {rd}")
    for sub in ("test-sessions", "control-sessions", "test-state", "control-state"):
        (rd / sub).mkdir(parents=True, exist_ok=True)
    base = a.base_pane or current_pane()
    if not base:
        sys.exit("ab-lab: could not resolve a base pane; pass --base-pane")
    test_pane = split(base, "right")
    control_pane = split(test_pane, "down")
    if not test_pane or not control_pane:
        sys.exit("ab-lab: pane split failed")
    cfg = {
        "run": a.run,
        "model": a.model,
        "control_config": os.path.abspath(a.control_config) if a.control_config else "",
        "state_env": a.state_env or "",
        "preamble": a.preamble or DEFAULT_PREAMBLE,
        "test_pane": test_pane,
        "control_pane": control_pane,
        "created": time.time(),
    }
    (rd / "config.json").write_text(json.dumps(cfg, indent=2))
    run_in(test_pane, build_launch("test", cfg, rd / "test-sessions", rd / "test-state"))
    run_in(control_pane, build_launch("control", cfg, rd / "control-sessions", rd / "control-state"))
    print(json.dumps({"run": a.run, "test_pane": test_pane, "control_pane": control_pane,
                      "control_config": cfg["control_config"] or "(none)", "dir": str(rd)}, indent=2))


def cmd_drive(a):
    cfg = load_cfg(a.run)
    rd = run_dir(a.run)
    prompts = [l.strip() for l in Path(a.workload).read_text().splitlines() if l.strip()]
    if not prompts:
        sys.exit("ab-lab: workload file has no prompts")
    log = (rd / "driver.log").open("a")
    start = time.time()
    log.write(f"{start} DRIVE START runs={a.runs} interval={a.interval}\n"); log.flush()
    for i in range(a.runs):
        p = prompts[i % len(prompts)]
        run_in(cfg["test_pane"], p)
        run_in(cfg["control_pane"], p)
        log.write(f"{time.time()} round={i} {p[:60]}\n"); log.flush()
        if i < a.runs - 1:
            time.sleep(a.interval)
    log.write(f"{time.time()} DRIVE END\n"); log.close()
    print(f"ab-lab: drove {a.runs} rounds to run '{a.run}'")


def cmd_measure(a):
    cfg = load_cfg(a.run)
    rd = run_dir(a.run)
    ns = {}
    exec(Path(a.extractor).read_text(), ns)
    analyze = ns.get("analyze")
    if not callable(analyze):
        sys.exit("ab-lab: extractor must define analyze(session_dir)->dict")
    test = analyze(str(rd / "test-sessions"))
    control = analyze(str(rd / "control-sessions"))
    delta = {}
    for k in set(test) | set(control):
        tv, cv = test.get(k), control.get(k)
        if isinstance(tv, (int, float)) and isinstance(cv, (int, float)):
            delta[k] = tv - cv
    print(json.dumps({"run": a.run, "variable": cfg["control_config"] or "(none)",
                      "test_arm": test, "control_arm": control, "test_minus_control": delta}, indent=2))


def cmd_status(a):
    cfg = load_cfg(a.run)
    print(json.dumps({"run": a.run, "test_pane": cfg["test_pane"], "test_status": pane_status(cfg["test_pane"]),
                      "control_pane": cfg["control_pane"], "control_status": pane_status(cfg["control_pane"]),
                      "dir": str(run_dir(a.run))}, indent=2))


def cmd_down(a):
    cfg = load_cfg(a.run)
    for pane in (cfg["test_pane"], cfg["control_pane"]):
        run_in(pane, "/quit")
    time.sleep(4)
    for pane in (cfg["test_pane"], cfg["control_pane"]):
        herdr("pane", "close", pane)
    print(f"ab-lab: tore down run '{a.run}' panes (data kept in {run_dir(a.run)})")


def main():
    ap = argparse.ArgumentParser(prog="ab-lab", description="A/B experiment rig")
    sub = ap.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("up"); up.add_argument("run"); up.add_argument("--control-config", dest="control_config")
    up.add_argument("--model", default=DEFAULT_MODEL); up.add_argument("--state-env", dest="state_env")
    up.add_argument("--preamble"); up.add_argument("--base-pane", dest="base_pane"); up.set_defaults(func=cmd_up)
    dr = sub.add_parser("drive"); dr.add_argument("run"); dr.add_argument("--workload", required=True)
    dr.add_argument("--runs", type=int, default=24); dr.add_argument("--interval", type=int, default=75); dr.set_defaults(func=cmd_drive)
    me = sub.add_parser("measure"); me.add_argument("run"); me.add_argument("--extractor", required=True); me.set_defaults(func=cmd_measure)
    st = sub.add_parser("status"); st.add_argument("run"); st.set_defaults(func=cmd_status)
    dn = sub.add_parser("down"); dn.add_argument("run"); dn.set_defaults(func=cmd_down)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
