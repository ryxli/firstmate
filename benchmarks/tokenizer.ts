// Fixed tokenizer approximation.  The replay intentionally avoids an optional
// package so results are byte-stable across offline and CI environments.
export const tokenizerBackend = "chars/4";

export function countTokens(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}
