#!/usr/bin/env bun
// Side-by-side comparison of action-bench results across models.
//
// Each input is one model's runs.json (control + harness arms). Renders a headline
// harness-lift table (per model), then per-model detail across the difficulty tiers,
// then the isolated harness effect per model. Wins do NOT transfer across models
// (benchmark-principles.md ## Attribution), so every model is reported on its own.
//
// Usage: bun compare.ts results/<modelA>.runs.json results/<modelB>.runs.json [...]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffAggregate, RunPayload, Stat } from "./engine.ts";

const DIFFS = ["easy", "medium", "hard", "aspirational"];

function stat(s: Stat | null | undefined): number | string {
	return s ? s.median : "-";
}

function corrupt(bd: Partial<Record<string, DiffAggregate>>): number {
	return Object.values(bd).reduce((acc, b) => acc + (b ? b.corruptSuccess : 0), 0);
}

function render(payloads: RunPayload[]): string {
	const L: string[] = [
		"# action-bench - cross-model comparison",
		"",
		"Controlled A/B: `control` (no scaffold) vs `harness` (firstmate discipline scaffold); " +
			"only the harness varies. Correctness is primary (incl. procedural: a reward-hacked pass " +
			"does not count). Efficiency is cost-of-pass on correct runs only. A harness win on one " +
			"model does not transfer to another - each model stands alone.",
		"",
	];

	// ---- headline ----
	L.push(
		"## Headline: harness lift per model",
		"",
		"| model | arm | overall correct | hard | aspirational | corrupt-success |",
		"|---|---|---|---|---|---|",
	);
	for (const p of payloads) {
		const agg = p.aggregate.arms;
		for (const arm of ["control", "harness"]) {
			const a = agg[arm];
			if (!a) continue;
			const bd = a.byDifficulty;
			L.push(
				`| \`${p.model ?? "?"}\` | ${arm} | ${a.overallCorrectness} | ` +
					`${bd.hard?.correctnessRate ?? "-"} | ${bd.aspirational?.correctnessRate ?? "-"} | ${corrupt(bd)} |`,
			);
		}
	}
	L.push("");

	// ---- per-model detail ----
	for (const p of payloads) {
		const agg = p.aggregate.arms;
		L.push(
			`## \`${p.model ?? "?"}\`  (thinking=${p.thinking ?? "?"}, ` +
				`trials=${p.trials ?? "?"}, sha=\`${p.sha ?? "?"}\`, ${p.elapsedS ?? "?"}s)`,
			"",
		);
		for (const arm of ["control", "harness"]) {
			const a = agg[arm];
			if (!a) continue;
			L.push(
				`### arm: ${arm} - overall ${a.overallCorrectness}, frontier **${a.capabilityFrontier}**`,
				"",
				"| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |",
				"|---|---|---|---|---|---|---|---|---|---|",
			);
			for (const d of DIFFS) {
				const b = a.byDifficulty[d];
				if (!b) continue;
				L.push(
					`| ${d} | ${b.correctnessRate} | ${b.goalRate} | ${b.corruptSuccess} | ` +
						`${b.meanGoalProgress} | ${stat(b.genTokensToPass)} | ` +
						`${stat(b.reasoningTokensToPass)} | ${stat(b.turnsToPass)} | ` +
						`${stat(b.wallMsToPass)} | ${stat(b.throughputTps)} |`,
				);
			}
			L.push("");
		}
		const c = agg.control;
		const h = agg.harness;
		if (c && h) {
			const lift = h.overallCorrectness - c.overallCorrectness;
			const cc = corrupt(c.byDifficulty);
			const hc = corrupt(h.byDifficulty);
			L.push(
				`**harness lift on \`${p.model ?? "?"}\`: overall correctness ` +
					`${c.overallCorrectness} -> ${h.overallCorrectness} (${lift >= 0 ? "+" : ""}${lift.toFixed(3)}); ` +
					`corrupt-success ${cc} -> ${hc}**`,
				"",
			);
		}
	}
	return `${L.join("\n")}\n`;
}

if (import.meta.main) {
	const paths = Bun.argv.slice(2);
	if (paths.length === 0) {
		console.log("usage: compare.ts <runs.json> [<runs.json> ...]");
		process.exit(1);
	}
	const payloads = paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as RunPayload);
	const out = render(payloads);
	console.log(out);
	const dest = join(import.meta.dir, "results", "cross-model-comparison.md");
	writeFileSync(dest, out);
	console.log("wrote", dest);
}
