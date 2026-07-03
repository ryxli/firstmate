// Long-horizon HARD variant - pushes the multi-session substrate to stress even strong models.
//
// A 10-session shift over a busier, churning fleet (9 tasks) under counterintuitive rules. The
// agent maintains actions_log.jsonl across fresh sessions and must record each needed (task, action)
// EXACTLY ONCE. What makes it hard beyond the base variant:
//   - counterintuitive rules: an idle secondmate is healthy (no action); a scout that is idle with a
//     "done:" line but NO report is an anomaly (escalate, not teardown); the LAST status line wins.
//   - state RE-OPENINGS: a task can need two DIFFERENT actions over the shift (e.g. a ship finalized
//     early, then a regression reopens it -> escalate). The agent must track (task, action) PAIRS, not
//     just "have I seen this task", across 10 sessions of fresh context - so it must log the second
//     action while never re-logging the first.
//   - many persistent done/idle tasks that stay actionable-looking for the rest of the shift, tempting
//     re-logs every session.
//
// Ground truth is computed from the deterministic timeline (dedup simulation), so it cannot be
// hand-mis-tagged. Runs on the engine's multi-session `steps`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Step, type Trace, type TraceArg, goalResult, procResult, toolCall, trace } from "../types.ts";

const KIND: Record<string, string> = {
	a1: "ship", a2: "scout", a3: "ship", a4: "secondmate", a5: "scout",
	a6: "ship", a7: "ship", a8: "scout", a9: "ship",
};
const PANE: Record<string, string> = Object.fromEntries(Object.keys(KIND).map((t, i) => [t, `p${i + 1}`]));
const ACTIONS = ["finalize", "teardown", "escalate"];

const RULES = `# Supervisor action rules
Pane status is in panes.json (keyed by meta pane=); always use the LAST line of the status file.
  finalize - a ship (kind=ship) whose pane is idle and whose latest status begins "done:".
  teardown - a scout (kind=scout) whose pane is idle, latest begins "done:", AND its report
             data/<id>/report.md exists.
  escalate - any task whose latest status begins "blocked:", "needs-decision:", or "failed:";
             OR a scout idle with a "done:" line but no report (a done claim, no deliverable).
An idle SECONDMATE (kind=secondmate) is healthy - never action it unless its latest line is an
escalate trigger. Otherwise no action. A task may need DIFFERENT actions at different times (e.g. a
finalized ship that later fails); log each distinct (task, action) EXACTLY ONCE across the whole
shift - if actions_log.jsonl already has that {task, action} line, never add it again.
`;

// One snapshot per session: task -> [paneStatus, lastStatus, hasReport].
type Snap = Record<string, [string, string, boolean]>;

// base state (persists until a delta changes it): task -> [paneStatus, lastStatus, hasReport]
const BASE: Snap = {
	a1: ["working", "working: impl", false],
	a2: ["working", "working: investigate", false],
	a4: ["idle", "idle: tending domain", false],
};
// per-session deltas (session i applies deltas[i] on top of the running state)
const DELTAS: Snap[] = [
	{ a1: ["idle", "done: PR open", false] },
	{ a2: ["idle", "done: report ready", true], a3: ["working", "working: build", false] },
	{ a3: ["idle", "needs-decision: which lib", false], a5: ["working", "working: repro", false] },
	{ a5: ["idle", "done: analysis ready", false], a6: ["working", "working: impl", false] },
	{ a1: ["idle", "failed: regression hit", false], a3: ["working", "working: decided, continuing", false] },
	{ a6: ["idle", "working: still going", false], a7: ["idle", "done: shipped", false] },
	{ a8: ["idle", "done: notes ready", true], a5: ["working", "working: reworking", false] },
	{ a4: ["idle", "needs-decision: route conflict", false] },
	{ a9: ["idle", "done: PR2 open", false], a1: ["working", "working: fixing regression", false] },
	{ a3: ["idle", "done: PR3 open", false] },
];

function buildSnaps(): Snap[] {
	const snaps: Snap[] = [];
	let cur: Snap = { ...BASE };
	for (const delta of DELTAS) {
		cur = { ...cur, ...delta };
		snaps.push({ ...cur });
	}
	return snaps;
}

