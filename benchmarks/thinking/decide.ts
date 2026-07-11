// The adopt-iff decision rule - the whole point of the bench. Pure and
// unit-tested so the adopt/reject boundary is proven to flip on exactly the
// right signals, with NO LLM in the loop.
//
//   ADOPT NEW iff:
//     median_thinking_tokens(new) < median_thinking_tokens(old)   (strictly fewer)
//     AND quality_pass_rate(new) >= quality_pass_rate(old)        (no regression)
//
// Latency is reported but NOT a gate: a discipline that trims tokens without
// regressing quality is worth adopting even if latency is a wash, and latency
// is the noisiest signal. On REJECT every failing clause is named.

import { round } from "./stats.ts";
import type { Aggregate, Decision } from "./types.ts";
import { pickVariant } from "./aggregate.ts";

// pct reduction of `now` vs `base` (positive = improvement). base 0 -> 0 to
// avoid a divide-by-zero blowing up the report.
function reductionPct(base: number, now: number): number {
	if (base === 0) return 0;
	return round(((base - now) / base) * 100, 1);
}

// Apply the rule to a set of aggregates, comparing `candidate` against
// `baseline`. Throws if either variant is missing.
export function decide(aggs: readonly Aggregate[], baseline: string, candidate: string): Decision {
	const o = pickVariant(aggs, baseline);
	const n = pickVariant(aggs, candidate);

	const tokensDown = n.thinking.median < o.thinking.median;
	const qualityHeld = n.quality_pass_rate >= o.quality_pass_rate;

	const failingSignals: string[] = [];
	if (!tokensDown)
		failingSignals.push(
			`thinking-tokens not reduced (median new ${n.thinking.median} >= old ${o.thinking.median})`,
		);
	if (!qualityHeld)
		failingSignals.push(
			`quality regressed (pass-rate new ${n.quality_pass_rate} < old ${o.quality_pass_rate})`,
		);

	return {
		adopt: tokensDown && qualityHeld,
		baseline,
		candidate,
		thinkingTokenDelta: round(o.thinking.median - n.thinking.median),
		thinkingTokenDeltaPct: reductionPct(o.thinking.median, n.thinking.median),
		qualityDelta: round(n.quality_pass_rate - o.quality_pass_rate, 4),
		latencyDelta: round(o.latency_ms.median - n.latency_ms.median),
		latencyDeltaPct: reductionPct(o.latency_ms.median, n.latency_ms.median),
		failingSignals,
	};
}
