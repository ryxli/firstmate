// Corpus-hardening: scenarios built to make even STRONG (Sonnet-class) models fail (<1.0),
// so there is real headroom to measure the harness. Two levers, both empirically tuned:
//
//   1. SCALE + COUNTERINTUITIVE RULES, ALL-CORRECT-REQUIRED - many items, each classified by a
//      precise rule that overrides the model's prior; correctness needs EVERY item right, so a
//      single slip drops the score below 1.0. A careful-but-not-exhaustive pass fails.
//   2. Rules derived from REAL firstmate operations (supervision awareness + restart recovery),
//      sanitized to generic fixtures, with spec-computed (never hand-annotated) ground truth.
//
//   fm-detect-state-change-hard : 14 in-flight tasks; classify the supervisor action for each from
//         three cross-referenced signals (pane status, LAST status line, report presence) under
//         counterintuitive rules: an idle secondmate is healthy (wait), a scout that claims done
//         with NO report is an anomaly (escalate), the LAST status line wins over an earlier
//         blocked/failed/needs-decision, and a done line with the pane still working is premature.
//   fm-recovery-triage-hard : 12 tasks to reconcile after a restart; choose the recovery action
//         per the recovery rules, where unlanded work is NEVER torn down (prime directive), a dead
//         secondmate is respawned, and a scout worktree with a report is closable even if unmerged.
//
// Multi-path (any route to the right end-state scores equally), procedural guard against tampering
// / invented actions, oracle positive control, leak markers. Ground truth is computed from the
// spec so the gates cannot be fooled.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}

// ===========================================================================
// 1. fm-detect-state-change-hard  (awareness-gap, hardened)
// ===========================================================================
const DH_ACTIONS = ["teardown", "finalize", "escalate", "wait"];
const DH_SPEC = `# Supervisor action rules (v2)
For EVERY in-flight task (one state/<id>.meta each) decide exactly one action and record it in
actions.json as { "<id>": "<action>", ... } covering every task once. Use the LAST line of the
status file; earlier lines are stale. A task's pane status is in panes.json keyed by meta pane=.

  escalate  - the LATEST status line begins with "blocked:", "needs-decision:", or "failed:"
              (regardless of pane); OR a SCOUT that is idle with a latest "done:" line but whose
              report data/<id>/report.md does NOT exist (a done claim with no deliverable).
  teardown  - a SCOUT (kind=scout) whose pane is idle, latest line begins "done:", and whose
              report data/<id>/report.md EXISTS.
  finalize  - a SHIP (kind=ship) whose pane is idle and whose latest line begins "done:".
  wait      - everything else. In particular: any kind=secondmate whose latest line is NOT one of
              the escalate triggers (an idle secondmate is healthy, never "finished"); a pane that
              is still "working"; an idle pane whose latest line is not terminal; and a latest
              "done:" line while the pane is still "working" (premature).
`;

// [id, kind, pane_id, pane_status, status_lines, has_report]
type DhTask = [string, string, string, string, string[], boolean];
const DH_TASKS: DhTask[] = [
	["scout-audit-a1", "scout", "w3:p1", "idle", ["working: auditing", "done: audit in report"], true],
	["ship-parser-b2", "ship", "w3:p2", "working", ["working: adding tests"], false],
	["ship-export-c3", "ship", "w3:p3", "idle", ["working: impl", "done: PR opened, checks green"], false],
	["ship-oauth-d4", "ship", "w3:p4", "idle", ["working: wiring", "needs-decision: which provider"], false],
	["scout-repro-e5", "scout", "w3:p5", "working", ["working: still reproducing"], false],
	["ship-cache-f6", "ship", "w3:p6", "idle", ["done: initial pass", "working: mid refactor"], false],
	["ship-build-g7", "ship", "w3:p7", "working", ["working: building", "done: wrapping up"], false],
	["scout-perf-h8", "scout", "w3:p8", "idle", ["working: profiling", "done: analysis complete"], false],
	["sm-quality-i9", "secondmate", "w3:p9", "idle", ["idle: tending domain"], false],
	["sm-triage-j10", "secondmate", "w3:p10", "idle", ["needs-decision: routing conflict"], false],
	["ship-migrate-k11", "ship", "w3:p11", "idle", ["failed: build broke", "working: retrying the fix"], false],
	["ship-lint-l12", "ship", "w3:p12", "working", ["blocked: waiting on review"], false],
	["scout-docs-m13", "scout", "w3:p13", "idle", ["working: drafting", "done: notes in report"], true],
	["ship-api-n14", "ship", "w3:p14", "idle", ["needs-decision: v1 or v2", "done: chose v1, PR open"], false],
];

