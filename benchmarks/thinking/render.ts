// Pure report builders. buildReportData turns recorded metrics into the full
// deterministic verdict (aggregates + decision + per-task breakdown); the two
// renderers turn that into the markdown evidence table and the raw JSON. No I/O,
// no LLM - this is what `replay` runs and what the offline tests assert on.

import { aggregate, pickVariant } from "./aggregate.ts";
import { decide } from "./decide.ts";
import type { Aggregate, Decision, RunMetric } from "./types.ts";

export type ReportMeta = {
	stamp: string; // ISO timestamp (only field allowed to vary run-to-run)
	model: string; // model used for the live run (or "replay")
	thinking: string; // thinking/effort level held constant across variants
	baseline: string; // baseline variant name
	candidate: string; // candidate (NEW) variant name
	corpusSize: number; // number of tasks
	trialsPerCell: number; // configured trials per (task, variant)
};

export type PerTaskRow = { task: string; baseline: Aggregate; candidate: Aggregate };

export type ReportData = {
	meta: ReportMeta;
	aggregates: Aggregate[];
	decision: Decision;
	perTask: PerTaskRow[];
};

// Compute the entire verdict from recorded metrics. Deterministic.
export function buildReportData(metrics: readonly RunMetric[], meta: ReportMeta): ReportData {
	const aggregates = aggregate(metrics);
	const decision = decide(aggregates, meta.baseline, meta.candidate);

	const ids: string[] = [];
	const seen = new Set<string>();
	for (const m of metrics) {
		if (!seen.has(m.task)) {
			seen.add(m.task);
			ids.push(m.task);
		}
	}
	ids.sort();

	const perTask: PerTaskRow[] = ids.map((task) => {
		const sub = aggregate(metrics.filter((m) => m.task === task));
		return { task, baseline: pickVariant(sub, meta.baseline), candidate: pickVariant(sub, meta.candidate) };
	});

	return { meta, aggregates, decision, perTask };
}

// Render the markdown evidence table.
export function renderMarkdown(data: ReportData): string {
	const { meta, aggregates, decision, perTask } = data;
	const o = pickVariant(aggregates, meta.baseline);
	const n = pickVariant(aggregates, meta.candidate);
	const L: string[] = [];

	L.push("# Thinking-efficiency bench: BASELINE vs NEW");
	L.push("");
	L.push(`Run: ${meta.stamp}`);
	L.push(`Model: ${meta.model} | thinking level: ${meta.thinking} (held constant across variants)`);
	L.push(`Corpus: ${meta.corpusSize} tasks x ${meta.trialsPerCell} trials per variant.`);
	L.push("Quality is a deterministic per-task oracle (objective pass/fail); thinking & output tokens come from the real harness usage report, not estimates.");
	L.push("");

	L.push("## Per-variant aggregate (corpus x trials)");
	L.push("");
	L.push("| variant | trials | thinking tok median / mean (sd) | output tok median | latency ms median | quality pass-rate |");
	L.push("|---|---|---|---|---|---|");
	for (const a of aggregates) {
		L.push(
			`| ${a.variant} | ${a.trials} | ${a.thinking.median} / ${a.thinking.mean} (${a.thinking.stddev}) | ${a.output.median} | ${a.latency_ms.median} | ${pctRate(a.quality_pass_rate)} |`,
		);
	}
	L.push("");

	L.push("## Decision rule (authoritative)");
	L.push("");
	L.push("Adopt NEW iff: median_thinking_tokens(new) < median_thinking_tokens(old) AND quality_pass_rate(new) >= quality_pass_rate(old).");
	L.push("");
	L.push(`- thinking median(new) < median(old): ${n.thinking.median} < ${o.thinking.median} -> ${n.thinking.median < o.thinking.median ? "PASS" : "FAIL"}`);
	L.push(`- quality pass-rate(new) >= old: ${pctRate(n.quality_pass_rate)} >= ${pctRate(o.quality_pass_rate)} -> ${n.quality_pass_rate >= o.quality_pass_rate ? "PASS" : "FAIL"}`);
	L.push("");
	L.push(`- thinking-token delta: ${decision.thinkingTokenDelta} (${decision.thinkingTokenDeltaPct}% reduction)`);
	L.push(`- quality delta: ${decision.qualityDelta} (>= 0 required)`);
	L.push(`- latency delta (informational): ${decision.latencyDelta} ms (${decision.latencyDeltaPct}% reduction)`);
	L.push("");
	if (decision.adopt) {
		L.push(`### VERDICT: ADOPT NEW (thinking-token reduction ${decision.thinkingTokenDeltaPct}%, no quality regression)`);
	} else {
		L.push(`### VERDICT: DO NOT ADOPT - ${decision.failingSignals.join("; ")}`);
	}
	L.push("");

	L.push("## Per-task breakdown");
	L.push("");
	L.push("| task | thinking median O/N | quality pass-rate O/N |");
	L.push("|---|---|---|");
	for (const r of perTask) {
		L.push(`| ${r.task} | ${r.baseline.thinking.median}/${r.candidate.thinking.median} | ${pctRate(r.baseline.quality_pass_rate)}/${pctRate(r.candidate.quality_pass_rate)} |`);
	}
	L.push("");

	L.push("## Notes");
	L.push("");
	L.push("- LLM runs are non-deterministic: this report is replayed from a fixed recorded runs file, so re-rendering it is byte-stable (only the header stamp varies).");
	L.push("- Failed calls (ok=false) are excluded from every statistic and from the quality denominator, so a flaky call cannot fake a regression.");
	L.push("- Latency is reported but is NOT a gate (noisiest signal); the gate is tokens-down AND quality-not-down.");
	L.push("");

	return L.join("\n");
}

// Format a 0..1 rate as a percent string.
function pctRate(rate: number): string {
	return `${Math.round(rate * 1000) / 10}%`;
}

// Render the raw JSON object (caller stringifies).
export function renderJson(data: ReportData): unknown {
	return {
		run: data.meta.stamp,
		model: data.meta.model,
		thinking: data.meta.thinking,
		baseline: data.meta.baseline,
		candidate: data.meta.candidate,
		corpusSize: data.meta.corpusSize,
		trialsPerCell: data.meta.trialsPerCell,
		aggregates: data.aggregates,
		decision: data.decision,
		perTask: data.perTask.map((r) => ({ task: r.task, baseline: r.baseline, candidate: r.candidate })),
	};
}
