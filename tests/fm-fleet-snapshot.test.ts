import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectSnapshot, findTask, normalizeTaskState } from "../.omp/extensions/bridge/collect";

function fixtureHome(): { home: string; panes: string } {
	const root = mkdtempSync(join(tmpdir(), "fleet-snapshot-"));
	const home = join(root, "home");
	const panes = join(root, "panes.json");
	mkdirSync(join(home, "data"), { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
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
	writeFileSync(join(home, "state", "self.meta"), "pane=w1:p1\nkind=ship\nworker=self\n");
	writeFileSync(join(home, "state", "self.status"), "working: building\n");
	writeFileSync(panes, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: home, agent_status: "working", workspace_id: "w1", tab_id: "t1" }] } }));
	return { home, panes };
}

describe("canonical FleetSnapshot collector", () => {
	it("reads all backlog sections and emits owner-qualified task keys", async () => {
		const fixture = fixtureHome();
		const oldHome = process.env.FM_HOME;
		const oldPanes = process.env.FM_FLEET_PANES_FILE;
		process.env.FM_HOME = fixture.home;
		process.env.FM_FLEET_PANES_FILE = fixture.panes;
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
