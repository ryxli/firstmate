// bridge - buildSnapshot (mates + tasks lenses) + render (roster/tasks/all views).
// Ported from herdr:.omp/extensions/bridge/fleet.test.ts
// Run: bun test tests/fm-bridge.test.ts

import { describe, expect, it } from "bun:test";

import {
	buildSnapshot,
	type FleetSnapshot,
	type HerdrAgent,
	type ParsedHome,
	type PendingItem,
	type PrInfo,
	render,
} from "../.omp/extensions/bridge/fleet";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function herdrMap(all: HerdrAgent[]): Map<string, HerdrAgent> {
	const m = new Map<string, HerdrAgent>();
	for (const a of all) if (a.pane_id) m.set(a.pane_id, a);
	return m;
}

const NOW = "2026-06-28T22:31:10Z";
const noPending: PendingItem[] = [];

// Firstmate + secondmate Plum, tasks across both homes, plus a stray pane.
const mainHome: ParsedHome = {
	path: "/main",
	label: "firstmate",
	isMain: true,
	backlog: {
		inflight: [
			{ id: "feat-x", desc: "build the thing (repo: app)", section: "inflight", resolved: false },
			{ id: "wait-pr", desc: "await review (repo: app)", section: "inflight", resolved: false },
			{ id: "blocked-1", desc: "blocked fixture (repo: app)", section: "inflight", resolved: false },
			{ id: "stale-1", desc: "stale fixture (repo: app)", section: "inflight", resolved: false },
		],
		queued: [
			{ id: "refactor-db", desc: "rework schema (repo: app) blocked-by: feat-x", section: "queued", resolved: false },
			{ id: "next-ready", desc: "ship follow-up (repo: app)", section: "queued", resolved: false },
		],
		done: [{ id: "old-feat", desc: "shipped (repo: app)", section: "done", pr: "https://github.com/o/r/pull/12", resolved: true }],
	},
	agents: [
		{ id: "plum", meta: { id: "plum", pane: "w15:p2", kind: "secondmate", home: "/sm-plum", raw: {} }, status: { state: "done", text: "ADOPT" } },
		{ id: "feat-x", meta: { id: "feat-x", pane: "w20:p1", raw: {} }, status: { state: "working", text: "building" } },
		{ id: "wait-pr", meta: { id: "wait-pr", pane: "w20:p2", raw: {} }, status: { state: "done", text: "PR https://github.com/o/r/pull/13" } },
		{ id: "blocked-1", meta: { id: "blocked-1", pane: "w20:p3", raw: {} }, status: { state: "blocked", text: "blocker: schema lock; next: ask db owner" } },
		{ id: "stale-1", meta: { id: "stale-1", pane: "w404:p1", raw: {} }, status: { state: "working", text: "still building" } },
	],
};

const smHome: ParsedHome = {
	path: "/sm-plum",
	label: "fm-sm-plum",
	isMain: false,
	backlog: { inflight: [{ id: "triage-1", desc: "repro bug (repo: support)", section: "inflight", resolved: false }], queued: [], done: [] },
	agents: [{ id: "triage-1", meta: { id: "triage-1", pane: "w21:p1", raw: {} }, status: { state: "working", text: "reproducing" } }],
};

const herdrAgents: HerdrAgent[] = [
	{ pane_id: "w2:pA", cwd: "/main", agent_status: "idle", name: "firstmate" },
	{ pane_id: "w15:p2", cwd: "/sm-plum", agent_status: "working", name: "plum" },
	{ pane_id: "w20:p1", cwd: "/wt/feat-x", agent_status: "working", name: "feat-x" },
	{ pane_id: "w20:p2", cwd: "/wt/wait-pr", agent_status: "idle", name: "wait-pr" },
	{ pane_id: "w20:p3", cwd: "/wt/blocked-1", agent_status: "working", name: "blocked-1" },
	{ pane_id: "w21:p1", cwd: "/wt/triage-1", agent_status: "working", name: "triage-1" },
	{ pane_id: "w99:p9", cwd: "/elsewhere", agent_status: "idle", name: "stray" },
];

