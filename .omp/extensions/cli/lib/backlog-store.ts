// Native markdown backlog engine shared by the `tasks`/`task` verb.
//
// Grammar (see AGENTS.md section 5 and skill://fm-manage-project-work):
//   ## In flight / ## Queued / ## Done   (any other header is passthrough/raw)
//   - [ ] <id> - <title>[ blocked-by: <id>[ - <reason>]]* [ (repo: <r>)] [ (kind: <k>)]
//         [ (priority: <0-4>)] [ (since <date>)] [ (hold: <reason>)] [ (hold-kind: <k>)]
//         [ (hold-until: <date>)] [ blocked-by: <id> - <reason>]*
//   - [x] <id> - <title> - <proof> (<merged|reported|done> <date>)
//   followed by zero or more 2-space-indented or blank body-continuation lines.
//
// Byte-exact round trip: every entry keeps its exact original source lines. An entry is
// re-rendered from structured fields ONLY when a mutation marks it dirty;
// every other entry and every free-form (no-id) line is emitted verbatim, so
// `render(parse(src))` equals `src` byte-for-byte on a file nobody mutated.
//
// Dependency truth for `ready`/`blocked` is the backlog's `## Done` section
// OR a terminal ArtifactRecord (landed/abandoned/superseded). Done remains a
// read-only compatibility projection during cutover; Artifact is canonical
// for new terminals. Never use a live status signal as dependency truth.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dependencySatisfied } from "./artifact";

