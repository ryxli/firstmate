// Shared TOON-output and structured-error helpers for fm verb modules.
// This is helper code, not a verb registry: adding a new verb never requires editing this file.

import { encode } from "@toon-format/toon";

export function output(value: unknown): void {
	process.stdout.write(`${encode(value, { keyFolding: "safe" })}\n`);
}

export function validationError(error: string, help: string[], code = "VALIDATION_ERROR", extra: Record<string, unknown> = {}): number {
	output({ error, code, help, ...extra });
	return 2;
}

export function operationalError(command: string, error: unknown): number {
	output({
		error: `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
		code: "OPERATIONAL_ERROR",
		help: ["Check the local fleet prerequisites, then retry the command."],
	});
	return 1;
}

export function ambiguous(kind: string, id: string, candidates: string[]): number {
	return validationError(
		`Ambiguous ${kind} identifier: ${id}`,
		["Use the canonical owner-qualified key."],
		"AMBIGUOUS_IDENTIFIER",
		{ candidates },
	);
}

export function missing(kind: string, id: string): number {
	return validationError(`${kind} not found: ${id}`, ["Run the fleet list command and retry."], "NOT_FOUND");
}

/** Bounded Levenshtein distance, used only for short CLI-token did-you-mean suggestions. */
function editDistance(a: string, b: string): number {
	const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
			prev = tmp;
		}
	}
	return dp[b.length];
}

/**
 * Rigid did-you-mean: candidates close enough to `input` to be a plausible
 * typo. Never used to auto-execute - callers report it as a suggestion in a
 * structured failure and run nothing (AGENT ERGONOMICS: near-misses never
 * auto-execute; the error is the training signal).
 */
export function didYouMean(candidates: string[], input: string): string[] {
	return candidates.filter(c => editDistance(c, input) <= 2 || c.startsWith(input));
}
