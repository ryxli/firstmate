// One shared tokenizer for both OLD and NEW interface_tokens, applied
// identically. Prefers js-tiktoken cl100k_base for realistic LLM-facing counts;
// falls back to deterministic ceil(chars/4) when the package is unavailable
// (offline / not installed). Both paths are pure and deterministic, so re-runs
// produce identical numbers.

type Encoder = (text: string) => number;

let encode: Encoder = (text: string) => Math.ceil(text.length / 4);
let backend = "chars/4";

// Runtime-selected import: js-tiktoken is an OPTIONAL dependency that may be
// absent (this repo has no package.json; the run must stay offline-safe). A
// static import would hard-fail module load and defeat the spec-mandated
// chars/4 fallback, so a guarded dynamic import is required here.
try {
	const tiktoken = await import("js-tiktoken");
	const enc = tiktoken.getEncoding("cl100k_base");
	encode = (text: string) => enc.encode(text).length;
	backend = "js-tiktoken/cl100k_base";
} catch {
	// keep the deterministic chars/4 fallback
}

// Token count of a string under the active backend.
export function countTokens(text: string): number {
	if (text.length === 0) return 0;
	return encode(text);
}

// Sum of token counts over many strings.
export function countAll(parts: readonly string[]): number {
	let total = 0;
	for (const p of parts) total += countTokens(p);
	return total;
}

// Which tokenizer is active this run (recorded in the results header).
export const tokenizerBackend = backend;
