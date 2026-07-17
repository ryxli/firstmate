// fm verb: milestone-view - read-only longitudinal harness-performance dashboard,
// rendered from the milestone ledger (benchmarks/action-bench/results/milestones.jsonl).
//
// Mirrors fleet-view.ts: a shared collector step (here: reading + lightly parsing the
// ledger, plus an optional git-log backfill) feeds a self-contained HTML artifact via
// the same template-file + embed + lavish-open pattern. Unlike fleet-view/kpi-view this
// template carries NO external network resources (no CDN CSS/JS) - every rule and every
// line of chart code is inlined, per the dashboard's own no-network-resource contract.
//
// This tool is strictly READ-ONLY. It never mutates the ledger, git, or any project. Its
// only write is the HTML artifact.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROG = "fm-milestone-view";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const TEMPLATE = `${REPO_ROOT}/sbin/fm-milestone-view.template.html`;
const DEFAULT_LEDGER = `${REPO_ROOT}/benchmarks/action-bench/results/milestones.jsonl`;
const MARKER = "__MILESTONE_PAYLOAD__";
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// git log record/field separators: ASCII record/unit separators never appear in commit
// prose, so they split cleanly without escaping.
const GIT_RECORD_SEP = "\x1e";
const GIT_FIELD_SEP = "\x1f";

const USAGE = `usage: fm-milestone-view.sh [--output <path>] [--input <path>] [--no-open] [--no-git-weight]
  Read-only visual longitudinal dashboard rendered from the milestone ledger.

  --output <path>  HTML artifact path (default: <repo>/.lavish/milestone-view.html).
  --input <path>   Ledger file to render instead of the live milestones.jsonl
                    (offline diagnostics, fixtures, tests). Accepts either a JSON
                    array of rows or newline-delimited JSON (the ledger's native
                    format). Still read-only.
  --no-open        Generate the artifact but do not launch lavish.
  --no-git-weight  Skip the git-log context-weight backfill scan.
  -h, --help       Show this help.
`;

interface ParsedArgs {
	out: string;
	input: string;
	open: boolean;
	gitWeight: boolean;
}

interface RowError {
	line: number;
	error: string;
}

interface GitWeightPoint {
	sha: string;
	date: string;
	label: string;
	before: number;
	after: number;
}

function defaultOut(): string {
	const root = process.env.FM_ROOT_OVERRIDE?.trim() || REPO_ROOT;
	return `${root}/.lavish/milestone-view.html`;
}

function needsValue(value: string | undefined): value is never {
	return value === undefined || value.length === 0 || value.startsWith("-");
}

function parseArgs(args: string[]): { parsed: ParsedArgs; exit?: undefined } | { parsed?: undefined; exit: number } {
	let out = defaultOut();
	let input = "";
	let open = true;
	let gitWeight = true;
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--output" || arg === "-o" || arg === "--input" || arg === "-i") {
			const value = args[i + 1];
			if (needsValue(value)) {
				process.stderr.write(`${PROG}: ${arg} requires a value\n`);
				process.stderr.write(USAGE);
				return { exit: 2 };
			}
			if (arg === "--output" || arg === "-o") out = value;
			else input = value;
			i += 2;
		} else if (arg === "--no-open") {
			open = false;
			i += 1;
		} else if (arg === "--no-git-weight") {
			gitWeight = false;
			i += 1;
		} else if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			return { exit: 0 };
		} else {
			process.stderr.write(`${PROG}: unknown argument: ${arg}\n`);
			process.stderr.write(USAGE);
			return { exit: 2 };
		}
	}
	return { parsed: { out, input, open, gitWeight } };
}

