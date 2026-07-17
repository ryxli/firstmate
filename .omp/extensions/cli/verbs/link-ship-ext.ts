// fm verb: link-ship-ext - install or refresh ship omp extension symlinks in a
// secondmate home, resolved by id or explicit home path.
// Ported behavior-preserving from the former sbin/fm link-ship-ext, with the
// symlink logic it sourced from sbin/fm-ship-ext-lib.sh inlined below.
//
// Each entry under .omp/extensions/ in this repo (canonical) is symlinked into
// <home>/.omp/extensions/<name>. An existing correct symlink is a no-op; a
// stale/wrong symlink is refreshed; a real file the home provides itself is
// left untouched.

import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Canonical extensions dir: always resolved from this module's own physical
// location (four directories up from .omp/extensions/cli/verbs/), matching the
// original script's SCRIPT_DIR-based resolution - independent of FM_ROOT_OVERRIDE.
const CANONICAL_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const EXT_SRC = join(CANONICAL_ROOT, ".omp", "extensions");

const USAGE = "usage: fm link-ship-ext <id|home-path>\n";

function envOr(name: string, fallback: string): string {
	const value = process.env[name];
	return value !== undefined && value !== "" ? value : fallback;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function extractHomeField(line: string): string {
	const idx = line.lastIndexOf("home: ");
	if (idx === -1) return "";
	const rest = line.slice(idx + "home: ".length);
	const match = rest.match(/^[^;)]*/);
	return match ? match[0] : "";
}

function homeForId(id: string, data: string): { home: string } | { error: string } {
	const reg = join(data, "secondmates.md");
	if (!existsSync(reg)) {
		return { error: `error: secondmates registry not found at ${reg}` };
	}
	const text = readFileSync(reg, "utf8");
	const lines = text.split(/\r?\n/);
	let pattern: RegExp;
	try {
		pattern = new RegExp(`^- ${id} `);
	} catch {
		return { error: `error: id '${id}' not found in ${reg}` };
	}
	const line = lines.find(candidate => pattern.test(candidate));
	if (line === undefined) {
		return { error: `error: id '${id}' not found in ${reg}` };
	}
	const home = extractHomeField(line);
	if (!home) {
		return { error: `error: no home entry for id '${id}' in ${reg}` };
	}
	return { home };
}

interface ShipExtResult {
	srcMissing: boolean;
	changed: number;
	skipped: number;
	noop: number;
}

function linkExists(path: string): { exists: boolean; isSymlink: boolean } {
	try {
		const st = lstatSync(path);
		return { exists: true, isSymlink: st.isSymbolicLink() };
	} catch {
		return { exists: false, isSymlink: false };
	}
}

function linkShipExtensions(home: string, extSrc: string): ShipExtResult {
	const result: ShipExtResult = { srcMissing: false, changed: 0, skipped: 0, noop: 0 };

	if (!isDirectory(extSrc)) {
		result.srcMissing = true;
		return result;
	}

	const extDst = join(home, ".omp", "extensions");
	if (!isDirectory(extDst)) {
		mkdirSync(extDst, { recursive: true });
	}

	const names = readdirSync(extSrc)
		.filter(name => !name.startsWith("."))
		.sort();

	for (const name of names) {
		const canonical = join(extSrc, name);
		const linkPath = join(extDst, name);
		const st = linkExists(linkPath);

		if (st.exists && !st.isSymlink) {
			process.stdout.write(`ship-ext: skip real file ${name}\n`);
			result.skipped += 1;
			continue;
		}

		if (st.isSymlink) {
			const existingTarget = readlinkSync(linkPath);
			if (existingTarget === canonical) {
				result.noop += 1;
				continue;
			}
			rmSync(linkPath, { force: true });
			symlinkSync(canonical, linkPath);
			process.stdout.write(`ship-ext: refreshed ${name} -> ${canonical}\n`);
			result.changed += 1;
		} else {
			symlinkSync(canonical, linkPath);
			process.stdout.write(`ship-ext: linked ${name} -> ${canonical}\n`);
			result.changed += 1;
		}
	}

	return result;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length !== 1) {
		process.stderr.write(USAGE);
		return 2;
	}
	const arg = args[0];

	const fmRoot = envOr("FM_ROOT_OVERRIDE", CANONICAL_ROOT);
	const fmHome = envOr("FM_HOME", fmRoot);
	const data = envOr("FM_DATA_OVERRIDE", join(fmHome, "data"));

	let home: string;
	if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../")) {
		home = arg;
	} else if (isDirectory(arg)) {
		home = arg;
	} else {
		const resolved = homeForId(arg, data);
		if ("error" in resolved) {
			process.stderr.write(`${resolved.error}\n`);
			return 1;
		}
		home = resolved.home;
	}

	if (!isDirectory(home)) {
		process.stderr.write(`error: home directory does not exist: ${home}\n`);
		return 1;
	}

	const result = linkShipExtensions(home, EXT_SRC);

	if (result.srcMissing) {
		process.stdout.write(`ship-ext: no extensions dir at ${EXT_SRC}; nothing to do\n`);
		return 0;
	}

	if (result.changed === 0 && result.skipped === 0) {
		process.stdout.write(`ship-ext: all links up to date (${result.noop})\n`);
	} else {
		process.stdout.write(
			`ship-ext: done (${result.changed} linked/refreshed, ${result.skipped} skipped, ${result.noop} already up to date)\n`,
		);
	}
	return 0;
}

export default {
	name: "link-ship-ext",
	describe: "Install or refresh ship omp extension symlinks in a secondmate home.",
	run,
};
