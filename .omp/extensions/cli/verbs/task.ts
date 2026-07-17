// fm verb: task - native backlog CRUD against the markdown backlog at
// <FM_HOME>/data/backlog.md. Replaces the never-installed external
// tasks-axi tool referenced by AGENTS.md section 10; this is the first
// (and so far only) implementation of that contract.
//
// Backlog format (see AGENTS.md section 10 and skill://firstmate-task-lifecycle):
//   ## In flight / ## Queued / ## Parked / ## Done
//   - [ ] <id> - <text>[ (kind: <k>, repo: <r>, since <date>)][ blocked-by: <id>[,<id>...]]
//   - [x] <id> - <text> - <proof> (<YYYY-MM-DD>)   (Done only)
//
// This tool owns that annotation grammar end to end: every field it writes
// (kind:, repo:, since, blocked-by:) it also reads back, so every
// subcommand round-trips through it losslessly. Any line this tool does not
// touch - free-form prose, other section headers, blank separators - is
// preserved byte for byte; every mutation is read -> transform in memory ->
// write to a fresh temp file -> atomic rename.
//
// Exit codes: 1 = usage error (bad/missing arguments, unknown flag); this
// never touches the file. 2 = unknown task id or a malformed backlog file
// (missing required section, duplicate/ambiguous id); the file is left
// untouched. 0 = success, including no-op idempotent re-runs of
// start/done/block/unblock.
//
// Usage:
//   fm task add <id> "<one line>" [--kind ship|scout] [--repo <name>] [--start] [--blocked-by <id>]... [--date <YYYY-MM-DD>]
//   fm task start <id> [--date <YYYY-MM-DD>]
//   fm task done <id> (--pr <url> | --report <path> | --note "<text>") [--date <YYYY-MM-DD>]
//   fm task update <id> [--append "<note>"] [--title "<text>"]
//   fm task block <id> --by <other-id>
//   fm task unblock <id> --by <other-id>
//   fm task ready
//   fm task show <id>
// Env: FM_HOME, FM_ROOT_OVERRIDE, FM_DATA_OVERRIDE

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

function resolveBacklogPath(): string {
	return join(resolveData(), "backlog.md");
}

function resolveArchivePath(): string {
	return join(resolveData(), "done-archive.md");
}

function stderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

