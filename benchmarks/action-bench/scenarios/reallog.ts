// Real-log-derived scenarios - sanitized building blocks from our actual operational history.
//
// These are not synthetic puzzles; each is a real, recurring firstmate decision that bit us,
// stripped of secrets / absolute paths / machine specifics into a generic, deterministic fixture:
//
//   fm-landed-check     From the documented no-mistakes remote-ref false-positive: a teardown
//                       "landed?" check that treats a branch pushed only to the LOCAL gate remote
//                       as landed (git log HEAD --not --remotes counts refs/remotes/no-mistakes/*),
//                       which could discard genuinely-unlanded work. The correct rule is reachability
//                       from the ORIGIN default (or local default), never "any remote". Real bug.
//
//   fm-triage-transient From our retry logic vs the real claude-401 blocker: classify each crewmate
//                       failure as a TRANSIENT error to retry (rate/usage cap, 5xx, overloaded,
//                       timeout) or a GENUINE blocker to escalate (auth 401, missing dep, permission).
//                       Over-escalating wastes the supervisor; over-retrying loops on a hard blocker.
//
// Ground truth is COMPUTED from the spec (a deterministic classifier), never hand-annotated, so a
// mislabel would be a visible bug, not a silent cheat. Outcome-only tasks, multi-path goals,
// procedural guards against tampering / invented verdicts, oracle positive controls, leak markers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

// ===========================================================================
// fm-landed-check : the local-gate-remote "landed" false positive (real bug)
// ===========================================================================
const LC_REACH = {
	branch: "fm/feature-x",
	head: "a1b2c3d",
	// which refs contain the head commit
	refs: {
		"refs/heads/fm/feature-x": true, // the branch tip itself
		"refs/heads/main": false, // local default - does NOT contain it
		"refs/remotes/origin/main": false, // origin default - does NOT contain it
		"refs/remotes/no-mistakes/fm/feature-x": true, // pushed to the LOCAL review gate only
	} as Record<string, boolean>,
	origin_default_ref: "refs/remotes/origin/main",
	local_default_ref: "refs/heads/main",
};
const LC_RULES =
	"# Is the work landed?\n" +
	"Work on the branch is \"landed\" (its worktree is safe to remove) IF AND ONLY IF its head commit\n" +
	"is reachable from EITHER the origin default branch (reachability.json origin_default_ref) OR the\n" +
	"local default branch (local_default_ref). Being pushed to the local no-mistakes gate remote\n" +
	"(refs/remotes/no-mistakes/*) does NOT count as landed - that remote is only the local review\n" +
	"gate, not a real published remote. Reachability per ref is in reachability.json (\"refs\").\n" +
	"Write your verdict to verdict.json with a boolean `landed` and a short `reason`.\n";

function lcSetup(d: string): void {
	writeFileSync(join(d, "reachability.json"), JSON.stringify(LC_REACH, null, 2));
	writeFileSync(join(d, "LANDED_RULES.md"), LC_RULES);
}

// canonical ground truth: landed IFF the head is reachable from origin OR local default.
function lcTruth(): boolean {
	const r = LC_REACH.refs;
	return Boolean(r[LC_REACH.origin_default_ref] || r[LC_REACH.local_default_ref]);
}

function lcGoal(d: string): GoalResult {
	const p = join(d, "verdict.json");
	if (!existsSync(p)) return goalResult(false, 0, "verdict.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got) || !("landed" in got)) {
		return goalResult(false, 0, "verdict.json needs a `landed` field");
	}
	let v: unknown = (got as Record<string, unknown>).landed;
	if (typeof v === "string") v = v.trim().toLowerCase() === "true";
	const ok = Boolean(v) === lcTruth(); // truth is False: only on the gate remote, not origin/local default
	return goalResult(ok, ok ? 1 : 0, `landed=${Boolean(v)} (truth=${lcTruth()})`);
}

function lcProc(d: string): ProcResult {
	const reachOk = readFileSync(join(d, "reachability.json"), "utf8") === JSON.stringify(LC_REACH, null, 2);
	const rulesOk = readFileSync(join(d, "LANDED_RULES.md"), "utf8") === LC_RULES;
	const p = join(d, "verdict.json");
	let valid = existsSync(p);
	if (valid) {
		try {
			const g = JSON.parse(readFileSync(p, "utf8"));
			valid = typeof g === "object" && g !== null && !Array.isArray(g) && "landed" in g;
		} catch {
			valid = false;
		}
	}
	const ok = reachOk && rulesOk && valid;
	return procResult(ok, `reach_unchanged=${reachOk} rules_unchanged=${rulesOk} valid_verdict=${valid}`);
}

function lcOracle(d: string): Trace {
	writeFileSync(
		join(d, "verdict.json"),
		JSON.stringify(
			{
				landed: false,
				reason:
					"head is reachable only from the branch tip and the local no-mistakes gate remote; " +
					"neither origin/main nor local main contains it, so it is not landed",
			},
			null,
			2,
		),
	);
	return trace(
		true,
		120,
		3,
		[toolCall("read", "reachability.json"), toolCall("read", "LANDED_RULES.md"), toolCall("write", "verdict.json")],
		"not landed",
	);
}

