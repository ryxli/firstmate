// fm verb: kpi-view - read-only visual KPI dashboard for the firstmate workflow.
// Migrated verbatim (behavior-preserving) out of the former sbin/fm kpi-view
// plus its shared sbin/fm view-lib helpers, which are inlined below.
//
// This tool is strictly READ-ONLY. It never mutates herdr, omp, git, data, or
// state. The only data it reads comes from the shared collector or a JSON file
// passed with --input. Its only write is the HTML artifact.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROG = "fm-kpi-view";
const TEMPLATE = fileURLToPath(new URL("../../../../sbin/fm-kpi-view.template.html", import.meta.url));
const FM_AXI = fileURLToPath(new URL("../../../../sbin/fm", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const MARKER = "__FM_DATA__";

function usageText(): string {
	return `usage: fm kpi-view [--output <path>] [--input <json>] [--home <path>]
                    [--no-open]
  Read-only visual KPI dashboard rendered from FleetSnapshot metrics.

  --output <path>  HTML artifact path (default: <repo>/.lavish/kpi.html).
  --input <json>   Render this KPI or FleetSnapshot JSON file instead of collecting live data.
                   (offline diagnostics, fixtures, tests). Still read-only.
  --home <path>    Collect a specific firstmate home.
  --no-open        Generate the artifact but do not launch lavish.
  -h, --help       Show this help.
This tool never mutates herdr, omp, git, data, or state.
`;
}

interface ParsedArgs {
	output?: string;
	input: string;
	home: string;
	open: boolean;
}

type ParseResult = { kind: "help" } | { kind: "error"; message: string } | { kind: "ok"; args: ParsedArgs };

// Mirrors fm_view_need_value's `[ -n "$2" ] && [ "${2#-}" = "$2" ]`: the value
// must be present and must not itself look like another flag.
function looksLikeValue(value: string | undefined): value is string {
	if (value === undefined || value === "") return false;
	return value.replace(/^-/, "") === value;
}

// Mirrors fm_view_parse_args: shared option loop for --output/--input/--home/--no-open/--help.
function parseArgs(argv: string[]): ParseResult {
	const args: ParsedArgs = { input: "", home: "", open: true };
	let i = 0;
	while (i < argv.length) {
		const token = argv[i];
		if (token === "--output" || token === "-o") {
			const value = argv[i + 1];
			if (!looksLikeValue(value)) return { kind: "error", message: `${PROG}: ${token} requires a value` };
			args.output = value;
			i += 2;
			continue;
		}
		if (token === "--input" || token === "-i") {
			const value = argv[i + 1];
			if (!looksLikeValue(value)) return { kind: "error", message: `${PROG}: ${token} requires a value` };
			args.input = value;
			i += 2;
			continue;
		}
		if (token === "--home") {
			const value = argv[i + 1];
			if (!looksLikeValue(value)) return { kind: "error", message: `${PROG}: ${token} requires a value` };
			args.home = value;
			i += 2;
			continue;
		}
		if (token === "--no-open") {
			args.open = false;
			i += 1;
			continue;
		}
		if (token === "-h" || token === "--help") {
			return { kind: "help" };
		}
		return { kind: "error", message: `${PROG}: unknown argument: ${token}` };
	}
	return { kind: "ok", args };
}

// Mirrors fm_view_collect: run the shared FleetSnapshot collector via
// `bun fm fleet snapshot --json --metrics [--home <home>]`, failing closed
// with the collector's stderr on error.
function collect(homeOverride: string): { ok: true; raw: string } | { ok: false } {
	const cmdArgs = ["fleet", "snapshot", "--json", "--metrics"];
	if (homeOverride) cmdArgs.push("--home", homeOverride);
	const result = spawnSync("bun", [FM_AXI, ...cmdArgs], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		process.stderr.write(`${PROG}: FleetSnapshot collector failed:\n`);
		if (result.stderr) process.stderr.write(result.stderr);
		if (result.error) process.stderr.write(`${result.error.message}\n`);
		return { ok: false };
	}
	return { ok: true, raw: result.stdout ?? "" };
}

// Extract and validate the canonical fm-kpi/1 metrics object, unwrapping a full
// FleetSnapshot when the input carries a nested metrics record.
function extractKpi(raw: unknown): Record<string, unknown> | null {
	let data = raw;
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const metrics = (data as Record<string, unknown>).metrics;
		if (metrics && typeof metrics === "object" && !Array.isArray(metrics)) data = metrics;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	if ((data as Record<string, unknown>).schema !== "fm-kpi/1") return null;
	return data as Record<string, unknown>;
}

// Mirrors fm_view_embed: embed the payload JSON into the template's data island,
// neutralizing it for inline <script type="application/json"> (the XSS-safe
// block is byte-identical to the fleet-view front-end). Returns null if the
// template lacks the marker.
function embed(templatePath: string, data: Record<string, unknown>, marker: string): string | null {
	const text = JSON.stringify(data)
		.replace(/&/g, "\\u0026")
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	const template = readFileSync(templatePath, "utf8");
	if (!template.includes(marker)) return null;
	return template.replaceAll(marker, text);
}

async function run(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv.slice(1));
	if (parsed.kind === "help") {
		process.stdout.write(usageText());
		return 0;
	}
	if (parsed.kind === "error") {
		process.stderr.write(`${parsed.message}\n`);
		process.stderr.write(usageText());
		return 2;
	}
	const { args } = parsed;
	const out = args.output ?? join(process.env.FM_ROOT_OVERRIDE || REPO_ROOT, ".lavish", "kpi.html");

	if (!existsSync(TEMPLATE)) {
		process.stderr.write(`${PROG}: template missing: ${TEMPLATE}\n`);
		return 1;
	}

	const work = mkdtempSync(join(process.env.TMPDIR || "/tmp", "fm-kpi."));
	try {
		let rawText: string;
		if (args.input) {
			if (!existsSync(args.input)) {
				process.stderr.write(`${PROG}: input not found: ${args.input}\n`);
				return 1;
			}
			const rawPath = join(work, "raw.json");
			copyFileSync(args.input, rawPath);
			rawText = readFileSync(rawPath, "utf8");
		} else {
			if (!existsSync(FM_AXI)) {
				process.stderr.write(`${PROG}: collector missing: ${FM_AXI}\n`);
				return 1;
			}
			const collected = collect(args.home);
			if (!collected.ok) return 1;
			rawText = collected.raw;
		}

		let raw: unknown;
		try {
			raw = JSON.parse(rawText);
		} catch {
			process.stderr.write(`${PROG}: input is not fm-kpi/1 metrics JSON\n`);
			return 1;
		}
		const kpi = extractKpi(raw);
		if (!kpi) {
			process.stderr.write(`${PROG}: input is not fm-kpi/1 metrics JSON\n`);
			return 1;
		}

		mkdirSync(dirname(out), { recursive: true });
		const rendered = embed(TEMPLATE, kpi, MARKER);
		if (rendered === null) {
			process.stderr.write(`${PROG}: template missing ${MARKER} marker\n`);
			return 1;
		}
		writeFileSync(out, rendered);

		process.stderr.write(`fm-kpi-view: wrote ${out}\n`);

		if (args.open) {
			const opened = spawnSync("bunx", ["lavish-axi", out], { stdio: "inherit" });
			if (opened.error) {
				process.stderr.write(`${opened.error.message}\n`);
				return 1;
			}
			return opened.status ?? 1;
		}
		return 0;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

export default {
	name: "kpi-view",
	describe: "Read-only visual KPI dashboard rendered from FleetSnapshot metrics.",
	run,
};
