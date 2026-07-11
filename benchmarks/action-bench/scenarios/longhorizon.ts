// Long-horizon (multi-session) scenario - the substrate step-up.
//
// A supervisor works a 6-SESSION shift. Between sessions the fleet state evolves (tasks finish, new
// tasks spawn, decisions are raised and resolved). Each session is a FRESH agent session whose only
// memory is the fixture on disk: the evolving state files plus an accumulating actions_log.jsonl the
// agent itself writes. The agent must log each needed supervisor action EXACTLY ONCE across the whole
// shift.
//
// Why this needs sustained long-horizon consistency (and why errors compound): a finished task stays
// "done + idle" for the REST of the shift, so an agent that only looks at the current state - without
// reconciling against what it already logged in earlier sessions - re-logs the same action every
// session and accumulates duplicates. One empty session (nothing new) tempts a spurious log. Getting
// the final log exactly right requires, every session, reconstructing the picture from disk and
// diffing current-needs against the prior log - the discipline the harness scaffold encodes and the
// real first-mate failure mode when it loses track across restarts.
//
// Runs on the engine's multi-session `steps`: goal/procedural receive the per-session trace list;
// ground truth is computed from the deterministic timeline, so it cannot be hand-mis-tagged.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Step, type Trace, type TraceArg, goalResult, procResult, toolCall, trace } from "../types.ts";

const PANES: Record<string, string> = { alpha: "p1", beta: "p2", gamma: "p3", delta: "p4", epsilon: "p5" };
const KIND: Record<string, string> = { alpha: "ship", beta: "scout", gamma: "ship", delta: "scout", epsilon: "ship" };
const ACTIONS = ["finalize", "teardown", "escalate"];

const RULES = `# Supervisor action rules
A task's pane status is in panes.json (keyed by the pane= in its meta); always use the LAST line of
its status file. An action is needed when:
  finalize - a ship (kind=ship) whose pane is idle and whose latest status begins "done:".
  teardown - a scout (kind=scout) whose pane is idle, latest status begins "done:", AND its report
             data/<id>/report.md exists.
  escalate - any task whose latest status begins "blocked:", "needs-decision:", or "failed:";
             OR a scout that is idle with a "done:" line but no report (a done claim, no deliverable).
Otherwise NO action is needed (do not log it). Record each needed action EXACTLY ONCE across the whole
shift: if actions_log.jsonl already contains a {task, action} line, never add it again.
`;

// One cumulative snapshot per session: task -> [paneStatus, lastStatus, hasReport].
type Snap = Record<string, [string, string, boolean]>;

// The deterministic timeline: a cumulative snapshot per session i (1..6).
const SNAP: Snap[] = [
	{ // session 1: alpha just finished
		alpha: ["idle", "done: PR open", false],
		beta: ["working", "working: investigating", false],
	},
	{ // session 2: beta finished (report in); gamma spawned
		alpha: ["idle", "done: PR open", false],
		beta: ["idle", "done: report ready", true],
		gamma: ["working", "working: build", false],
	},
	{ // session 3: gamma raised a decision
		alpha: ["idle", "done: PR open", false],
		beta: ["idle", "done: report ready", true],
		gamma: ["idle", "needs-decision: which lib", false],
	},
	{ // session 4: delta spawned; nothing NEW actionable (gamma already escalated)
		alpha: ["idle", "done: PR open", false],
		beta: ["idle", "done: report ready", true],
		gamma: ["idle", "needs-decision: which lib", false],
		delta: ["working", "working: repro", false],
	},
	{ // session 5: delta finished (report in); gamma's decision resolved -> back to working
		alpha: ["idle", "done: PR open", false],
		beta: ["idle", "done: report ready", true],
		gamma: ["working", "working: decided, continuing", false],
		delta: ["idle", "done: analysis ready", true],
	},
	{ // session 6: epsilon spawned and immediately failed
		alpha: ["idle", "done: PR open", false],
		beta: ["idle", "done: report ready", true],
		gamma: ["working", "working: decided, continuing", false],
		delta: ["idle", "done: analysis ready", true],
		epsilon: ["idle", "failed: build broke", false],
	},
];

function actionFor(task: string, paneStatus: string, lastStatus: string, hasReport: boolean): string | null {
	const s = lastStatus.trim();
	if (s.startsWith("blocked:") || s.startsWith("needs-decision:") || s.startsWith("failed:")) {
		return "escalate";
	}
	if (paneStatus === "idle" && s.startsWith("done:")) {
		if (KIND[task] === "scout") {
			return hasReport ? "teardown" : "escalate";
		}
		return "finalize";
	}
	return null;
}

// Walk the timeline; each needed (task, action) is logged once, at first appearance.
function expectedLog(): Array<[string, string]> {
	const logged = new Set<string>();
	const order: Array<[string, string]> = [];
	for (const snap of SNAP) {
		for (const [task, [ps, last, rep]] of Object.entries(snap)) {
			const act = actionFor(task, ps, last, rep);
			if (act && !logged.has(`${task}\t${act}`)) {
				logged.add(`${task}\t${act}`);
				order.push([task, act]);
			}
		}
	}
	return order;
}