// Parse the ledger text either as one JSON array (a fixture-friendly shape) or as
// newline-delimited JSON (the native milestones.jsonl format). Tolerant of blank
// lines and of individual malformed lines: a bad line is skipped and recorded in
// `errors` rather than aborting the whole render, so one corrupt row never blanks
// the dashboard.
function parseLedger(text: string): { rows: unknown[]; errors: RowError[] } {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { rows: [], errors: [] };

	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return { rows: parsed, errors: [] };
		} catch {
			// fall through to line-delimited parsing
		}
	}

	const rows: unknown[] = [];
	const errors: RowError[] = [];
	const lines = text.split("\n");
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx].trim();
		if (line.length === 0) continue;
		try {
			rows.push(JSON.parse(line));
		} catch (error) {
			errors.push({ line: idx + 1, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { rows, errors };
}

// Scan git log for commit messages that cite an fm-context-weight before/after
// token count (the "Weight: <label> N -> M tokens" convention used across recent
// harness-reduction commits) and fold every "<label> before -> after tokens" clause
// into one flat, deduplicated, date-sorted point list. The template groups these
// by label into a longitudinal backfill series. Fails closed to "unavailable" with
// a reason instead of throwing: this is an optional enhancement, never a hard
// dependency of the dashboard.
function collectGitWeightSeries(repoRoot: string): { available: boolean; reason?: string; points: GitWeightPoint[] } {
	if (!existsSync(`${repoRoot}/.git`)) {
		return { available: false, reason: "not a git repository", points: [] };
	}
	const result = spawnSync(
		"git",
		["-C", repoRoot, "log", "--all", "--grep=Weight:", `--pretty=format:%H${GIT_FIELD_SEP}%aI${GIT_FIELD_SEP}%B${GIT_RECORD_SEP}`],
		{ encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
	);
	if (result.error || result.status !== 0) {
		return { available: false, reason: result.error ? result.error.message : "git log failed", points: [] };
	}

	const seen = new Set<string>();
	const points: GitWeightPoint[] = [];
	const records = result.stdout.split(GIT_RECORD_SEP);
	const clause = /(\S+)\s+([\d,]+(?:\.\d+)?)\s*->\s*([\d,]+(?:\.\d+)?)\s*tok(?:ens)?\b/g;
	for (const record of records) {
		const fields = record.split(GIT_FIELD_SEP);
		if (fields.length < 3) continue;
		// git inserts its own newline between formatted commits (there is no
		// separator-free multi-commit --pretty mode), so every record but the
		// first arrives with a leading "\n" on its sha field; trim it here
		// rather than fighting git's log formatting.
		const sha = fields[0].trim();
		const [, date, body] = fields;
		const weightIdx = body.indexOf("Weight:");
		if (weightIdx === -1) continue;
		const segment = body.slice(weightIdx);
		for (const match of segment.matchAll(clause)) {
			const label = match[1];
			const before = Number(match[2].replace(/,/g, ""));
			const after = Number(match[3].replace(/,/g, ""));
			if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
			const key = `${date}|${label}|${before}|${after}`;
			if (seen.has(key)) continue;
			seen.add(key);
			points.push({ sha: sha.slice(0, 12), date, label, before, after });
		}
	}
	points.sort((a, b) => a.date.localeCompare(b.date));
	return { available: true, points };
}

// Mirrors fleet-view's embed(): neutralize the payload JSON for inline
// <script type="application/json">, byte-identical escaping.
function embed(templateText: string, payload: unknown): string {
	const text = JSON.stringify(payload)
		.split("&").join("\\u0026")
		.split("<").join("\\u003c")
		.split(">").join("\\u003e")
		.split(LINE_SEPARATOR).join("\\u2028")
		.split(PARAGRAPH_SEPARATOR).join("\\u2029");
	return templateText.split(MARKER).join(text);
}

async function run(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv.slice(1));
	if (parsed.exit !== undefined) return parsed.exit;
	const { out, input, open, gitWeight } = parsed.parsed;

	if (!existsSync(TEMPLATE)) {
		process.stderr.write(`${PROG}: template missing: ${TEMPLATE}\n`);
		return 1;
	}

	const ledgerPath = input || DEFAULT_LEDGER;
	if (!existsSync(ledgerPath)) {
		process.stderr.write(`${PROG}: ledger not found: ${ledgerPath}\n`);
		return 1;
	}

	let rows: unknown[];
	let rowErrors: RowError[];
	try {
		const text = readFileSync(ledgerPath, "utf8");
		const result = parseLedger(text);
		rows = result.rows;
		rowErrors = result.errors;
	} catch (error) {
		process.stderr.write(`${PROG}: could not read ledger: ${ledgerPath}\n`);
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	const gitWeightSeries = gitWeight
		? collectGitWeightSeries(REPO_ROOT)
		: { available: false, reason: "skipped (--no-git-weight)", points: [] };

	const generated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	mkdirSync(dirname(out), { recursive: true });

	const payload = {
		generated,
		source: input ? `input:${ledgerPath}` : `ledger:${ledgerPath}`,
		ledgerPath,
		rows,
		rowErrors,
		gitWeight: gitWeightSeries,
	};

	const templateText = readFileSync(TEMPLATE, "utf8");
	if (!templateText.includes(MARKER)) {
		process.stderr.write(`${PROG}: template missing ${MARKER} marker\n`);
		return 1;
	}
	writeFileSync(out, embed(templateText, payload));

	process.stderr.write(`${PROG}: wrote ${out}\n`);

	if (open) {
		const child = spawnSync("bunx", ["lavish-axi", out], { stdio: "inherit" });
		if (child.error) throw child.error;
		return child.status ?? 1;
	}
	return 0;
}

export default {
	name: "milestone-view",
	describe: "Read-only visual longitudinal dashboard rendered from the milestone ledger.",
	run,
};
