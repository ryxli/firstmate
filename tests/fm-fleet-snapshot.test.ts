import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectSnapshot, findTask, normalizeTaskState } from "../.omp/extensions/bridge/collect";
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
		} finally {
			if (oldHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = oldHome;
			if (oldPanes === undefined) delete process.env.FM_FLEET_PANES_FILE;
			else process.env.FM_FLEET_PANES_FILE = oldPanes;
			rmSync(join(fixture.home, ".."), { recursive: true, force: true });
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
});
