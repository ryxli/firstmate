import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { attentionFor, collectSnapshot, findTask, normalizeTaskState, readRawHome } from "../.omp/extensions/bridge/collect";
import { parseStatus, render } from "../.omp/extensions/bridge/fleet";
import type { AgentRow, ParsedHome, StatusState } from "../.omp/extensions/bridge/fleet";
const FIXTURE_MANIFEST = "fixture manifest\n";

function receiptManifestHash(content: string): string {
	const fileHash = createHash("sha256").update(content).digest("hex");
	return createHash("sha256").update(`AGENTS.md\0${fileHash}\0`).digest("hex");
}
function receiptManifestHashEntries(entries: Record<string, string>): string {
	const hash = createHash("sha256");
	for (const path of Object.keys(entries).sort()) {
		const digest = createHash("sha256").update(entries[path]).digest("hex");
		hash.update(path);
		hash.update("\0");
		hash.update(digest);
		hash.update("\0");
	}
	return hash.digest("hex");
}
function manifestEntry(path: string, content: string): { path: string; sha256: string } {
	return { path, sha256: createHash("sha256").update(content).digest("hex") };
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
				manifest: [manifestEntry("AGENTS.md", FIXTURE_MANIFEST)],
			}));
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.schema).toBe("fleet-snapshot/1");
			expect(new Set(snapshot.tasks.map(task => task.key))).toEqual(new Set(["home/self", "home/queued", "home/old"]));
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
			const idleWithDoneFile = provenance.agents?.find(agent => agent.key === "home/self");
			expect(idleWithDoneFile).toMatchObject({
				status: "idle",
				liveStatus: "idle",
				statusFile: { state: "done", text: "PR checks green" },
			});
			expect(provenancePending.map(item => item.key).slice(0, 2)).toEqual(["home/self", "home/done"]);
			expect(provenancePending.find(item => item.key === "home/self")?.reason).toContain("PR checks green");
			expect(provenancePending.find(item => item.key === "home/done")?.reason).toContain("closeout");
			expect(provenancePending.find(item => item.key === "home/done")?.reason).not.toContain("done:");
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
				{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" },
				{ pane_id: "w1:p2", cwd: fixture.home, agent_status: "done", workspace_id: "w1", tab_id: "t1", agent: "omp" },
			] } }));
			const workingWithDoneFile = await collectSnapshot("2026-07-13T00:00:00.375Z");
			expect(workingWithDoneFile.agents?.find(agent => agent.key === "home/self")).toMatchObject({
				status: "working",
				liveStatus: "working",
				statusFile: { state: "done", text: "PR checks green" },
			});
			expect(workingWithDoneFile.pending?.find(item => item.key === "home/self")?.reason).toContain("PR checks green");
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
				{ pane_id: "w1:p2", cwd: fixture.home, agent_status: "done", workspace_id: "w1", tab_id: "t1", agent: "omp" },
			] } }));
			const missingPaneWithDoneFile = await collectSnapshot("2026-07-13T00:00:00.437Z");
			expect(missingPaneWithDoneFile.agents?.find(agent => agent.key === "home/self")).toMatchObject({
				status: "done",
				statusFile: { state: "done", text: "PR checks green" },
				topology: { degraded: "missing-pane" },
			});
			writeFileSync(join(fixture.home, "state", "self.status"), "blocked: waiting on cap\n");
			const blocked = await collectSnapshot("2026-07-13T00:00:00.500Z");
			expect(blocked.pending?.find(item => item.id === "self")?.cls).toBe("CAP-BLOCKED");
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
			const startupSnapshot = await collectSnapshot("2026-07-13T00:00:01.500Z", undefined, { startingMain: true });
			expect(startupSnapshot.topology).toMatchObject({ state: "complete", present: 1, missing: 0, incomplete: 0 });
			expect(startupSnapshot.health?.state).toBe("healthy");

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
				started_at: "2026-07-13T00:00:00Z",
				manifest: [manifestEntry("AGENTS.md", "child manifest\n")],
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
				started_at: "2026-07-13T00:00:00Z",
				manifest: [manifestEntry("AGENTS.md", "gauge manifest\n")],
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
				started_at: "2026-07-13T00:00:00Z",
				manifest: [manifestEntry("AGENTS.md", FIXTURE_MANIFEST)],
			}));
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
				{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" },
				{ pane_id: "w1:p2", cwd: child, agent_status: "idle", workspace_id: "w1", tab_id: "t2", agent_session_id: "child-session", agent: "omp" },
				{ pane_id: "w1:p3", cwd: gauge, agent_status: "idle", workspace_id: "w1", tab_id: "t3", agent_session_id: "gauge-session", agent: "omp" },
			] } }));
			const linkedChild = await collectSnapshot("2026-07-13T00:00:04Z");
			expect(linkedChild.homePaths).toEqual([fixture.home, child, gauge]);
			expect(linkedChild.topology).toMatchObject({ state: "complete", present: 3, missing: 0, incomplete: 0 });
			expect(linkedChild.activation?.state).toBe("fresh");
			expect(linkedChild.identity?.state).toBe("bound");
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
				{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "session-1", agent: "omp" },
				{ pane_id: "w1:p2", cwd: "/other-home", agent_status: "working", workspace_id: "w1", tab_id: "t2", agent_session_id: "other-session", agent: "omp" },
				{ pane_id: "w1:p3", cwd: gauge, agent_status: "idle", workspace_id: "w1", tab_id: "t3", agent_session_id: "gauge-session", agent: "omp" },
				{ pane_id: "w1:p4", cwd: child, agent_status: "idle", workspace_id: "w1", tab_id: "t4", agent_session_id: "child-session", agent: "omp" },
			] } }));
			writeFileSync(join(child, "state", "activation-receipt.json"), JSON.stringify({
				schema: "firstmate.activation-receipt/v1",
				manifest_sha256: receiptManifestHash("child manifest\n"),
				pane_id: "w1:p99",
				session_id: "stale-child-session",
				started_at: "2026-07-13T00:00:00Z",
				manifest: [manifestEntry("AGENTS.md", "child manifest\n")],
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
			expect(snapshot.tasks.find(task => task.key === "home/self")?.topology).toMatchObject({ degraded: "missing-pane" });
			expect(snapshot.tasks.find(task => task.key === "home/self")?.topology?.pane).toBeUndefined();
			expect(snapshot.agents?.find(agent => agent.key === "home/self")?.topology?.pane).toBeUndefined();
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
	it("marks failed, missing, and malformed metrics input unavailable", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		const stats = join(fixture.home, "stats.json");
		try {
			const missing = await collectSnapshot("2026-07-13T00:00:00Z", undefined, { includeMetrics: true, statsFile: stats });
			expect(missing.metrics).toBeUndefined();
			expect(missing.notes).toContain(`fleet metrics unavailable: stats file missing: ${stats}`);
			writeFileSync(stats, "{}");
			const malformed = await collectSnapshot("2026-07-13T00:00:00Z", undefined, { includeMetrics: true, statsFile: stats });
			expect(malformed.metrics).toBeUndefined();
			expect(malformed.notes).toContain(`fleet metrics unavailable: malformed stats JSON in ${stats}`);
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});
	it("accepts descendant home panes and rejects lexical-prefix impostors", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		try {
		mkdirSync(join(fixture.home, "project"));
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: join(fixture.home, "project"), agent_status: "working", agent: "omp" }] } }));
			const descendant = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(descendant.topology).toMatchObject({ state: "complete", present: 1, missing: 0 });
			writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: `${fixture.home}-impostor`, agent_status: "working", agent: "omp" }] } }));
			const impostor = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(impostor.topology).toMatchObject({ state: "unknown", present: 0, missing: 1 });
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});
	it("displays idle Herdr while preserving semantic terminal disposition", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		writeFileSync(join(fixture.home, "state", "self.status"), "working: checks green\n");
		writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "idle", agent: "omp" }] } }));
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.agents?.find(agent => agent.key === "home/self")?.status).toBe("idle");
			expect(snapshot.tasks.find(task => task.key === "home/self")?.workerState).toBe("done");
			expect(snapshot.attention?.find(item => item.key === "home/self")?.cls).toBe("REVIEW-READY");
			expect(render(snapshot, "tasks")).toContain("\u2713");
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});
	it("honors an explicit home over inherited FM_HOME", async () => {
		const first = fixtureHome();
		const second = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = first.home;
		process.env.FM_FLEET_PANES_FILE = second.panes;
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z", second.home);
			expect(snapshot.home).toBe(second.home);
			expect(snapshot.tasks.find(task => task.key === "home/self")?.topology?.home).toBe(second.home);
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(first.home, ".."), { recursive: true, force: true });
			rmSync(join(second.home, ".."), { recursive: true, force: true });
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
			started_at: "2026-07-13T00:00:00Z",
			manifest: [manifestEntry("AGENTS.md", "main alias manifest\n")],
		}));
		writeFileSync(join(child, "state", "activation-receipt.json"), JSON.stringify({
			schema: "firstmate.activation-receipt/v1",
			manifest_sha256: receiptManifestHash("child alias manifest\n"),
			pane_id: "w1:p2",
			session_id: "child-session",
			started_at: "2026-07-13T00:00:00Z",
			manifest: [manifestEntry("AGENTS.md", "child alias manifest\n")],
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
			started_at: "2026-07-13T00:00:00Z",
			manifest: [manifestEntry("AGENTS.md", FIXTURE_MANIFEST)],
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
		const cli = join(import.meta.dir, "..", "sbin", "fm");
		for (const flag of ["--home", "--stats-file"]) {
			const result = spawnSync(process.execPath, [cli, "fleet", "snapshot", flag, "--metrics"], {
				cwd: join(import.meta.dir, ".."),
				encoding: "utf8",
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(`${flag} requires a value`);
			expect(result.stdout).toContain("VALIDATION_ERROR");
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
		expect(byId("failed")?.cls).toBe("CAP-BLOCKED");
		expect(byId("add-tests")?.cls).toBe("CAP-BLOCKED");
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
		expect(livePending.map(item => item.key)).toEqual(["live/failed", "live/blocked", "live/needs", "live/done", "live/working", "live/idle", "live/other", "live/unknown"]);
		expect(livePending.find(item => item.id === "blocked")?.cls).toBe("CAP-BLOCKED");
		expect(livePending.find(item => item.id === "done")?.cls).toBe("REVIEW-READY");
		expect(livePending.find(item => item.id === "working")?.cls).toBe("IN-FLIGHT");
		expect(livePending.find(item => item.id === "failed")?.cls).toBe("CAP-BLOCKED");
		expect(livePending.find(item => item.id === "needs")?.cls).toBe("CAP-BLOCKED");
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
	it("maps live secondmate terminal states to cap attention", () => {
		const liveSecondmate = (id: string, liveStatus: string): AgentRow => ({
			key: `secondmate/${id}`,
			id,
			owner: "secondmate",
			kind: "secondmate",
			liveStatus,
			home: "/tmp/secondmate",
			topology: { home: "/tmp/secondmate" },
		});
		const pending = attentionFor([
			liveSecondmate("failed", "failed"),
			liveSecondmate("needs", "needs-decision"),
		], [], "2026-07-13T00:00:00Z");
		expect(pending.map(item => item.key)).toEqual(["secondmate/failed", "secondmate/needs"]);
		expect(pending.find(item => item.id === "failed")?.cls).toBe("CAP-BLOCKED");
		expect(pending.find(item => item.id === "needs")?.cls).toBe("CAP-BLOCKED");
	});
	it("hashes symlinked bridge sources in the activation manifest", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		const source = join(fixture.home, "..", "bridge-source");
		const bridgeSource = "export default 1;\n";
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "index.ts"), bridgeSource);
		mkdirSync(join(fixture.home, ".omp"), { recursive: true });
		symlinkSync(source, join(fixture.home, ".omp", "extensions"), "dir");
		const entries = { "AGENTS.md": FIXTURE_MANIFEST, ".omp/extensions/index.ts": bridgeSource };
		writeFileSync(join(fixture.home, "state", "activation-receipt.json"), JSON.stringify({
			schema: "firstmate.activation-receipt/v1",
			manifest_sha256: receiptManifestHashEntries(entries),
			pane_id: "w1:p1",
			session_id: "session-1",
			started_at: "2026-07-13T00:00:00Z",
			manifest: Object.entries(entries).map(([path, content]) => ({ path, sha256: createHash("sha256").update(content).digest("hex") })),
		}));
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.activation).toMatchObject({ state: "fresh", fresh: 1, stale: 0, unknown: 0 });
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});

	it("discovers metadata-linked secondmate homes without a usable registry", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		const child = join(fixture.home, "..", "plum");
		mkdirSync(join(child, "data"), { recursive: true });
		mkdirSync(join(child, "state"), { recursive: true });
		writeFileSync(join(child, "AGENTS.md"), "child manifest\n");
		writeFileSync(join(child, "data", "backlog.md"), "## In flight\n- **child-task** - child work (repo: app)\n");
		writeFileSync(join(child, "state", "child-task.meta"), "kind=ship\npane=w1:p2\nworker=child\n");
		writeFileSync(join(child, "state", "child-task.status"), "working: child work\n");
		writeFileSync(join(fixture.home, "state", "plum.meta"), `kind=secondmate\nhome=${child}\npane=w1:p2\n`);
		const registryPath = join(fixture.home, "data", "secondmates.md");
		writeFileSync(registryPath, "not a valid secondmate registry\n");
		writeFileSync(fixture.panes, JSON.stringify({ result: { panes: [
			{ pane_id: "w1:p1", cwd: fixture.home, agent_status: "working", agent: "omp" },
			{ pane_id: "w1:p2", cwd: child, agent_status: "working", agent: "omp" },
		] } }));
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		try {
			rmSync(registryPath);
			const absent = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(absent.homePaths).toEqual([fixture.home, child]);
			writeFileSync(registryPath, "not a valid secondmate registry\n");
			const malformed = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(malformed.homePaths).toEqual([fixture.home, child]);
			expect(malformed.health?.homes).toBe(2);
			expect(malformed.tasks.find(task => task.key === "plum/child-task")?.topology?.home).toBe(child);
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});

	it("honors FM_ROOT_OVERRIDE and FM_STATE_OVERRIDE for the main home", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldRoot = process.env.FM_ROOT_OVERRIDE;
		const oldState = process.env.FM_STATE_OVERRIDE;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		const state = join(fixture.home, "..", "override-state");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "self.meta"), "kind=ship\npane=w1:p1\nworker=self\n");
		writeFileSync(join(state, "self.status"), "failed: override state\n");
		writeFileSync(join(state, "activation-receipt.json"), JSON.stringify({
			schema: "firstmate.activation-receipt/v1",
			manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST),
			pane_id: "w1:p1",
			started_at: "2026-07-13T00:00:00Z",
			manifest: [manifestEntry("AGENTS.md", FIXTURE_MANIFEST)],
		}));
		delete process.env.FM_HOME;
		process.env.FM_ROOT_OVERRIDE = fixture.home;
		process.env.FM_STATE_OVERRIDE = state;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		try {
			const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
			expect(snapshot.home).toBe(fixture.home);
			expect(snapshot.agents?.find(agent => agent.id === "self")).toMatchObject({
				status: "working",
				statusFile: { state: "failed", text: "override state" },
			});
			expect(snapshot.pending?.find(item => item.id === "self")?.cls).toBe("CAP-BLOCKED");
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldRoot === undefined) delete process.env.FM_ROOT_OVERRIDE;
			else process.env.FM_ROOT_OVERRIDE = oldRoot;
			if (oldState === undefined) delete process.env.FM_STATE_OVERRIDE;
			else process.env.FM_STATE_OVERRIDE = oldState;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});

	it("rejects partial and malformed activation receipts", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
		const receiptPath = join(fixture.home, "state", "activation-receipt.json");
		try {
			for (const receipt of [
				{ schema: "firstmate.activation-receipt/v1", manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST), pane_id: "w1:p1" },
				{ schema: "firstmate.activation-receipt/v1", manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST), pane_id: 7, started_at: "2026-07-13T00:00:00Z", manifest: [] },
				{ schema: "firstmate.activation-receipt/v1", manifest_sha256: receiptManifestHash(FIXTURE_MANIFEST), pane_id: "w1:p1", started_at: "2026-07-13T00:00:00Z", manifest: [manifestEntry("AGENTS.md", FIXTURE_MANIFEST)] },
				{ schema: "firstmate.activation-receipt/v1", manifest_sha256: "0".repeat(64), pane_id: "w1:p1", started_at: "2026-07-13T00:00:00Z", manifest: [manifestEntry("AGENTS.md", FIXTURE_MANIFEST)] },
			]) {
				writeFileSync(receiptPath, JSON.stringify(receipt));
				const snapshot = await collectSnapshot("2026-07-13T00:00:00Z");
				expect(snapshot.activation).toMatchObject({ state: "unknown", fresh: 0, stale: 0, unknown: 1 });
				expect(readRawHome(fixture.home, true).activationPane).toBeUndefined();
			}
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
		}
	});
});