function dhExpected(kind: string, pane: string, last: string, hasReport: boolean): string {
	const s = last.trim();
	if (s.startsWith("blocked:") || s.startsWith("needs-decision:") || s.startsWith("failed:")) return "escalate";
	if (kind === "secondmate") return "wait";
	if (pane === "idle" && s.startsWith("done:")) {
		if (kind === "scout") return hasReport ? "teardown" : "escalate";
		return "finalize";
	}
	return "wait";
}

function dhTruth(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [tid, kind, , ps, lines, rep] of DH_TASKS) {
		out[tid] = dhExpected(kind, ps, lines[lines.length - 1], rep);
	}
	return out;
}

function dhSetup(d: string): void {
	mkdirSync(join(d, "state"), { recursive: true });
	writeFileSync(join(d, "ACTIONS_SPEC.md"), DH_SPEC);
	const panes: Record<string, string> = {};
	for (const [tid, kind, pid, ps, lines, rep] of DH_TASKS) {
		writeFileSync(join(d, "state", `${tid}.meta`), `kind=${kind}\npane=${pid}\n`);
		writeFileSync(join(d, "state", `${tid}.status`), `${lines.join("\n")}\n`);
		panes[pid] = ps;
		if (rep) {
			mkdirSync(join(d, "data", tid), { recursive: true });
			writeFileSync(join(d, "data", tid, "report.md"), "# findings\ncomplete.\n");
		}
	}
	writeFileSync(join(d, "panes.json"), JSON.stringify(panes, null, 2));
}

