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
