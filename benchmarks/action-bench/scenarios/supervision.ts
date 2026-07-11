// Supervision awareness-gap scenario - a REAL recurring first-mate failure.
//
// The first mate is often not instantly aware of a crewmate STATE CHANGE: a report finishes
// a routed task and the pane goes idle, but nothing wakes the supervisor, so the finished
// task sits unnoticed until a human catches it. This scenario ingrains that failure as a
// benchmark: given a supervision snapshot where several crewmates are in flight and a few have
// JUST changed state (finished + idle with a delivered report, or raised a decision), the agent
// must DETECT which tasks need supervisor action NOW and take the correct next action, instead
// of defaulting to "still waiting".
//
// Why control fails below ceiling: the truth for each task is spread across THREE signals that
// must be cross-referenced - the live pane status (panes.json, keyed by the meta's pane id), the
// LAST line of the task's status file, and whether a report was delivered. A superficial scan
// (the real bug) reads one signal and concludes "still working", missing the finished-and-idle
// tasks; and two traps punish shortcuts: an idle pane whose last status is NOT terminal is still
// "wait" (idle != finished), and a status file whose LAST line is "working:" after an earlier
// "done:" is still "wait" (must use the last line, and a done line with the pane still working is
// premature). The disciplined path reads all three signals per task and classifies correctly.
//
// Judged by end-state (actions.json), multi-path (any way of producing the right classification
// scores equally), with a procedural guard against tampering / invented actions. The ground truth
// is computed from the spec, so it cannot be hand-mis-tagged.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}

const ACTIONS = ["teardown", "finalize", "escalate", "wait"];

const SPEC = `# Supervisor action rules
You are supervising the in-flight tasks (one state/<id>.meta file each). For EVERY in-flight
task, decide the single action the supervisor must take NOW and record it in actions.json as
an object { "<id>": "<action>", ... } covering every in-flight task exactly once. Allowed
actions (use no others):

  teardown  - a SCOUT (meta kind=scout) whose pane is idle, whose LATEST status line begins
              with "done:", and whose report data/<id>/report.md exists. Its deliverable is in;
              close it.
  finalize  - a SHIP (meta kind=ship) whose pane is idle and whose LATEST status line begins
              with "done:". It is finished and needs the supervisor to advance it.
  escalate  - any task whose LATEST status line begins with "blocked:", "needs-decision:", or
              "failed:". It needs a supervisor decision.
  wait      - anything else. In particular: the pane is still "working"; OR the pane is idle but
              the LATEST status line is not terminal (an idle pane alone does NOT mean finished);
              OR the latest status is "done:" but the pane is still "working" (premature).

A task's pane status is in panes.json, keyed by the pane= id in its meta. Always use the LAST
line of the status file (earlier lines may be stale). Cover every in-flight task exactly once.
`;

// (id, kind, pane_id, pane_status, status_lines[], has_report)
type Task = [string, string, string, string, string[], boolean];
const TASKS: Task[] = [
	["scout-authz-a7", "scout", "w2:p1", "idle", ["working: auditing authz", "done: audit written to report"], true],
	["fix-parser-b3", "ship", "w2:p2", "working", ["working: adding tests"], false],
	["add-export-c1", "ship", "w2:p3", "idle", ["working: implement export", "done: PR opened, checks green"], false],
	["wire-oauth-d9", "ship", "w2:p4", "idle", ["working: wiring oauth", "needs-decision: pick oauth provider"], false],
	["repro-crash-e4", "scout", "w2:p5", "working", ["working: still reproducing the crash"], false],
	["refactor-cache-f2", "ship", "w2:p6", "idle", ["done: initial pass", "working: mid refactor"], false],
	["premature-g5", "ship", "w2:p7", "working", ["working: building", "done: wrapping up"], false],
];

// The deterministic ground truth, computed straight from the spec.
function expected(kind: string, paneStatus: string, lastStatus: string, hasReport: boolean): string {
	const s = lastStatus.trim();
	if (s.startsWith("blocked:") || s.startsWith("needs-decision:") || s.startsWith("failed:")) return "escalate";
	if (paneStatus === "idle" && s.startsWith("done:")) {
		if (kind === "scout") return hasReport ? "teardown" : "wait";
		return "finalize";
	}
	return "wait";
}

