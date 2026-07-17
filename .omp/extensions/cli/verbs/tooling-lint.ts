// fm verb: tooling-lint - guard firstmate's own shipped tooling surfaces against
// non-bun JS/TS invocation.
//
// Migrated verbatim (behavior-preserving) out of the former sbin/fm tooling-lint.
//
// This workstation runs bun (see the "House tooling conventions" block that
// sbin/fm-brief.sh bakes into every crewmate brief and secondmate charter). A
// tool firstmate ships must be invoked via `bunx <tool>` or a bun-linked bare
// command - never the generic ecosystem runner, and never by running built
// output or a raw script file directly in docs, help text, or any user-facing
// invocation. This linter is the cheap mechanical backstop so that convention
// cannot silently rot back in: it greps the surfaces a human or agent actually
// reads and fails (exit 1) listing every offending line.
//
// Scanned surfaces under the root (default: this repo): README.md,
// CONTRIBUTING.md, .agents/skills/*/SKILL.md, and sbin/*.sh help/echo text.
//
// Usage:
//   fm tooling-lint            # scan this repo
//   fm tooling-lint <root>     # scan an alternate root (used by the test)
//
// Two files are deliberately NOT scanned: the former guard script's basename
// and sbin/fm-brief.sh. Both exist to STATE the convention, so they
// legitimately name the forbidden forms as prohibition text; scanning them
// would flag the very rule they define. For any other one-off counterexample
// a line may carry the marker `fm-tooling-lint: allow` and it is skipped.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// firstmate root: verbs/ -> cli/ -> extensions/ -> .omp/ -> repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

// The convention-definers: named by the forbidden forms on purpose, so exempt.
const SELF = "tooling-lint.ts";
const GENERATOR = "fm-brief.sh";
const ALLOW = "fm-tooling-lint: allow";

function usage(): number {
	process.stderr.write("usage: fm tooling-lint [root]\n");
	return 2;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// Recursively collect files under dir whose basename passes `match`.
function walk(dir: string, match: (name: string) => boolean, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries.sort()) {
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(full, match, out);
		} else if (st.isFile() && match(entry)) {
			out.push(full);
		}
	}
}

interface Scan {
	label: string;
	test: (line: string) => boolean;
}

// 1) the generic ecosystem runner, as a whole word.
const NPX_RE = /\bnpx\b/;
// 2) running built output directly: `node <path-with-dist>` (e.g. node dist/cli.js).
const NODE_DIST_RE = /\bnode\s+\S*dist\b/;
// 3) a raw .js script file as a user-facing command (./sbin/x.js, sbin/x.js).
const JS_SCRIPT_RE = /(^|\s|`)\.?\/?sbin\/[^\s]*\.js/;

const SCANS: Scan[] = [
	{ label: "npx invocation", test: line => NPX_RE.test(line) },
	{ label: "node dist invocation", test: line => NODE_DIST_RE.test(line) },
	{ label: ".js script invocation", test: line => JS_SCRIPT_RE.test(line) },
];

function fileLines(path: string): string[] {
	const content = readFileSync(path, "utf8");
	const lines = content.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length > 1) return usage();

	const root = args.length === 1 ? args[0] : REPO_ROOT;
	if (!isDir(root)) {
		process.stderr.write(`error: no such root: ${root}\n`);
		return 2;
	}

	// Collect the tooling surfaces that exist under root.
	const files: string[] = [];
	const readme = join(root, "README.md");
	if (isFile(readme)) files.push(readme);
	const contributing = join(root, "CONTRIBUTING.md");
	if (isFile(contributing)) files.push(contributing);

	const skillsDir = join(root, ".agents", "skills");
	if (isDir(skillsDir)) walk(skillsDir, name => name === "SKILL.md", files);

	const sbinDir = join(root, "sbin");
	if (isDir(sbinDir)) {
		const sbinFiles: string[] = [];
		walk(sbinDir, name => name.endsWith(".sh"), sbinFiles);
		for (const f of sbinFiles) {
			const b = basename(f);
			if (b === SELF || b === GENERATOR) continue;
			files.push(f);
		}
	}

	if (files.length === 0) {
		process.stdout.write(`ok - no tooling surfaces to scan under ${root}\n`);
		return 0;
	}

	let fail = false;

	for (const scan of SCANS) {
		const hits: string[] = [];
		for (const file of files) {
			const lines = fileLines(file);
			lines.forEach((line, idx) => {
				if (scan.test(line) && !line.includes(ALLOW)) {
					hits.push(`${file}:${idx + 1}:${line}`);
				}
			});
		}
		if (hits.length > 0) {
			process.stderr.write(`forbidden: ${scan.label} in firstmate tooling surface (house convention: use bun/bunx)\n`);
			for (const hit of hits) {
				process.stderr.write(`  ${scan.label}: ${hit}\n`);
			}
			fail = true;
		}
	}

	if (fail) {
		process.stderr.write("--\n");
		process.stderr.write("Use bun/bunx (or a bun-linked bare invocation) in shipped tooling docs and help text.\n");
		return 1;
	}

	process.stdout.write("ok - no non-bun JS invocation in firstmate tooling surfaces\n");
	return 0;
}

export default {
	name: "tooling-lint",
	describe: "Guard firstmate's shipped tooling surfaces (README, CONTRIBUTING, SKILL.md, sbin help text) against non-bun JS invocation.",
	run,
};
