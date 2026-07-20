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
		inflight: [{ id: "feat-x", desc: "build the thing (repo: app)", section: "inflight", resolved: false }],
		queued: [{ id: "refactor-db", desc: "rework schema (repo: app) blocked-by: feat-x", section: "queued", resolved: false }],
		done: [{ id: "old-feat", desc: "shipped (repo: app)", section: "done", pr: "https://github.com/o/r/pull/12", resolved: true }],
	},
	agents: [
		{ id: "plum", meta: { id: "plum", pane: "w15:p2", kind: "secondmate", home: "/sm-plum", raw: {} }, status: { state: "done", text: "ADOPT" } },
		{ id: "feat-x", meta: { id: "feat-x", pane: "w20:p1", raw: { worktree: "/wt/feat-x" } }, status: { state: "working", text: "building" } },
	],
};

const smHome: ParsedHome = {
	path: "/sm-plum",
	label: "fm-sm-plum",
	isMain: false,
	backlog: { inflight: [{ id: "triage-1", desc: "repro bug (repo: support)", section: "inflight", resolved: false }], queued: [], done: [] },
	agents: [{ id: "triage-1", meta: { id: "triage-1", pane: "w21:p1", raw: { worktree: "/wt/triage-1" } }, status: { state: "working", text: "reproducing" } }],
};

const herdrAgents: HerdrAgent[] = [
	{ pane_id: "w2:pA", cwd: "/main", agent_status: "idle", name: "firstmate" },
	{ pane_id: "w15:p2", cwd: "/sm-plum", agent_status: "working", name: "plum" },
	{ pane_id: "w20:p1", cwd: "/wt/feat-x", agent_status: "working", name: "feat-x" },
	{ pane_id: "w21:p1", cwd: "/wt/triage-1", agent_status: "working", name: "triage-1" },
	{ pane_id: "w99:p9", cwd: "/elsewhere", agent_status: "idle", name: "stray" },
];

const prByUrl = new Map<string, PrInfo>([
	["https://github.com/o/r/pull/12", { url: "https://github.com/o/r/pull/12", state: "MERGED", checks: "passing" }],
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

	it("firstmate: role firstmate, idle, load 1", () => {
		const m = snap.mates.find(mate => mate.name === "firstmate");
		expect(m).toBeDefined();
		expect(m?.role).toBe("firstmate");
		expect(m?.herdrStatus).toBe("idle");
		expect(m?.load).toBe(1);
	});

	it("plum: secondmate, working, load 1", () => {
		const m = snap.mates.find(mate => mate.name === "plum");
		expect(m).toBeDefined();
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

	it("refactor-db: queued, note includes blocked-by feat-x", () => {
		const t = byId("refactor-db");
		expect(t?.state).toBe("queued");
		expect(t?.note).toContain("blocked-by feat-x");
	});

	it("old-feat: done, merged=true, note='merged'", () => {
		const t = byId("old-feat");
		expect(t?.state).toBe("done");
		expect(t?.merged).toBe(true);
		expect(t?.note).toBe("merged");
	});

	it("triage-1: owner is plum (mate name, not home dir), project support", () => {
		const t = byId("triage-1");
		expect(t?.owner).toBe("plum");
		expect(t?.project).toBe("support");
	});

	it("only the stray pane is unaffiliated", () => {
		expect(snap.otherLivePanes.map(p => p.name).sort()).toEqual(["stray"]);
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
		expect(tasks).toContain("IN FLIGHT (2)");
		expect(tasks).toContain("QUEUED (1)");
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
		expect(all).toContain("IN FLIGHT (2)");
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
			cls: "CAP-BLOCKED",
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
			{ id: "a-very-long-task-identifier-that-overflows-the-column", state: "inflight", owner: "firstmate", project: "some-long-project-name", workerState: "working", note: "doing \uD83D\uDE80 a thing with an emoji and a long status that runs well past the right edge" },
			{ id: "q1", state: "queued", owner: "plum", note: "blocked-by something-with-a-long-name" },
			{ id: "d1", state: "done", owner: "plum", note: "merged", merged: true },
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