function dhGoal(d: string): GoalResult {
	const p = join(d, "actions.json");
	if (!existsSync(p)) return goalResult(false, 0, "actions.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) return goalResult(false, 0, "not an object");
	const obj = got as Record<string, unknown>;
	const truth = dhTruth();
	const ids = Object.keys(truth);
	let correct = 0;
	for (const t of ids) {
		const v = obj[t];
		if (typeof v === "string" && v.trim() === truth[t]) correct++;
	}
	const covered = ids.every((t) => t in obj);
	return goalResult(
		correct === ids.length && covered,
		round3(correct / ids.length),
		`${correct}/${ids.length} correct${covered ? "" : " (missing ids)"}`,
	);
}

function dhProc(d: string): ProcResult {
	const specOk = readFileSync(join(d, "ACTIONS_SPEC.md"), "utf8") === DH_SPEC;
	const stateOk = DH_TASKS.every(([t, , , , l]) => readFileSync(join(d, "state", `${t}.status`), "utf8") === `${l.join("\n")}\n`);
	const p = join(d, "actions.json");
	let valid = existsSync(p);
	let vocab = true;
	if (valid) {
		try {
			const g: unknown = JSON.parse(readFileSync(p, "utf8"));
			vocab =
				typeof g === "object" &&
				g !== null &&
				!Array.isArray(g) &&
				Object.values(g as Record<string, unknown>).every((v) => typeof v === "string" && DH_ACTIONS.includes(v));
		} catch {
			valid = false;
		}
	}
	const ok = specOk && stateOk && valid && vocab;
	return procResult(ok, `spec_unchanged=${specOk} state_unchanged=${stateOk} valid=${valid} vocab_ok=${vocab}`);
}

function dhOracle(d: string): Trace {
	writeFileSync(join(d, "actions.json"), JSON.stringify(dhTruth(), null, 2));
	return trace(
		true,
		220,
		5,
		[toolCall("read", "ACTIONS_SPEC.md"), toolCall("read", "panes.json"), toolCall("read", "state"), toolCall("write", "actions.json")],
		"classified all 14",
	);
}

// ===========================================================================
// 2. fm-recovery-triage-hard  (real-log: restart recovery reconciliation)
// ===========================================================================
const RC_ACTIONS = ["monitor", "respawn", "salvage", "teardown", "report-lost"];
const RC_SPEC = `# Restart recovery rules
After a restart, reconcile each in-flight task (one state/<id>.meta with kind= and landed=) using
the live snapshot live.json ({ "<id>": {"pane_alive": bool, "worktree_exists": bool} }) and whether
a report data/<id>/report.md exists. Choose exactly one recovery action per task and write
recovery.json { "<id>": "<action>", ... } covering every task. Allowed actions:

  monitor    - the task's pane is still alive (pane_alive true). Reconcile in place; no recovery.
  respawn    - a dead-pane task with kind=secondmate (a persistent supervisor is always brought back).
  report-lost- a dead-pane ordinary task (kind ship/scout) whose worktree no longer exists.
  teardown   - a dead-pane ordinary task whose worktree exists AND the work is safe to discard:
               landed=true, OR it is a scout whose report data/<id>/report.md exists (the report is
               the deliverable).
  salvage    - a dead-pane ordinary task whose worktree exists but the work is NOT safe to discard:
               unlanded (landed=false) and not a scout-with-report. Unlanded work is NEVER torn down.

Precedence: pane_alive -> monitor first; then kind=secondmate -> respawn; then worktree checks.
`;

// [id, kind, landed, pane_alive, worktree_exists, has_report]
type RcTask = [string, string, boolean, boolean, boolean, boolean];
const RC_TASKS: RcTask[] = [
	["ship-alpha-1", "ship", false, true, true, false], // alive -> monitor
	["scout-beta-2", "scout", false, true, true, false], // alive -> monitor
	["sm-gamma-3", "secondmate", false, false, true, false], // dead secondmate -> respawn
	["ship-delta-4", "ship", false, false, false, false], // dead, no worktree -> report-lost
	["ship-eps-5", "ship", true, false, true, false], // dead, worktree, landed -> teardown
	["ship-zeta-6", "ship", false, false, true, false], // dead, worktree, UNLANDED -> salvage (safety)
	["scout-eta-7", "scout", false, false, true, true], // dead scout, report exists -> teardown
	["scout-theta-8", "scout", false, false, true, false], // dead scout, no report, unlanded -> salvage
	["sm-iota-9", "secondmate", false, true, true, false], // alive secondmate -> monitor
	["ship-kappa-10", "ship", true, false, true, false], // dead, worktree, landed -> teardown
	["ship-lam-11", "ship", false, false, false, false], // dead, no worktree -> report-lost
	["scout-mu-12", "scout", false, false, true, true], // dead scout, report -> teardown
];

function rcExpected(kind: string, landed: boolean, paneAlive: boolean, worktreeExists: boolean, hasReport: boolean): string {
	if (paneAlive) return "monitor";
	if (kind === "secondmate") return "respawn";
	if (!worktreeExists) return "report-lost";
	if (landed) return "teardown";
	if (kind === "scout" && hasReport) return "teardown";
	return "salvage";
}

function rcTruth(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [tid, k, ld, pa, we, hr] of RC_TASKS) {
		out[tid] = rcExpected(k, ld, pa, we, hr);
	}
	return out;
}

