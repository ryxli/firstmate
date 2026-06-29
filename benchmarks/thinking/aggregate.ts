// Pure aggregation math: collapse the recorded per-trial metrics into one
// summary per variant (median + mean + spread of thinking tokens, output
// tokens, latency, plus quality pass-rate). Deterministic and unit-tested
// against synthetic fixtures - this is the layer the decision rule trusts.

import { PASS_THRESHOLD } from "./oracle.ts";
import { round, summarize } from "./stats.ts";
import type { Aggregate, RunMetric } from "./types.ts";

// Aggregate all metrics, grouped by variant. Failed calls (ok === false) are
// excluded from every statistic and from the quality denominator, so a flaky
// call can never masquerade as a quality regression. Variants are returned in
// first-seen order.
export function aggregate(metrics: readonly RunMetric[]): Aggregate[] {
	const order: string[] = [];
	const byVariant = new Map<string, RunMetric[]>();
	for (const m of metrics) {
		let bucket = byVariant.get(m.variant);
		if (!bucket) {
			bucket = [];
			byVariant.set(m.variant, bucket);
			order.push(m.variant);
		}
		bucket.push(m);
	}

	const out: Aggregate[] = [];
	for (const variant of order) {
		const ok = (byVariant.get(variant) ?? []).filter((m) => m.ok);
		const passes = ok.filter((m) => m.quality >= PASS_THRESHOLD).length;
		out.push({
			variant,
			trials: ok.length,
			thinking: summarize(ok.map((m) => m.thinking_tokens)),
			output: summarize(ok.map((m) => m.output_tokens)),
			latency_ms: summarize(ok.map((m) => m.latency_ms)),
			quality_pass_rate: ok.length === 0 ? 0 : round(passes / ok.length, 4),
			quality_mean: round(ok.length === 0 ? 0 : ok.reduce((s, m) => s + m.quality, 0) / ok.length, 4),
		});
	}
	return out;
}

// Find an aggregate by variant name, throwing if absent (a missing variant is a
// corpus/run defect, never a silent skip in the decision).
export function pickVariant(aggs: readonly Aggregate[], name: string): Aggregate {
	const found = aggs.find((a) => a.variant === name);
	if (!found) throw new Error(`no aggregate for variant ${JSON.stringify(name)} (have: ${aggs.map((a) => a.variant).join(", ")})`);
	return found;
}