const SNAP: Snap[] = buildSnaps();

function actionFor(task: string, paneStatus: string, lastStatus: string, hasReport: boolean): string | null {
	const s = lastStatus.trim();
	if (s.startsWith("blocked:") || s.startsWith("needs-decision:") || s.startsWith("failed:")) {
		return "escalate";
	}
	if (KIND[task] === "secondmate") {
		return null;
	}
	if (paneStatus === "idle" && s.startsWith("done:")) {
		if (KIND[task] === "scout") {
			return hasReport ? "teardown" : "escalate";
		}
		return "finalize";
	}
	return null;
}

// Walk the timeline; each distinct (task, action) is logged once, at first appearance.
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
		writeFileSync(join(d, "state", `${task}.meta`), `kind=${KIND[task]}\npane=${PANE[task]}\n`);
		writeFileSync(join(d, "state", `${task}.status`), `${last}\n`);
		panes[PANE[task]] = ps;
		if (rep) {
			mkdirSync(join(d, "data", task), { recursive: true });
			writeFileSync(join(d, "data", task, "report.md"), "# report\ndelivered.\n");
		}
	}
	writeFileSync(join(d, "panes.json"), JSON.stringify(panes, null, 2));
}

function setup(d: string): void {
	writeFileSync(join(d, "RULES.md"), RULES);
	writeFileSync(join(d, "actions_log.jsonl"), "");
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
		return goalResult(false, 0.0, "actions_log.jsonl malformed");
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
		`${matched}/${expected.size} unique actions; logged ${got.length} lines`,
	);
}

function procedural(d: string, _tr: TraceArg): ProcResult {
	const rulesOk = readFileSync(join(d, "RULES.md"), "utf8") === RULES;
	const pairs = readLog(d);
	const valid = Array.isArray(pairs);
	let fabricated = false;
	let vocabBad = false;
	if (Array.isArray(pairs)) {
		for (const [t, a] of pairs) {
			if (!Object.hasOwn(KIND, t)) {
				fabricated = true;
			}
			if (!ACTIONS.includes(a)) {
				vocabBad = true;
			}
		}
	}
	const ok = rulesOk && valid && !fabricated && !vocabBad;
	return procResult(ok, `rules_unchanged=${rulesOk} valid_log=${valid} fabricated_id=${fabricated} vocab_bad=${vocabBad}`);
}

function oracle(d: string): Trace[] {
	writeSnapshot(d, SNAP[SNAP.length - 1]);
	let log = "";
	for (const [task, act] of expectedLog()) {
		log += `{"task": "${task}", "action": "${act}"}\n`;
	}
	writeFileSync(join(d, "actions_log.jsonl"), log);
	return SNAP.map(() =>
		trace(true, 140, 4, [toolCall("read", "state"), toolCall("write", "actions_log.jsonl")], "session"),
	);
}

const STEPS: Step[] = SNAP.map((_snap, i): Step => [
	`Session ${i + 1} of a 10-session supervision shift over a busy fleet. New events may have ` +
		"occurred. Read the CURRENT fleet state (state/<id>.meta, state/<id>.status, panes.json, and any " +
		"data/<id>/report.md) and the existing actions_log.jsonl. For each task that needs a supervisor " +
		"action NOW per RULES.md and whose exact {\"task\",\"action\"} pair is NOT already in " +
		"actions_log.jsonl, append one JSON line {\"task\": \"<id>\", \"action\": \"<finalize|teardown|escalate>\"}. " +
		"A task may legitimately need a NEW, different action even if a prior different action of its is " +
		"already logged. If nothing new needs action, append nothing. Then stop.",
	(d: string) => writeSnapshot(d, SNAP[i]),
]);

export const SCENARIOS: Scenario[] = [
	{
		id: "fm-supervise-longhorizon-hard",
		difficulty: "aspirational",
		task: "Work a 10-session supervision shift over a churning fleet, maintaining actions_log.jsonl per RULES.md.",
		setup,
		goal,
		procedural,
		oracle,
		leakMarkers: [
			'"task": "a1", "action": "escalate"',
			'"task": "a3", "action": "finalize"',
			'"task": "a4", "action": "escalate"',
		],
		steps: STEPS,
	},
];
