// fm verb: lint-shared-text - guard shared, semi-public text against firstmate's
// private persona and against the em-dash.
//
// Migrated verbatim (behavior-preserving) out of the former sbin/fm lint-shared-text.
//
// PR descriptions, commit messages, and issue bodies are read by people outside
// this fleet. They must read as plain engineering prose - never in firstmate's
// captain/first-mate persona, and never narrating firstmate's internal machinery
// as if it were product behavior. This linter is the cheap backstop: run a body
// through it BEFORE posting, and it fails (exit 1) listing every offending line.
//
// Usage:
//   fm lint-shared-text <file>     # lint a file
//   fm lint-shared-text -          # lint stdin
//   some-cmd | fm lint-shared-text # (same as -)
//
// What it flags (high-confidence only, so the guard stays trusted and false-
// positive-free): the persona/nautical address vocabulary that never belongs in
// engineering prose, plus the em-dash (U+2014, banned by convention - use "-").
// It deliberately does NOT flag legitimate technical words that happen to name
// this project or its parts (firstmate, lavish, worktree, steward, pane): those
// are real nouns a PR may need. Keeping mechanics OUT of shared text past this
// list is a judgment call the author still owns; this catches the obvious leaks.

import { existsSync, readFileSync, statSync } from "node:fs";

// Persona / nautical address vocabulary. Case-insensitive, word-boundary matched.
// These are the terms AGENTS.md forbids in cap-facing text; in a shared body
// they are always a leak. "captain" stays listed to catch legacy-style leaks;
// bare "cap" is deliberately NOT listed - as an ordinary English word it would
// false-positive on legitimate engineering prose ("cap the retries").
const PERSONA_WORDS = [
	"captain",
	"first mate",
	"crewmate",
	"crewmates",
	"secondmate",
	"secondmates",
	"shipmate",
	"matey",
	"aye",
	"shipshape",
	"belay",
	"avast",
];
// A couple of multi-word ones (phrase-matched, case-insensitive, no word boundary).
const PHRASE_WORDS = ["on deck", "all hands"];

const EMDASH = "—";

function escapeForRegex(word: string): string {
	return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PERSONA_RE = new RegExp(`\\b(?:${PERSONA_WORDS.map(escapeForRegex).join("|")})\\b`, "i");
const PHRASE_RE = new RegExp(`(?:${PHRASE_WORDS.map(escapeForRegex).join("|")})`, "i");

function usage(): number {
	process.stderr.write("usage: fm lint-shared-text <file|->\n");
	return 2;
}

function readStdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

// Mirrors bash `$(cat ...)` command-substitution semantics: all trailing
// newlines are stripped.
function stripTrailingNewlines(text: string): string {
	return text.replace(/\n+$/, "");
}

function grepMatches(lines: string[], test: (line: string) => boolean): string[] {
	const hits: string[] = [];
	lines.forEach((line, index) => {
		if (test(line)) hits.push(`${index + 1}:${line}`);
	});
	return hits;
}

function emit(label: string, hits: string[]): void {
	for (const hit of hits) {
		process.stderr.write(`  ${label}: ${hit}\n`);
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length > 1) return usage();
	const src = args.length === 1 ? args[0] : "-";

	let text: string;
	if (src === "-") {
		text = stripTrailingNewlines(readStdin());
	} else {
		if (!existsSync(src) || !statSync(src).isFile()) {
			process.stderr.write(`error: no such file: ${src}\n`);
			return 2;
		}
		text = stripTrailingNewlines(readFileSync(src, "utf8"));
	}

	const lines = text.split("\n");
	let fail = false;

	// 1) em-dash (U+2014) - always wrong.
	const emHits = grepMatches(lines, line => line.includes(EMDASH));
	if (emHits.length > 0) {
		process.stderr.write("forbidden: em-dash (U+2014); use an ASCII hyphen '-'\n");
		emit("em-dash", emHits);
		fail = true;
	}

	// 2) persona/nautical vocabulary (word-boundary, case-insensitive).
	const personaHits = grepMatches(lines, line => PERSONA_RE.test(line));
	if (personaHits.length > 0) {
		process.stderr.write("forbidden: firstmate persona/nautical vocabulary in shared text\n");
		emit("persona", personaHits);
		fail = true;
	}

	// 3) multi-word persona phrases.
	const phraseHits = grepMatches(lines, line => PHRASE_RE.test(line));
	if (phraseHits.length > 0) {
		process.stderr.write("forbidden: firstmate persona phrase in shared text\n");
		emit("phrase", phraseHits);
		fail = true;
	}

	if (fail) {
		process.stderr.write("--\n");
		process.stderr.write("Rewrite as plain engineering prose (no persona, no em-dash) before posting.\n");
		return 1;
	}

	process.stdout.write("ok - no persona/nautical vocabulary or em-dash in shared text\n");
	return 0;
}

export default {
	name: "lint-shared-text",
	describe: "Lint a file or stdin for the em-dash and firstmate persona/nautical vocabulary before it is posted to a shared PR/commit/issue body.",
	run,
};
