// bridge - buildSnapshot (mates + tasks lenses) + render (roster/tasks/all views).
// Ported from herdr:.omp/extensions/bridge/fleet.test.ts
// Run: bun test tests/fm-bridge.test.ts
//
// Two lenses: MATES (the persistent roster - firstmate + secondmates, presence +
// load) and TASKS (every backlog item, tagged owner/project/state/worker). A
// crewmate is the live worker of an in-flight task and shows on the TASK lens,
// never as a roster person. PENDING is passed in from fm-focus (its own tests
// cover the ranking). These cases lock the lens separation, the view dispatch,
// and render robustness (no overflow, no split surrogate pairs).

import { buildSnapshot, type FleetSnapshot, type HerdrAgent, type ParsedHome, type PendingItem, type PrInfo, render } from "../.omp/extensions/bridge/fleet";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (!cond) {
		console.error(`FAIL ${name}`);
		failures++;
	}
}
function herdrMap(all: HerdrAgent[]): Map<string, HerdrAgent> {
	const m = new Map<string, HerdrAgent>();
	for (const a of all) if (a.pane_id) m.set(a.pane_id, a);
	return m;
}
const NOW = "2026-06-28T22:31:10Z";
const noPending: PendingItem[] = [];

// Fixture: firstmate + secondmate Plum, tasks across both homes, plus a stray pane.
const mainHome: ParsedHome = {
	path: "/main",
	label: "firstmate",
	isMain: true,
	backlog: {
		inflight: [{ id: "feat-x", desc: "build the thing (repo: app)", section: "inflight", resolved: false }],
		queued: [{ id: "refactor-db", desc: "rework schema (repo: app) blocked-by: feat-x", section: "queued", resolved: false }],
		done: [{ id: "old-feat", desc: "shipped (repo: app)", section: "done", pr: "https://github.com/o/r/pull/12", resolved: true }],
	},
	agents: [
		{ id: "plum", meta: { id: "plum", pane: "w15:p2", kind: "secondmate", home: "/sm-plum", raw: {} }, status: { state: "done", text: "ADOPT" } },
		{ id: "feat-x", meta: { id: "feat-x", pane: "w20:p1", raw: {} }, status: { state: "working", text: "building" } },
	],
};
const smHome: ParsedHome = {
	path: "/sm-plum",
	label: "fm-sm-plum",
	isMain: false,
	backlog: { inflight: [{ id: "triage-1", desc: "repro bug (repo: support)", section: "inflight", resolved: false }], queued: [], done: [] },
	agents: [{ id: "triage-1", meta: { id: "triage-1", pane: "w21:p1", raw: {} }, status: { state: "working", text: "reproducing" } }],
};
const herdr: HerdrAgent[] = [
	{ pane_id: "w2:pA", cwd: "/main", agent_status: "idle", name: "firstmate" },
	{ pane_id: "w15:p2", cwd: "/sm-plum", agent_status: "working", name: "plum" },
	{ pane_id: "w20:p1", cwd: "/wt/feat-x", agent_status: "working", name: "feat-x" },
	{ pane_id: "w21:p1", cwd: "/wt/triage-1", agent_status: "working", name: "triage-1" },
	{ pane_id: "w99:p9", cwd: "/elsewhere", agent_status: "idle", name: "stray" },
];
const prByUrl = new Map<string, PrInfo>([["https://github.com/o/r/pull/12", { url: "https://github.com/o/r/pull/12", state: "MERGED", checks: "passing" }]]);

const snap = buildSnapshot([mainHome, smHome], herdrMap(herdr), herdr, prByUrl, noPending, NOW);

// MATES lens: persistent people only, with presence + load.
check("two mates (firstmate + plum)", snap.mates.length === 2);
check("firstmate first: role firstmate, idle, load 1", snap.mates[0]?.name === "firstmate" && snap.mates[0]?.role === "firstmate" && snap.mates[0]?.herdrStatus === "idle" && snap.mates[0]?.load === 1);
check("plum: secondmate, working, load 1", snap.mates[1]?.name === "plum" && snap.mates[1]?.role === "secondmate" && snap.mates[1]?.herdrStatus === "working" && snap.mates[1]?.load === 1);
check("crewmates are NOT mates", !snap.mates.some(m => m.name === "feat-x" || m.name === "triage-1"));

