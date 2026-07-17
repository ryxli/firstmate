// fm verb: handoff-check - cross-check captain handoff records for overlap.
// Ported verbatim (behavior-preserving) from the former sbin/fm handoff-check.
// Verifies every pending/active row in data/handoff/current-actions.md has a
// corresponding, sufficiently-overlapping entry in data/handoff/firstmate-readback.md
// (and vice versa), via token-overlap matching.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// firstmate root: verbs/ -> cli/ -> extensions/ -> .omp/ -> repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

const IGNORED_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "between", "by", "captain",
	"conversation", "do", "for", "from", "in", "is", "it", "its", "of", "on",
	"or", "that", "the", "this", "to", "with", "work", "your",
]);

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// Mirrors fm_home_from_cwd in sbin/fm-root-lib.sh: walk up from the invocation
// dir to the nearest AGENTS.md marker (matches a secondmate home too, not just
// the canonical main checkout).
function homeFromCwd(): string | null {
	let dir: string;
	try {
		dir = realpathSync(process.cwd());
	} catch {
		return null;
	}
	for (;;) {
		if (isFile(join(dir, "AGENTS.md"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readLines(content: string): string[] {
	const raw = content.split(/\r?\n/);
	if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
	return raw;
}

function containsOrderedSubstrings(line: string, parts: string[]): boolean {
	let idx = 0;
	for (const part of parts) {
		const found = line.indexOf(part, idx);
		if (found === -1) return false;
		idx = found + part.length;
	}
	return true;
}

function normalizeTokens(text: string): string[] {
	return (text.match(/[A-Za-z0-9]+/g) ?? []).map(token => token.toLowerCase());
}

function tokenCount(text: string): number {
	return normalizeTokens(text).filter(token => !IGNORED_WORDS.has(token)).length;
}

function tokenOverlap(expected: string, candidate: string): number {
	const expectedTokens = normalizeTokens(expected).filter(token => !IGNORED_WORDS.has(token));
	const candidateTokens = normalizeTokens(candidate);
	let overlap = 0;
	for (const token of expectedTokens) {
		if (candidateTokens.includes(token)) overlap += 1;
	}
	return overlap;
}

interface SourceEntry {
	line: number;
	status: string;
	outcome: string;
}

interface ReadbackEntry {
	line: number;
	item: string;
}

function parseCurrentActions(content: string): { headerLine: number; entries: SourceEntry[] } {
	let headerLine = 1;
	const entries: SourceEntry[] = [];
	const lines = readLines(content);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const lineNo = i + 1;
		if (containsOrderedSubstrings(line, ["Exact request", "Status", "Proof"])) {
			headerLine = lineNo;
			continue;
		}
		if (line.startsWith("| ")) {
			const fields = line.split("|");
			const outcome = fields[3] ?? "";
			const status = (fields[4] ?? "").trim();
			if (
				status.startsWith("Pending") || status.startsWith("pending") ||
				status.startsWith("Active") || status.startsWith("active")
			) {
				entries.push({ line: lineNo, status, outcome });
			}
		}
	}
	return { headerLine, entries };
}

function parseReadback(content: string): { sectionLine: number; sectionEnd: number; entries: ReadbackEntry[] } {
	let sectionLine = 1;
	let sectionEnd = 1;
	let inSection = false;
	const entries: ReadbackEntry[] = [];
	const lines = readLines(content);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const lineNo = i + 1;
		if (line === "## Pending or active") {
			inSection = true;
			sectionLine = lineNo;
			continue;
		}
		if (inSection) {
			if (line.startsWith("## ")) {
				inSection = false;
				sectionEnd = lineNo - 1;
				continue;
			}
			const match = line.match(/^\s*[0-9]+\.\s*(.*)$/);
			if (match) entries.push({ line: lineNo, item: match[1] });
		}
	}
	if (inSection) sectionEnd = lines.length;
	return { sectionLine, sectionEnd, entries };
}

async function run(_argv: string[]): Promise<number> {
	const envHome = process.env.FM_HOME;
	let fmHome = envHome && envHome.length > 0 ? envHome : homeFromCwd();
	if (!fmHome) fmHome = REPO_ROOT;

	const current = join(fmHome, "data", "handoff", "current-actions.md");
	const readback = join(fmHome, "data", "handoff", "firstmate-readback.md");

	const currentExists = isFile(current);
	const readbackExists = isFile(readback);

	if (!currentExists && !readbackExists) {
		process.stdout.write(`SKIP: no handoff records under ${fmHome}/data/handoff (nothing to check)\n`);
		return 0;
	}
	if (!currentExists) {
		process.stdout.write("FAIL: current-actions.md:1 is missing; firstmate-readback.md:1 cannot be checked\n");
		return 1;
	}
	if (!readbackExists) {
		process.stdout.write("FAIL: current-actions.md:1 cannot be checked; firstmate-readback.md:1 is missing\n");
		return 1;
	}

	const { headerLine: currentHeaderLine, entries: sourceEntries } = parseCurrentActions(readFileSync(current, "utf8"));
	const { sectionLine: readbackSectionLine, sectionEnd: readbackSectionEnd, entries: readbackEntries } =
		parseReadback(readFileSync(readback, "utf8"));

	let failed = false;
	const matchedLines = new Set<number>();
	const output: string[] = [];

	let sourceCount = 0;
	for (const entry of sourceEntries) {
		sourceCount += 1;
		const expectedCount = tokenCount(entry.outcome);
		let bestScore = 0;
		let bestLine: number | null = null;
		let candidateIndex = 0;
		for (const rb of readbackEntries) {
			candidateIndex += 1;
			const score = tokenOverlap(entry.outcome, rb.item);
			if (score > bestScore || (score === bestScore && candidateIndex === sourceCount)) {
				bestScore = score;
				bestLine = rb.line;
			}
		}

		// A matching item must carry at least two meaningful words. Active
		// constraints may be paraphrased as a boundary in the readback, so they
		// use a lower overlap ratio than pending work outcomes.
		let requiredRatio = 40;
		if (entry.status.startsWith("Active") || entry.status.startsWith("active")) requiredRatio = 25;

		if (bestScore >= 2 && bestScore * 100 >= expectedCount * requiredRatio) {
			output.push(`PASS: current-actions.md:${entry.line} ↔ firstmate-readback.md:${bestLine}`);
			if (bestLine !== null) matchedLines.add(bestLine);
		} else {
			if (bestLine !== null) {
				output.push(`FAIL: current-actions.md:${entry.line} has no matching active-readback entry; closest is firstmate-readback.md:${bestLine}`);
			} else {
				output.push(`FAIL: current-actions.md:${entry.line} has no matching active-readback entry in firstmate-readback.md:${readbackSectionLine}-${readbackSectionEnd}`);
			}
			failed = true;
		}
	}

	if (sourceCount === 0) {
		output.push(`FAIL: current-actions.md:${currentHeaderLine} contains no pending or active entries; firstmate-readback.md:${readbackSectionLine} has no expected entries`);
		failed = true;
	}

	let readbackCount = 0;
	for (const rb of readbackEntries) {
		readbackCount += 1;
		if (!matchedLines.has(rb.line)) {
			output.push(`FAIL: firstmate-readback.md:${rb.line} is not represented by a pending or active current-actions.md entry; current-actions.md:${currentHeaderLine} is the table header`);
			failed = true;
		}
	}

	if (readbackCount === 0 && sourceCount > 0) {
		output.push(`FAIL: firstmate-readback.md:${readbackSectionLine}-${readbackSectionEnd} has no pending or active entries for current-actions.md:${currentHeaderLine}`);
		failed = true;
	}

	if (output.length > 0) process.stdout.write(`${output.join("\n")}\n`);
	return failed ? 1 : 0;
}

export default {
	name: "handoff-check",
	describe: "Cross-check captain handoff records for sufficient token overlap.",
	run,
};
