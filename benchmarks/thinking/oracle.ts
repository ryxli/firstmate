// Pure, deterministic quality oracle. Maps produced agent output to a score in
// [0,1]. Every kind is programmatic - never a model judgement and never a human
// rating - so "quality" is reproducible and cannot be argued away when the
// verdict is uncomfortable.

import type { Oracle } from "./types.ts";

// A trial counts as a quality PASS when its score is at or above this. The
// binary kinds (equals/regex/numeric) emit exactly 0 or 1, so 0.5 separates
// them cleanly; `contains` can emit partial credit and is judged the same way.
export const PASS_THRESHOLD = 0.5;

// Lowercase + trim + collapse internal whitespace. Used for tolerant-but-exact
// answer matching: "  391 " and "391" are equal, "Friday." vs "friday" differ
// only by trailing punctuation which `stripEdgePunct` removes.
function norm(s: string, ci: boolean): string {
	let out = s.trim().replace(/\s+/g, " ");
	if (ci) out = out.toLowerCase();
	return out;
}

// Strip surrounding quotes/punctuation an LLM tends to wrap a terse answer in.
function stripEdgePunct(s: string): string {
	return s.replace(/^[\s"'`*.,:;()\[\]]+/, "").replace(/[\s"'`*.,:;()\[\]]+$/, "");
}

// Extract the first signed decimal number in the text, or null. Tolerates
// thousands separators and surrounding prose ("The answer is 1,234.").
function firstNumber(s: string): number | null {
	const m = s.replace(/,(?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/);
	return m ? Number(m[0]) : null;
}

// Score `output` against `oracle` in [0,1]. Deterministic and side-effect free.
export function gradeOutput(output: string, oracle: Oracle): number {
	switch (oracle.kind) {
		case "equals": {
			const ci = oracle.ci !== false; // default case-insensitive
			const got = stripEdgePunct(norm(output, ci));
			const want = stripEdgePunct(norm(oracle.expected, ci));
			return got === want ? 1 : 0;
		}
		case "contains": {
			const ci = oracle.ci !== false;
			const hay = norm(output, ci);
			if (oracle.needles.length === 0) return 0;
			let hit = 0;
			for (const n of oracle.needles) {
				if (hay.includes(norm(n, ci))) hit += 1;
			}
			return hit / oracle.needles.length;
		}
		case "regex": {
			const re = new RegExp(oracle.pattern, oracle.flags);
			return re.test(output) ? 1 : 0;
		}
		case "numeric": {
			const got = firstNumber(output);
			if (got === null) return 0;
			const tol = oracle.tol ?? 0;
			return Math.abs(got - oracle.expected) <= tol ? 1 : 0;
		}
		default: {
			// Exhaustiveness guard: an unknown oracle kind is a corpus error, not
			// a silent zero.
			const bad = oracle as { kind?: string };
			throw new Error(`unknown oracle kind: ${String(bad.kind)}`);
		}
	}
}