// TASK lens: every backlog item, tagged owner/project/state/worker.
const byId = (id: string): FleetSnapshot["tasks"][number] | undefined => snap.tasks.find(t => t.id === id);
check("feat-x: inflight, owner firstmate, project app, worker working", byId("feat-x")?.state === "inflight" && byId("feat-x")?.owner === "firstmate" && byId("feat-x")?.project === "app" && byId("feat-x")?.workerState === "working");
check("refactor-db: queued, blocked-by feat-x", byId("refactor-db")?.state === "queued" && byId("refactor-db")?.note.includes("blocked-by feat-x") === true);
check("old-feat: done, merged", byId("old-feat")?.state === "done" && byId("old-feat")?.merged === true && byId("old-feat")?.note === "merged");
check("triage-1: owner is plum (mate name, not home dir), project support", byId("triage-1")?.owner === "plum" && byId("triage-1")?.project === "support");
check("only the stray is unaffiliated", snap.otherLivePanes.length === 1 && snap.otherLivePanes[0]?.name === "stray");

// VIEWS: the dispatch shows the right lens for each.
const roster = render(snap, "roster");
check("roster: CREW + NEEDS YOU", roster.includes("CREW") && roster.includes("NEEDS YOU"));
check("roster: lists the mates", roster.includes("firstmate") && roster.includes("plum"));
check("roster: NOT the task board", !roster.includes("IN FLIGHT"));
check("roster is the default view", render(snap) === roster);
const tasks = render(snap, "tasks");
check("tasks: board headers + counts", tasks.includes("IN FLIGHT (2)") && tasks.includes("QUEUED (1)") && tasks.includes("DONE (1)"));
check("tasks: task ids + owners", tasks.includes("feat-x") && tasks.includes("triage-1") && tasks.includes("plum"));
check("tasks: NOT the roster", !tasks.includes("CREW"));
const all = render(snap, "all");
check("all: both lenses", all.includes("CREW") && all.includes("IN FLIGHT (2)"));

// No main home -> empty roster, NEEDS YOU says not read.
const empty = buildSnapshot([], herdrMap([]), [], new Map(), noPending, NOW);
check("no main home -> no mates", empty.mates.length === 0);
check("render: fleet NOT read", render(empty).includes("fleet NOT read"));

// Render robustness: width + surrogate safety, incl. a high-load + long-name mate.
const BOARD_WIDTH = 70;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const stress: FleetSnapshot = {
	generatedAt: NOW,
	pending: [{ cls: "CAPTAIN-BLOCKED", clsRank: 4, home: "really-long-project-name", id: "a-very-long-task-id-exceeding-its-budget", reason: "BLOCKED - a long reason that must clip without overflowing the right edge of the board ever" }],
	mates: [
		{ name: "an-extremely-long-firstmate-name-well-past-the-limit", role: "firstmate", herdrStatus: "idle", load: 12 },
		{ name: "plum", role: "secondmate", herdrStatus: "working", load: 0 },
	],
	tasks: [
		{ id: "a-very-long-task-identifier-that-overflows-the-column", state: "inflight", owner: "firstmate", project: "some-long-project-name", workerState: "working", note: "doing \uD83D\uDE80 a thing with an emoji and a long status that runs well past the right edge" },
		{ id: "q1", state: "queued", owner: "plum", note: "blocked-by something-with-a-long-name" },
		{ id: "d1", state: "done", owner: "plum", note: "merged", merged: true },
	],
	otherLivePanes: [{ name: "a-very-long-other-pane-name-that-should-clip-to-the-budget", status: "idle", cwd: "x" }],
	notes: ["a long degradation note that should clip to the board width without overflowing the edge"],
};
const sr = render(stress, "all");
check("stress: no line exceeds BOARD_WIDTH", sr.split("\n").every(l => [...l].length <= BOARD_WIDTH));
check("stress: no split surrogate pair", !LONE_SURROGATE.test(sr));
check("stress: long content clipped with ellipsis", sr.includes("\u2026"));

if (failures > 0) {
	console.error(`\n${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("bridge mates + tasks + views: all checks pass");
