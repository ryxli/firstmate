// fm verb: backlog-handoff - mechanically move already-scoped backlog line
// items from the main firstmate backlog into a secondmate's own home backlog.
// Migrated verbatim (behavior-preserving) from the former sbin/fm backlog-handoff.
//
// Scope-matching is firstmate's JUDGMENT: the caller passes the task-id keys
// already judged in-scope for the secondmate. This verb performs only the
// mechanical move - it removes each matched line from data/backlog.md under
// the active firstmate home and appends it, under the same section heading,
// to the secondmate home's data/backlog.md (home resolved from
// data/secondmates.md). It never changes a line's text, never writes into a
// project (it refuses a home that is not a firstmate home), and is
// idempotent: a key already present in the secondmate backlog is reported
// and skipped, so re-running converges. If any key matches neither backlog,
// nothing is moved. See AGENTS.md section 6.
//
// Usage: fm backlog-handoff <secondmate-id> <item-key>...
// Env: FM_HOME, FM_ROOT_OVERRIDE, FM_DATA_OVERRIDE

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value !== "" ? value : undefined;
}

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT_DEFAULT = path.resolve(path.dirname(HERE), "../../../../");
const FM_ROOT = nonEmpty(process.env.FM_ROOT_OVERRIDE) ?? REPO_ROOT_DEFAULT;
const FM_HOME = nonEmpty(process.env.FM_HOME) ?? FM_ROOT;
const DATA = nonEmpty(process.env.FM_DATA_OVERRIDE) ?? path.join(FM_HOME, "data");
const REG = path.join(DATA, "secondmates.md");
const MAIN_BACKLOG = path.join(DATA, "backlog.md");

function err(message: string): void {
	process.stderr.write(`${message}\n`);
}

function pathIsAncestorOf(ancestor: string, candidate: string): boolean {
	if (!ancestor || !candidate) return false;
	if (ancestor === candidate) return false;
	return candidate.startsWith(`${ancestor}/`);
}

function resolvedExistingDir(target: string): string | null {
	if (!existsSync(target) || !statSync(target).isDirectory()) {
		err(`error: firstmate home does not exist or is not a directory: ${target}`);
		return null;
	}
	return realpathSync(target);
}