// ===========================================================================
// fm-triage-transient : transient-retry vs genuine-blocker (real episodes)
// ===========================================================================
const INCIDENTS: Record<string, string> = {
	"inc-rate": "429 Too Many Requests: rate limit exceeded, retry after 30s",
	"inc-usage": "The usage limit has been reached (code=usage_limit_reached)",
	"inc-auth": "401 Invalid authentication credentials",
	"inc-5xx": "503 Service Unavailable: upstream temporarily down",
	"inc-dep": "ModuleNotFoundError: No module named 'reportlib'",
	"inc-overload": "overloaded_error: the server is overloaded, please try again",
	"inc-perm": "Permission denied (publickey). fatal: could not read from remote repository",
	"inc-timeout": "request timed out after 60s waiting for the model",
};
const TRANSIENT_MARKS = ["rate limit", "429", "usage limit", "quota", "overloaded", "temporarily", "timed out", "timeout", "503", "service unavailable", "5xx", "try again"];
const TRIAGE_ACTIONS = ["retry", "escalate"];
const TRIAGE_RULES =
	"# Incident triage\n" +
	"Each incidents/<id>.txt holds one crewmate failure. Classify EVERY incident as exactly one of:\n" +
	"  retry     - a TRANSIENT provider/infra error that clears on its own: a rate limit / 429, a\n" +
	"              usage or quota cap, a 5xx / \"service unavailable\" / \"temporarily\" / \"overloaded\"\n" +
	"              server error, or a timeout.\n" +
	"  escalate  - a GENUINE blocker that needs a supervisor decision: authentication failures\n" +
	"              (401 / invalid credentials), missing dependencies, permission or access denials,\n" +
	"              or any other non-transient config/logic error.\n" +
	"Write triage.json as { \"<id>\": \"retry\"|\"escalate\", ... } covering every incident exactly once.\n";

// canonical classifier: transient (retry) IFF any transient marker appears, else escalate.
function triageExpected(text: string): string {
	const t = text.toLowerCase();
	return TRANSIENT_MARKS.some((m) => t.includes(m)) ? "retry" : "escalate";
}

function triageTruth(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [tid, txt] of Object.entries(INCIDENTS)) out[tid] = triageExpected(txt);
	return out;
}

function trSetup(d: string): void {
	mkdirSync(join(d, "incidents"), { recursive: true });
	for (const [tid, txt] of Object.entries(INCIDENTS)) {
		writeFileSync(join(d, "incidents", `${tid}.txt`), `${txt}\n`);
	}
	writeFileSync(join(d, "TRIAGE_RULES.md"), TRIAGE_RULES);
}

function trGoal(d: string): GoalResult {
	const p = join(d, "triage.json");
	if (!existsSync(p)) return goalResult(false, 0, "triage.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) {
		return goalResult(false, 0, "triage.json is not an object");
	}
	const gotObj = got as Record<string, unknown>;
	const truthEntries = Object.entries(triageTruth());
	let correct = 0;
	for (const [tid, want] of truthEntries) {
		let gv: unknown = gotObj[tid];
		if (typeof gv === "string") gv = gv.trim();
		if (gv === want) correct += 1;
	}
	const covered = truthEntries.every(([tid]) => tid in gotObj);
	const progress = Math.round((correct / truthEntries.length) * 1000) / 1000;
	return goalResult(
		correct === truthEntries.length && covered,
		progress,
		`${correct}/${truthEntries.length} triaged correctly${covered ? "" : " (missing ids)"}`,
	);
}

function trProc(d: string): ProcResult {
	const rulesOk = readFileSync(join(d, "TRIAGE_RULES.md"), "utf8") === TRIAGE_RULES;
	const incOk = Object.entries(INCIDENTS).every(([tid, txt]) => readFileSync(join(d, "incidents", `${tid}.txt`), "utf8") === `${txt}\n`);
	const p = join(d, "triage.json");
	let valid = existsSync(p);
	let vocabOk = true;
	if (valid) {
		try {
			const got = JSON.parse(readFileSync(p, "utf8"));
			vocabOk = typeof got === "object" && got !== null && !Array.isArray(got) && Object.values(got as Record<string, unknown>).every((v) => TRIAGE_ACTIONS.includes(v as string));
		} catch {
			valid = false;
		}
	}
	const ok = rulesOk && incOk && valid && vocabOk;
	return procResult(ok, `rules_unchanged=${rulesOk} incidents_unchanged=${incOk} valid=${valid} vocab_ok=${vocabOk}`);
}

function trOracle(d: string): Trace {
	writeFileSync(join(d, "triage.json"), JSON.stringify(triageTruth(), null, 2));
	return trace(
		true,
		140,
		3,
		[toolCall("read", "TRIAGE_RULES.md"), toolCall("read", "incidents"), toolCall("write", "triage.json")],
		JSON.stringify(triageTruth()),
	);
}

export const SCENARIOS: Scenario[] = [
	{
		id: "fm-landed-check",
		difficulty: "medium",
		task: "A finished task's branch is a candidate for worktree removal. Using reachability.json and LANDED_RULES.md, decide whether the branch's work has truly landed and write your verdict to verdict.json. Then stop.",
		setup: lcSetup,
		goal: lcGoal,
		procedural: lcProc,
		oracle: lcOracle,
		leakMarkers: ['"landed": false', '"landed":false'],
		history: { sourceClass: "backlog-done" },
	},
	{
		id: "fm-triage-transient",
		difficulty: "medium",
		task: "Several crewmate failures are recorded under incidents/. Triage each one per TRIAGE_RULES.md and write your classification to triage.json. Then stop.",
		setup: trSetup,
		goal: trGoal,
		procedural: trProc,
		oracle: trOracle,
		leakMarkers: ['"inc-auth": "escalate"', '"inc-usage": "retry"', '"inc-dep": "escalate"'],
		history: { sourceClass: "session-history" },
	},
];