export type TaskState = "inflight" | "queued" | "done";
export const HOLD_KINDS = ["captain", "external", "load", "parked", "future"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export interface Dep {
	id: string;
	reason?: string;
}

export interface Hold {
	reason: string;
	kind?: HoldKind;
	until?: string;
}

export interface Task {
	id: string;
	title: string;
	state: TaskState;
	kind?: string;
	repo?: string;
	body?: string;
	/** Done-only: the recorded delivery evidence (PR url, report path, or note). */
	proof?: string;
	deps: Dep[];
	hold?: Hold;
	priority?: number;
	/** Maps to `(since <date>)`. */
	created?: string;
	/** Maps to `(<verb> <date>)` on a Done item. */
	closed?: string;
}

export interface TaskEntry {
	kind: "task";
	task: Task;
	raw: string[];
	dirty: boolean;
}
interface RawEntry {
	kind: "raw";
	lines: string[];
}
type Entry = TaskEntry | RawEntry;

interface Section {
	headerLine: string;
	state?: TaskState;
	entries: Entry[];
}

interface BacklogDoc {
	finalNewline: boolean;
	preamble: string[];
	sections: Section[];
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HEADERS: Record<TaskState, string> = { inflight: "## In flight", queued: "## Queued", done: "## Done" };
export const REQUIRED_HEADERS = [HEADERS.inflight, HEADERS.queued, HEADERS.done];

function headerState(headerLine: string): TaskState | undefined {
	const text = headerLine.trim().replace(/^#{1,6}\s+/, "").toLowerCase();
	if (text === "in flight") return "inflight";
	if (text === "queued") return "queued";
	if (text === "done") return "done";
	return undefined;
}

// ---------------------------------------------------------------------------
// Trailing tag-region grammar: each pattern strips ONE tag off the END of the
// remaining text; the caller loops until no pattern matches, so tags may
// appear in any order and still parse (matches the proven upstream design).
// ---------------------------------------------------------------------------

const TAIL_DEP = /\s*blocked-by:\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+-\s+((?:(?!\s+blocked-by:\s).)+?))?\s*$/;
const TAIL_REPO = /\s*\(repo:\s*([^()]+)\)\s*$/;
const TAIL_KIND = /\s*\(kind:\s*([^()]+)\)\s*$/;
const TAIL_PRIORITY = /\s*\(priority:\s*([0-4])\)\s*$/;
const TAIL_SINCE = /\s*\(since\s+(\d{4}-\d{2}-\d{2})\)\s*$/;
const TAIL_HOLD_UNTIL = /\s*\(hold-until:\s*(\d{4}-\d{2}-\d{2})\)\s*$/;
const TAIL_HOLD_KIND = new RegExp(`\\s*\\(hold-kind:\\s*(${HOLD_KINDS.join("|")})\\)\\s*$`);
const TAIL_HOLD = /\s*\(hold:\s*([^()]+)\)\s*$/;
const TAIL_CLOSED = /\s*\((merged|reported|done)\s+(\d{4}-\d{2}-\d{2})\)\s*$/;

interface ExtractedTags {
	title: string;
	deps: Dep[];
	repo?: string;
	kind?: string;
	priority?: number;
	created?: string;
	hold?: Hold;
}

/** Strip every recognized trailing tag off a Queued/In-flight bullet's rest. */
function extractTags(rest: string): ExtractedTags {
	const deps: Dep[] = [];
	let repo: string | undefined;
	let kind: string | undefined;
	let priority: number | undefined;
	let created: string | undefined;
	let holdReason: string | undefined;
	let holdKind: HoldKind | undefined;
	let holdUntil: string | undefined;

	let title = rest;
	let stripped = true;
	while (stripped) {
		stripped = false;
		let m = title.match(TAIL_DEP);
		if (m) {
			const dep: Dep = { id: m[1] };
			if (m[2] !== undefined) dep.reason = m[2].trim();
			deps.unshift(dep);
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_REPO);
		if (m) {
			repo ??= m[1].trim();
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_KIND);
		if (m) {
			kind ??= m[1].trim();
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_PRIORITY);
		if (m) {
			priority ??= Number(m[1]);
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_SINCE);
		if (m) {
			created ??= m[1];
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_HOLD_UNTIL);
		if (m) {
			holdUntil ??= m[1];
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_HOLD_KIND);
		if (m) {
			holdKind ??= m[1] as HoldKind;
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
		m = title.match(TAIL_HOLD);
		if (m) {
			holdReason ??= m[1].trim();
			title = title.slice(0, m.index);
			stripped = true;
			continue;
		}
	}

	const hold = holdReason !== undefined ? { reason: holdReason, ...(holdKind ? { kind: holdKind } : {}), ...(holdUntil ? { until: holdUntil } : {}) } : undefined;
	return { title: title.trim(), deps, repo, kind, priority, created, hold };
}

/** Build a Queued/In-flight bullet's canonical prose (title + tags). */
function buildProse(task: Task): string {
	const parts: string[] = [task.title];
	for (const dep of task.deps) if (!dep.reason) parts.push(`blocked-by: ${dep.id}`);
	if (task.repo) parts.push(`(repo: ${task.repo})`);
	if (task.kind) parts.push(`(kind: ${task.kind})`);
	if (task.priority !== undefined) parts.push(`(priority: ${task.priority})`);
	if (task.created) parts.push(`(since ${task.created})`);
	if (task.hold) {
		parts.push(`(hold: ${task.hold.reason})`);
		if (task.hold.kind) parts.push(`(hold-kind: ${task.hold.kind})`);
		if (task.hold.until) parts.push(`(hold-until: ${task.hold.until})`);
	}
	for (const dep of task.deps) if (dep.reason) parts.push(`blocked-by: ${dep.id} - ${dep.reason}`);
	return parts.join(" ");
}

/** The `merged`/`reported`/`done` closure verb inferred from the proof text. */
function closureVerb(proof: string): string {
	if (/^https?:\/\/\S+\/pull\/\d+$/.test(proof)) return "merged";
	if (/report\.md$/.test(proof)) return "reported";
	return "done";
}

/** Render one task entry to its canonical source lines (bullet + body). */
function renderTaskLines(task: Task): string[] {
	const prose = task.state === "done" ? `${task.title} - ${task.proof ?? ""} (${closureVerb(task.proof ?? "")} ${task.closed ?? ""})` : buildProse(task);
	const bulletPrefix = task.state === "done" ? `- [x] ${task.id} - ` : `- [ ] ${task.id} - `;
	const lines = [bulletPrefix + prose];
	if (task.body) {
		for (const bodyLine of task.body.split("\n")) lines.push(bodyLine === "" ? "" : `  ${bodyLine}`);
	}
	return lines;
}

const QUEUED_RE = new RegExp(`^- \\[ \\] (${ID_RE.source.slice(1, -1)}) - (.*)$`);
const DONE_RE = new RegExp(`^- \\[x\\] (${ID_RE.source.slice(1, -1)}) - (.*)$`);
// Non-greedy title, then ` - <proof> (<verb> <date>)`; proof is whatever remains
// once the trailing closure tag is stripped, split at the LAST ` - ` so a title
// containing a hyphenated clause does not swallow the proof segment.
function parseDoneRest(id: string, rest: string): Task {
	let closed: string | undefined;
	let body = rest;
	const closedMatch = body.match(TAIL_CLOSED);
	if (closedMatch) {
		closed = closedMatch[2];
		body = body.slice(0, closedMatch.index);
	}
	const sep = body.lastIndexOf(" - ");
	const title = sep >= 0 ? body.slice(0, sep) : body;
	const proof = sep >= 0 ? body.slice(sep + 3) : "";
	const task: Task = { id, title: title.trim(), state: "done", deps: [] };
	if (proof) task.proof = proof.trim();
	if (closed) task.closed = closed;
	return task;
}

function buildTask(id: string, rest: string, state: TaskState): Task {
	if (state === "done") return parseDoneRest(id, rest);
	const tags = extractTags(rest);
	const task: Task = { id, title: tags.title, state, deps: tags.deps };
	if (tags.repo) task.repo = tags.repo;
	if (tags.kind) task.kind = tags.kind;
	if (tags.priority !== undefined) task.priority = tags.priority;
	if (tags.created) task.created = tags.created;
	if (tags.hold) task.hold = tags.hold;
	return task;
}

function matchBullet(line: string, state: TaskState): { id: string; rest: string } | null {
	const m = line.match(state === "done" ? DONE_RE : QUEUED_RE);
	return m ? { id: m[1], rest: m[2] } : null;
}

/** Drop trailing blank continuation lines (they stay with `raw` for byte-exact emit). */
function structuredBody(bodyLines: string[]): string | undefined {
	let end = bodyLines.length;
	while (end > 0 && bodyLines[end - 1] === "") end--;
	return end === 0 ? undefined : bodyLines.slice(0, end).join("\n");
}

function parseEntries(lines: string[], state: TaskState | undefined): Entry[] {
	const entries: Entry[] = [];
	let rawRun: string[] = [];
	const flushRaw = () => {
		if (rawRun.length > 0) {
			entries.push({ kind: "raw", lines: rawRun });
			rawRun = [];
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const bullet = state ? matchBullet(line, state) : null;
		if (bullet && state) {
			flushRaw();
			const raw = [line];
			const bodyLines: string[] = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1];
				if (next.trim().length === 0) {
					i++;
					raw.push(lines[i]);
					bodyLines.push("");
					continue;
				}
				if (next.startsWith("  ")) {
					i++;
					raw.push(lines[i]);
					bodyLines.push(next.slice(2));
					continue;
				}
				break;
			}
			const task = buildTask(bullet.id, bullet.rest, state);
			const body = structuredBody(bodyLines);
			if (body !== undefined) task.body = body;
			entries.push({ kind: "task", task, raw, dirty: false });
			continue;
		}
		rawRun.push(line);
	}
	flushRaw();
	return entries;
}

function readLinesRaw(text: string): { lines: string[]; finalNewline: boolean } {
	if (text === "") return { lines: [], finalNewline: false };
	const finalNewline = text.endsWith("\n");
	const body = finalNewline ? text.slice(0, -1) : text;
	return { lines: body.split("\n"), finalNewline };
}

function parseBacklogDoc(text: string): BacklogDoc {
	const { lines, finalNewline } = readLinesRaw(text);
	const preamble: string[] = [];
	const sections: Section[] = [];
	let current: Section | null = null;
	let buffer: string[] = [];
	const closeSection = () => {
		if (current) {
			current.entries = parseEntries(buffer, current.state);
			sections.push(current);
		}
		buffer = [];
	};
	for (const line of lines) {
		if (/^##\s+/.test(line)) {
			closeSection();
			current = { headerLine: line, state: headerState(line), entries: [] };
			continue;
		}
		if (current) buffer.push(line);
		else preamble.push(line);
	}
	closeSection();
	return { finalNewline, preamble, sections };
}

function renderEntry(entry: Entry): string[] {
	return entry.kind === "raw" ? entry.lines : entry.dirty ? renderTaskLines(entry.task) : entry.raw;
}

function renderBacklogDoc(doc: BacklogDoc): string {
	const lines: string[] = [...doc.preamble];
	for (const section of doc.sections) {
		lines.push(section.headerLine);
		for (const entry of section.entries) lines.push(...renderEntry(entry));
	}
	if (lines.length === 0) return "";
	return `${lines.join("\n")}${doc.finalNewline ? "\n" : ""}`;
}

function missingHeader(doc: BacklogDoc): string | null {
	for (const header of REQUIRED_HEADERS) {
		if (!doc.sections.some(s => s.headerLine.trim() === header)) return header;
	}
	return null;
}

function atomicWrite(path: string, content: string): void {
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export class StoreError extends Error {
	code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "MALFORMED";
	help: string[];
	constructor(message: string, code: StoreError["code"], help: string[] = []) {
		super(message);
		this.code = code;
		this.help = help;
	}
}

export function todayLocal(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface FoundTask {
	task: Task;
	sectionIndex: number;
	entryIndex: number;
}

/**
 * One open backlog file: parsed once, mutated in memory, and persisted with
 * `save()`. Every subcommand loads a fresh Store (no cross-invocation cache),
 * satisfying "every pass recomputes registered durable state".
 */
export class BacklogStore {
	readonly path: string;
	private doc: BacklogDoc;
	private existed: boolean;

	private constructor(path: string, doc: BacklogDoc, existed: boolean) {
		this.path = path;
		this.doc = doc;
		this.existed = existed;
	}

	/**
	 * Load a backlog file. `lenient` (used only by `mv`'s destination side)
	 * appends any missing required section headers instead of refusing, so a
	 * secondmate backlog that never needed a `## Done` section yet still
	 * accepts a moved Done item - matching the retired backlog-handoff verb.
	 */
	static load(path: string, opts: { lenient?: boolean } = {}): BacklogStore {
		const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		if (text === undefined) throw new StoreError(`no backlog file at ${path}`, "MALFORMED", ["Run `fm tasks add <id> \"<title>\"` after creating the backlog scaffold."]);
		const doc = parseBacklogDoc(text);
		if (opts.lenient) {
			for (const header of REQUIRED_HEADERS) {
				if (!doc.sections.some(s => s.headerLine.trim() === header)) doc.sections.push({ headerLine: header, state: headerState(header), entries: [] });
			}
		} else {
			const missing = missingHeader(doc);
			if (missing) throw new StoreError(`malformed backlog file: missing section "${missing}" in ${path}`, "MALFORMED");
		}
		return new BacklogStore(path, doc, true);
	}

	save(): void {
		atomicWrite(this.path, renderBacklogDoc(this.doc));
	}

	private sectionFor(state: TaskState): Section {
		const section = this.doc.sections.find(s => s.state === state);
		if (!section) throw new StoreError(`malformed backlog file: missing section "${HEADERS[state]}" in ${this.path}`, "MALFORMED");
		return section;
	}

	/** Every task across every recognized section, in file order. */
	list(): Task[] {
		const out: Task[] = [];
		for (const section of this.doc.sections) {
			for (const entry of section.entries) if (entry.kind === "task") out.push(entry.task);
		}
		return out;
	}

	/** Find a task by id, or every match when the file is malformed (duplicate ids). */
	findAll(id: string): FoundTask[] {
		const out: FoundTask[] = [];
		this.doc.sections.forEach((section, sectionIndex) => {
			section.entries.forEach((entry, entryIndex) => {
				if (entry.kind === "task" && entry.task.id === id) out.push({ task: entry.task, sectionIndex, entryIndex });
			});
		});
		return out;
	}

	get(id: string): Task | undefined {
		const matches = this.findAll(id);
		if (matches.length > 1) throw new StoreError(`malformed backlog file: multiple items match id "${id}"`, "MALFORMED");
		return matches[0]?.task;
	}

	private requireUnique(id: string): FoundTask {
		const matches = this.findAll(id);
		if (matches.length === 0) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
		if (matches.length > 1) throw new StoreError(`malformed backlog file: multiple items match id "${id}"`, "MALFORMED");
		return matches[0];
	}

	private removeEntryFull(found: FoundTask): TaskEntry {
		const section = this.doc.sections[found.sectionIndex];
		const [entry] = section.entries.splice(found.entryIndex, 1);
		return entry as TaskEntry;
	}

	private removeEntry(found: FoundTask): Task {
		return this.removeEntryFull(found).task;
	}

	private insertAtTop(state: TaskState, task: Task): void {
		this.sectionFor(state).entries.unshift({ kind: "task", task, raw: [], dirty: true });
	}

	private insertEntryAtTop(entry: TaskEntry): void {
		this.sectionFor(entry.task.state).entries.unshift(entry);
	}

	create(input: Omit<Task, "deps"> & { deps?: Dep[] }): Task {
		if (this.findAll(input.id).length > 0) throw new StoreError(`task id already exists: ${input.id}`, "CONFLICT");
		const task: Task = { ...input, deps: input.deps ?? [] };
		this.insertAtTop(task.state, task);
		return task;
	}

	/** Move a task to a new state, stamping `created`/`closed` as appropriate. */
	transition(id: string, to: TaskState, opts: { proof?: string; date?: string } = {}): { task: Task; already: boolean } {
		const found = this.requireUnique(id);
		if (found.task.state === to) return { task: found.task, already: true };
		const task = this.removeEntry(found);
		task.state = to;
		if (to === "inflight") task.created = opts.date ?? todayLocal();
		if (to === "done") {
			task.proof = opts.proof;
			task.closed = opts.date ?? todayLocal();
		}
		if (to === "queued") {
			task.proof = undefined;
			task.closed = undefined;
		}
		this.insertAtTop(to, task);
		return { task, already: false };
	}

	update(id: string, patch: { title?: string; body?: string; archiveBody?: boolean; repo?: string; kind?: string; priority?: number; hold?: Hold | null }): { task: Task; changed: string[]; archivedBody?: string } {
		const found = this.requireUnique(id);
		const task = found.task;
		const changed: string[] = [];
		let archivedBody: string | undefined;
		if (patch.title !== undefined && patch.title !== task.title) {
			task.title = patch.title;
			changed.push("title");
		}
		if (patch.body !== undefined && patch.body !== (task.body ?? "")) {
			if (patch.archiveBody && task.body) archivedBody = task.body;
			task.body = patch.body;
			changed.push("body");
		}
		if (patch.repo !== undefined && patch.repo !== task.repo) {
			task.repo = patch.repo;
			changed.push("repo");
		}
		if (patch.kind !== undefined && patch.kind !== task.kind) {
			task.kind = patch.kind;
			changed.push("kind");
		}
		if (patch.priority !== undefined && patch.priority !== task.priority) {
			task.priority = patch.priority;
			changed.push("priority");
		}
		if (patch.hold !== undefined) {
			const next = patch.hold === null ? undefined : patch.hold;
			const same = task.hold?.reason === next?.reason && task.hold?.kind === next?.kind && task.hold?.until === next?.until;
			if (!same) {
				task.hold = next;
				changed.push("hold");
			}
		}
		if (changed.length > 0) this.markDirty(found);
		return { task, changed, ...(archivedBody !== undefined ? { archivedBody } : {}) };
	}

	private markDirty(found: FoundTask): void {
		const entry = this.doc.sections[found.sectionIndex].entries[found.entryIndex] as TaskEntry;
		entry.dirty = true;
	}

	addDep(id: string, blockerId: string): boolean {
		const found = this.requireUnique(id);
		if (found.task.deps.some(d => d.id === blockerId)) return false;
		found.task.deps.push({ id: blockerId });
		this.markDirty(found);
		return true;
	}

	removeDep(id: string, blockerId: string): boolean {
		const found = this.requireUnique(id);
		const before = found.task.deps.length;
		found.task.deps = found.task.deps.filter(d => d.id !== blockerId);
		if (found.task.deps.length === before) return false;
		this.markDirty(found);
		return true;
	}

	/** Trim a section to the `keep` most recent entries, returning the overflow (oldest first). */
	prune(state: TaskState, keep: number): Task[] {
		const section = this.sectionFor(state);
		const taskEntryIdx = section.entries.map((e, i) => (e.kind === "task" ? i : -1)).filter(i => i >= 0);
		if (taskEntryIdx.length <= keep) return [];
		const overflowIdx = taskEntryIdx.slice(keep);
		const overflow: Task[] = [];
		for (let i = overflowIdx.length - 1; i >= 0; i--) {
			const [entry] = section.entries.splice(overflowIdx[i], 1);
			overflow.unshift((entry as TaskEntry).task);
		}
		return overflow;
	}

	/** Mark every recognized task dirty so `save()` normalizes the whole file. */
	renderAll(): number {
		let count = 0;
		for (const section of this.doc.sections) {
			for (const entry of section.entries) {
				if (entry.kind === "task") {
					entry.dirty = true;
					count++;
				}
			}
		}
		return count;
	}

	/**
	 * Remove a task from this store without inserting it elsewhere, preserving
	 * its exact original source lines (mv/move-out). A relocation is not a
	 * content rewrite: the moved entry keeps its original tag order, spacing,
	 * and closure verb byte-exact, matching the retired backlog-handoff verb's
	 * preservation contract.
	 */
	extractEntry(id: string): TaskEntry {
		const found = this.requireUnique(id);
		return this.removeEntryFull(found);
	}

	/** Insert an already-extracted entry verbatim (mv/move-in), at the top of its section. */
	insertEntry(entry: TaskEntry): void {
		if (this.findAll(entry.task.id).length > 0) throw new StoreError(`task id already exists in destination: ${entry.task.id}`, "CONFLICT");
		this.insertEntryAtTop(entry);
	}
}

// ---------------------------------------------------------------------------
// Derived projections shared by `ready`/`list`/`show` (report §8 style:
// blocked/ready/held are computed here, not stored).
// ---------------------------------------------------------------------------

function isResolvedDep(id: string, doneIds: Set<string>): boolean {
	return doneIds.has(id) || dependencySatisfied(id);
}

/** Ids blocked by an unresolved `blocked-by` edge. Done section + Artifact terminals. */
export function blockedIds(tasks: Task[]): Set<string> {
	const doneIds = new Set(tasks.filter(t => t.state === "done").map(t => t.id));
	const blocked = new Set<string>();
	for (const task of tasks) {
		if (task.state === "done") continue;
		if (task.deps.some(dep => !isResolvedDep(dep.id, doneIds))) blocked.add(task.id);
	}
	return blocked;
}

/** Unresolved blocker ids for one task (subset of its deps not yet Done/Artifact-terminal). */
export function unresolvedBlockers(task: Task, tasks: Task[]): string[] {
	const doneIds = new Set(tasks.filter(t => t.state === "done").map(t => t.id));
	return task.deps.map(d => d.id).filter(id => !isResolvedDep(id, doneIds));
}

export function isHoldActive(task: Task, today = todayLocal()): boolean {
	if (!task.hold) return false;
	if (task.state === "done") return false;
	if (!task.hold.until) return true;
	return task.hold.until > today;
}

export function readyTasks(tasks: Task[], opts: { includeHeld?: boolean; today?: string } = {}): Task[] {
	const blocked = blockedIds(tasks);
	const today = opts.today ?? todayLocal();
	return tasks
		.filter(t => t.state === "queued" && !blocked.has(t.id) && (opts.includeHeld || !isHoldActive(t, today)))
		.slice()
		.sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
}

export function heldTasks(tasks: Task[], today = todayLocal()): Task[] {
	return tasks.filter(t => isHoldActive(t, today));
}
