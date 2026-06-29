// Pure summary statistics. Deterministic: identical input -> identical output,
// so the aggregation that builds on these is fully CI-testable.

import type { Stat } from "./types.ts";

// Median of a sample. Empty sample -> 0 (callers treat an empty variant as a
// degenerate aggregate; the decision rule never adopts off zero medians).
export function median(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Arithmetic mean. Empty -> 0.
export function mean(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	let total = 0;
	for (const x of xs) total += x;
	return total / xs.length;
}

// Population standard deviation (spread of the sample). Empty/singleton -> 0.
export function stddev(xs: readonly number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	let sq = 0;
	for (const x of xs) sq += (x - m) * (x - m);
	return Math.sqrt(sq / xs.length);
}

// Round to `places` decimals (deterministic; avoids long float tails in output).
export function round(x: number, places = 2): number {
	const f = 10 ** places;
	return Math.round(x * f) / f;
}

// Full summary for a sample, rounded for stable rendering/JSON.
export function summarize(xs: readonly number[]): Stat {
	return {
		median: round(median(xs)),
		mean: round(mean(xs)),
		stddev: round(stddev(xs)),
		n: xs.length,
	};
}
