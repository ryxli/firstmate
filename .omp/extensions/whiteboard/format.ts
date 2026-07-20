// whiteboard markdown formatting.
//
// Mirrors the captain's nvim format-on-save: conform.nvim formats markdown with
// `prettierd` (falling back to `prettier`), stop-after-first. Every agent
// whiteboard write is normalized the same way, so agent writes and the captain's
// nvim writes converge on one canonical shape and the board diff stays clean
// instead of churning on list markers, blank-line runs, and trailing whitespace.
//
// Prettier's default `proseWrap: "preserve"` means prose is NOT re-wrapped, so
// the captain's sentence-per-line convention is kept intact; only structural
// whitespace is normalized.
//
// Fail-safe by construction: if no formatter is on PATH, the formatter errors,
// times out, or returns empty output, the original text is returned unchanged.
// Formatting is a convenience, never a gate - an agent write must never be lost
// or blocked because the formatter hiccuped. This module imports only node, so it
// stays omp-free and unit-testable like the rest of the extension core.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// Formatter command chain, mirroring conform's
// `markdown = { "prettierd", "prettier", stop_after_first = true }`.
// The first binary that exists and exits 0 with non-empty output wins.
const FORMATTERS = ["prettierd", "prettier"] as const;

// Default per-formatter wall-clock budget. prettierd's first call may spin up its
// daemon (~200ms observed); 4s is generous headroom without wedging a write.
const DEFAULT_TIMEOUT_MS = 4000;

// Injectable spawn so tests stay deterministic and never shell out.
type SpawnFn = (
	cmd: string,
	args: string[],
	opts: { input: string; encoding: "utf8"; timeout: number; maxBuffer: number },
) => SpawnSyncReturns<string>;

let _spawn: SpawnFn = spawnSync as unknown as SpawnFn;
export function _setSpawn(fn: SpawnFn): void { _spawn = fn; }
export function _resetSpawn(): void { _spawn = spawnSync as unknown as SpawnFn; }

// The argv that feeds `text` on stdin and names `filePath` so the formatter picks
// the markdown parser and resolves any prettier config from the board's location.
function argvFor(bin: string, filePath: string): string[] {
	// prettierd takes the target path positionally and formats stdin against it;
	// prettier needs the explicit --stdin-filepath flag for the same effect.
	return bin === "prettierd" ? [filePath] : ["--stdin-filepath", filePath];
}

// Normalize `text` as markdown the way nvim would on save. Returns the formatted
// document, or `text` unchanged when no formatter can be applied. Never throws.
export function formatMarkdown(
	text: string,
	filePath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): string {
	// Nothing to format; skip the subprocess entirely.
	if (text.trim().length === 0) return text;

	for (const bin of FORMATTERS) {
		let res: SpawnSyncReturns<string> | undefined;
		try {
			res = _spawn(bin, argvFor(bin, filePath), {
				input: text,
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch {
			// Spawn threw (e.g. binary missing): try the next formatter.
			continue;
		}
		// Missing binary (ENOENT) or timeout surfaces as res.error; a rejecting
		// formatter surfaces as a non-zero status. Either way, try the next one.
		if (!res || res.error || res.status !== 0) continue;
		const out = typeof res.stdout === "string" ? res.stdout : "";
		// Never let a formatter blank the board.
		if (out.trim().length === 0) continue;
		return out;
	}

	// Fail-safe: no formatter applied, keep the agent's exact text.
	return text;
}
