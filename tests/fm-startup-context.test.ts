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

	it("returns empty string when the budget cannot fit a code point plus ellipsis", () => {
		expect(truncateUtf8("hello", 0)).toBe("");
		expect(truncateUtf8("hello", 1)).toBe("");
		expect(truncateUtf8("hello", 2)).toBe("");
		expect(Buffer.byteLength(truncateUtf8("hello", 3), "utf8")).toBeLessThanOrEqual(3);
	});
});

describe("renderStaticFleet operator summary", () => {
	it("preserves fleet attention order for the first three and reports totals", () => {
		const snap = baseSnapshot({
			attention: [
				{ key: "a/first", cls: "REVIEW-READY", clsRank: 3, reason: "pr ready", pr: "https://example/1" },
				{ key: "b/second", cls: "CAP-BLOCKED", clsRank: 4, reason: "blocked" },
				{ key: "c/third", cls: "FAILED", clsRank: 4, reason: "failed" },
				{ key: "d/fourth", cls: "OTHER", clsRank: 3, reason: "noise" },
			],
		});
		const body = buildStartupDecisionBody(snap, "/tmp/fm-home", 0, { readyCount: 0 });
		expect(body.attention.map(r => r.key)).toEqual(["a/first", "b/second", "c/third"]);
		expect(body.attention_total).toBe(4);
		expect(body.omitted.attention).toBe(1);
		const text = formatStartupSummary(body);
		expect(text).toContain("Needs attention: 4 total, showing 3");
		expect(text.indexOf("a/first")).toBeLessThan(text.indexOf("b/second"));
		expect(text).not.toContain("d/fourth");
		expect(text).toContain("Home: /tmp/fm-home");
		expect(text).toMatch(/^As of: /m);
		expect(text.indexOf("Refresh: fm fleet")).toBeLessThan(text.indexOf("As of:"));
	});

	it("excludes routine clsRank < 3 from needs-attention", () => {
		const body = buildStartupDecisionBody(
			baseSnapshot({
				attention: [
					{ key: "k/working", cls: "IN-FLIGHT", clsRank: 2, reason: "working" },
					{ key: "k/idle", cls: "DORMANT", clsRank: 1, reason: "secondmate idle" },
					{ key: "k/blocked", cls: "CAP-BLOCKED", clsRank: 4, reason: "needs decision" },
					{ key: "k/ready", cls: "REVIEW-READY", clsRank: 3, reason: "pr ready" },
				],
			}),
			"/tmp",
			0,
		);
		expect(body.attention.map(r => r.key)).toEqual(["k/blocked", "k/ready"]);
		expect(body.attention_total).toBe(2);
		expect(body.omitted.attention).toBe(0);
		const text = formatStartupSummary(body);
		expect(text).toContain("Needs attention: 2 total, showing 2");
		expect(text).not.toContain("k/working");
		expect(text).not.toContain("k/idle");
	});

	it("prefers pending over full attention inventory", () => {
		const body = buildStartupDecisionBody(
			baseSnapshot({
				attention: [
					{ key: "k/working", cls: "IN-FLIGHT", clsRank: 2, reason: "working" },
					{ key: "k/blocked", cls: "CAP-BLOCKED", clsRank: 4, reason: "needs decision" },
				],
				pending: [{ key: "k/blocked", cls: "CAP-BLOCKED", clsRank: 4, reason: "needs decision" }],
			}),
			"/tmp",
			0,
		);
		expect(body.attention.map(r => r.key)).toEqual(["k/blocked"]);
		expect(body.attention_total).toBe(1);
	});

	it("renders none when there is no actionable attention", () => {
		const text = formatStartupSummary(
			buildStartupDecisionBody(
				baseSnapshot({
					attention: [{ key: "k/working", cls: "IN-FLIGHT", clsRank: 2, reason: "working" }],
					pending: [],
				}),
				"/tmp",
				0,
			),
		);
		expect(text).toContain("Needs attention: none");
		expect(text).not.toContain("showing 0");
	});

	it("active_work is inflight-only and ignores stale done PRs", () => {
		const body = buildStartupDecisionBody(
			baseSnapshot({
				tasks: [
					{ key: "main/live", id: "live", state: "inflight", note: "", pr: "https://x/1" },
					{ key: "main/stale", id: "stale", state: "done", note: "", pr: "https://x/99" },
					{ key: "main/queued", id: "queued", state: "queued", note: "", pr: "https://x/2" },
				],
			}),
			"/tmp",
			0,
		);
		expect(body.active_work.map(r => r.key)).toEqual(["main/live"]);
		expect(body.active_work_total).toBe(1);
		expect(body.omitted.active_work).toBe(0);
	});

	it("caps active_work at three and reports total + showing", () => {
		const tasks = Array.from({ length: 8 }, (_, i) => ({
			key: `main/task-${i}`,
			id: `task-${i}`,
			state: "inflight",
			owner: "main",
			note: "",
		}));
		const body = buildStartupDecisionBody(baseSnapshot({ tasks }), "/tmp", 0);
		expect(body.active_work).toHaveLength(3);
		expect(body.active_work_total).toBe(8);
		expect(body.omitted.active_work).toBe(5);
		expect(formatStartupSummary(body)).toContain("Active work: 8 total, showing 3");
	});

	it("keeps first three notes in order, dedups against structured exceptions", () => {
		const body = buildStartupDecisionBody(
			baseSnapshot({
				health: { state: "degraded", herdr: "ok", homes: 3, missingHomes: 2, livePanes: 0 },
				notes: [
					"could not locate the firstmate home",
					"secondmate home not found: /tmp/a",
					"activation manifest degraded for /tmp/x: stale",
					"artifact records unavailable",
					"fleet metrics unavailable: omp stats --json failed",
				],
			}),
			"/tmp",
			0,
		);
		// missingHomes owns only "secondmate home not found:" notes; main-home note is preserved.
		expect(body.health.exceptions.some(e => /homes? missing/i.test(e))).toBe(true);
		expect(body.health.exceptions).toContain("could not locate the firstmate home");
		expect(body.health.exceptions).toContain("activation manifest degraded for /tmp/x: stale");
		expect(body.health.exceptions).not.toContain("secondmate home not found: /tmp/a");
		// Unique notes after dedup: main-home, activation, artifact, metrics (4).
		// Keep first 3; structured takes slot 1 → exceptions show structured + 2 notes.
		// Cap-dropped unique notes: metrics (1) + activation/artifact not in final 3-exception window?
		// merged = [structured homes, main-home, activation, artifact]; exceptions = first 3.
		// noteKeep = [main-home, activation, artifact]; metrics omitted by 3-row note cap (=1).
		// artifact loses exception slot → notesOmitted = 1 (metrics) + 1 (artifact) = 2.
		expect(body.omitted.notes).toBe(2);
		expect(body.health.exceptions).not.toContain("fleet metrics unavailable: omp stats --json failed");
	});

	it("renders attention reason and PR together when both exist", () => {
		const text = formatStartupSummary(
			buildStartupDecisionBody(
				baseSnapshot({
					attention: [
						{
							key: "kodiak/blocked",
							cls: "CAP-BLOCKED",
							clsRank: 4,
							reason: "needs cap decision",
							pr: "https://github.com/example/repo/pull/9",
						},
					],
				}),
				"/tmp/fm-home",
				0,
			),
		);
		expect(text).toContain("Home: /tmp/fm-home");
		const block = text.slice(text.indexOf("kodiak/blocked"));
		expect(block.indexOf("needs cap decision")).toBeGreaterThan(-1);
		expect(block.indexOf("PR: https://github.com/example/repo/pull/9")).toBeGreaterThan(
			block.indexOf("needs cap decision"),
		);
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
			clsRank: i === 0 ? 4 : 3,
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
			{ readyCount: 6, readyIds: ["hybrid-control-beater"] },
		);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STARTUP_SUMMARY_MAX_BYTES);
		expect(out).toContain("FIRSTMATE START");
		expect(out).toContain("Needs attention: 50 total, showing 3");
		expect(out).toContain("Active work: 5 total, showing 3");
		expect(out).toContain("Queue: 395 total, 6 ready");
		expect(out).toContain("Next ready: hybrid-control-beater");
		expect(out).toContain("Omitted:");
		expect(out).toContain("Refresh: fm fleet");
	});

	it("survives large multibyte free-text under the ceiling", () => {
		const monster = "🚀日本語".repeat(500);
		const out = renderStaticFleet(
			baseSnapshot({
				attention: [{ key: "kodiak/blocked", cls: "CAP-BLOCKED", clsRank: 4, reason: monster }],
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
		);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(STARTUP_SUMMARY_MAX_BYTES);
		expect(out).toContain("kodiak/blocked");
		expect(out).toMatch(/^As of: /m);
	});

	it("is deterministic for the same input", () => {
		const snap = baseSnapshot({
			attention: [
				{ key: "a/1", cls: "REVIEW-READY", clsRank: 3, reason: "r1", pr: "https://x/1" },
				{ key: "b/2", cls: "CAP-BLOCKED", clsRank: 4, reason: "r2" },
			],
			tasks: [
				{ key: "a/1", id: "1", state: "inflight", note: "" },
				{ key: "c/3", id: "3", state: "queued", note: "" },
			],
		});
		const frozen = new Date("2026-07-20T08:24:00.000Z");
		const a = renderStaticFleet(snap, "/tmp", 0, { readyCount: 1, readyIds: ["3"], now: frozen });
		const b = renderStaticFleet(snap, "/tmp", 0, { readyCount: 1, readyIds: ["3"], now: frozen });
		expect(a).toBe(b);
	});

	it("minimal fallback always stays under a tiny injected ceiling", () => {
		const body = buildStartupDecisionBody(
			baseSnapshot({
				attention: [{ key: "x", cls: "CAP-BLOCKED", clsRank: 4, reason: "y" }],
			}),
			"/tmp",
			1,
		);
		const huge = `${formatStartupSummary(body)}${"pad".repeat(5000)}`;
		const out = enforceStartupByteBound(huge, body, 400);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(400);
		expect(out).toContain("FIRSTMATE START");
		expect(out).toContain("bound fallback");
	});
});