function secondmateHome(id: string): string | null {
	if (!existsSync(REG)) {
		err(`error: no secondmate registry at ${REG}`);
		return null;
	}
	const lines = readFileSync(REG, "utf8").split("\n");
	const pattern = new RegExp(`^- ${id}( |$)`);
	let matched: string | null = null;
	for (const line of lines) {
		if (pattern.test(line)) matched = line;
	}
	if (matched === null) {
		err(`error: secondmate ${id} is not registered in ${REG}`);
		return null;
	}
	const homeMatch = matched.match(/^[^(]*\(home: ([^;)]*);/);
	return homeMatch ? homeMatch[1] : "";
}

function validateOperationalDirs(absHome: string, absActiveHome: string, absRoot: string): boolean {
	for (const name of ["data", "state", "config", "projects"]) {
		const dir = path.join(absHome, name);
		const symlinked = isSymlink(dir);
		if (symlinked && !existsSync(dir)) {
			err(`error: secondmate ${name} directory must resolve inside the secondmate home: ${dir}`);
			return false;
		}
		let absDir: string;
		if (existsSync(dir) && statSync(dir).isDirectory()) {
			absDir = realpathSync(dir);
		} else if (existsSync(dir)) {
			err(`error: secondmate ${name} path is not a directory: ${dir}`);
			return false;
		} else {
			absDir = dir;
		}
		if (!pathIsAncestorOf(absHome, absDir)) {
			err(`error: secondmate ${name} directory must resolve inside the secondmate home: ${dir}`);
			return false;
		}
		if (absDir === absActiveHome || pathIsAncestorOf(absActiveHome, absDir)) {
			err(`error: secondmate ${name} directory cannot be inside the active firstmate home: ${dir}`);
			return false;
		}
		if (absDir === absRoot || pathIsAncestorOf(absRoot, absDir)) {
			err(`error: secondmate ${name} directory cannot be inside the firstmate repo: ${dir}`);
			return false;
		}
	}
	return true;
}

function isSymlink(target: string): boolean {
	try {
		return lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

function validateSecondmateHome(id: string, home: string): string | null {
	const absHome = resolvedExistingDir(home);
	if (absHome === null) return null;
	const absActiveHome = resolvedExistingDir(FM_HOME);
	if (absActiveHome === null) return null;
	const absRoot = resolvedExistingDir(FM_ROOT);
	if (absRoot === null) return null;

	if (absHome === "/") {
		err(`error: secondmate home cannot be the filesystem root: ${home}`);
		return null;
	}
	if (absHome === absActiveHome) {
		err(`error: secondmate home cannot be the active firstmate home: ${home}`);
		return null;
	}
	if (absHome === absRoot) {
		err(`error: secondmate home cannot be the firstmate repo: ${home}`);
		return null;
	}
	if (pathIsAncestorOf(absActiveHome, absHome)) {
		err(`error: secondmate home cannot be inside the active firstmate home: ${home}`);
		return null;
	}
	if (pathIsAncestorOf(absRoot, absHome)) {
		err(`error: secondmate home cannot be inside the firstmate repo: ${home}`);
		return null;
	}
	if (pathIsAncestorOf(absHome, absActiveHome)) {
		err(`error: secondmate home cannot be an ancestor of the active firstmate home: ${home}`);
		return null;
	}
	if (pathIsAncestorOf(absHome, absRoot)) {
		err(`error: secondmate home cannot be an ancestor of the firstmate repo: ${home}`);
		return null;
	}
	if (!validateOperationalDirs(absHome, absActiveHome, absRoot)) return null;

	const markerFile = path.join(absHome, ".fm-secondmate-home");
	if (!existsSync(markerFile)) {
		err(`error: firstmate home ${home} is not a seeded secondmate home`);
		return null;
	}
	let markerId = "";
	try {
		markerId = readFileSync(markerFile, "utf8").replace(/\n+$/, "");
	} catch {
		markerId = "";
	}
	if (markerId !== id) {
		err(`error: firstmate home ${home} is marked for secondmate ${markerId || "unknown"}, expected ${id}`);
		return null;
	}
	if (!existsSync(path.join(absHome, "AGENTS.md"))) {
		err(`error: ${home} is not a firstmate home (missing AGENTS.md)`);
		return null;
	}
	const sbinDir = path.join(absHome, "sbin");
	let sbinOk = false;
	try {
		const s = lstatSync(sbinDir);
		sbinOk = s.isDirectory() || s.isSymbolicLink();
	} catch {
		sbinOk = false;
	}
	if (!sbinOk) {
		err(`error: ${home} is not a firstmate home (missing sbin/)`);
		return null;
	}
	return absHome;
}

function validateBacklogFile(label: string, target: string): boolean {
	try {
		if (lstatSync(target).isSymbolicLink()) {
			err(`error: ${label} must not be a symlink: ${target}`);
			return false;
		}
	} catch {
		// does not exist at all: fine, handled below.
	}
	if (existsSync(target) && !statSync(target).isFile()) {
		err(`error: ${label} is not a regular file: ${target}`);
		return false;
	}
	return true;
}

function readLines(file: string): string[] {
	const content = readFileSync(file, "utf8");
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) lines.pop();
	return lines;
}

function linesToContent(lines: string[]): string {
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

const CHECKLIST_PREFIX = /^- \[[ x]\] +/;

function backlogKeySection(file: string, key: string): string | null {
	if (!existsSync(file)) return null;
	let section = "## Queued";
	for (const line of readLines(file)) {
		if (line.startsWith("## ")) {
			section = line;
			continue;
		}
		const m = line.match(CHECKLIST_PREFIX);
		if (m) {
			const rest = line.slice(m[0].length);
			const id = rest.split(/[ \t]/)[0];
			if (id === key) return section;
		}
	}
	return null;
}

interface MovedLine {
	section: string;
	line: string;
}

function dropMatched(mainLines: string[], want: Set<string>): { kept: string[]; moved: MovedLine[] } {
	const kept: string[] = [];
	const moved: MovedLine[] = [];
	let section = "## Queued";
	for (const line of mainLines) {
		if (line.startsWith("## ")) {
			section = line;
			kept.push(line);
			continue;
		}
		const m = line.match(CHECKLIST_PREFIX);
		if (m) {
			const rest = line.slice(m[0].length);
			const id = rest.split(/[ \t]/)[0];
			if (want.has(id)) {
				moved.push({ section, line });
				continue;
			}
		}
		kept.push(line);
	}
	return { kept, moved };
}

function insertMoved(subLines: string[], moved: MovedLine[]): string[] {
	const items = new Map<string, string[]>();
	const order: string[] = [];
	for (const { section, line } of moved) {
		if (!items.has(section)) {
			items.set(section, []);
			order.push(section);
		}
		items.get(section)!.push(line);
	}
	const flushed = new Set<string>();
	const out: string[] = [];
	const flush = (sec: string) => {
		if (sec !== "" && items.has(sec) && !flushed.has(sec)) {
			out.push(...items.get(sec)!);
			flushed.add(sec);
		}
	};
	let cur = "";
	for (const line of subLines) {
		if (line.startsWith("## ")) {
			flush(cur);
			cur = line;
			out.push(line);
			continue;
		}
		out.push(line);
	}
	flush(cur);
	for (const sec of order) {
		if (!flushed.has(sec)) {
			out.push("");
			out.push(sec);
			out.push(...items.get(sec)!);
			flushed.add(sec);
		}
	}
	return out;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length < 2) {
		err("usage: fm backlog-handoff <secondmate-id> <item-key>...");
		return 1;
	}
	const id = args[0];
	const itemKeys = args.slice(1);

	const rawHome = secondmateHome(id);
	if (rawHome === null) return 1;
	if (!rawHome) {
		err(`error: secondmate ${id} has no home in ${REG}`);
		return 1;
	}
	const subHome = validateSecondmateHome(id, rawHome);
	if (subHome === null) return 1;
	const subBacklog = path.join(subHome, "data", "backlog.md");
	if (!validateBacklogFile("main backlog", MAIN_BACKLOG)) return 1;
	if (!validateBacklogFile("secondmate backlog", subBacklog)) return 1;

	const toMove: string[] = [];
	const already: string[] = [];
	const missing: string[] = [];
	const inFlight: string[] = [];
	for (const key of itemKeys) {
		if (backlogKeySection(subBacklog, key) !== null) {
			already.push(key);
			continue;
		}
		const section = backlogKeySection(MAIN_BACKLOG, key);
		if (section !== null) {
			if (section === "## In flight") inFlight.push(key);
			else toMove.push(key);
		} else {
			missing.push(key);
		}
	}

	let failed = false;
	if (inFlight.length > 0) {
		err(`error: refusing to hand off in-flight backlog items: ${inFlight.join(" ")}`);
		failed = true;
	}
	if (missing.length > 0) {
		err(`error: no backlog item matched these keys in ${MAIN_BACKLOG}: ${missing.join(" ")}`);
		failed = true;
	}
	if (failed) {
		err("       nothing was moved.");
		return 1;
	}

	if (toMove.length === 0) {
		process.stdout.write(`nothing to move: ${already.length > 0 ? already.join(" ") : "no keys"} already present in ${subBacklog}\n`);
		return 0;
	}

	mkdirSync(path.join(subHome, "data"), { recursive: true });
	const subExisted = existsSync(subBacklog);
	const subOriginalLines = subExisted ? readLines(subBacklog) : ["## In flight", "", "## Queued", "", "## Done"];

	const mainLines = readLines(MAIN_BACKLOG);
	const want = new Set(toMove);
	const { kept, moved } = dropMatched(mainLines, want);
	const newSubLines = insertMoved(subOriginalLines, moved);

	const newMainContent = linesToContent(kept);
	const newSubContent = linesToContent(newSubLines);

	let subWritten = false;
	try {
		writeFileSync(subBacklog, newSubContent);
		subWritten = true;
		writeFileSync(MAIN_BACKLOG, newMainContent);
	} catch (error) {
		if (subWritten) {
			if (subExisted) {
				writeFileSync(subBacklog, linesToContent(subOriginalLines));
			} else {
				try {
					unlinkSync(subBacklog);
				} catch {
					// best effort
				}
			}
		}
		throw error;
	}

	process.stdout.write(`handed off ${toMove.length} item(s) to ${id}: ${toMove.join(" ")}\n`);
	process.stdout.write(`  into ${subBacklog}\n`);
	if (already.length > 0) {
		process.stdout.write(`  already present (skipped): ${already.join(" ")}\n`);
	}
	return 0;
}

export default {
	name: "backlog-handoff",
	describe: "Hand scoped backlog items off from the main backlog into a secondmate's own home backlog.",
	run,
};