const prByUrl = new Map<string, PrInfo>([
	["https://github.com/o/r/pull/12", { url: "https://github.com/o/r/pull/12", state: "MERGED", checks: "passing" }],
	["https://github.com/o/r/pull/13", { url: "https://github.com/o/r/pull/13", state: "OPEN", checks: "pending" }],
]);

const snap = buildSnapshot([mainHome, smHome], herdrMap(herdrAgents), herdrAgents, prByUrl, noPending, NOW);

const byId = (id: string): FleetSnapshot["tasks"][number] | undefined => snap.tasks.find(t => t.id === id);

// ---------------------------------------------------------------------------
// MATES lens
// ---------------------------------------------------------------------------

describe("MATES lens: persistent roster with presence + load", () => {
	it("two mates (firstmate + plum)", () => {
		expect(snap.mates.length).toBe(2);
	});

	it("firstmate first: role firstmate, idle, load 4", () => {
		const m = snap.mates[0];
		expect(m?.name).toBe("firstmate");
		expect(m?.role).toBe("firstmate");
		expect(m?.herdrStatus).toBe("idle");
		expect(m?.load).toBe(4);
	});

	it("plum: secondmate, working, load 1", () => {
		const m = snap.mates[1];
		expect(m?.name).toBe("plum");
		expect(m?.role).toBe("secondmate");
		expect(m?.herdrStatus).toBe("working");
		expect(m?.load).toBe(1);
	});

	it("crewmates (feat-x, triage-1) are NOT mates", () => {
		expect(snap.mates.some(m => m.name === "feat-x" || m.name === "triage-1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// TASK lens
// ---------------------------------------------------------------------------

describe("TASK lens: every backlog item tagged owner/project/state/worker", () => {
	it("feat-x: inflight, owner firstmate, project app, worker working", () => {
		const t = byId("feat-x");
		expect(t?.state).toBe("inflight");
		expect(t?.owner).toBe("firstmate");
		expect(t?.project).toBe("app");
		expect(t?.workerState).toBe("working");
	});

	it("classification/evidence is visible for active work", () => {
		const t = byId("feat-x");
		const rendered = render(snap, "tasks");
		expect(t?.classification).toBe("active");
		expect(t?.evidence).toBe("building");
		expect(rendered).toContain("ACTIVE: building");
	});

	it("classification/evidence is visible for valid waiting", () => {
		const t = byId("wait-pr");
		const rendered = render(snap, "tasks");
		expect(t?.classification).toBe("waiting");
		expect(t?.evidence).toBe("waiting on PR (open, checks pending)");
		expect(rendered).toContain("WAIT: waiting on PR (open, checks pending)");
	});

	it("classification/evidence is visible for blocked work with one blocker and next action", () => {
		const t = byId("blocked-1");
		const rendered = render(snap, "tasks");
		expect(t?.classification).toBe("blocked");
		expect(t?.blocker).toBe("schema lock");
		expect(t?.nextAction).toBe("ask db owner");
		expect(rendered).toContain("BLOCKED: blocked by schema lock; next: ask db owner");
	});

	it("classification/evidence is visible for stale or drifted state", () => {
		const t = byId("stale-1");
		const rendered = render(snap, "tasks");
		expect(t?.classification).toBe("stale");
		expect(t?.evidence).toBe("recorded pane w404:p1 is not live");
		expect(rendered).toContain("STALE: recorded pane w404:p1 is not live");
	});

	it("refactor-db: queued, note includes blocked-by feat-x", () => {
		const t = byId("refactor-db");
		expect(t?.state).toBe("queued");
		expect(t?.note).toContain("blocked-by feat-x");
	});

	it("old-feat: done, merged=true, note='merged', next priority queued", () => {
		const t = byId("old-feat");
		const rendered = render(snap, "tasks");
		expect(t?.state).toBe("done");
		expect(t?.merged).toBe(true);
		expect(t?.note).toBe("merged");
		expect(t?.classification).toBe("complete");
		expect(t?.nextPriority).toBe("next-ready");
		expect(rendered).toContain("DONE: completed and merged; next priority: next-ready");
	});

	it("triage-1: owner is plum (mate name, not home dir), project support", () => {
		const t = byId("triage-1");
		expect(t?.owner).toBe("plum");
		expect(t?.project).toBe("support");
	});

	it("only the stray pane is unaffiliated", () => {
		expect(snap.otherLivePanes.length).toBe(1);
		expect(snap.otherLivePanes[0]?.name).toBe("stray");
	});
});

// ---------------------------------------------------------------------------
// VIEW dispatch
// ---------------------------------------------------------------------------

describe("view dispatch: roster / tasks / all", () => {
	const roster = render(snap, "roster");
	const tasks = render(snap, "tasks");
	const all = render(snap, "all");

	it("roster: contains CREW + NEEDS YOU", () => {
		expect(roster).toContain("CREW");
		expect(roster).toContain("NEEDS YOU");
	});

	it("roster: lists mates by name", () => {
		expect(roster).toContain("firstmate");
		expect(roster).toContain("plum");
	});

	it("roster: does NOT include task board", () => {
		expect(roster).not.toContain("IN FLIGHT");
	});

	it("roster is the default view", () => {
		expect(render(snap)).toBe(roster);
	});

	it("tasks: board headers + counts", () => {
		expect(tasks).toContain("IN FLIGHT (5)");
		expect(tasks).toContain("QUEUED (2)");
		expect(tasks).toContain("DONE (1)");
	});

	it("tasks: task ids + owner names present", () => {
		expect(tasks).toContain("feat-x");
		expect(tasks).toContain("triage-1");
		expect(tasks).toContain("plum");
	});

	it("tasks: does NOT include roster section", () => {
		expect(tasks).not.toContain("CREW");
	});

	it("all: both lenses present", () => {
		expect(all).toContain("CREW");
		expect(all).toContain("IN FLIGHT (5)");
	});
});

// ---------------------------------------------------------------------------
// Empty fleet
// ---------------------------------------------------------------------------

describe("empty fleet (no main home)", () => {
	const empty = buildSnapshot([], herdrMap([]), [], new Map(), noPending, NOW);

	it("no mates", () => {
		expect(empty.mates.length).toBe(0);
	});

	it("render says fleet NOT read", () => {
		expect(render(empty)).toContain("fleet NOT read");
	});
});

// ---------------------------------------------------------------------------
// Render robustness
// ---------------------------------------------------------------------------

describe("render robustness: width + surrogate safety", () => {
	const BOARD_WIDTH = 70;
	const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

	const stress: FleetSnapshot = {
		generatedAt: NOW,
		pending: [{
			cls: "CAPTAIN-BLOCKED",
			clsRank: 4,
			home: "really-long-project-name",
			id: "a-very-long-task-id-exceeding-its-budget",
			reason: "BLOCKED - a long reason that must clip without overflowing the right edge of the board ever",
		}],
		mates: [
			{ name: "an-extremely-long-firstmate-name-well-past-the-limit", role: "firstmate", herdrStatus: "idle", load: 12 },
			{ name: "plum", role: "secondmate", herdrStatus: "working", load: 0 },
		],
		tasks: [
			{ id: "a-very-long-task-identifier-that-overflows-the-column", state: "inflight", owner: "firstmate", project: "some-long-project-name", workerState: "working", classification: "active", evidence: "doing \uD83D\uDE80 a thing with an emoji and a long status that runs well past the right edge", note: "doing \uD83D\uDE80 a thing with an emoji and a long status that runs well past the right edge" },
			{ id: "q1", state: "queued", owner: "plum", classification: "waiting", evidence: "waiting on something-with-a-long-name", note: "blocked-by something-with-a-long-name" },
			{ id: "d1", state: "done", owner: "plum", classification: "complete", evidence: "completed and merged", note: "merged", merged: true },
		],
		otherLivePanes: [{ name: "a-very-long-other-pane-name-that-should-clip-to-the-budget", status: "idle", cwd: "x" }],
		notes: ["a long degradation note that should clip to the board width without overflowing the edge"],
	};

	const sr = render(stress, "all");

	it("no line exceeds BOARD_WIDTH", () => {
		const violations = sr.split("\n").filter(l => [...l].length > BOARD_WIDTH);
		expect(violations).toEqual([]);
	});

	it("no split surrogate pair", () => {
		expect(LONE_SURROGATE.test(sr)).toBe(false);
	});

	it("long content clipped with ellipsis", () => {
		expect(sr).toContain("\u2026");
	});
});