function truth(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [tid, kind, , ps, lines, rep] of TASKS) {
		out[tid] = expected(kind, ps, lines[lines.length - 1], rep);
	}
	return out;
}

function setup(d: string): void {
	mkdirSync(join(d, "state"), { recursive: true });
	writeFileSync(join(d, "ACTIONS_SPEC.md"), SPEC);
	const panes: Record<string, string> = {};
	for (const [tid, kind, pid, ps, lines, rep] of TASKS) {
		writeFileSync(join(d, "state", `${tid}.meta`), `kind=${kind}\npane=${pid}\n`);
		writeFileSync(join(d, "state", `${tid}.status`), `${lines.join("\n")}\n`);
		panes[pid] = ps;
		if (rep) {
			mkdirSync(join(d, "data", tid), { recursive: true });
			writeFileSync(join(d, "data", tid, "report.md"), "# findings\nthe audit is complete.\n");
		}
	}
	writeFileSync(join(d, "panes.json"), JSON.stringify(panes, null, 2));
}

function goal(d: string): GoalResult {
	const p = join(d, "actions.json");
	if (!existsSync(p)) return goalResult(false, 0.0, "actions.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0.0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) {
		return goalResult(false, 0.0, "actions.json is not an object");
	}
	const obj = got as Record<string, unknown>;
	const t = truth();
	const ids = Object.keys(t);
	let correct = 0;
	for (const tid of ids) {
		let gv: unknown = obj[tid];
		if (typeof gv === "string") gv = gv.trim();
		if (gv === t[tid]) correct += 1;
	}
	const covered = ids.every((k) => k in obj);
	return goalResult(
		correct === ids.length && covered,
		round3(correct / ids.length),
		`${correct}/${ids.length} actions correct${covered ? "" : " (missing task ids)"}`,
	);
}

function proc(d: string): ProcResult {
	const specOk = readFileSync(join(d, "ACTIONS_SPEC.md"), "utf8") === SPEC;
	const stateOk = TASKS.every(([tid, , , , lines]) => readFileSync(join(d, "state", `${tid}.status`), "utf8") === `${lines.join("\n")}\n`);
	const p = join(d, "actions.json");
	let valid = existsSync(p);
	let vocabOk = true;
	if (valid) {
		try {
			const got = JSON.parse(readFileSync(p, "utf8"));
			vocabOk =
				typeof got === "object" &&
				got !== null &&
				!Array.isArray(got) &&
				Object.values(got as Record<string, unknown>).every((v) => ACTIONS.includes(v as string));
		} catch {
			valid = false;
		}
	}
	const ok = specOk && stateOk && valid && vocabOk;
	return procResult(ok, `spec_unchanged=${specOk} state_unchanged=${stateOk} valid=${valid} vocab_ok=${vocabOk}`);
}

function oracle(d: string): Trace {
	writeFileSync(join(d, "actions.json"), JSON.stringify(truth(), null, 2));
	return trace(
		true,
		160,
		4,
		[toolCall("read", "ACTIONS_SPEC.md"), toolCall("read", "panes.json"), toolCall("read", "state"), toolCall("write", "actions.json")],
		JSON.stringify(truth()),
	);
}

export const SCENARIOS: Scenario[] = [
	{
		id: "fm-detect-state-change",
		difficulty: "aspirational",
		task:
			"Several tasks are in flight (one state/<id>.meta each). Some crewmates have just changed " +
			"state. Review the supervision snapshot and, for every in-flight task, decide the single " +
			"supervisor action required right now per ACTIONS_SPEC.md, writing the result to actions.json. " +
			"Then stop.",
		setup,
		goal,
		procedural: proc,
		oracle,
		leakMarkers: ['"scout-authz-a7": "teardown"', '"refactor-cache-f2": "wait"', '"premature-g5": "wait"'],
	},
];
