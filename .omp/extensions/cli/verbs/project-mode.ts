// fm verb: project-mode - resolve a project's delivery mode and yolo flag from
// the data/projects.md registry.
// Ported behavior-preserving from the former sbin/fm project-mode.
//
// Prints two words to stdout: "<mode> <yolo>" where mode is one of
// direct-PR|direct-main|local-only and yolo is on|off.
//
// Registry line format (data/projects.md):
//   - <name> - <desc> (added <date>)                  -> direct-PR off  (default)
//   - <name> [<mode>] - <desc> (added <date>)          -> <mode> off
//   - <name> [<mode> +yolo] - <desc> (added <date>)    -> <mode> on
//
// mode = how a finished change reaches main:
//   direct-PR    push + PR via gh-axi, focused review + tests, no pipeline -> captain merge (default)
//   direct-main  captain-authorized project mode: reviewed clean branch -> guarded direct push to origin/main, no PR
//   no-mistakes  legacy registry alias; canonicalized to direct-PR on output, so
//                consumers only ever see direct-PR|direct-main|local-only
//   local-only   local branch, no remote/PR -> firstmate review -> captain approve -> local merge
// yolo (orthogonal) = when on, firstmate makes approval decisions itself (PR merges,
//   ask-user findings, local-only merge approval) without checking the captain - except
//   anything destructive/irreversible/security-sensitive, which still escalates.
//
// An unknown/missing project or unknown mode falls back to "direct-PR off" and warns
// to stderr, so a typo never silently selects a direct-to-main mode.
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

// Mirrors the original awk one-liner: find the first registry line whose first
// two whitespace-separated fields are "-" and the project name, then read an
// optional bracketed "[<mode> +yolo]" token out of the remaining fields.
function parseRegistry(text: string, name: string): Parsed | null {
	for (const rawLine of text.split("\n")) {
		const trimmed = rawLine.trim();
		const fields = trimmed.length ? trimmed.split(/\s+/) : [];
		if (fields[0] !== "-" || fields[1] !== name) continue;

		let mode = "direct-PR";
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
		process.stderr.write(`warn: no registry at ${reg}; defaulting ${name} to direct-PR off\n`);
		process.stdout.write("direct-PR off\n");
		return 0;
	}

	const text = readFileSync(reg, "utf8");
	const parsed = parseRegistry(text, name);

	if (!parsed) {
		process.stderr.write(`warn: project "${name}" not in registry; defaulting to direct-PR off\n`);
		process.stdout.write("direct-PR off\n");
		return 0;
	}

	let { mode, yolo } = parsed;
	switch (mode) {
		case "no-mistakes":
			mode = "direct-PR"; // legacy alias: canonicalize so consumers never see it
			break;
		case "direct-PR":
		case "direct-main":
		case "local-only":
			break;
		default:
			process.stderr.write(`warn: unknown mode "${mode}" for ${name}; defaulting to direct-PR off\n`);
			mode = "direct-PR";
			yolo = "off";
			break;
	}
	if (yolo !== "on" && yolo !== "off") yolo = "off";

	process.stdout.write(`${mode} ${yolo}\n`);
	return 0;
}

export default {
	name: "project-mode",
	describe: "Resolve a project's delivery mode (direct-PR/direct-main/local-only) and yolo flag from the data/projects.md registry.",
	run,
};
