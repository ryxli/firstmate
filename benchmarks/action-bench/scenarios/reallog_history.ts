// Real-history-derived scenarios, one per queued source class. Each is a real,
// recurring firstmate decision drawn from actual read-only operational history and
// stripped down to a generic, deterministic fixture - NO raw excerpts, absolute
// paths, hostnames, identities, credentials, or answer leakage is committed.
//
//   fm-done-blocker-scan   source class: backlog Done entries (data/backlog.md ## Done).
//                          A finished task can still record an ESCALATED / remaining
//                          blocker (the real firstmate-gate-base-fix Done entry did:
//                          "SEPARATE remaining blocker escalated to captain ... review
//                          cannot complete"). Treating every [x] as fully closed loses
//                          that open thread. Classify each Done entry clean vs open-blocker.
//
//   fm-status-escalation   source class: state/*.status (crewmate-appended "<state>: <note>"
//                          lines). The supervisor must escalate captain-relevant lines and
//                          suppress internal chatter, exactly per sbin/fm-classify-status.sh.
//                          Over-escalating spams the captain; under-escalating drops a real
//                          blocker/done/PR-ready signal.
//
//   fm-turn-board-audit    source class: session history (the whiteboard turn loop, per
//                          state/whiteboard-metrics.jsonl: trigger/outcome/board-write per
//                          turn). The turn-exit guard requires EVERY turn to write the board;
//                          a turn that ended with no board write is a section-6 incident.
//                          Flag the incident turns from a generic turn log.
//
// Ground truth is COMPUTED from the spec by a deterministic classifier, never
// hand-annotated, so a mislabel would be a visible bug rather than a silent cheat.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

// ===========================================================================
// fm-done-blocker-scan : Done entries that still carry an open blocker (backlog-done)
// ===========================================================================
// Sanitized, generic Done-entry notes (slugs + verification prose only; no URLs, no
// SHAs, no paths). The shapes mirror the real ## Done section: most are cleanly
// landed + verified, but one records an escalated remaining blocker and one needs a
// credential before it can finish.
const DONE_ENTRIES: Record<string, string> = {
	"task-alpha": "landed via review; verified: focused tests, full behavior suite, integrity gates all green.",
	"task-bravo": "labels polished + a stale test realigned; landed on the default branch, verified green, torn down clean.",
	"task-charlie":
		"reset the review gate base clean; registration verified. SEPARATE remaining blocker escalated to captain: the headless review agent fails authentication, so rebase and review cannot complete.",
	"task-delta": "baseline-vs-new A/B bench adopted on all deterministic gates; verified green and landed.",
	"task-echo": "pipeline reworked and shipped; verified. Remaining blocker: needs credential refresh before the nightly run can start.",
	"task-foxtrot": "docs + wrapper cleanup only; verified with shellcheck and the focused test, landed clean.",
};
// A Done entry is OPEN if its note carries any blocker marker; CLEAN otherwise.
const BLOCKER_MARKS = ["remaining blocker", "escalated to captain", "cannot complete", "needs credential", "needs auth", "blocked-by"];
const DONE_ACTIONS = ["clean", "open-blocker"];
const DONE_RULES =
	"# Scan finished tasks for open blockers\n" +
	"Each done/<slug>.txt is the completion note of a task already marked done. Classify EVERY entry as:\n" +
	"  clean         - fully landed AND verified, with no open thread left behind.\n" +
	"  open-blocker  - marked done but the note still records an UNRESOLVED blocker: a remaining\n" +
	"                  blocker, something escalated to the captain, work that cannot complete, or a\n" +
	"                  dependency it still needs (credential/auth/blocked-by).\n" +
	"Write blocker_scan.json as { \"<slug>\": \"clean\"|\"open-blocker\", ... } covering every entry exactly once.\n";

function dbExpected(note: string): string {
	const t = note.toLowerCase();
	return BLOCKER_MARKS.some((m) => t.includes(m)) ? "open-blocker" : "clean";
}

function dbTruth(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [slug, note] of Object.entries(DONE_ENTRIES)) out[slug] = dbExpected(note);
	return out;
}

function dbSetup(d: string): void {
	mkdirSync(join(d, "done"), { recursive: true });
	for (const [slug, note] of Object.entries(DONE_ENTRIES)) writeFileSync(join(d, "done", `${slug}.txt`), `${note}\n`);
	writeFileSync(join(d, "DONE_RULES.md"), DONE_RULES);
}