function todayDate(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKLIST_PREFIX = /^- \[[ x]\] +/;
const REQUIRED_HEADERS = ["## In flight", "## Queued", "## Done"];

function needsValue(value: string | undefined): boolean {
	return value === undefined || value.length === 0 || value.startsWith("-");
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

function atomicWrite(file: string, content: string): void {
	const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}

function headerIndex(lines: string[], header: string): number {
	return lines.findIndex(l => l.trimEnd() === header);
}

function sectionName(header: string): string {
	return header.replace(/^##\s+/, "");
}

function checkStructure(lines: string[]): string | null {
	for (const header of REQUIRED_HEADERS) {
		if (headerIndex(lines, header) === -1) return header;
	}
	return null;
}

interface Location {
	section: string;
	index: number;
	id: string;
}

// Scans every line, tracking the most recent "## " header as the current
// section (defaulting to Queued before any header is seen, matching the
// convention already used by fm backlog-handoff), and records every
// checklist-item line's id and section.
function allChecklistLocations(lines: string[]): Location[] {
	let section = "## Queued";
	const out: Location[] = [];
	lines.forEach((line, index) => {
		if (line.startsWith("## ")) {
			section = line.trimEnd();
			return;
		}
		const m = line.match(CHECKLIST_PREFIX);
		if (!m) return;
		const rest = line.slice(m[0].length);
		const id = rest.split(/[ \t]/)[0];
		if (id) out.push({ section, index, id });
	});
	return out;
}

function locateId(lines: string[], id: string): Location[] {
	return allChecklistLocations(lines).filter(loc => loc.id === id);
}

function doneItemIndices(lines: string[]): number[] {
	const hIdx = headerIndex(lines, "## Done");
	if (hIdx === -1) return [];
	const out: number[] = [];
	for (let i = hIdx + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) break;
		if (CHECKLIST_PREFIX.test(lines[i])) out.push(i);
	}
	return out;
}

function insertAtSectionTop(lines: string[], header: string, itemLine: string): string[] {
	const idx = headerIndex(lines, header);
	if (idx === -1) throw new Error(`missing section: ${header}`);
	const out = lines.slice();
	out.splice(idx + 1, 0, itemLine);
	return out;
}

interface ItemBody {
	text: string;
	kind?: string;
	repo?: string;
	since?: string;
	blockedBy: string[];
}

// Inverse of buildItemLine: given a line already known to start with the
// checklist prefix and this id, recover the free-form text plus the
// kind/repo/since annotations and blocked-by list this tool wrote.
function parseBody(id: string, line: string): ItemBody {
	const prefixMatch = line.match(CHECKLIST_PREFIX);
	const prefixLen = prefixMatch ? prefixMatch[0].length : 0;
	let rest = line.slice(prefixLen + id.length);

	let blockedBy: string[] = [];
	const blockedMatch = rest.match(/^(.*?)\s+blocked-by:\s*(\S+)\s*$/);
	if (blockedMatch) {
		rest = blockedMatch[1];
		blockedBy = blockedMatch[2].split(",").map(s => s.trim()).filter(Boolean);
	}

	let kind: string | undefined;
	let repo: string | undefined;
	let since: string | undefined;
	const parenMatch = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
	if (parenMatch) {
		rest = parenMatch[1];
		for (const token of parenMatch[2].split(/,\s*/)) {
			const kindMatch = token.match(/^kind:\s*(.+)$/);
			const repoMatch = token.match(/^repo:\s*(.+)$/);
			const sinceMatch = token.match(/^since\s+(.+)$/);
			if (kindMatch) kind = kindMatch[1].trim();
			else if (repoMatch) repo = repoMatch[1].trim();
			else if (sinceMatch) since = sinceMatch[1].trim();
		}
	}

	const text = rest.replace(/^\s*-\s*/, "").trim();
	return { text, kind, repo, since, blockedBy };
}

function buildItemLine(id: string, text: string, opts: { kind?: string; repo?: string; since?: string; blockedBy?: string[] }): string {
	let line = `- [ ] ${id} - ${text}`;
	const parts: string[] = [];
	if (opts.kind) parts.push(`kind: ${opts.kind}`);
	if (opts.repo) parts.push(`repo: ${opts.repo}`);
	if (opts.since) parts.push(`since ${opts.since}`);
	if (parts.length > 0) line += ` (${parts.join(", ")})`;
	if (opts.blockedBy && opts.blockedBy.length > 0) line += ` blocked-by: ${opts.blockedBy.join(",")}`;
	return line;
}

function buildDoneLine(id: string, text: string, proof: string, date: string): string {
	return `- [x] ${id} - ${text} - ${proof} (${date})`;
}

function loadBacklog(): { path: string; lines: string[] } | null {
	const path = resolveBacklogPath();
	if (!existsSync(path)) {
		stderr(`error: no backlog file at ${path}`);
		return null;
	}
	return { path, lines: readLines(path) };
}

function requireStructure(path: string, lines: string[]): boolean {
	const missing = checkStructure(lines);
	if (missing) {
		stderr(`error: malformed backlog file: missing section "${missing}" in ${path}`);
		return false;
	}
	return true;
}

// Resolves a single unambiguous existing location for id, or prints the
// appropriate error and returns null: unknown id and multiple matches
// (a malformed file) both count as the id/file error class (exit 2).
function requireSingleLocation(lines: string[], id: string): Location | null {
	const matches = locateId(lines, id);
	if (matches.length === 0) {
		stderr(`error: unknown task id: ${id}`);
		return null;
	}
	if (matches.length > 1) {
		stderr(`error: malformed backlog file: multiple items match id "${id}"`);
		return null;
	}
	return matches[0];
}

function cmdAdd(rest: string[]): number {
	const USAGE = 'usage: fm task add <id> "<one line>" [--kind ship|scout] [--repo <name>] [--start] [--blocked-by <id>]... [--date <YYYY-MM-DD>]';
	const id = rest[0];
	const text = rest[1];
	if (!id || text === undefined) {
		stderr(USAGE);
		return 1;
	}
	if (!ID_RE.test(id)) {
		stderr(`error: invalid task id: ${id}`);
		return 1;
	}

	let kind: string | undefined;
	let repo: string | undefined;
	let start = false;
	let date: string | undefined;
	const blockedBy: string[] = [];

	let i = 2;
	while (i < rest.length) {
		const arg = rest[i];
		if (arg === "--kind") {
			const v = rest[i + 1];
			if (needsValue(v)) {
				stderr("error: --kind requires a value (ship|scout)");
				return 1;
			}
			if (v !== "ship" && v !== "scout") {
				stderr(`error: --kind must be ship or scout, got: ${v}`);
				return 1;
			}
			kind = v;
			i += 2;
		} else if (arg === "--repo") {
			const v = rest[i + 1];
			if (needsValue(v)) {
				stderr("error: --repo requires a value");
				return 1;
			}
			repo = v;
			i += 2;
		} else if (arg === "--start") {
			start = true;
			i += 1;
		} else if (arg === "--blocked-by") {
			const v = rest[i + 1];
			if (needsValue(v)) {
				stderr("error: --blocked-by requires a value");
				return 1;
			}
			blockedBy.push(v);
			i += 2;
		} else if (arg === "--date") {
			const v = rest[i + 1];
			if (needsValue(v) || !DATE_RE.test(v)) {
				stderr("error: --date requires a value in YYYY-MM-DD form");
				return 1;
			}
			date = v;
			i += 2;
		} else {
			stderr(`error: unknown argument: ${arg}`);
			stderr(USAGE);
			return 1;
		}
	}

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { path, lines } = backlog;
	if (!requireStructure(path, lines)) return 2;

	const existing = locateId(lines, id);
	if (existing.length > 1) {
		stderr(`error: malformed backlog file: multiple items already match id "${id}"`);
		return 2;
	}
	if (existing.length === 1) {
		stderr(`error: task id already exists: ${id} (in ${sectionName(existing[0].section)})`);
		return 2;
	}

	const targetHeader = start ? "## In flight" : "## Queued";
	const since = start ? date || todayDate() : undefined;
	const itemLine = buildItemLine(id, text, { kind, repo, since, blockedBy });
	const newLines = insertAtSectionTop(lines, targetHeader, itemLine);
	atomicWrite(path, linesToContent(newLines));
	process.stdout.write(`added ${id} to ${sectionName(targetHeader)}\n`);
	return 0;
}

function cmdStart(rest: string[]): number {
	const USAGE = "usage: fm task start <id> [--date <YYYY-MM-DD>]";
	const id = rest[0];
	if (!id) {
		stderr(USAGE);
		return 1;
	}
	let date: string | undefined;
	let i = 1;
	while (i < rest.length) {
		const arg = rest[i];
		if (arg === "--date") {
			const v = rest[i + 1];
			if (needsValue(v) || !DATE_RE.test(v)) {
				stderr("error: --date requires a value in YYYY-MM-DD form");
				return 1;
			}
			date = v;
			i += 2;
		} else {
			stderr(`error: unknown argument: ${arg}`);
			stderr(USAGE);
			return 1;
		}
	}

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { path, lines } = backlog;
	if (!requireStructure(path, lines)) return 2;

	const loc = requireSingleLocation(lines, id);
	if (!loc) return 2;

	if (loc.section === "## In flight") {
		process.stdout.write(`already in flight: ${id}\n`);
		return 0;
	}
	if (loc.section !== "## Queued") {
		stderr(`error: task ${id} is not in Queued (found in ${sectionName(loc.section)})`);
		return 2;
	}

	const body = parseBody(id, lines[loc.index]);
	const since = date || todayDate();
	const newLine = buildItemLine(id, body.text, { kind: body.kind, repo: body.repo, since, blockedBy: body.blockedBy });

	const withoutOld = lines.slice();
	withoutOld.splice(loc.index, 1);
	const newLines = insertAtSectionTop(withoutOld, "## In flight", newLine);
	atomicWrite(path, linesToContent(newLines));
	process.stdout.write(`started ${id}\n`);
	return 0;
}

function cmdDone(rest: string[]): number {
	const USAGE = 'usage: fm task done <id> (--pr <url> | --report <path> | --note "<text>") [--date <YYYY-MM-DD>]';
	const id = rest[0];
	if (!id) {
		stderr(USAGE);
		return 1;
	}
	let pr: string | undefined;
	let report: string | undefined;
	let note: string | undefined;
	let date: string | undefined;

	let i = 1;
	while (i < rest.length) {
		const arg = rest[i];
		if (arg === "--pr" || arg === "--report" || arg === "--note" || arg === "--date") {
			const v = rest[i + 1];
			if (needsValue(v)) {
				stderr(`error: ${arg} requires a value`);
				return 1;
			}
			if (arg === "--pr") pr = v;
			else if (arg === "--report") report = v;
			else if (arg === "--note") note = v;
			else {
				if (!DATE_RE.test(v)) {
					stderr("error: --date requires a value in YYYY-MM-DD form");
					return 1;
				}
				date = v;
			}
			i += 2;
		} else {
			stderr(`error: unknown argument: ${arg}`);
			stderr(USAGE);
			return 1;
		}
	}

	const provided = [pr, report, note].filter(v => v !== undefined);
	if (provided.length !== 1) {
		stderr("error: exactly one of --pr, --report, or --note is required");
		return 1;
	}
	const proof = (pr ?? report ?? note) as string;

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { path, lines } = backlog;
	if (!requireStructure(path, lines)) return 2;

	const loc = requireSingleLocation(lines, id);
	if (!loc) return 2;

	if (loc.section === "## Done") {
		process.stdout.write(`already done: ${id}\n`);
		return 0;
	}

	const body = parseBody(id, lines[loc.index]);
	const doneDate = date || todayDate();
	const doneLine = buildDoneLine(id, body.text, proof, doneDate);

	const withoutOld = lines.slice();
	withoutOld.splice(loc.index, 1);
	let newLines = insertAtSectionTop(withoutOld, "## Done", doneLine);

	const doneIdx = doneItemIndices(newLines);
	let archived: string[] = [];
	if (doneIdx.length > 10) {
		const excess = doneIdx.slice(10);
		archived = excess.map(k => newLines[k]);
		for (let k = excess.length - 1; k >= 0; k--) newLines.splice(excess[k], 1);
	}

	atomicWrite(path, linesToContent(newLines));

	if (archived.length > 0) {
		const archivePath = resolveArchivePath();
		const archiveLines = existsSync(archivePath) ? readLines(archivePath) : [];
		atomicWrite(archivePath, linesToContent(archiveLines.concat(archived)));
	}

	process.stdout.write(`completed ${id}\n`);
	if (archived.length > 0) {
		process.stdout.write(`pruned ${archived.length} entr${archived.length === 1 ? "y" : "ies"} to ${resolveArchivePath()}\n`);
	}
	return 0;
}

function cmdUpdate(rest: string[]): number {
	const USAGE = 'usage: fm task update <id> [--append "<note>"] [--title "<text>"]';
	const id = rest[0];
	if (!id) {
		stderr(USAGE);
		return 1;
	}
	let append: string | undefined;
	let title: string | undefined;
	let i = 1;
	while (i < rest.length) {
		const arg = rest[i];
		if (arg === "--append" || arg === "--title") {
			const v = rest[i + 1];
			if (needsValue(v)) {
				stderr(`error: ${arg} requires a value`);
				return 1;
			}
			if (arg === "--append") append = v;
			else title = v;
			i += 2;
		} else {
			stderr(`error: unknown argument: ${arg}`);
			stderr(USAGE);
			return 1;
		}
	}
	if (append === undefined && title === undefined) {
		stderr("error: --append or --title is required");
		return 1;
	}

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { path, lines } = backlog;

	const loc = requireSingleLocation(lines, id);
	if (!loc) return 2;
	if (loc.section === "## Done") {
		stderr(`error: cannot update a completed task: ${id}`);
		return 2;
	}

	const body = parseBody(id, lines[loc.index]);
	let text = body.text;
	if (title !== undefined) text = title;
	if (append !== undefined) text = text ? `${text}; ${append}` : append;

	const newLine = buildItemLine(id, text, { kind: body.kind, repo: body.repo, since: body.since, blockedBy: body.blockedBy });
	const newLines = lines.slice();
	newLines[loc.index] = newLine;
	atomicWrite(path, linesToContent(newLines));
	process.stdout.write(`updated ${id}\n`);
	return 0;
}

function cmdBlockOrUnblock(rest: string[], mode: "block" | "unblock"): number {
	const USAGE = `usage: fm task ${mode} <id> --by <other-id>`;
	const id = rest[0];
	if (!id) {
		stderr(USAGE);
		return 1;
	}
	let by: string | undefined;
	let i = 1;
	while (i < rest.length) {
		const arg = rest[i];
		if (arg === "--by") {
			const v = rest[i + 1];
			if (needsValue(v)) {
				stderr("error: --by requires a value");
				return 1;
			}
			by = v;
			i += 2;
		} else {
			stderr(`error: unknown argument: ${arg}`);
			stderr(USAGE);
			return 1;
		}
	}
	if (!by) {
		stderr(USAGE);
		return 1;
	}

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { path, lines } = backlog;

	const loc = requireSingleLocation(lines, id);
	if (!loc) return 2;
	if (loc.section === "## Done") {
		stderr(`error: cannot ${mode} a completed task: ${id}`);
		return 2;
	}

	const body = parseBody(id, lines[loc.index]);
	const has = body.blockedBy.includes(by);
	if (mode === "block") {
		if (has) {
			process.stdout.write(`already blocked: ${id} by ${by}\n`);
			return 0;
		}
		body.blockedBy.push(by);
	} else {
		if (!has) {
			process.stdout.write(`not blocked: ${id} by ${by}\n`);
			return 0;
		}
		body.blockedBy = body.blockedBy.filter(x => x !== by);
	}

	const newLine = buildItemLine(id, body.text, { kind: body.kind, repo: body.repo, since: body.since, blockedBy: body.blockedBy });
	const newLines = lines.slice();
	newLines[loc.index] = newLine;
	atomicWrite(path, linesToContent(newLines));
	process.stdout.write(`${mode === "block" ? "blocked" : "unblocked"} ${id} by ${by}\n`);
	return 0;
}

function cmdReady(rest: string[]): number {
	if (rest.length > 0) {
		stderr("usage: fm task ready");
		return 1;
	}

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { path, lines } = backlog;
	const qIdx = headerIndex(lines, "## Queued");
	if (qIdx === -1) {
		stderr(`error: malformed backlog file: missing section "## Queued" in ${path}`);
		return 2;
	}

	const doneIds = new Set<string>();
	for (const loc of allChecklistLocations(lines)) {
		if (loc.section === "## Done") doneIds.add(loc.id);
	}

	for (let i = qIdx + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) break;
		const m = lines[i].match(CHECKLIST_PREFIX);
		if (!m) continue;
		const idOf = lines[i].slice(m[0].length).split(/[ \t]/)[0];
		if (!idOf) continue;
		const body = parseBody(idOf, lines[i]);
		const unresolved = body.blockedBy.filter(b => !doneIds.has(b));
		if (unresolved.length === 0) process.stdout.write(`${lines[i]}\n`);
	}
	return 0;
}

function cmdShow(rest: string[]): number {
	const id = rest[0];
	if (!id) {
		stderr("usage: fm task show <id>");
		return 1;
	}

	const backlog = loadBacklog();
	if (!backlog) return 2;
	const { lines } = backlog;

	const loc = requireSingleLocation(lines, id);
	if (!loc) return 2;
	process.stdout.write(`${lines[loc.index]}\n`);
	return 0;
}

const USAGE_TOP = [
	"usage: fm task <subcommand> ...",
	'  add <id> "<one line>" [--kind ship|scout] [--repo <name>] [--start] [--blocked-by <id>]... [--date <YYYY-MM-DD>]',
	"  start <id> [--date <YYYY-MM-DD>]",
	'  done <id> (--pr <url> | --report <path> | --note "<text>") [--date <YYYY-MM-DD>]',
	'  update <id> [--append "<note>"] [--title "<text>"]',
	"  block <id> --by <other-id>",
	"  unblock <id> --by <other-id>",
	"  ready",
	"  show <id>",
].join("\n");

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const sub = args[0];
	if (!sub) {
		stderr(USAGE_TOP);
		return 1;
	}
	const rest = args.slice(1);

	switch (sub) {
		case "add":
			return cmdAdd(rest);
		case "start":
			return cmdStart(rest);
		case "done":
			return cmdDone(rest);
		case "update":
			return cmdUpdate(rest);
		case "block":
			return cmdBlockOrUnblock(rest, "block");
		case "unblock":
			return cmdBlockOrUnblock(rest, "unblock");
		case "ready":
			return cmdReady(rest);
		case "show":
			return cmdShow(rest);
		default:
			stderr(`error: unknown subcommand: ${sub}`);
			stderr(USAGE_TOP);
			return 1;
	}
}

export default {
	name: "task",
	describe: "Native backlog CRUD (add/start/done/update/block/unblock/ready/show) against data/backlog.md.",
	run,
};
