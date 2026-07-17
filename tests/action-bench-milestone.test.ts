// tests/action-bench-milestone.test.ts - focused tests for the revived action-bench
// milestone/calibration/comparison layer (benchmarks/action-bench/{calibrate,charts,
// compare,milestone-ledger,milestone.sh}.ts). NO live LLM runs: the milestone.sh
// integration case drives the real pipeline (gates -> live run -> ledger/compare/
// charts) against a deterministic stub standing in for the `omp` binary, so it
// needs no network and spends no tokens - it only proves the wiring is correct.
//
// Every artifact this file produces is written under a per-test mkdtemp dir, NEVER
// under benchmarks/action-bench/results/: that directory stays untouched (a cap
// decision on seeding historical results data is pending), and the milestone layer
// must prove it runs cleanly from an empty results dir.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aggregate, type RunPayload, type RunRecord } from "../benchmarks/action-bench/engine.ts";
import { rowsFrom } from "../benchmarks/action-bench/charts.ts";
import { render } from "../benchmarks/action-bench/compare.ts";
import { macroFor, recordToJsonl, renderSection } from "../benchmarks/action-bench/milestone-ledger.ts";
import { perScenario } from "../benchmarks/action-bench/calibrate.ts";

const BENCH_DIR = join(import.meta.dir, "..", "benchmarks", "action-bench");
const REAL_RESULTS_DIR = join(BENCH_DIR, "results");

// ---- shared synthetic fixture (mirrors tests/fm-action-bench.test.sh's agg.runs.json) ----
function fixtureRuns(): RunRecord[] {
	return [
		{ scenario: "s1", difficulty: "easy", arm: "control", trial: 0, correct: true, goalCorrect: true, proceduralClean: true, goalProgress: 1, reasoningTokens: 100, turns: 3, fixture: "f0" },
		{ scenario: "s1", difficulty: "easy", arm: "control", trial: 1, correct: false, goalCorrect: false, proceduralClean: true, goalProgress: 0, reasoningTokens: 40, turns: 2, fixture: "f1" },
		{ scenario: "s1", difficulty: "easy", arm: "harness", trial: 0, correct: true, goalCorrect: true, proceduralClean: true, goalProgress: 1, reasoningTokens: 50, turns: 2, fixture: "f2" },
		{ scenario: "s1", difficulty: "easy", arm: "harness", trial: 1, correct: false, goalCorrect: true, proceduralClean: false, goalProgress: 1, reasoningTokens: 60, turns: 2, fixture: "f3" },
	];
}

function fixturePayload(model: string, sha: string): RunPayload {
	const runs = fixtureRuns();
	return {
		capturedUtc: "2026-01-01T00:00:00.000Z",
		sha,
		model,
		thinking: "off",
		trials: 2,
		elapsedS: 1.2,
		runs,
		aggregate: aggregate(runs),
	};
}

describe("charts.ts rowsFrom (tidy long-format rows)", () => {
	it("emits overall + per-difficulty rows per arm with stable metric labels", () => {
		const rows = rowsFrom(fixturePayload("model-a", "sha1"));
		const overall = rows.filter((r) => r.difficulty === "overall");
		expect(overall.length).toBe(2); // control + harness
		expect(overall.map((r) => r.metric)).toEqual(["overall_correctness", "overall_correctness"]);
		const easyCorrectness = rows.find((r) => r.arm === "control" && r.difficulty === "easy" && r.metric === "correctness_rate");
		expect(easyCorrectness?.value).toBe(0.5);
		expect(easyCorrectness?.n).toBe(2);
		const reasonMedian = rows.find((r) => r.arm === "harness" && r.difficulty === "easy" && r.metric === "reasoning_tokens_to_pass");
		expect(reasonMedian?.value).toBe(50); // only the 1 correct harness run counts (corrupt success excluded)
		expect(reasonMedian?.n).toBe(1);
	});
});

describe("compare.ts render (cross-model narrative)", () => {
	it("renders a headline table and the per-model harness lift", () => {
		const md = render([fixturePayload("model-a", "sha1")]);
		expect(md).toContain("## Headline: harness lift per model");
		expect(md).toContain("`model-a`");
		expect(md).toContain("harness lift on `model-a`: overall correctness 0.5 -> 0.5");
		expect(md).toContain("corrupt-success 0 -> 1"); // control has 0, harness has 1 (the reward-hack)
	});
});

describe("milestone-ledger.ts macroFor + serialization", () => {
	it("re-aggregates under supplied tiers and computes the harness lift", () => {
		const tiers = new Map([["s1", "easy"]]);
		const macro = macroFor(fixturePayload("model-a", "sha1"), tiers);
		expect(macro.model).toBe("model-a");
		expect(macro.scenarios).toBe(1);
		expect(macro.control).toBe(0.5);
		expect(macro.harness).toBe(0.5);
		expect(macro.lift).toBe(0);
		expect(macro.corrupt).toBe(1);
	});

	it("serializes a milestone record to a Python-json.dumps-compatible jsonl line", () => {
		const tiers = new Map([["s1", "easy"]]);
		const macro = macroFor(fixturePayload("model-a", "sha1"), tiers);
		const rec = { captured: "2026-01-01T00:00:00.000000+00:00", milestone: "m1", sha: "sha1", corpus_scenarios: 1, trials: 2, note: "", models: [macro] };
		const line = recordToJsonl(rec);
		expect(() => JSON.parse(line)).not.toThrow();
		const parsed = JSON.parse(line);
		expect(parsed.models[0].control).toBe(0.5);
		expect(parsed.milestone).toBe("m1");
		const section = renderSection(rec);
		expect(section).toContain("## m1");
		expect(section).toContain("| `model-a` | 0.5 | 0.5 | +0.000 | 1 |");
	});
});