function dbGoal(d: string): GoalResult {
	const p = join(d, "blocker_scan.json");
	if (!existsSync(p)) return goalResult(false, 0, "blocker_scan.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) return goalResult(false, 0, "blocker_scan.json is not an object");
	const gotObj = got as Record<string, unknown>;
	const truth = Object.entries(dbTruth());
	let correct = 0;
	for (const [slug, want] of truth) {
		let gv: unknown = gotObj[slug];
		if (typeof gv === "string") gv = gv.trim();
		if (gv === want) correct += 1;
	}
	const covered = truth.every(([slug]) => slug in gotObj);
	const progress = Math.round((correct / truth.length) * 1000) / 1000;
	return goalResult(correct === truth.length && covered, progress, `${correct}/${truth.length} classified${covered ? "" : " (missing slugs)"}`);
}

function dbProc(d: string): ProcResult {
	const rulesOk = readFileSync(join(d, "DONE_RULES.md"), "utf8") === DONE_RULES;
	const entriesOk = Object.entries(DONE_ENTRIES).every(([slug, note]) => readFileSync(join(d, "done", `${slug}.txt`), "utf8") === `${note}\n`);
	const p = join(d, "blocker_scan.json");
	let valid = existsSync(p);
	let vocabOk = true;
	if (valid) {
		try {
			const got = JSON.parse(readFileSync(p, "utf8"));
			vocabOk =
				typeof got === "object" && got !== null && !Array.isArray(got) && Object.values(got as Record<string, unknown>).every((v) => DONE_ACTIONS.includes(v as string));
		} catch {
			valid = false;
		}
	}
	const ok = rulesOk && entriesOk && valid && vocabOk;
	return procResult(ok, `rules_unchanged=${rulesOk} entries_unchanged=${entriesOk} valid=${valid} vocab_ok=${vocabOk}`);
}

function dbOracle(d: string): Trace {
	writeFileSync(join(d, "blocker_scan.json"), JSON.stringify(dbTruth(), null, 2));
	return trace(true, 150, 3, [toolCall("read", "DONE_RULES.md"), toolCall("read", "done"), toolCall("write", "blocker_scan.json")], JSON.stringify(dbTruth()));
}

// ===========================================================================
// fm-status-escalation : captain-relevant vs internal status lines (state-status)
// ===========================================================================
// Generic crewmate status lines. The classifier mirrors sbin/fm-classify-status.sh:
// a leading ISO timestamp is ignored; a `working` prefix is internal; a
// done/blocked/failed/needs-decision prefix OR a word-bounded PR ready / checks green
// / ready in branch / merged phrase is captain; everything else is internal.
const STATUS_LINES: Record<string, string> = {
	s0: "working: setup complete, starting the implementation",
	s1: "done: ready in branch feature-slug",
	s2: "blocked: an upstream dependency is missing",
	s3: "working on the migration, roughly halfway through",
	s4: "needs-decision: two equally good designs, need a tie-break",
	s5: "checks green on the focused gate",
	s6: "investigating the flaky reproduction",
	s7: "failed: the reproduction never converged",
	s8: "PR ready for review",
	s9: "reading through the scenario files",
};
const STATUS_ACTIONS = ["captain", "internal"];
const STATUS_RULES =
	"# Escalate crewmate status lines\n" +
	"Each line in status_lines.txt is `<id> <status text>`. Classify each id as:\n" +
	"  captain   - the supervisor must surface it: the text (after any leading ISO timestamp) begins\n" +
	"              with done:, blocked:, failed:, or needs-decision:, OR it contains the phrase\n" +
	"              'PR ready', 'checks green', 'ready in branch', or 'merged'.\n" +
	"  internal  - routine progress the supervisor suppresses: a 'working' prefix, or anything else.\n" +
	"Write escalation.json as { \"<id>\": \"captain\"|\"internal\", ... } covering every id exactly once.\n";

const STATUS_PHRASE = /(^|[^a-z])(pr ready|checks green|ready in branch|merged)([^a-z]|$)/;

function seExpected(text: string): string {
	const line = text.replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T\S+\s+/, "").toLowerCase();
	if (/^working([\s:])/.test(line)) return "internal";
	if (/^(done|blocked|failed|needs-decision):/.test(line)) return "captain";
	if (STATUS_PHRASE.test(line)) return "captain";
	return "internal";
}

