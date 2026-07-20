// fm fleet view - read-only visual fleet dashboard for the firstmate crew.
// Migrated from the former parent-level `fm fleet-view` command.
//
// Runs the shared typed FleetSnapshot collector and embeds its topology-rich
// snapshot into a self-contained HTML artifact (default .lavish/fleet.html).
//
// This tool is strictly READ-ONLY. It never mutates herdr, omp, git, data, or
// state. The only data it reads comes from the shared collector or a JSON file
// passed with --input. Its only write is the HTML artifact.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "../../bridge/collect";

const PROG = "fm fleet view";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const TEMPLATE = `${REPO_ROOT}/sbin/fm-fleet-view.template.html`;
const MARKER = "__FLEET_PAYLOAD__";
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const USAGE = `usage: fm fleet view [--output <path>] [--input <json>] [--home <path>] [--no-open]
  Read-only visual dashboard rendered from the shared FleetSnapshot collector.

  --output <path>  HTML artifact path (default: <repo>/.lavish/fleet.html).
  --input <json>   Render this FleetSnapshot JSON instead of collecting live data.
                   (offline diagnostics, fixtures, tests). Still read-only.
  --home <path>    Collect a specific firstmate home.
  --no-open        Generate the artifact but do not launch lavish.
  -h, --help       Show this help.
`;

interface ParsedArgs {
	out: string;
	input: string;
	home: string;
	open: boolean;
}

function defaultOut(): string {
	const root = process.env.FM_ROOT_OVERRIDE?.trim() || REPO_ROOT;
	return `${root}/.lavish/fleet.html`;
}

function needsValue(value: string | undefined): value is never {
	return value === undefined || value.length === 0 || value.startsWith("-");
}

// Mirrors fm_view_parse_args / fm_view_need_value in the former sbin/fm view-lib.
function parseArgs(args: string[]): { parsed: ParsedArgs; exit?: undefined } | { parsed?: undefined; exit: number } {
	let out = defaultOut();
	let input = "";
	let home = "";
	let open = true;
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--output" || arg === "-o" || arg === "--input" || arg === "-i" || arg === "--home") {
			const value = args[i + 1];
			if (needsValue(value)) {
				process.stderr.write(`${PROG}: ${arg} requires a value\n`);
				process.stderr.write(USAGE);
				return { exit: 2 };
			}
			if (arg === "--output" || arg === "-o") out = value;
			else if (arg === "--input" || arg === "-i") input = value;
			else home = value;
			i += 2;
		} else if (arg === "--no-open") {
			open = false;
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
	return { parsed: { out, input, home, open } };
}

// Mirrors fm_view_embed in the former sbin/fm view-lib: embed the payload JSON
// into the template's data island, neutralizing it for inline
// <script type="application/json"> (byte-identical escaping to the shell version).
function embed(templateText: string, payload: unknown): string {
	const text = JSON.stringify(payload)
		.split("&").join("\\u0026")
		.split("<").join("\\u003c")
		.split(">").join("\\u003e")
		.split(LINE_SEPARATOR).join("\\u2028")
		.split(PARAGRAPH_SEPARATOR).join("\\u2029");
	return templateText.split(MARKER).join(text);
}

export async function runFleetView(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv.slice(1));
	if (parsed.exit !== undefined) return parsed.exit;
	const { out, input, home, open } = parsed.parsed;

	if (!existsSync(TEMPLATE)) {
		process.stderr.write(`${PROG}: template missing: ${TEMPLATE}\n`);
		return 1;
	}

	let fleet: unknown;
	let source: string;
	if (input) {
		if (!existsSync(input)) {
			process.stderr.write(`${PROG}: input not found: ${input}\n`);
			return 1;
		}
		source = `file:${input}`;
		try {
			fleet = JSON.parse(readFileSync(input, "utf8"));
		} catch (error) {
			process.stderr.write(`${PROG}: invalid input JSON: ${input}: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	} else {
		source = "live";
		try {
			fleet = await collectSnapshot(new Date().toISOString(), home || undefined);
		} catch (error) {
			process.stderr.write(`${PROG}: FleetSnapshot collector failed:\n`);
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	}

	const generated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	mkdirSync(dirname(out), { recursive: true });

	const payload = { generated, source, fleet };
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