describe("calibrate.ts perScenario", () => {
	it("counts correct/total per scenario per arm across payloads", () => {
		const { counts, diff } = perScenario(fixturePayload("model-a", "sha1"));
		expect(diff.get("s1")).toBe("easy");
		expect(counts.get("s1")?.get("control")).toEqual([1, 2]);
		expect(counts.get("s1")?.get("harness")).toEqual([1, 2]);
	});
});

// ---- milestone.sh end-to-end, against a deterministic omp stub (no network/tokens) ----
describe("milestone.sh end-to-end (deterministic stub, isolated out dir)", () => {
	it("runs gates -> live run -> ledger/compare/charts with no network and no results/ pollution", () => {
		const resultsExistedBefore = existsSync(REAL_RESULTS_DIR);
		const preExistingEntries = resultsExistedBefore ? readdirSync(REAL_RESULTS_DIR) : null;

		const workDir = mkdtempSync(join(tmpdir(), "action-bench-milestone-"));
		const outDir = join(workDir, "results");
		const fakeOmp = join(workDir, "fake-omp");
		// A deterministic no-op agent stub standing in for `omp`: it "runs" (a real
		// assistant turn + turn_end) but takes no tool action, so it fails every
		// scenario's goal by design (real-difficulty gate guarantees a no-op cannot
		// pass) - this proves the run/judge/aggregate/ledger pipeline end-to-end
		// without spending a token or touching the network.
		writeFileSync(
			fakeOmp,
			[
				"#!/usr/bin/env bun",
				"const argv = Bun.argv.slice(2);",
				'if (argv[0] === "stats") {',
				'  console.log(JSON.stringify({ byFolder: [] }));',
				"  process.exit(0);",
				"}",
				'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { reasoningTokens: 1 }, content: [{ type: "text", text: "noop" }] } }));',
				'console.log(JSON.stringify({ type: "turn_end" }));',
				"process.exit(0);",
				"",
			].join("\n"),
		);
		chmodSync(fakeOmp, 0o755);

		const run = spawnSync("bash", ["milestone.sh", "test-milestone", "testsha", "1"], {
			cwd: BENCH_DIR,
			encoding: "utf8",
			env: {
				...process.env,
				FM_MILESTONE_OMP: fakeOmp,
				FM_MILESTONE_MODELS: "fake-model:off",
				FM_MILESTONE_ONLY: "ref-easy-uppercase,fm-status-escalation",
				FM_MILESTONE_OUT: outDir,
			},
		});

		if (run.status !== 0) {
			throw new Error(`milestone.sh exited ${run.status}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`);
		}
		expect(run.stdout).toContain("integrity gates: ALL PASS");
		expect(run.stdout).toContain("milestone 'test-milestone' complete");

		// ledger
		const jsonlPath = join(outDir, "milestones.jsonl");
		const mdPath = join(outDir, "milestones.md");
		expect(existsSync(jsonlPath)).toBe(true);
		expect(existsSync(mdPath)).toBe(true);
		const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
		expect(lines.length).toBe(1);
		const rec = JSON.parse(lines[0]);
		expect(rec.milestone).toBe("test-milestone");
		expect(rec.sha).toBe("testsha");
		expect(rec.corpus_scenarios).toBe(2);
		expect(rec.trials).toBe(1);
		expect(rec.models.length).toBe(1);
		expect(rec.models[0].model).toBe("fake-model");
		// the no-op stub fails every scenario's goal (real-difficulty gate proves this
		// is guaranteed), so both arms score 0 correctness - the pipeline still ran.
		expect(rec.models[0].control).toBe(0);
		expect(rec.models[0].harness).toBe(0);
		const md = readFileSync(mdPath, "utf8");
		expect(md).toContain("## test-milestone");

		// cross-model comparison
		const comparePath = join(outDir, "cross-model-comparison.md");
		expect(existsSync(comparePath)).toBe(true);
		expect(readFileSync(comparePath, "utf8")).toContain("cross-model comparison");

		// charts
		const chartsPath = join(outDir, "charts.json");
		expect(existsSync(chartsPath)).toBe(true);
		const charts = JSON.parse(readFileSync(chartsPath, "utf8"));
		expect(charts.schema).toBe("action-bench.tidy.v1");
		expect(charts.rows.length).toBeGreaterThan(0);

		// the durable, committed results/ dir must be untouched by this run: every
		// artifact landed under the isolated outDir instead.
		if (resultsExistedBefore) {
			expect(readdirSync(REAL_RESULTS_DIR)).toEqual(preExistingEntries as string[]);
		} else {
			expect(existsSync(REAL_RESULTS_DIR)).toBe(false);
		}
	}, 60_000);
});
