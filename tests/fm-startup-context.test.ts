// Unit tests for bounded startup operator summary.
// Run: bun test tests/fm-startup-context.test.ts
import { describe, expect, it } from "bun:test";
import {
	STARTUP_SUMMARY_MAX_BYTES,
	buildStartupDecisionBody,
	enforceStartupByteBound,
	formatStartupSummary,
	renderStaticFleet,
	truncateUtf8,
	type FleetSnapshotLike,
} from "../.omp/extensions/cli/lib/startup-context";

function baseSnapshot(over: Partial<FleetSnapshotLike> = {}): FleetSnapshotLike {
	return {
		generatedAt: "2026-07-20T08:24:00.000Z",
		home: "/tmp/fm-home",
		health: { state: "healthy", herdr: "ok", homes: 1, missingHomes: 0, livePanes: 0 },
		attention: [],
		tasks: [],
		agents: [],
		otherLivePanes: [],
		notes: [],
		...over,
	};
}

describe("truncateUtf8", () => {
	it("does not split multibyte code points and stays within budget", () => {
		const s = "日本語テスト文字列".repeat(20);
		const out = truncateUtf8(s, 40);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(40);
		expect(() => Buffer.from(out, "utf8").toString("utf8")).not.toThrow();
	});
});

describe("renderStaticFleet operator summary", () => {
	it("preserves fleet attention order for the first three", () => {
		const snap = baseSnapshot({
			attention: [
				{ key: "a/first", cls: "REVIEW-READY", reason: "pr ready", pr: "https://example/1" },
				{ key: "b/second", cls: "CAP-BLOCKED", reason: "blocked" },
				{ key: "c/third", cls: "FAILED", reason: "failed" },
				{ key: "d/fourth", cls: "OTHER", reason: "noise" },
			],
		});
		const body = buildStartupDecisionBody(snap, "/tmp/fm-home", 0, { role: "firstmate", readyCount: 0 });
		expect(body.attention.map(r => r.key)).toEqual(["a/first", "b/second", "c/third"]);
		expect(body.omitted.attention).toBe(1);
		const text = formatStartupSummary(body);
		expect(text.indexOf("a/first")).toBeLessThan(text.indexOf("b/second"));
		expect(text.indexOf("b/second")).toBeLessThan(text.indexOf("c/third"));
		expect(text).not.toContain("d/fourth");
	});

	it("caps active_work at three and reports omitted", () => {
		const tasks = Array.from({ length: 8 }, (_, i) => ({
			key: `main/task-${i}`,
			id: `task-${i}`,
			state: "inflight",
			owner: "main",
			note: "",
		}));
		const body = buildStartupDecisionBody(baseSnapshot({ tasks }), "/tmp", 0, { role: "firstmate" });
		expect(body.active_work).toHaveLength(3);
		expect(body.omitted.active_work).toBe(5);
	});

	it("stays under the byte ceiling with hundreds of queued tasks", () => {
		const tasks = Array.from({ length: 400 }, (_, i) => ({
			key: `main/q-${i}`,
			id: `q-${i}`,
			state: i < 5 ? "inflight" : "queued",
			owner: "main",
			note: "x".repeat(200),
			pr: i === 0 ? `https://github.com/example/repo/pull/${i}` : undefined,
		}));
		const attention = Array.from({ length: 50 }, (_, i) => ({
			key: `main/att-${i}`,
			cls: i === 0 ? "CAP-BLOCKED" : "NOISE",
			reason: "理由".repeat(80),
		}));
		const out = renderStaticFleet(
			baseSnapshot({
				tasks,
				attention,
				agents: Array.from({ length: 20 }, (_, i) => ({
					key: `main/agent-${i}`,
					liveStatus: "idle",
				})),
				otherLivePanes: Array.from({ length: 15 }, (_, i) => ({ id: `pane-${i}` })),
				notes: Array.from({ length: 10 }, (_, i) => `note-${i}`),
				health: { state: "degraded", herdr: "ok", homes: 3, missingHomes: 1, livePanes: 2 },
			}),
			"/tmp/fm-home",
			0,
			{ role: "firstmate", readyCount: 6, readyIds: ["hybrid-control-beater"] },
		);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STARTUP_SUMMARY_MAX_BYTES);
		expect(out).toContain("FIRSTMATE START");
		expect(out).toContain("main/att-0");
		expect(out).toContain("Queue: 395 total, 6 ready");
		expect(out).toContain("Next ready: hybrid-control-beater");
		expect(out).toContain("Omitted:");
		expect(out).toContain("Refresh: fm fleet");
		expect(out).not.toMatch(/^\s{2}"schema"/m);
	});

	it("survives large multibyte free-text under the ceiling", () => {
		const monster = "🚀日本語".repeat(500);
		const out = renderStaticFleet(
			baseSnapshot({
				attention: [{ key: "kodiak/blocked", cls: "CAP-BLOCKED", reason: monster }],
				tasks: [
					{
						key: "kodiak/active",
						id: "active",
						state: "inflight",
						note: monster,
						pr: `https://github.com/example/repo/pull/1?x=${monster}`,
					},
				],
			}),
			"/tmp",
			0,
			{ role: "sub", roleNote: "another firstmate is active" },
		);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STARTUP_SUMMARY_MAX_BYTES);
		expect(out).toContain("Role: sub - another firstmate is active");
		expect(out).toContain("kodiak/blocked");
	});

	it("is deterministic for the same input", () => {
		const snap = baseSnapshot({
			attention: [
				{ key: "a/1", cls: "REVIEW-READY", reason: "r1", pr: "https://x/1" },
				{ key: "b/2", cls: "CAP-BLOCKED", reason: "r2" },
			],
			tasks: [
				{ key: "a/1", id: "1", state: "inflight", note: "" },
				{ key: "c/3", id: "3", state: "queued", note: "" },
			],
		});
		const a = renderStaticFleet(snap, "/tmp", 0, { role: "firstmate", readyCount: 1, readyIds: ["3"] });
		const b = renderStaticFleet(snap, "/tmp", 0, { role: "firstmate", readyCount: 1, readyIds: ["3"] });
		expect(a).toBe(b);
	});

	it("minimal fallback always stays under a tiny injected ceiling", () => {
		const body = buildStartupDecisionBody(
			baseSnapshot({
				attention: [{ key: "x", cls: "CAP-BLOCKED", reason: "y" }],
			}),
			"/tmp",
			1,
			{ role: "firstmate" },
		);
		const huge = `${formatStartupSummary(body)}${"pad".repeat(5000)}`;
		const out = enforceStartupByteBound(huge, body, 400);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(400);
		expect(out).toContain("FIRSTMATE START");
		expect(out).toContain("bound fallback");
	});
});
