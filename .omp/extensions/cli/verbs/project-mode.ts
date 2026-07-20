// fm verb: project-mode - resolve a project's delivery mode and yolo flag from
// the data/projects.md registry.
//
// Prints two words to stdout: "<mode> <yolo>" where mode is one of
// trunk|pr and yolo is on|off.
//
// Registry line format (data/projects.md):
//   - <name> - <desc> (added <date>)                  -> pr off  (default)
//   - <name> [<mode>] - <desc> (added <date>)          -> <mode> off
//   - <name> [<mode> +yolo] - <desc> (added <date>)    -> <mode> on
//
// Modes (only these; no legacy aliases):
//   pr     collaborative: accepted patch -> GitHub PR -> observe merge
//   trunk  personal: accepted patch -> integrate local default branch -> optional push
//
// Unknown/missing modes fall back to "pr off" with a stderr warning.
// Usage: fm project-mode <project-name>

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveData(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const dataOverride = process.env.FM_DATA_OVERRIDE?.trim();
	return dataOverride || join(fmHome, "data");
}

interface Parsed {
	mode: string;
	yolo: string;
}

function parseRegistry(text: string, name: string): Parsed | null {
	for (const rawLine of text.split("\n")) {
		const trimmed = rawLine.trim();
		const fields = trimmed.length ? trimmed.split(/\s+/) : [];
		if (fields[0] !== "-" || fields[1] !== name) continue;

		let mode = "pr";
		let yolo = "off";

		if (fields[2] && fields[2].startsWith("[")) {
			const collected: string[] = [];
			for (let i = 2; i < fields.length; i++) {
				collected.push(fields[i]);
				if (fields[i].endsWith("]")) break;
			}
			const inner = collected.join(" ").replace(/^\[|\]$/g, "");
			const parts = inner.length ? inner.split(/\s+/) : [];
			if (parts[0] && parts[0] !== "+yolo") mode = parts[0];
			if (parts.includes("+yolo")) yolo = "on";
		}

		return { mode, yolo };
	}
	return null;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const name = args[0];
	if (!name) {
		process.stderr.write("usage: fm project-mode <project-name>\n");
		return 1;
	}

	const data = resolveData();
	const reg = join(data, "projects.md");

	if (!existsSync(reg) || !statSync(reg).isFile()) {
		process.stderr.write(`warn: no registry at ${reg}; defaulting ${name} to pr off\n`);
		process.stdout.write("pr off\n");
		return 0;
	}

	const text = readFileSync(reg, "utf8");
	const parsed = parseRegistry(text, name);

	if (!parsed) {
		process.stderr.write(`warn: project "${name}" not in registry; defaulting to pr off\n`);
		process.stdout.write("pr off\n");
		return 0;
	}

	let { mode, yolo } = parsed;
	if (mode !== "pr" && mode !== "trunk") {
		process.stderr.write(
			`warn: unknown mode "${mode}" for ${name}; only trunk|pr are valid (no legacy aliases); defaulting to pr off\n`,
		);
		mode = "pr";
		yolo = "off";
	}
	if (yolo !== "on" && yolo !== "off") yolo = "off";

	process.stdout.write(`${mode} ${yolo}\n`);
	return 0;
}

export default {
	name: "project-mode",
	describe: "Resolve a project's delivery mode (trunk|pr only) and yolo flag from data/projects.md.",
	run,
};