function rcSetup(d: string): void {
	mkdirSync(join(d, "state"), { recursive: true });
	writeFileSync(join(d, "RECOVERY_SPEC.md"), RC_SPEC);
	const live: Record<string, { pane_alive: boolean; worktree_exists: boolean }> = {};
	for (const [tid, kind, landed, pa, we, hr] of RC_TASKS) {
		writeFileSync(join(d, "state", `${tid}.meta`), `kind=${kind}\nlanded=${landed ? "true" : "false"}\n`);
		live[tid] = { pane_alive: pa, worktree_exists: we };
		if (hr) {
			mkdirSync(join(d, "data", tid), { recursive: true });
			writeFileSync(join(d, "data", tid, "report.md"), "# report\ndelivered.\n");
		}
	}
	writeFileSync(join(d, "live.json"), JSON.stringify(live, null, 2));
}

function rcGoal(d: string): GoalResult {
	const p = join(d, "recovery.json");
	if (!existsSync(p)) return goalResult(false, 0, "recovery.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) return goalResult(false, 0, "not an object");
	const obj = got as Record<string, unknown>;
	const truth = rcTruth();
	const ids = Object.keys(truth);
	let correct = 0;
	for (const t of ids) {
		const v = obj[t];
		if (typeof v === "string" && v.trim() === truth[t]) correct++;
	}
	const covered = ids.every((t) => t in obj);
	return goalResult(
		correct === ids.length && covered,
		round3(correct / ids.length),
		`${correct}/${ids.length} correct${covered ? "" : " (missing ids)"}`,
	);
}

function rcProc(d: string): ProcResult {
	const specOk = readFileSync(join(d, "RECOVERY_SPEC.md"), "utf8") === RC_SPEC;
	const liveOk = existsSync(join(d, "live.json"));
	const p = join(d, "recovery.json");
	let valid = existsSync(p);
	let vocab = true;
	if (valid) {
		try {
			const g: unknown = JSON.parse(readFileSync(p, "utf8"));
			vocab =
				typeof g === "object" &&
				g !== null &&
				!Array.isArray(g) &&
				Object.values(g as Record<string, unknown>).every((v) => typeof v === "string" && RC_ACTIONS.includes(v));
		} catch {
			valid = false;
		}
	}
	const ok = specOk && liveOk && valid && vocab;
	return procResult(ok, `spec_unchanged=${specOk} live_present=${liveOk} valid=${valid} vocab_ok=${vocab}`);
}

function rcOracle(d: string): Trace {
	writeFileSync(join(d, "recovery.json"), JSON.stringify(rcTruth(), null, 2));
	return trace(
		true,
		210,
		5,
		[toolCall("read", "RECOVERY_SPEC.md"), toolCall("read", "live.json"), toolCall("read", "state"), toolCall("write", "recovery.json")],
		"reconciled all 12",
	);
}

export const SCENARIOS: Scenario[] = [
	{
		id: "fm-detect-state-change-hard",
		difficulty: "aspirational",
		task:
			"A larger fleet is in flight (one state/<id>.meta each) and several crewmates just changed " +
			"state. For every in-flight task decide the single supervisor action required now per " +
			"ACTIONS_SPEC.md and write the result to actions.json. Then stop.",
		setup: dhSetup,
		goal: dhGoal,
		procedural: dhProc,
		oracle: dhOracle,
		leakMarkers: ['"scout-perf-h8": "escalate"', '"sm-quality-i9": "wait"', '"ship-migrate-k11": "wait"'],
	},
	{
		id: "fm-recovery-triage-hard",
		difficulty: "hard",
		task:
			"This home was just restarted. Reconcile every in-flight task by choosing its recovery action " +
			"per RECOVERY_SPEC.md (using the metas, live.json, and any reports) and write the result to " +
			"recovery.json. Then stop.",
		setup: rcSetup,
		goal: rcGoal,
		procedural: rcProc,
		oracle: rcOracle,
		leakMarkers: ['"ship-zeta-6": "salvage"', '"scout-eta-7": "teardown"', '"sm-gamma-3": "respawn"'],
	},
];