function seTruth(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, text] of Object.entries(STATUS_LINES)) out[id] = seExpected(text);
	return out;
}

function seFileBody(): string {
	return `${Object.entries(STATUS_LINES)
		.map(([id, text]) => `${id} ${text}`)
		.join("\n")}\n`;
}

function seSetup(d: string): void {
	writeFileSync(join(d, "status_lines.txt"), seFileBody());
	writeFileSync(join(d, "STATUS_RULES.md"), STATUS_RULES);
}

function seGoal(d: string): GoalResult {
	const p = join(d, "escalation.json");
	if (!existsSync(p)) return goalResult(false, 0, "escalation.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) return goalResult(false, 0, "escalation.json is not an object");
	const gotObj = got as Record<string, unknown>;
	const truth = Object.entries(seTruth());
	let correct = 0;
	for (const [id, want] of truth) {
		let gv: unknown = gotObj[id];
		if (typeof gv === "string") gv = gv.trim();
		if (gv === want) correct += 1;
	}
	const covered = truth.every(([id]) => id in gotObj);
	const progress = Math.round((correct / truth.length) * 1000) / 1000;
	return goalResult(correct === truth.length && covered, progress, `${correct}/${truth.length} classified${covered ? "" : " (missing ids)"}`);
}

function seProc(d: string): ProcResult {
	const rulesOk = readFileSync(join(d, "STATUS_RULES.md"), "utf8") === STATUS_RULES;
	const linesOk = readFileSync(join(d, "status_lines.txt"), "utf8") === seFileBody();
	const p = join(d, "escalation.json");
	let valid = existsSync(p);
	let vocabOk = true;
	if (valid) {
		try {
			const got = JSON.parse(readFileSync(p, "utf8"));
			vocabOk =
				typeof got === "object" && got !== null && !Array.isArray(got) && Object.values(got as Record<string, unknown>).every((v) => STATUS_ACTIONS.includes(v as string));
		} catch {
			valid = false;
		}
	}
	const ok = rulesOk && linesOk && valid && vocabOk;
	return procResult(ok, `rules_unchanged=${rulesOk} lines_unchanged=${linesOk} valid=${valid} vocab_ok=${vocabOk}`);
}

function seOracle(d: string): Trace {
	writeFileSync(join(d, "escalation.json"), JSON.stringify(seTruth(), null, 2));
	return trace(true, 150, 3, [toolCall("read", "STATUS_RULES.md"), toolCall("read", "status_lines.txt"), toolCall("write", "escalation.json")], JSON.stringify(seTruth()));
}

// ===========================================================================
// fm-turn-board-audit : turns that skipped the board-write exit guard (session-history)
// ===========================================================================
// A generic whiteboard turn log (trigger/outcome/board-write per turn), mirroring the
// real state/whiteboard-metrics.jsonl shape. The turn-exit guard: EVERY turn writes
// the board, so a turn with board_write=false is a section-6 incident regardless of
// its outcome. Flag exactly those turn ids.
interface TurnRec {
	id: string;
	trigger: string;
	board_write: boolean;
	outcome: string;
}
const TURNS: TurnRec[] = [
	{ id: "t1", trigger: "steer", board_write: true, outcome: "progress" },
	{ id: "t2", trigger: "tick", board_write: false, outcome: "progress" },
	{ id: "t3", trigger: "subagent-return", board_write: true, outcome: "settled" },
	{ id: "t4", trigger: "tick", board_write: true, outcome: "blocked" },
	{ id: "t5", trigger: "none", board_write: false, outcome: "progress" },
	{ id: "t6", trigger: "message", board_write: true, outcome: "needs-decision" },
	{ id: "t7", trigger: "tick", board_write: false, outcome: "error" },
];
const TBA_RULES =
	"# Audit the whiteboard turn loop\n" +
	"turns.json is a list of turn records { id, trigger, board_write, outcome }. The turn-exit guard\n" +
	"requires EVERY turn to write the whiteboard before it ends; a turn that ended with board_write\n" +
	"false is an incident, no matter its outcome. List every incident turn id.\n" +
	"Write audit.json as { \"incidents\": [\"<id>\", ...] } with the ids in the order they appear.\n";

function tbaTruth(): string[] {
	return TURNS.filter((t) => !t.board_write).map((t) => t.id);
}

function tbaSetup(d: string): void {
	writeFileSync(join(d, "turns.json"), JSON.stringify(TURNS, null, 2));
	writeFileSync(join(d, "TBA_RULES.md"), TBA_RULES);
}

function tbaGoal(d: string): GoalResult {
	const p = join(d, "audit.json");
	if (!existsSync(p)) return goalResult(false, 0, "audit.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `invalid json: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got) || !Array.isArray((got as Record<string, unknown>).incidents)) {
		return goalResult(false, 0, "audit.json needs an `incidents` array");
	}
	const gotList = ((got as Record<string, unknown>).incidents as unknown[]).map((x) => (typeof x === "string" ? x.trim() : x));
	const want = tbaTruth();
	const ok = gotList.length === want.length && want.every((id, i) => gotList[i] === id);
	const hit = want.filter((id) => gotList.includes(id)).length;
	const spurious = gotList.filter((id) => !want.includes(id as string)).length;
	const progress = ok ? 1 : Math.max(0, Math.round(((hit - spurious) / want.length) * 1000) / 1000);
	return goalResult(ok, progress, `incidents=${JSON.stringify(gotList)} (truth=${JSON.stringify(want)})`);
}

function tbaProc(d: string): ProcResult {
	const rulesOk = readFileSync(join(d, "TBA_RULES.md"), "utf8") === TBA_RULES;
	const turnsOk = readFileSync(join(d, "turns.json"), "utf8") === JSON.stringify(TURNS, null, 2);
	const p = join(d, "audit.json");
	let valid = existsSync(p);
	if (valid) {
		try {
			const got = JSON.parse(readFileSync(p, "utf8"));
			valid = typeof got === "object" && got !== null && !Array.isArray(got) && Array.isArray((got as Record<string, unknown>).incidents);
		} catch {
			valid = false;
		}
	}
	const ok = rulesOk && turnsOk && valid;
	return procResult(ok, `rules_unchanged=${rulesOk} turns_unchanged=${turnsOk} valid=${valid}`);
}

function tbaOracle(d: string): Trace {
	writeFileSync(join(d, "audit.json"), JSON.stringify({ incidents: tbaTruth() }, null, 2));
	return trace(true, 130, 3, [toolCall("read", "TBA_RULES.md"), toolCall("read", "turns.json"), toolCall("write", "audit.json")], JSON.stringify(tbaTruth()));
}

export const SCENARIOS: Scenario[] = [
	{
		id: "fm-done-blocker-scan",
		difficulty: "medium",
		task: "Several finished tasks are recorded under done/, each already marked done. Following DONE_RULES.md, decide for each whether it is truly clean or still carries an open blocker, and write blocker_scan.json. Then stop.",
		setup: dbSetup,
		goal: dbGoal,
		procedural: dbProc,
		oracle: dbOracle,
		leakMarkers: ['"task-charlie": "open-blocker"', '"task-echo": "open-blocker"', '"task-alpha": "clean"'],
		history: { sourceClass: "backlog-done" },
	},
	{
		id: "fm-status-escalation",
		difficulty: "medium",
		task: "status_lines.txt holds several crewmate status lines. Classify each per STATUS_RULES.md into captain vs internal and write escalation.json. Then stop.",
		setup: seSetup,
		goal: seGoal,
		procedural: seProc,
		oracle: seOracle,
		leakMarkers: ['"s0": "internal"', '"s1": "captain"', '"s8": "captain"'],
		history: { sourceClass: "state-status" },
	},
	{
		id: "fm-turn-board-audit",
		difficulty: "medium",
		task: "turns.json is a log of whiteboard turns. Following TBA_RULES.md, find every turn that ended without writing the board and write the incident ids to audit.json. Then stop.",
		setup: tbaSetup,
		goal: tbaGoal,
		procedural: tbaProc,
		oracle: tbaOracle,
		leakMarkers: ['"incidents": ["t2", "t5", "t7"]', '"t2","t5","t7"'],
		history: { sourceClass: "session-history" },
	},
];
