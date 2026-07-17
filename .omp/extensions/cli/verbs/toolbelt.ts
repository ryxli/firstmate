// fm verb: toolbelt - scan sbin/ for executable scripts and print
// "<name><TAB><description>" for each, sorted by name.
//
// Ported behavior-preserving from the former sbin/fm-toolbelt (no libs
// sourced). The description is the first header comment line after the
// shebang (shebang and "# shellcheck" directive lines are skipped, and a
// leading "<name> - " prefix is stripped). Scripts with no such comment
// print "(no header)" instead of failing. This replaces the hand-maintained
// toolbelt table in README.md so the listing can never drift from the
// actual scripts on disk.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Canonical sbin dir: resolved from this module's own physical location
// (four directories up from .omp/extensions/cli/verbs/ to the repo root),
// matching the original script's BASH_SOURCE-based dirname resolution.
const CANONICAL_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const SBIN_DIR = join(CANONICAL_ROOT, "sbin");

function isExecutableFile(path: string): boolean {
	try {
		const st = statSync(path);
		if (!st.isFile()) return false;
		return (st.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function describe(file: string): string {
	const name = file.split("/").pop() as string;
	let desc = "";
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return `${name}\t(no header)`;
	}

	// Mirror the original's `read -r line || [ -n "$line" ]` loop: split on
	// newlines, and a trailing non-terminated final line is still visited.
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;
		if (lineNum === 1 && line.startsWith("#!")) {
			continue;
		}
		if (line === "") {
			continue;
		}
		if (line.startsWith("# shellcheck")) {
			continue;
		}
		if (line.startsWith("#")) {
			desc = line.slice(1);
			if (desc.startsWith(" ")) desc = desc.slice(1);
		} else if (line.startsWith("//")) {
			desc = line.slice(2);
			if (desc.startsWith(" ")) desc = desc.slice(1);
		}
		break;
	}

	if (desc.startsWith(`${name} - `)) {
		desc = desc.slice(`${name} - `.length);
	} else if (desc.startsWith(`${name} -`)) {
		desc = desc.slice(`${name} -`.length);
	}
	if (desc === "") desc = "(no header)";

	return `${name}\t${desc}`;
}

async function run(_argv: string[]): Promise<number> {
	let entries: string[];
	try {
		entries = readdirSync(SBIN_DIR);
	} catch {
		entries = [];
	}

	const lines: string[] = [];
	for (const entry of entries) {
		const full = join(SBIN_DIR, entry);
		if (!isExecutableFile(full)) continue;
		lines.push(describe(full));
	}

	lines.sort();
	for (const line of lines) {
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

export default {
	name: "toolbelt",
	describe: "List every executable sbin/ script with its header description.",
	run,
};
