#!/usr/bin/env bun
// Emit clean, chart-consumable aggregated JSON from action-bench runs.json artifacts.
//
// Per benchmark-principles.md ## Reporting and visualization: the runner emits clean JSON and
// data-viz is OFFLOADED to purpose-built tools - raw token/latency/throughput/cost live in the
// omp stats dashboard (`omp stats --port <n>`), and result charts (correctness-by-tier, the
// accuracy-efficiency Pareto, cross-model harness lift) are drawn by a scientific charting tool.
// This module does NOT render charts; it produces a tidy long-format table those tools consume:
//   - correctness-by-tier    grouped bar: x=difficulty, series=arm, facet=model  (metric=correctness_rate)
//   - accuracy-efficiency    Pareto scatter: x=gen_tokens_to_pass, y=correctness_rate, series=arm
//   - cross-model lift       bar: value where difficulty=overall, metric=overall_correctness, by model x arm
//
// Usage: bun charts.ts results/<a>.runs.json [results/<b>.runs.json ...] [--out results/charts.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffAggregate, RunPayload, Stat } from "./engine.ts";

const DIFFS = ["easy", "medium", "hard", "aspirational"];
// (aggregate camelCase data key, stable snake_case metric label, is_median_stat)
const METRICS: Array<[keyof DiffAggregate, string, boolean]> = [
	["correctnessRate", "correctness_rate", false],
	["goalRate", "goal_rate", false],
	["corruptSuccess", "corrupt_success", false],
	["meanGoalProgress", "mean_goal_progress", false],
	["genTokensToPass", "gen_tokens_to_pass", true],
	["reasoningTokensToPass", "reasoning_tokens_to_pass", true],
	["turnsToPass", "turns_to_pass", true],
	["wallMsToPass", "wall_ms_to_pass", true],
	["ttftMsToPass", "ttft_ms_to_pass", true],
	["throughputTps", "throughput_tps", true],
	["costUsdToPass", "cost_usd_to_pass", true],
];

interface ChartRow {
	model: string;
	thinking: string;
	sha: string;
	arm: string;
	difficulty: string;
	metric: string;
	value: number | null;
	n: number | null;
}

function rowsFrom(payload: RunPayload): ChartRow[] {
	const rows: ChartRow[] = [];
	const model = payload.model ?? "?";
	const thinking = payload.thinking ?? "?";
	const sha = payload.sha ?? "?";
	for (const [arm, a] of Object.entries(payload.aggregate.arms)) {
		rows.push({
			model,
			thinking,
			sha,
			arm,
			difficulty: "overall",
			metric: "overall_correctness",
			value: a.overallCorrectness,
			n: null,
		});
		for (const d of DIFFS) {
			const b = a.byDifficulty[d];
			if (!b) continue;
			for (const [key, label, isStat] of METRICS) {
				const v = b[key];
				let value: number | null;
				let n: number | null;
				if (isStat) {
					const s = v as Stat | null;
					value = s ? s.median : null;
					n = s ? s.n : null;
				} else {
					value = v as number;
					n = b.runs;
				}
				rows.push({ model, thinking, sha, arm, difficulty: d, metric: label, value, n });
			}
		}
	}
	return rows;
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	const paths: string[] = [];
	let outPath: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") {
			outPath = argv[++i] ?? null;
		} else {
			paths.push(argv[i]);
		}
	}
	if (paths.length === 0) {
		console.log("usage: charts.ts <runs.json> [<runs.json> ...] [--out results/charts.json]");
		process.exit(1);
	}
	const rows: ChartRow[] = [];
	for (const p of paths) {
		rows.push(...rowsFrom(JSON.parse(readFileSync(p, "utf8")) as RunPayload));
	}
	const out = {
		schema: "action-bench.tidy.v1",
		columns: ["model", "thinking", "sha", "arm", "difficulty", "metric", "value", "n"],
		rows,
	};
	const dest = outPath ?? join(import.meta.dir, "results", "charts.json");
	writeFileSync(dest, JSON.stringify(out, null, 2));
	console.log(`wrote ${dest} (${rows.length} rows from ${paths.length} artifact(s))`);
}