function writeSnapshot(d: string, snap: Snap): void {
	mkdirSync(join(d, "state"), { recursive: true });
	const panes: Record<string, string> = {};
	for (const [task, [ps, last, rep]] of Object.entries(snap)) {
		writeFileSync(join(d, "state", `${task}.meta`), `kind=${KIND[task]}\npane=${PANES[task]}\n`);
		writeFileSync(join(d, "state", `${task}.status`), `${last}\n`);
		panes[PANES[task]] = ps;
		if (rep) {
			mkdirSync(join(d, "data", task), { recursive: true });
			writeFileSync(join(d, "data", task, "report.md"), "# report\ndelivered.\n");
		}
	}
	writeFileSync(join(d, "panes.json"), JSON.stringify(panes, null, 2));
}

function setup(d: string): void {
	writeFileSync(join(d, "RULES.md"), RULES);
	writeFileSync(join(d, "actions_log.jsonl"), ""); // empty accumulating log
}

function readLog(d: string): Array<[string, string]> | null | "malformed" {
	const p = join(d, "actions_log.jsonl");
	if (!existsSync(p)) {
		return null;
	}
	const pairs: Array<[string, string]> = [];
	for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		try {
			const e = JSON.parse(line) as { task?: string; action?: string };
			pairs.push([e.task as string, e.action as string]);
		} catch {
			return "malformed";
		}
	}
	return pairs;
}

function goal(d: string, _tr: TraceArg): GoalResult {
	const pairs = readLog(d);
	if (pairs === null) {
		return goalResult(false, 0.0, "actions_log.jsonl missing");
	}
	if (pairs === "malformed") {
		return goalResult(false, 0.0, "actions_log.jsonl has a malformed line");
	}
	const expected = new Set(expectedLog().map(([t, a]) => `${t}\t${a}`));
	const got = pairs.map(([t, a]) => `${t}\t${a}`);
	const gotSet = new Set(got);
	let matched = 0;
	for (const k of gotSet) {
		if (expected.has(k)) matched++;
	}
	const exact = gotSet.size === expected.size && [...gotSet].every((k) => expected.has(k)) && got.length === expected.size;
	return goalResult(
		exact,
		Math.round((matched / expected.size) * 1000) / 1000,
		`${matched}/${expected.size} unique actions; logged ${got.length} lines (dupes/extras fail exactness)`,
	);
}

function procedural(d: string, _tr: TraceArg): ProcResult {
	const rulesOk = readFileSync(join(d, "RULES.md"), "utf8") === RULES;
	const pairs = readLog(d);
	const valid = Array.isArray(pairs);
	let fabricated = false;
	let vocabOk = true;
	if (Array.isArray(pairs)) {
		for (const [t, a] of pairs) {
			if (!Object.hasOwn(PANES, t)) {
				fabricated = true;
			}
			if (!ACTIONS.includes(a)) {
				vocabOk = false;
			}
		}
	}
	const ok = rulesOk && valid && !fabricated && vocabOk;
	return procResult(ok, `rules_unchanged=${rulesOk} valid_log=${valid} fabricated_id=${fabricated} vocab_ok=${vocabOk}`);
}

function oracle(d: string): Trace[] {
	writeSnapshot(d, SNAP[SNAP.length - 1]); // bring the fixture to the final session's state
	let log = "";
	for (const [task, act] of expectedLog()) {
		log += `{"task": "${task}", "action": "${act}"}\n`;
	}
	writeFileSync(join(d, "actions_log.jsonl"), log);
	return SNAP.map(() =>
		trace(true, 120, 3, [toolCall("read", "state"), toolCall("write", "actions_log.jsonl")], "session"),
	);
}

const STEPS: Step[] = SNAP.map((_snap, i): Step => [
	`Session ${i + 1} of a 6-session supervision shift. New events may have occurred since the last ` +
		"session. Read the CURRENT fleet state (state/<id>.meta, state/<id>.status, panes.json, and any " +
		"data/<id>/report.md) and the existing actions_log.jsonl. For each in-flight task that needs a " +
		"supervisor action NOW per RULES.md and is NOT already recorded in actions_log.jsonl, append one " +
		"JSON line: {\"task\": \"<id>\", \"action\": \"<finalize|teardown|escalate>\"}. If nothing new needs " +
		"action, append nothing. Never re-log an action already present. Then stop.",
	(d: string) => writeSnapshot(d, SNAP[i]),
]);

export const SCENARIOS: Scenario[] = [
	{
		id: "fm-supervise-longhorizon",
		difficulty: "aspirational",
		task: "Work a multi-session supervision shift, maintaining actions_log.jsonl across sessions per RULES.md.",
		setup,
		goal,
		procedural,
		oracle,
		leakMarkers: [
			'"task": "alpha", "action": "finalize"',
			'"task": "epsilon", "action": "escalate"',
			'"task": "delta", "action": "teardown"',
		],
		steps: STEPS,
	},
];
