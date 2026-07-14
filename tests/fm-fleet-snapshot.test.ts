import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { attentionFor, collectSnapshot, findTask, normalizeTaskState } from "../.omp/extensions/bridge/collect";
import { parseStatus, render } from "../.omp/extensions/bridge/fleet";
import type { AgentRow, ParsedHome, StatusState } from "../.omp/extensions/bridge/fleet";
const FIXTURE_MANIFEST = "fixture manifest\n";

function receiptManifestHash(content: string): string {
	const fileHash = createHash("sha256").update(content).digest("hex");
	return createHash("sha256").update(`AGENTS.md\0${fileHash}\0`).digest("hex");
}

function fixtureHome(): { home: string; panes: string } {
	const root = mkdtempSync(join(tmpdir(), "fleet-snapshot-"));
	const home = join(root, "home");
	const panes = join(root, "panes.json");
	mkdirSync(join(home, "data"), { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	writeFileSync(join(home, "AGENTS.md"), FIXTURE_MANIFEST);
	mkdirSync(join(home, "config"), { recursive: true });
	mkdirSync(join(home, "sbin"), { recursive: true });
	writeFileSync(join(home, "sbin", "fm-spawn.sh"), "");
	writeFileSync(join(home, "data", "backlog.md"), [
		"## In flight",
		"- **self** - ship main (repo: app)",
		"## Queued",
		"- [ ] **queued** - wait (repo: app) blocked-by: self",
		"## Done",
		"- [x] **old** - shipped (repo: app)",
	].join("\n"));
	writeFileSync(panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" }] } }));
	writeFileSync(join(home, "state", "self.meta"), "pane=w1:p1\nkind=ship\nworker=self\n");
	writeFileSync(join(home, "state", "self.status"), "working: building\n");
	return { home, panes };
}

describe("canonical FleetSnapshot collector", () => {
	it("reads all backlog sections and emits owner-qualified task keys", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
			const receiptPath = join(fixture.home, "state", "activation-receipt.json");
			writeFileSync(receiptPath, JSON.stringify({
				schema: "firstmate.activation-receipt/v1",
				manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST),
				pane_id: "w1:p1",
				session_id: "session-1",
				started_at: "2026-07-13T00:00:00Z",
			}));
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.schema).toBe("fleet-snapshot/1");
			expect(snapshot.tasks.map(task => task.key)).toEqual(["home/self", "home/queued", "home/old"]);
			expect(snapshot.tasks.filter(task => task.state === "inflight")).toHaveLength(1);
			expect(snapshot.tasks.filter(task => task.state === "queued")).toHaveLength(1);
			expect(snapshot.tasks.filter(task => task.state === "done")).toHaveLength(1);
			expect(snapshot.tasks.find(task => task.key === "home/self")?.topology?.workspace).toBe("w1");
			expect(snapshot.health?.herdr).toBe("ok");
			expect(snapshot.metrics).toBeUndefined();
			expect(snapshot.agents?.find(agent => agent.id === "self")?.key).toBe("home/self");
			expect(snapshot.activation).toMatchObject({ state: "fresh", fresh: 1, stale: 0, unknown: 0 });
			expect(snapshot.identity).toMatchObject({ state: "bound", bound: 1, mismatch: 0, unknown: 0 });
			expect(snapshot.health?.state).toBe("healthy");
			expect(snapshot.attention?.find(item => item.id === "self")?.cls).toBe("IN-FLIGHT");
			expect(snapshot.pending).toEqual([]);
			expect(render(snapshot, "roster")).toContain("all clear");
			writeFileSync(join(fixture.home, "state", "done.meta"), "kind=ship\nworker=done\npane=w1:p2\n");
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
				{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "idle", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" },
				{ pane_id: "w1:p2", cwd: fixture.home, agent_status: "done", workspace_id: "w1", tab_id: "t1", agent: "omp" },
			] } }));
			writeFileSync(join(fixture.home, "state", "self.status"), "done: PR checks green\n");
			const provenance = await collectSnapshot("2026-07-13T00:00:00.250Z");
			const provenancePending = provenance.pending ?? [];
			expect(provenancePending.map(item => item.key).slice(0, 2)).toEqual(["home/self", "home/done"]);
			expect(provenancePending.find(item => item.key === "home/self")?.reason).toContain("PR checks green");
			expect(provenancePending.find(item => item.key === "home/done")?.reason).toContain("closeout");
			expect(provenancePending.find(item => item.key === "home/done")?.reason).not.toContain("done:");
			writeFileSync(join(fixture.home, "state", "self.status"), "blocked: waiting on captain\n");
			const blocked = await collectSnapshot("2026-07-13T00:00:00.500Z");
			expect(blocked.pending?.find(item => item.id === "self")?.cls).toBe("CAPTAIN-BLOCKED");
			writeFileSync(join(fixture.home, "state", "self.status"), "working: building\n");

			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent: "omp" }] } }));
			const identityUnknown = await collectSnapshot("2026-07-13T00:00:01Z");
			expect(identityUnknown.activation?.state).toBe("fresh");
			expect(identityUnknown.identity?.state).toBe("unknown");
			expect(identityUnknown.health?.state).toBe("healthy");
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-2", agent: "omp" }] } }));
			const identityMismatch = await collectSnapshot("2026-07-13T00:00:01.250Z");
			expect(identityMismatch.activation?.state).toBe("fresh");
			expect(identityMismatch.identity).toMatchObject({ state: "mismatch", bound: 0, mismatch: 1, unknown: 0 });
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1" }] } }));
			const missingAgent = await collectSnapshot("2026-07-13T00:00:01.500Z");
			expect(missingAgent.activation?.state).toBe("fresh");
			expect(missingAgent.topology).toMatchObject({ state: "incomplete", present: 0, missing: 0, incomplete: 1 });
			expect(missingAgent.health?.state).toBe("degraded");

			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" }] } }));
			writeFileSync(join(fixture.home, "AGENTS.md"), "changed manifest\n");
			const stale = await collectSnapshot("2026-07-13T00:00:02Z");
			expect(stale.activation?.state).toBe("stale");
			expect(stale.identity?.state).toBe("bound");

			rmSync(receiptPath);
			const missing = await collectSnapshot("2026-07-13T00:00:03Z");
			expect(missing.activation?.state).toBe("unknown");
			expect(missing.identity?.state).toBe("unknown");
			const child = join(fixture.home, "plum");
			mkdirSync(join(child, "data"), { recursive: true });
			mkdirSync(join(child, "state"), { recursive: true });
			writeFileSync(join(child, "AGENTS.md"), "child manifest\n");
			writeFileSync(join(child, "data", "backlog.md"), "");
			writeFileSync(join(child, "state", "activation-receipt.json"), JSON.stringify({
				schema: "firstmate.activation-receipt/v1",
				manifest_sha256: receiptManifestHash("child manifest\n"),
				pane_id: "w1:p2",
				session_id: "child-session",
			}));
			const gauge = join(child, "gauge");
			mkdirSync(join(gauge, "data"), { recursive: true });
			mkdirSync(join(gauge, "state"), { recursive: true });
			writeFileSync(join(gauge, "AGENTS.md"), "gauge manifest\n");
			writeFileSync(join(gauge, "data", "backlog.md"), "");
			writeFileSync(join(gauge, "state", "activation-receipt.json"), JSON.stringify({
				schema: "firstmate.activation-receipt/v1",
				manifest_sha256: receiptManifestHash("gauge manifest\n"),
				pane_id: "w1:p3",
				session_id: "gauge-session",
			}));
			writeFileSync(join(child, "data", "secondmates.md"), `- gauge - nested child (home: ${gauge})\n`);
			writeFileSync(join(child, "state", "gauge.meta"), `kind=secondmate\nhome=${gauge}\npane=w1:p3\n`);
			writeFileSync(join(fixture.home, "data", "secondmates.md"), `- plum - child (home: ${child})\n`);
			writeFileSync(join(fixture.home, "state", "plum.meta"), `kind=secondmate\nhome=${child}\npane=w1:p2\n`);
			writeFileSync(join(fixture.home, "AGENTS.md"), FIXTURE_MANIFEST);
			writeFileSync(receiptPath, JSON.stringify({
				schema: "firstmate.activation-receipt/v1",
				manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST),
				pane_id: "w1:p1",
				session_id: "session-1",
			}));
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
				{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" },
				{ pane_id: "w1:p2", cwd: join(child, "project"), agent_status: "idle", workspace_id: "w1", tab_id: "t2", agent_session_id: "child-session", agent: "omp" },
				{ pane_id: "w1:p3", cwd: join(gauge, "project"), agent_status: "idle", workspace_id: "w1", tab_id: "t3", agent_session_id: "gauge-session", agent: "omp" },
			] } }));
			const linkedChild = await collectSnapshot("2026-07-13T00:00:04Z");
			expect(linkedChild.homePaths).toEqual([fixture.home, child, gauge]);
			expect(linkedChild.topology).toMatchObject({ state: "complete", present: 3, missing: 0, incomplete: 0 });
			expect(linkedChild.activation?.state).toBe("fresh");
			expect(linkedChild.identity?.state).toBe("bound");
			writeFileSync(join(child, "state", "activation-receipt.json"), JSON.stringify({
				schema: "firstmate.activation-receipt/v1",
				manifest_sha256: receiptManifestHash("child manifest\n"),
				pane_id: "w1:p99",
				session_id: "stale-child-session",
			}));
			const staleChildReceipt = await collectSnapshot("2026-07-13T00:00:04.250Z");
			expect(staleChildReceipt.topology).toMatchObject({ state: "complete", present: 3, missing: 0, incomplete: 0 });
			expect(staleChildReceipt.mates.find(mate => mate.name === "plum")?.herdrStatus).toBe("idle");
			rmSync(join(child, "state", "activation-receipt.json"));
			const missingChildReceipt = await collectSnapshot("2026-07-13T00:00:04.500Z");
			expect(missingChildReceipt.topology).toMatchObject({ state: "complete", present: 3, missing: 0, incomplete: 0 });
			expect(missingChildReceipt.mates.find(mate => mate.name === "plum")?.herdrStatus).toBe("idle");
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});
	it("uses persisted nonterminal status when live pane inventory is absent", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [] } }));
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.agents?.find(agent => agent.key === "home/self")?.status).toBe("working");
			expect(snapshot.tasks.find(task => task.key === "home/self")?.workerState).toBe("working");
			expect(snapshot.attention?.find(item => item.key === "home/self")?.cls).toBe("IN-FLIGHT");
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});

	it("matches symlink and dot aliases by canonical path while preserving display paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "fleet-alias-"));
		const home = join(root, "main");
		const alias = join(root, "main-link");
		const child = join(home, "plum");
		const childAlias = `${child}/../plum`;
		mkdirSync(join(home, "data"), { recursive: true });
		mkdirSync(join(home, "state"), { recursive: true });
		mkdirSync(join(home, "sbin"), { recursive: true });
		mkdirSync(join(child, "data"), { recursive: true });
		mkdirSync(join(child, "state"), { recursive: true });
		writeFileSync(join(home, "sbin", "fm-spawn.sh"), "");
		writeFileSync(join(home, "AGENTS.md"), "main alias manifest\n");
		writeFileSync(join(child, "AGENTS.md"), "child alias manifest\n");
		writeFileSync(join(home, "data", "backlog.md"), `## Queued\n- [ ] **wait** - wait (repo: app)\n`);
		writeFileSync(join(child, "data", "backlog.md"), `## In flight\n- **self** - child work (repo: app)\n`);
		writeFileSync(join(home, "data", "secondmates.md"), `- plum - child (home: ${childAlias})\n`);
		writeFileSync(join(home, "state", "plum.meta"), `kind=secondmate\nhome=${childAlias}\npane=w1:p2\n`);
		writeFileSync(join(child, "state", "self.meta"), "kind=ship\nworker=self\npane=w1:p2\n");
		writeFileSync(join(home, "state", "self.status"), "working: child\n");
		writeFileSync(join(child, "state", "self.status"), "working: child\n");
		writeFileSync(join(home, "state", "activation-receipt.json"), JSON.stringify({
			schema: "firstmate.activation-receipt/v1",
			manifest_sha256: receiptManifestHash("main alias manifest\n"),
			pane_id: "w1:p1",
			session_id: "main-session",
		}));
		writeFileSync(join(child, "state", "activation-receipt.json"), JSON.stringify({
			schema: "firstmate.activation-receipt/v1",
			manifest_sha256: receiptManifestHash("child alias manifest\n"),
			pane_id: "w1:p2",
			session_id: "child-session",
		}));
		symlinkSync(home, alias, "dir");
		const panes = join(root, "panes.json");
		writeFileSync(panes, JSON.stringify({ result: { panes: [
			{ pane_id: "w1:p1", cwd: alias, agent_status: "idle", agent_session_id: "main-session", agent: "omp" },
			{ pane_id: "w1:p2", cwd: childAlias, agent_status: "working", agent_session_id: "child-session", agent: "omp" },
		] } }));
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = alias;
		process.env.FM_FLEET_PANES_FILE = panes;
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			const task = snapshot.tasks.find(item => item.key === "plum/self");
			expect(snapshot.home).toBe(alias);
			expect(snapshot.homePaths).toEqual([alias, childAlias]);
			expect(task?.owner).toBe("plum");
			expect(task?.topology?.home).toBe(childAlias);
			expect(task?.topology?.pane).toBe("w1:p2");
			expect(snapshot.mates.find(mate => mate.name === "plum")?.herdrStatus).toBe("working");
			expect(snapshot.health?.state).toBe("healthy");
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back from a stale linked pane to the unique live home pane", async () => {
		const fixture = fixtureHome();
		const receiptPath = join(fixture.home, "state", "activation-receipt.json");
		writeFileSync(receiptPath, JSON.stringify({
			schema: "firstmate.activation-receipt/v1",
			manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST),
			pane_id: "w1:p1",
			session_id: "session-1",
		}));
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
			{ pane_id: "w1:p2", cwd: fixture.home, agent_status: "working", agent_session_id: "session-2", agent: "omp" },
		] } }));
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.topology).toMatchObject({ state: "complete", present: 1, missing: 0, incomplete: 0 });
			expect(snapshot.identity).toMatchObject({ state: "mismatch", bound: 0, mismatch: 1, unknown: 0 });
			expect(snapshot.health?.state).toBe("degraded");
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});

	it("rejects missing snapshot option values before collecting", () => {
		const script = join(import.meta.dir, "..", "sbin", "fm-fleet-snapshot.ts");
		for (const flag of ["--home", "--stats-file"]) {
			const result = spawnSync(process.execPath, [script, flag, "--metrics"], {
				cwd: join(import.meta.dir, ".."),
				encoding: "utf8",
			});
			expect(result.status).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`${flag} requires a value`);
		}
	});

	it("requires a unique bare id and reports candidates for duplicates", () => {
		const snapshot = {
			tasks: [
				{ key: "firstmate/self", id: "self", owner: "firstmate" },
				{ key: "plum/self", id: "self", owner: "plum" },
			],
		} as Parameters<typeof findTask>[0];
		expect(findTask(snapshot, "self").task).toBeUndefined();
		expect(findTask(snapshot, "self").candidates).toEqual(["firstmate/self", "plum/self"]);
		expect(findTask(snapshot, "plum/self").task?.key).toBe("plum/self");
	});

	it("normalizes the public task state spelling", () => {
		expect(normalizeTaskState("in-flight")).toBe("inflight");
		expect(normalizeTaskState("queued")).toBe("queued");
		expect(normalizeTaskState("done")).toBe("done");
		expect(normalizeTaskState("running")).toBeUndefined();
	});

	it("reads the last status line and handles empty status files", () => {
		expect(parseStatus("")).toBeUndefined();
		expect(parseStatus("working: first\nneeds-decision: last\n")).toEqual({ state: "needs-decision", text: "last" });
		expect(parseStatus("done: first\nnot-a-state: last\n")).toEqual({ state: "unknown", text: "not-a-state: last" });
	});

	it("preserves focus priority classes, blast radius, and forwarded proximity", () => {
		const row = (id: string, statusLine: string, kind = "ship", depth = 0): AgentRow => {
			const state = statusLine.split(":", 1)[0] as StatusState;
			return {
				key: `home/${id}`,
				id,
				owner: "home",
				kind,
				status: state,
				statusFile: { state, text: statusLine },
				liveStatus: state,
				statusText: statusLine,
				depth,
				home: "/tmp/home",
				topology: { home: "/tmp/home" },
			};
		};
		const homes = [{
			path: "/tmp/home",
			backlogText: "## In flight\n- x - active blocked-by: add-tests\n## Queued\n- q - queued blocked-by: wire-api\n## Done\nfree-form blocked-by: add-tests blocked-by: add-tests\n",
			label: "home",
			isMain: true,
			depth: 0,
			backlog: {
				inflight: [],
				queued: [
					{ id: "q1", desc: "one blocked-by: add-tests", section: "queued", resolved: false },
					{ id: "q2", desc: "two blocked-by: add-tests", section: "queued", resolved: false },
					{ id: "q3", desc: "three blocked-by: wire-api", section: "queued", resolved: false },
				],
				done: [],
			},
			agents: [],
		}] as ParsedHome[];
		const pending = attentionFor([
			row("failed", "failed: wedged"),
			row("add-tests", "needs-decision: framework"),
			row("wire-api", "needs-decision: auth"),
			row("grandkid", "needs-decision: deep choice", "ship", 1),
			row("refactor", "done: PR checks green"),
			row("cleanup", "done: PR merged"),
			row("working", "working: active"),
			row("idle", "idle"),
			row("unknown", "unknown"),
			row("plum", "done: independent audit", "secondmate"),
		], homes, "2026-07-13T00:00:00Z");
		const byId = (id: string) => pending.find(item => item.id === id);
		expect(pending.map(item => item.key)).toEqual(["home/failed", "home/add-tests", "home/wire-api", "home/grandkid", "home/refactor", "home/cleanup", "home/working", "home/idle", "home/plum", "home/unknown"]);
		expect(byId("failed")?.cls).toBe("CAPTAIN-BLOCKED");
		expect(byId("add-tests")?.cls).toBe("CAPTAIN-BLOCKED");
		expect(byId("refactor")?.cls).toBe("REVIEW-READY");
		expect(byId("cleanup")?.cls).toBe("REVIEW-READY");
		expect(byId("working")?.cls).toBe("IN-FLIGHT");
		expect(byId("idle")?.cls).toBe("DORMANT");
		expect(byId("unknown")?.cls).toBe("UNKNOWN");
		expect(byId("plum")?.cls).toBe("DORMANT");

		const liveRow = (id: string, liveStatus: string): AgentRow => ({
			key: `live/${id}`,
			id,
			owner: "live",
			liveStatus,
			home: "/tmp/live",
			topology: { home: "/tmp/live" },
		});
		const livePending = attentionFor([
			liveRow("blocked", "blocked"),
			liveRow("working", "working"),
			liveRow("done", "done"),
			liveRow("idle", "idle"),
			liveRow("unknown", "unknown"),
			liveRow("failed", "failed"),
			liveRow("needs", "needs-decision"),
			liveRow("other", "other"),
		], [], "2026-07-13T00:00:00Z");
		expect(livePending.map(item => item.key)).toEqual(["live/blocked", "live/done", "live/working", "live/failed", "live/idle", "live/needs", "live/other", "live/unknown"]);
		expect(livePending.find(item => item.id === "blocked")?.cls).toBe("CAPTAIN-BLOCKED");
		expect(livePending.find(item => item.id === "done")?.cls).toBe("REVIEW-READY");
		expect(livePending.find(item => item.id === "working")?.cls).toBe("IN-FLIGHT");
		expect(livePending.find(item => item.id === "failed")?.cls).toBe("DORMANT");
		expect(livePending.find(item => item.id === "needs")?.cls).toBe("DORMANT");
		expect(livePending.find(item => item.id === "unknown")?.cls).toBe("UNKNOWN");
		expect(pending.find(item => item.id === "add-tests")?.reason).toContain("blocks 3");
		expect(pending.find(item => item.id === "wire-api")?.reason).toContain("blocks 1");
		const duplicateHomes = [{
			path: "/display/alpha",
			pathKey: "/canonical/alpha",
			label: "alpha",
			isMain: true,
			backlogText: "blocked-by: same blocked-by: same\n",
			backlog: { inflight: [], queued: [], done: [] },
			agents: [],
		}, {
			path: "/display/beta",
			pathKey: "/canonical/beta",
			label: "beta",
			isMain: false,
			backlogText: "blocked-by: same\n",
			backlog: { inflight: [], queued: [], done: [] },
			agents: [],
		}] as ParsedHome[];
		const duplicatePending = attentionFor([
			{ ...liveRow("same", "working"), key: "alpha/same", owner: "alpha", home: "/display/alpha" },
			{ ...liveRow("same", "working"), key: "beta/same", owner: "beta", home: "/display/beta" },
		], duplicateHomes, "2026-07-13T00:00:00Z");
		expect(duplicatePending.find(item => item.key === "alpha/same")?.reason).toContain("blocks 2");
		expect(duplicatePending.find(item => item.key === "beta/same")?.reason).toContain("blocks 1");
		const crossOwnerPending = attentionFor([
			{ ...liveRow("aaa", "other"), key: "z/aaa", owner: "z", home: "/display/alpha" },
			{ ...liveRow("zzz", "other"), key: "a/zzz", owner: "a", home: "/display/beta" },
		], duplicateHomes, "2026-07-13T00:00:00Z");
		expect(crossOwnerPending.map(item => item.key)).toEqual(["z/aaa", "a/zzz"]);
	});
});
