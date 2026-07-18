// fm verb: tasks - the single executable task system for the backlog ledger
// (data/backlog.md) and the live fleet records. `fm task` (singular) is an
// explicit zero-ambiguity alias for this verb - see task.ts.
//
// Bare `fm tasks` prints a content-first TOON dashboard. Subcommands: add,
// list, show, start, done, reopen, update, block, unblock, hold, unhold,
// ready, mv, prune, render, fleet.
//
// The `fleet` subcommand (and top-level `--fleet` flag) is the live-fleet
// facet: it reuses the same FleetSnapshot collector as `fm fleet`, so
// `fm tasks fleet` and `fm fleet tasks` return identical data.
//
// `ready` compiles the recursive scheduler invariant: every call recomputes
// fresh state (backlog + fleet snapshot), distinguishes a worker's own
// "done" report from confirmed delivery-mode landing, and returns exactly
// one actionable class - completion, active_command, unblock_action, or
// failure - alongside the traditional ready listing, never a fixed wait or
// a permission prompt.
//
// Env: FM_HOME, FM_ROOT_OVERRIDE, FM_DATA_OVERRIDE

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import {
	BacklogStore,
	DATE_RE,
	HOLD_KINDS,
	ID_RE,
	StoreError,
	blockedIds,
	heldTasks,
	isHoldActive,
	readyTasks,
	todayLocal,
	unresolvedBlockers,
	type Dep,
	type HoldKind,
	type Task,
	type TaskState,
} from "../lib/backlog-store";
import { collectSnapshot, findTask, normalizeTaskState, rankedTasks } from "../../bridge/collect";
import type { FleetSnapshot, TaskRow } from "../../bridge/fleet";
import { didYouMean } from "../common";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveHome(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	return process.env.FM_HOME?.trim() || rootOverride || fmRoot;
}
function resolveData(): string {
	return process.env.FM_DATA_OVERRIDE?.trim() || join(resolveHome(), "data");
}
function resolveBacklogPath(): string {
	return join(resolveData(), "backlog.md");
}
function resolveArchivePath(): string {
	return join(resolveData(), "done-archive.md");
}
function resolveNoteArchivePath(): string {
	return join(resolveData(), "note-archive.md");
}

// ---------------------------------------------------------------------------
// TOON block rendering (house style: content-first, terse `ok:` confirmations,
// truncated list rows, state-aware next-step hints).
// ---------------------------------------------------------------------------

function toon(value: unknown): string {
	return encode(value, { keyFolding: "safe" });
}
function renderList(label: string, items: Record<string, unknown>[]): string {
	return toon({ [label]: items });
}
function renderScalar(label: string, value: string): string {
	return toon({ [label]: value });
}
function renderHelp(lines: string[]): string {
	return lines.length > 0 ? toon({ help: lines }) : "";
}
function renderOutput(blocks: string[]): string {
	return blocks.filter(Boolean).join("\n");
}

const TITLE_LIST_LIMIT = 80;

function truncate(text: string | undefined, maxLen: number, hint: string): string {
	if (!text) return "";
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}\n... (truncated, ${text.length} chars total - ${hint})`;
}

function fullHint(id: string): string {
	return `use \`fm tasks show ${id} --full\` to see complete text`;
}

function stateLabel(state: TaskState): string {
	return state === "inflight" ? "In flight" : state === "queued" ? "Queued" : "Done";
}

/**
 * Flat row projection for list/show/ready. Title is truncated when long;
 * body is omitted ENTIRELY (never a partial preview, at any length) unless
 * `full` - the whole point of title/body separation is that a list/dashboard
 * row never carries body content, only `show <id> --full` does.
 */
function toRow(task: Task, all: Task[], full = false): Record<string, unknown> {
	const blockers = unresolvedBlockers(task, all);
	const held = isHoldActive(task);
	const hint = fullHint(task.id);
	return {
		id: task.id,
		title: full ? task.title : truncate(task.title, TITLE_LIST_LIMIT, hint) || task.title,
		state: task.state,
		blocked: blockers.length > 0 ? "yes" : "no",
		blocked_by: blockers.length > 0 ? blockers.join(",") : "none",
		held: held ? "yes" : "no",
		hold_reason: task.hold?.reason ?? "-",
		hold_kind: task.hold?.kind ?? "-",
		hold_until: task.hold?.until ?? "-",
		kind: task.kind ?? "-",
		repo: task.repo ?? "-",
		priority: task.priority ?? "-",
		created: task.created ?? "-",
		closed: task.closed ?? "-",
		proof: task.proof ?? "-",
		deps: task.deps.length > 0 ? task.deps.map(d => (d.reason ? `${d.id} - ${d.reason}` : d.id)).join(", ") : "none",
		body: full ? (task.body ?? "") : "",
	};
}

function confirm(message: string): string {
	return `ok: ${message}`;
}

function errorOut(error: string, code: string, help: string[] = []): number {
	process.stdout.write(`${toon({ error, code, help })}\n`);
	return code === "USAGE" ? 1 : 2;
}

function storeErrorExit(error: unknown): number {
	if (error instanceof StoreError) return errorOut(error.message, error.code, error.help);
	return errorOut(error instanceof Error ? error.message : String(error), "UNKNOWN");
}

// ---------------------------------------------------------------------------
// Minimal arg parsing (no external CLI-parsing dependency; matches the shape
// firstmate's other verbs already hand-roll).
// ---------------------------------------------------------------------------

function needsValue(v: string | undefined): boolean {
	return v === undefined || v.length === 0 || v.startsWith("-");
}
function takeFlag(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i === -1) return undefined;
	const v = args[i + 1];
	if (needsValue(v)) throw new StoreError(`${flag} requires a value`, "VALIDATION_ERROR");
	args.splice(i, 2);
	return v;
}
function takeAllFlags(args: string[], flag: string): string[] {
	const out: string[] = [];
	let v = takeFlag(args, flag);
	while (v !== undefined) {
		out.push(v);
		v = takeFlag(args, flag);
	}
	return out;
}
function takeBoolFlag(args: string[], flag: string): boolean {
	const i = args.indexOf(flag);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}
function requireNoUnknownFlags(args: string[], usage: string): void {
	const unknown = args.find(a => a.startsWith("-"));
	if (unknown) throw new StoreError(`unknown argument: ${unknown}`, "VALIDATION_ERROR", [usage]);
}
function requirePositionals(args: string[], min: number, max: number, usage: string): string[] {
	requireNoUnknownFlags(args, usage);
	if (args.length < min || args.length > max) throw new StoreError(`expected ${min === max ? min : `${min}-${max}`} positional argument(s), got ${args.length}`, "VALIDATION_ERROR", [usage]);
	return args;
}
function requireDate(flag: string, v: string | undefined): string | undefined {
	if (v === undefined) return undefined;
	if (!DATE_RE.test(v)) throw new StoreError(`${flag} requires a value in YYYY-MM-DD form`, "VALIDATION_ERROR");
	return v;
}
function requirePriority(v: string | undefined): number | undefined {
	if (v === undefined) return undefined;
	if (!/^[0-4]$/.test(v)) throw new StoreError("--priority must be an integer 0-4", "VALIDATION_ERROR");
	return Number(v);
}
function requireNoParens(flag: string, v: string): string {
	if (/[()]/.test(v)) throw new StoreError(`${flag} must not contain parentheses`, "VALIDATION_ERROR");
	if (/[\r\n]/.test(v)) throw new StoreError(`${flag} must be a single line`, "VALIDATION_ERROR");
	return v.trim();
}
function requireId(v: string | undefined): string {
	if (!v) throw new StoreError("missing id", "VALIDATION_ERROR", ["Pass a task id, e.g. `fm tasks show <id>`."]);
	if (!ID_RE.test(v)) throw new StoreError(`invalid task id: ${v}`, "VALIDATION_ERROR", ["Use a slug like `homemux-h7`, or pass --mint to generate one."]);
	return v;
}
function requireTitle(v: string | undefined): string {
	if (v === undefined || v.trim() === "") throw new StoreError("a title is required", "VALIDATION_ERROR");
	if (/[\r\n]/.test(v)) throw new StoreError("task title must be a single line", "VALIDATION_ERROR");
	return v.trim();
}

function takeBody(args: string[]): string | undefined {
	const inline = takeFlag(args, "--body");
	const file = takeFlag(args, "--body-file");
	if (inline !== undefined && file !== undefined) throw new StoreError("use only one of --body or --body-file", "VALIDATION_ERROR");
	if (inline !== undefined) return inline;
	if (file === undefined) return undefined;
	try {
		return readFileSync(file, "utf8");
	} catch {
		throw new StoreError(`could not read --body-file path: ${file}`, "VALIDATION_ERROR");
	}
}

// ---------------------------------------------------------------------------
// Mint: generate a slug-xx id from a title.
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

function mintAvailableId(store: BacklogStore, title: string, prefix: string | undefined): string {
	const base = slugify(title) || "task";
	const head = prefix ? `${slugify(prefix)}-${base}` : base;
	for (let n = 0; n < 256; n++) {
		const candidate = `${head}-${n.toString(16).padStart(2, "0")}`;
		if (!store.get(candidate)) return candidate;
	}
	throw new StoreError("could not mint a unique id for this title", "CONFLICT", ['Pass an explicit id, e.g. `fm tasks add <id> "title"`.']);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const ADD_USAGE = 'usage: fm tasks add <id> "<title>" [--kind K] [--repo R] [--body T|--body-file F] [--start|--queue] [--blocked-by <id>]... [--priority 0-4] [--date YYYY-MM-DD] | fm tasks add "<title>" --mint [--prefix P]';

function cmdAdd(rest: string[]): number {
	const args = [...rest];
	const kind = takeFlag(args, "--kind");
	const repo = takeFlag(args, "--repo");
	const body = takeBody(args);
	const priority = requirePriority(takeFlag(args, "--priority"));
	const date = requireDate("--date", takeFlag(args, "--date"));
	const blockedBy = takeAllFlags(args, "--blocked-by");
	const start = takeBoolFlag(args, "--start");
	const queue = takeBoolFlag(args, "--queue");
	const mint = takeBoolFlag(args, "--mint");
	const prefix = takeFlag(args, "--prefix");
	if (start && queue) throw new StoreError("use only one of --start or --queue", "VALIDATION_ERROR");
	if (prefix !== undefined && !mint) throw new StoreError("--prefix can only be used with --mint", "VALIDATION_ERROR", [ADD_USAGE]);

	const positionals = requirePositionals(args, mint ? 1 : 2, mint ? 1 : 2, ADD_USAGE);
	const store = BacklogStore.load(resolveBacklogPath());
	const id = mint ? mintAvailableId(store, requireTitle(positionals[0]), prefix) : requireId(positionals[0]);
	const title = mint ? requireTitle(positionals[0]) : requireTitle(positionals[1]);

	if (!mint) {
		const existing = store.get(id);
		if (existing) {
			const all = store.list();
			const blocks = [confirm(`add ${id} already exists -> ${stateLabel(existing.state)}`), "already: true", renderList("task", [toRow(existing, all)])];
			blocks.push(renderHelp([`Run \`fm tasks show ${id} --full\` to see the result`]));
			process.stdout.write(`${renderOutput(blocks)}\n`);
			return 0;
		}
	}

	const deps: Dep[] = blockedBy.map(b => ({ id: requireId(b) }));
	for (const dep of deps) if (dep.id === id) throw new StoreError("a task cannot block itself", "VALIDATION_ERROR");
	for (const dep of deps) if (!store.get(dep.id)) throw new StoreError(`blocker "${dep.id}" not found`, "VALIDATION_ERROR", ["Create the blocker task first, or choose an existing task id."]);

	const state: TaskState = start ? "inflight" : "queued";
	const task: Task = { id, title, state, deps };
	if (kind) task.kind = kind;
	if (repo) task.repo = repo;
	if (body !== undefined) task.body = body;
	if (priority !== undefined) task.priority = priority;
	if (state === "inflight") task.created = date ?? todayLocal();

	store.create(task);
	store.save();
	const all = store.list();
	const attrs = [kind, repo ? `repo ${repo}` : undefined].filter(Boolean).join(", ");
	const blocks = [confirm(`added ${id}${attrs ? ` (${attrs})` : ""} -> ${stateLabel(state)}`), renderList("task", [toRow(task, all)])];
	const hints = state === "inflight" ? [`Run \`fm tasks done ${id} --pr <url>\` when it ships`] : [`Run \`fm tasks start ${id}\` to move it to in flight`, `Run \`fm tasks block ${id} --by <other>\` to record a dependency`];
	blocks.push(renderHelp(hints));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

const STATE_ALIASES: Record<string, TaskState> = { queued: "queued", "in-flight": "inflight", inflight: "inflight", in_flight: "inflight", done: "done" };

function parseListState(v: string | undefined): TaskState | "held" | undefined {
	if (v === undefined) return undefined;
	if (v === "held") return "held";
	const state = STATE_ALIASES[v];
	if (!state) throw new StoreError("--state must be one of queued, in-flight, done, held", "VALIDATION_ERROR");
	return state;
}

function cmdList(rest: string[]): number {
	const args = [...rest];
	const state = parseListState(takeFlag(args, "--state"));
	const repo = takeFlag(args, "--repo");
	const kind = takeFlag(args, "--kind");
	const onlyBlocked = takeBoolFlag(args, "--blocked");
	const limitRaw = takeFlag(args, "--limit");
	const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
	if (limitRaw !== undefined && (!/^\d+$/.test(limitRaw))) throw new StoreError("--limit must be a non-negative integer", "VALIDATION_ERROR");
	requirePositionals(args, 0, 0, "usage: fm tasks list [--state queued|in-flight|done|held] [--repo R] [--kind K] [--blocked] [--limit N]");

	const store = BacklogStore.load(resolveBacklogPath());
	const all = store.list();
	const blocked = blockedIds(all);
	const held = new Set(heldTasks(all).map(t => t.id));
	let matched = all;
	if (state === "held") matched = matched.filter(t => held.has(t.id));
	else if (state) matched = matched.filter(t => t.state === state);
	if (repo) matched = matched.filter(t => t.repo === repo);
	if (kind) matched = matched.filter(t => t.kind === kind);
	if (onlyBlocked) matched = matched.filter(t => blocked.has(t.id));

	const total = matched.length;
	const items = limit !== undefined ? matched.slice(0, limit) : matched;
	const blocks = [renderScalar("count", `${items.length}${total !== items.length ? ` of ${total} total` : ""}`)];
	if (items.length === 0) blocks.push(renderScalar("tasks", "0 tasks match this filter"));
	else blocks.push(renderList("tasks", items.map(t => toRow(t, all))));
	blocks.push(renderHelp(items.length === 0 ? ['Run `fm tasks add <id> "<title>"` to add a task'] : ["Run `fm tasks show <id>` for full notes on a task", "Run `fm tasks ready` to see unblocked queued work"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

function cmdShow(rest: string[]): number {
	const args = [...rest];
	const full = takeBoolFlag(args, "--full");
	const [id] = requirePositionals(args, 1, 1, "usage: fm tasks show <id> [--full]");
	const store = BacklogStore.load(resolveBacklogPath());
	const task = store.get(requireId(id));
	if (!task) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	const all = store.list();
	const blocks = [renderList("task", [toRow(task, all, full)])];
	if (blockedIds(all).has(task.id)) blocks.push(renderHelp([`Run \`fm tasks unblock ${task.id} --by <other>\` to clear a blocker`, `Run \`fm tasks start ${task.id}\` to move it to in flight`]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

function cmdStart(rest: string[]): number {
	const args = [...rest];
	const date = requireDate("--date", takeFlag(args, "--date"));
	const [id] = requirePositionals(args, 1, 1, "usage: fm tasks start <id> [--date YYYY-MM-DD]");
	const store = BacklogStore.load(resolveBacklogPath());
	if (!store.get(id)) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	const current = store.get(id)!;
	if (current.state === "done") throw new StoreError(`task ${id} is Done; run \`fm tasks reopen ${id}\` first`, "VALIDATION_ERROR");
	const { task, already } = store.transition(id, "inflight", { date });
	if (!already) store.save();
	const all = store.list();
	const blocks = [confirm(already ? `start ${id} already in flight` : `start ${id} -> ${stateLabel(task.state)}`)];
	if (already) blocks.push("already: true");
	if (!already) blocks.push(renderHelp([`Run \`fm tasks done ${id} --pr <url>\` when it ships`]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

const DONE_USAGE = 'usage: fm tasks done <id> (--pr <url>|--report <path>|--note "<text>") [--date YYYY-MM-DD]';

function cmdDone(rest: string[]): number {
	const args = [...rest];
	const pr = takeFlag(args, "--pr");
	const report = takeFlag(args, "--report");
	const note = takeFlag(args, "--note");
	const date = requireDate("--date", takeFlag(args, "--date"));
	const [id] = requirePositionals(args, 1, 1, DONE_USAGE);
	const provided = [pr, report, note].filter(v => v !== undefined);
	if (provided.length !== 1) return errorOut("exactly one of --pr, --report, or --note is required", "VALIDATION_ERROR", [DONE_USAGE]);

	const store = BacklogStore.load(resolveBacklogPath());
	if (!store.get(id)) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	const proof = (pr ?? report ?? note) as string;
	const { task, already } = store.transition(id, "done", { proof, date });
	let archived = 0;
	if (!already) {
		archived = pruneAndArchive(store, "done", 10);
		store.save();
	}
	const blocks = [confirm(already ? `done ${id} already -> ${stateLabel(task.state)}` : `done ${id} -> ${stateLabel(task.state)} (${proof})${archived > 0 ? `; pruned ${archived}` : ""}`)];
	if (already) blocks.push("already: true");
	if (!already) blocks.push(renderHelp(["Run `fm tasks ready` to dispatch work unblocked by this"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

function cmdReopen(rest: string[]): number {
	const args = [...rest];
	const [id] = requirePositionals(args, 1, 1, "usage: fm tasks reopen <id>");
	const store = BacklogStore.load(resolveBacklogPath());
	if (!store.get(id)) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	const { task, already } = store.transition(id, "queued");
	if (!already) store.save();
	const blocks = [confirm(already ? `reopen ${id} already queued` : `reopen ${id} -> ${stateLabel(task.state)}`)];
	if (already) blocks.push("already: true");
	if (!already) blocks.push(renderHelp([`Run \`fm tasks start ${id}\` to move it to in flight`]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

const UPDATE_USAGE = 'usage: fm tasks update <id> [--title T] [--body T|--body-file F] [--archive-body] [--repo R] [--kind K] [--priority 0-4]';

function cmdUpdate(rest: string[]): number {
	const args = [...rest];
	const titleRaw = takeFlag(args, "--title");
	const body = takeBody(args);
	const archiveBody = takeBoolFlag(args, "--archive-body");
	const repo = takeFlag(args, "--repo");
	const kind = takeFlag(args, "--kind");
	const priority = requirePriority(takeFlag(args, "--priority"));
	const [id] = requirePositionals(args, 1, 1, UPDATE_USAGE);
	if (archiveBody && body === undefined) throw new StoreError("--archive-body requires --body or --body-file", "VALIDATION_ERROR", ["Inspect the current task first with `show --full`, then pass a replacement body."]);
	const title = titleRaw !== undefined ? requireTitle(titleRaw) : undefined;
	if (title === undefined && body === undefined && repo === undefined && kind === undefined && priority === undefined) throw new StoreError("nothing to update", "VALIDATION_ERROR", [UPDATE_USAGE]);

	const store = BacklogStore.load(resolveBacklogPath());
	const current = store.get(id);
	if (!current) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	if (current.state === "done") throw new StoreError(`cannot update a completed task: ${id}`, "VALIDATION_ERROR", [`Run \`fm tasks reopen ${id}\` first if it genuinely needs to change.`]);
	const { task, changed, archivedBody } = store.update(id, { title, body, archiveBody, repo, kind, priority });
	if (changed.length > 0) {
		if (archivedBody !== undefined) archiveNote(id, archivedBody);
		store.save();
	}
	const all = store.list();
	const blocks = [confirm(changed.length === 0 ? `updated ${id} already` : `updated ${id} (${changed.join(", ")})`)];
	if (changed.length === 0) blocks.push("already: true");
	blocks.push(renderList("task", [toRow(task, all)]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

function archiveNote(id: string, body: string): void {
	const path = resolveNoteArchivePath();
	const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
	const entry = `## ${id} (${todayLocal()})\n\n${body}\n\n`;
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	writeFileSync(tmp, prior + entry);
	renameSync(tmp, path);
}

function cmdBlockOrUnblock(rest: string[], mode: "block" | "unblock"): number {
	const args = [...rest];
	const by = takeFlag(args, "--by");
	const [id] = requirePositionals(args, 1, 1, `usage: fm tasks ${mode} <id> --by <other-id>`);
	if (!by) throw new StoreError("--by <id> is required", "VALIDATION_ERROR");
	const otherId = requireId(by);
	if (otherId === id) throw new StoreError("a task cannot block itself", "VALIDATION_ERROR");
	const store = BacklogStore.load(resolveBacklogPath());
	if (!store.get(id)) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	if (mode === "block" && !store.get(otherId)) throw new StoreError(`blocker "${otherId}" not found`, "VALIDATION_ERROR", ["Create the blocker task first, or choose an existing task id."]);

	const changed = mode === "block" ? store.addDep(id, otherId) : store.removeDep(id, otherId);
	if (changed) store.save();
	const verb = mode === "block" ? "blocked-by" : "cleared";
	const already = mode === "block" ? "already blocked-by" : "already not blocked-by";
	const blocks = [confirm(changed ? `${mode} ${id} -> ${verb} ${otherId}` : `${mode} ${id} ${already} ${otherId}`)];
	if (!changed) blocks.push("already: true");
	blocks.push(renderHelp(mode === "block" ? [`Run \`fm tasks unblock ${id} --by ${otherId}\` to clear it`, "Run `fm tasks ready` to see what is still dispatchable"] : ["Run `fm tasks ready` to see newly unblocked work"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

const HOLD_USAGE = 'usage: fm tasks hold <id> --reason "<text>" [--kind captain|external|load|parked|future] [--until YYYY-MM-DD]';

function cmdHold(rest: string[]): number {
	const args = [...rest];
	const reasonRaw = takeFlag(args, "--reason");
	const kindRaw = takeFlag(args, "--kind");
	const until = requireDate("--until", takeFlag(args, "--until"));
	const [id] = requirePositionals(args, 1, 1, HOLD_USAGE);
	if (!reasonRaw) throw new StoreError('--reason "<text>" is required', "VALIDATION_ERROR", [HOLD_USAGE]);
	const reason = requireNoParens("--reason", reasonRaw);
	let kind: HoldKind | undefined;
	if (kindRaw !== undefined) {
		if (!(HOLD_KINDS as readonly string[]).includes(kindRaw)) throw new StoreError(`--kind must be one of ${HOLD_KINDS.join(", ")}`, "VALIDATION_ERROR");
		kind = kindRaw as HoldKind;
	}

	const store = BacklogStore.load(resolveBacklogPath());
	const current = store.get(id);
	if (!current) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	const hold = { reason, ...(kind ? { kind } : {}), ...(until ? { until } : {}) };
	const { task, changed } = store.update(id, { hold });
	if (changed.length > 0) store.save();
	const attrs = [kind, until ? `until ${until}` : undefined].filter(Boolean).join(", ");
	const blocks = [confirm(changed.length === 0 ? `hold ${id} already held` : `hold ${id} -> held${attrs ? ` (${attrs})` : ""}`)];
	if (changed.length === 0) blocks.push("already: true");
	blocks.push(renderList("task", [toRow(task, store.list())]));
	blocks.push(renderHelp([`Run \`fm tasks unhold ${id}\` to resume dispatch`, "Run `fm tasks ready --include-held` to review paused work"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

function cmdUnhold(rest: string[]): number {
	const args = [...rest];
	const [id] = requirePositionals(args, 1, 1, "usage: fm tasks unhold <id>");
	const store = BacklogStore.load(resolveBacklogPath());
	const current = store.get(id);
	if (!current) throw new StoreError(`Task "${id}" not found in this backlog`, "NOT_FOUND", ["Run `fm tasks list` to see existing tasks."]);
	const already = current.hold === undefined;
	const { task, changed } = already ? { task: current, changed: [] as string[] } : store.update(id, { hold: null });
	if (changed.length > 0) store.save();
	const blocks = [confirm(already ? `unhold ${id} already not held` : `unhold ${id} -> cleared`)];
	if (already) blocks.push("already: true");
	blocks.push(renderHelp(["Run `fm tasks ready` to see dispatchable work"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

/**
 * `ready` is the canonical recursive-scheduler command, not a bare listing:
 * every call recomputes the local backlog AND the live fleet snapshot fresh
 * (no cached belief), distinguishes a worker's own "done"/"ready in branch"
 * report from confirmed delivery-mode landing, releases only legitimately
 * closed lanes, resolves dependencies/date gates, returns the highest-
 * priority independent ready work with every other ready id as
 * `parallel_ready` (never serialized), names an explicit unblock action for
 * the highest-priority blocked/held item when nothing is ready, and falls
 * back to full fleet reconciliation once the local queue is genuinely empty.
 * Exactly one of four `class` values comes back: completion, active_command,
 * unblock_action, or failure - never a fixed wait or a permission prompt.
 * `--include-held` only adds a separate `held` display group; held work is
 * never itself treated as ready or dispatchable.
 */
async function cmdReady(rest: string[]): Promise<number> {
	const args = [...rest];
	const includeHeld = takeBoolFlag(args, "--include-held");
	requirePositionals(args, 0, 0, "usage: fm tasks ready [--include-held]");

	let snapshot: FleetSnapshot | undefined;
	let snapshotError: unknown;
	try {
		snapshot = await collectSnapshot();
	} catch (error) {
		snapshotError = error;
	}
	const attention = snapshot ? (snapshot.attention ?? snapshot.pending ?? []) : [];

	let store: BacklogStore;
	try {
		store = BacklogStore.load(resolveBacklogPath());
	} catch (error) {
		process.stdout.write(`${toon({ command: "tasks ready", class: "failure", error: error instanceof StoreError ? error.message : String(error), evidence: [resolveBacklogPath()] })}\n`);
		return 2;
	}
	const all = store.list();
	const items = readyTasks(all);
	const held = heldTasks(all).filter(t => t.state === "queued" && !blockedIds(all).has(t.id));

	const landed = attention.find(row => /^MERGED\b/.test(row.reason));
	let scheduler: Record<string, unknown>;
	if (landed) {
		scheduler = {
			class: "completion",
			lane: landed,
			next_command: `fm tasks fleet get ${landed.key ?? landed.id}`,
			action: "delivery landed; inspect the lane, then record it with `fm tasks done` and `fm teardown` once the proof is confirmed",
		};
	} else if (items.length > 0) {
		const [top, ...restReady] = items;
		scheduler = { class: "active_command", next_command: `fm tasks start ${top.id}`, parallel_ready: restReady.map(t => t.id) };
	} else {
		const readySet = new Set(items.map(t => t.id));
		const notReady = all.filter(t => t.state === "queued" && !readySet.has(t.id)).sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
		if (notReady.length > 0) {
			const top = notReady[0];
			const blockers = unresolvedBlockers(top, all);
			const isHeld = isHoldActive(top);
			scheduler = {
				class: "unblock_action",
				id: top.id,
				blocked_by: blockers,
				held: isHeld,
				hold_reason: top.hold?.reason ?? null,
				action: blockers.length > 0 ? `resolve ${blockers.join(", ")}, e.g. \`fm tasks show ${blockers[0]}\`` : `run \`fm tasks unhold ${top.id}\` once the hold reason clears`,
			};
		} else if (snapshotError) {
			scheduler = { class: "failure", error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError), evidence: ["fleet snapshot collection failed"] };
		} else {
			const top = attention[0];
			if (!top) scheduler = { class: "completion", detail: "fleet fully reconciled: no local or fleet work outstanding" };
			else if (top.clsRank >= 4)
				scheduler = {
					class: "unblock_action",
					lane: top,
					next_command: `fm tasks fleet get ${top.key ?? top.id}`,
					action: "needs the cap's decision or an unblock; inspect the lane's reason first",
				};
			else if (top.clsRank === 3)
				scheduler = {
					class: "active_command",
					lane: top,
					next_command: `fm tasks fleet get ${top.key ?? top.id}`,
					action: "review-ready; inspect the lane, confirm checks, then land per the project's delivery mode",
				};
			else scheduler = { class: "completion", detail: "fleet fully reconciled: no local or fleet work outstanding" };
		}
	}

	const blocks = [toon({ command: "tasks ready", ...scheduler })];
	blocks.push(renderScalar("count", String(items.length)));
	blocks.push(items.length === 0 ? renderScalar("ready", "0 unblocked queued tasks") : renderList("ready", items.map(t => toRow(t, all))));
	if (includeHeld && held.length > 0) blocks.push(renderList("held", held.map(t => toRow(t, all))));
	blocks.push(renderHelp(items.length === 0 ? ["Run `fm tasks list --state queued` to see all queued work (incl. blocked)"] : ["Run `fm tasks start <id>` to dispatch one of these"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return scheduler.class === "failure" ? 2 : 0;
}
function pruneAndArchive(store: BacklogStore, state: TaskState, keep: number): number {
	const overflow = store.prune(state, keep);
	if (overflow.length === 0) return 0;
	if (state === "done") {
		const path = resolveArchivePath();
		const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
		const lines = overflow.map(t => `- [x] ${t.id} - ${t.title} - ${t.proof ?? ""} (${t.closed ?? ""})`);
		const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
		writeFileSync(tmp, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
		renameSync(tmp, path);
	}
	return overflow.length;
}

function cmdPrune(rest: string[]): number {
	const args = [...rest];
	const keepRaw = takeFlag(args, "--keep");
	const keep = keepRaw !== undefined ? Number(keepRaw) : 10;
	if (keepRaw !== undefined && !/^\d+$/.test(keepRaw)) throw new StoreError("--keep must be a non-negative integer", "VALIDATION_ERROR");
	const stateRaw = takeFlag(args, "--state") ?? "done";
	const state = parseListState(stateRaw);
	if (state === undefined || state === "held") throw new StoreError("--state must be one of queued, in-flight, done", "VALIDATION_ERROR");
	requirePositionals(args, 0, 0, "usage: fm tasks prune [--keep N] [--state queued|in-flight|done]");
	const store = BacklogStore.load(resolveBacklogPath());
	const archived = pruneAndArchive(store, state, keep);
	if (archived > 0) store.save();
	const blocks = [confirm(`prune ${state} -> archived ${archived} (kept ${keep})`)];
	blocks.push(renderHelp(["Run `fm tasks list --state done` to see retained Done items"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

function cmdRender(rest: string[]): number {
	requirePositionals([...rest], 0, 0, "usage: fm tasks render");
	const store = BacklogStore.load(resolveBacklogPath());
	const count = store.renderAll();
	store.save();
	const blocks = [confirm(`render -> normalized ${count}`)];
	blocks.push(renderHelp(["Run `fm tasks list` to see the normalized backlog"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// mv: absorbs `fm backlog-handoff`'s validated cross-home move. Retires that
// verb. Generalized to move a whole dependency-connected set atomically.
// ---------------------------------------------------------------------------

function pathIsAncestorOf(ancestor: string, candidate: string): boolean {
	return Boolean(ancestor) && Boolean(candidate) && ancestor !== candidate && candidate.startsWith(`${ancestor}/`);
}
function isSymlink(target: string): boolean {
	try {
		return lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Resolve + validate a secondmate id into its safe absolute home path (ported from the retired backlog-handoff verb). */
function resolveSecondmateHome(id: string): string {
	const reg = join(resolveData(), "secondmates.md");
	if (!existsSync(reg)) throw new StoreError(`no secondmate registry at ${reg}`, "VALIDATION_ERROR");
	const pattern = new RegExp(`^- ${id}( |$)`);
	let matched: string | null = null;
	for (const line of readFileSync(reg, "utf8").split("\n")) if (pattern.test(line)) matched = line;
	if (matched === null) throw new StoreError(`secondmate ${id} is not registered in ${reg}`, "VALIDATION_ERROR");
	const homeMatch = matched.match(/^[^(]*\(home: ([^;)]*);/);
	const rawHome = homeMatch ? homeMatch[1] : "";
	if (!rawHome) throw new StoreError(`secondmate ${id} has no home in ${reg}`, "VALIDATION_ERROR");

	if (!existsSync(rawHome) || !statSync(rawHome).isDirectory()) throw new StoreError(`firstmate home does not exist or is not a directory: ${rawHome}`, "VALIDATION_ERROR");
	const absHome = realpathSync(rawHome);
	const absActiveHome = existsSync(resolveHome()) ? realpathSync(resolveHome()) : resolveHome();
	const absRoot = existsSync(REPO_ROOT) ? realpathSync(REPO_ROOT) : REPO_ROOT;

	if (absHome === "/" || absHome === absActiveHome || absHome === absRoot || pathIsAncestorOf(absActiveHome, absHome) || pathIsAncestorOf(absRoot, absHome) || pathIsAncestorOf(absHome, absActiveHome) || pathIsAncestorOf(absHome, absRoot)) {
		throw new StoreError(`secondmate home is not a safe destination: ${rawHome}`, "VALIDATION_ERROR");
	}
	for (const name of ["data", "state", "config", "projects"]) {
		const dir = join(absHome, name);
		if (isSymlink(dir) && !existsSync(dir)) throw new StoreError(`secondmate ${name} directory must resolve inside the secondmate home: ${dir}`, "VALIDATION_ERROR");
		const absDir = existsSync(dir) && statSync(dir).isDirectory() ? realpathSync(dir) : dir;
		if (!pathIsAncestorOf(absHome, absDir) || absDir === absActiveHome || pathIsAncestorOf(absActiveHome, absDir) || absDir === absRoot || pathIsAncestorOf(absRoot, absDir)) {
			throw new StoreError(`secondmate ${name} directory must resolve safely inside the secondmate home: ${dir}`, "VALIDATION_ERROR");
		}
	}
	const markerFile = join(absHome, ".fm-secondmate-home");
	if (!existsSync(markerFile)) throw new StoreError(`firstmate home ${rawHome} is not a seeded secondmate home`, "VALIDATION_ERROR");
	const markerId = readFileSync(markerFile, "utf8").replace(/\n+$/, "");
	if (markerId !== id) throw new StoreError(`firstmate home ${rawHome} is marked for secondmate ${markerId || "unknown"}, expected ${id}`, "VALIDATION_ERROR");
	if (!existsSync(join(absHome, "AGENTS.md"))) throw new StoreError(`${rawHome} is not a firstmate home (missing AGENTS.md)`, "VALIDATION_ERROR");
	const sbinDir = join(absHome, "sbin");
	let sbinOk = false;
	try {
		const s = lstatSync(sbinDir);
		sbinOk = s.isDirectory() || s.isSymbolicLink();
	} catch {
		sbinOk = false;
	}
	if (!sbinOk) throw new StoreError(`${rawHome} is not a firstmate home (missing sbin/)`, "VALIDATION_ERROR");
	return absHome;
}

const MV_USAGE = "usage: fm tasks mv <id> [<id>...] --to <secondmate-id>";

function cmdMv(rest: string[]): number {
	const args = [...rest];
	const to = takeFlag(args, "--to");
	if (!to) throw new StoreError("--to <secondmate-id> is required", "VALIDATION_ERROR", [MV_USAGE]);
	requireNoUnknownFlags(args, MV_USAGE);
	if (args.length === 0) throw new StoreError("expected at least one task id", "VALIDATION_ERROR", [MV_USAGE]);
	const ids = [...new Set(args.map(requireId))];

	const destHome = resolveSecondmateHome(to);
	const destPath = join(destHome, "data", "backlog.md");
	mkdirSync(join(destHome, "data"), { recursive: true });
	const destExisted = existsSync(destPath);
	const destOriginal = destExisted ? readFileSync(destPath, "utf8") : undefined;
	if (!destExisted) {
		writeFileSync(destPath, "## In flight\n\n## Queued\n\n## Done\n");
	}

	const source = BacklogStore.load(resolveBacklogPath());
	const dest = BacklogStore.load(destPath, { lenient: true });
	const sourceAll = source.list();
	const destAll = dest.list();
	const destIds = new Set(destAll.map(t => t.id));

	const alreadyThere: string[] = [];
	const toMove: string[] = [];
	const missing: string[] = [];
	const inFlightRefused: string[] = [];
	for (const id of ids) {
		if (destIds.has(id)) {
			alreadyThere.push(id);
			continue;
		}
		const task = sourceAll.find(t => t.id === id);
		if (!task) {
			missing.push(id);
			continue;
		}
		if (task.state === "inflight") {
			inFlightRefused.push(id);
			continue;
		}
		toMove.push(id);
	}
	if (missing.length > 0) throw new StoreError(`no backlog item matched these ids: ${missing.join(" ")}`, "NOT_FOUND", ["Nothing was moved."]);
	if (inFlightRefused.length > 0) throw new StoreError(`refusing to move in-flight backlog items: ${inFlightRefused.join(" ")}`, "VALIDATION_ERROR", ["Nothing was moved."]);

	if (toMove.length === 0) {
		process.stdout.write(`${renderOutput([confirm(`mv already present (skipped): ${alreadyThere.join(" ")}`), "already: true"])}\n`);
		return 0;
	}

	const movedSet = new Set(toMove);
	const strandedBlocker = toMove.map(id => sourceAll.find(t => t.id === id)!).flatMap(t => t.deps.filter(d => !movedSet.has(d.id) && !destIds.has(d.id)).map(d => `moving ${t.id} would strand its blocker ${d.id}`))[0];
	if (strandedBlocker) throw new StoreError(strandedBlocker, "VALIDATION_ERROR", ["Include the whole dependency set, or move the missing endpoint there first."]);
	const strandedDependent = sourceAll
		.filter(t => !movedSet.has(t.id) && t.state !== "done")
		.flatMap(t => t.deps.filter(d => movedSet.has(d.id)).map(d => `moving ${d.id} would strand its active dependent ${t.id}`))[0];
	if (strandedDependent) throw new StoreError(strandedDependent, "VALIDATION_ERROR", ["Include the whole dependency set, or move the missing endpoint there first."]);

	const moved = toMove.map(id => source.extractEntry(id));
	for (const entry of moved) dest.insertEntry(entry);
	dest.save();
	try {
		source.save();
	} catch (error) {
		// Roll the destination back to its pre-move state so a source-write
		// failure never leaves the moved tasks duplicated across both files.
		if (destExisted && destOriginal !== undefined) writeFileSync(destPath, destOriginal);
		else unlinkSync(destPath);
		throw error;
	}

	const blocks = [confirm(toMove.length === 1 ? `mv ${toMove[0]} -> ${destPath}` : `mv ${toMove.join(" ")} -> ${destPath}`)];
	if (alreadyThere.length > 0) blocks.push(renderScalar("skipped", alreadyThere.join(" ")));
	blocks.push(renderHelp(["Run `fm tasks list` to see remaining tasks"]));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// fleet facet: `fm tasks fleet` === `fm fleet tasks`; `fm tasks fleet get <id>`
// === `fm fleet task get <id>`. Reuses the same collector, never a fork of it.
// ---------------------------------------------------------------------------

async function cmdFleet(rest: string[]): Promise<number> {
	const args = [...rest];
	if (args[0] === "get") {
		const [, id] = requirePositionals(args, 2, 2, "usage: fm tasks fleet get <id>");
		const snapshot = await collectSnapshot();
		const found = findTask(snapshot, id);
		if (found.candidates.length > 1) return errorOut(`Ambiguous task identifier: ${id}`, "AMBIGUOUS_IDENTIFIER", ["Use the canonical owner-qualified key."]);
		if (!found.task) return errorOut(`task not found: ${id}`, "NOT_FOUND", ["Run the fleet list command and retry."]);
		process.stdout.write(`${toon({ command: "tasks fleet get", result: found.task })}\n`);
		return 0;
	}
	let state: TaskRow["state"] | undefined;
	if (args.length === 2) {
		if (args[0] !== "--state") return errorOut(`unexpected argument: ${args[0]}`, "VALIDATION_ERROR", ["Use `--state` to filter tasks."]);
		state = normalizeTaskState(args[1]);
		if (!state) return errorOut(`invalid task state: ${args[1]}`, "VALIDATION_ERROR", ["Choose in-flight, queued, or done."]);
	} else if (args.length !== 0) {
		return errorOut("invalid fleet arguments", "VALIDATION_ERROR", ["Use `fm tasks fleet [--state <in-flight|queued|done>]` or `fm tasks fleet get <id>`."]);
	}
	const snapshot = await collectSnapshot();
	process.stdout.write(`${toon({ command: "tasks fleet", result: rankedTasks(snapshot, state) })}\n`);
	return 0;
}

// Bare dashboard: content-first, in_flight/queued tables, summary counts.
// ---------------------------------------------------------------------------

function cmdDashboard(): number {
	const store = BacklogStore.load(resolveBacklogPath());
	const all = store.list();
	const inFlight = all.filter(t => t.state === "inflight");
	const queued = all.filter(t => t.state === "queued");
	const doneCount = all.filter(t => t.state === "done").length;
	const readyCount = readyTasks(all).length;
	const blocked = blockedIds(all);

	const blocks: string[] = [];
	blocks.push(inFlight.length > 0 ? renderList("in_flight", inFlight.map(t => toRow(t, all))) : "in_flight: 0 tasks");
	if (queued.length > 0) {
		blocks.push(toon({ summary: { queued: queued.length, ready: readyCount } }));
		blocks.push(renderList("queued", queued.slice(0, 10).map(t => toRow(t, all))));
	} else {
		blocks.push("queued: 0 tasks");
	}
	blocks.push(`done: ${doneCount} retained`);

	const hints: string[] = [];
	if (queued.length > 10) hints.push(`Run \`fm tasks list --state queued\` for all ${queued.length} queued tasks`);
	if (blocked.size > 0) hints.push("Run `fm tasks ready` to see only unblocked work");
	if (hints.length === 0) hints.push("Run `fm tasks ready` to see unblocked queued work", 'Run `fm tasks add <id> "<title>" --start` to add and start a task');
	blocks.push(renderHelp(hints));
	process.stdout.write(`${renderOutput(blocks)}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const SUBCOMMANDS = ["add", "list", "show", "start", "done", "reopen", "update", "block", "unblock", "hold", "unhold", "ready", "mv", "prune", "render", "fleet"];

const HELP_TEXT: Record<string, string> = {
	add: ADD_USAGE,
	list: "usage: fm tasks list [--state queued|in-flight|done|held] [--repo R] [--kind K] [--blocked] [--limit N]",
	show: "usage: fm tasks show <id> [--full]",
	start: "usage: fm tasks start <id> [--date YYYY-MM-DD]",
	done: DONE_USAGE,
	reopen: "usage: fm tasks reopen <id>",
	update: UPDATE_USAGE,
	block: "usage: fm tasks block <id> --by <other-id>",
	unblock: "usage: fm tasks unblock <id> --by <other-id>",
	hold: HOLD_USAGE,
	unhold: "usage: fm tasks unhold <id>",
	ready: "usage: fm tasks ready [--include-held] - recursive scheduler oracle: fresh-reconciles the local backlog and live fleet, returns one class (completion|active_command|unblock_action|failure)",
	mv: MV_USAGE,
	prune: "usage: fm tasks prune [--keep N] [--state queued|in-flight|done]",
	render: "usage: fm tasks render",
	fleet: "usage: fm tasks fleet [--state <in-flight|queued|done>] | fm tasks fleet get <id>",
};

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const sub = args[0] === "--fleet" ? "fleet" : args[0];
	const rest = args.slice(1);

	if (!sub) return cmdDashboard();
	if (sub === "--help" || sub === "-h") {
		process.stdout.write(`${toon({ command: "tasks", usage: "fm tasks [--fleet] [add|list|show|start|done|reopen|update|block|unblock|hold|unhold|ready|mv|prune|render|fleet]", commands: SUBCOMMANDS.map(name => ({ command: name, usage: HELP_TEXT[name] })) })}\n`);
		return 0;
	}
	if (rest[0] === "--help" || rest[0] === "-h") {
		if (!SUBCOMMANDS.includes(sub)) return errorOut(`unknown subcommand: ${sub}`, "VALIDATION_ERROR", [`Run \`fm tasks --help\` for available commands.`]);
		process.stdout.write(`${toon({ command: `tasks ${sub}`, usage: HELP_TEXT[sub] })}\n`);
		return 0;
	}

	if (!SUBCOMMANDS.includes(sub)) {
		const suggestions = didYouMean(SUBCOMMANDS, sub);
		return errorOut(`unknown subcommand: ${sub}`, "UNKNOWN_SUBCOMMAND", suggestions.length > 0 ? [`Did you mean: ${suggestions.join(", ")}?`] : ["Run `fm tasks --help` for available commands."]);
	}

	try {
		switch (sub) {
			case "add":
				return cmdAdd(rest);
			case "list":
				return cmdList(rest);
			case "show":
				return cmdShow(rest);
			case "start":
				return cmdStart(rest);
			case "done":
				return cmdDone(rest);
			case "reopen":
				return cmdReopen(rest);
			case "update":
				return cmdUpdate(rest);
			case "block":
				return cmdBlockOrUnblock(rest, "block");
			case "unblock":
				return cmdBlockOrUnblock(rest, "unblock");
			case "hold":
				return cmdHold(rest);
			case "unhold":
				return cmdUnhold(rest);
			case "ready":
				return await cmdReady(rest);
			case "mv":
				return cmdMv(rest);
			case "prune":
				return cmdPrune(rest);
			case "render":
				return cmdRender(rest);
			case "fleet":
				return await cmdFleet(rest);
			default:
				return errorOut(`unknown subcommand: ${sub}`, "UNKNOWN_SUBCOMMAND", ["Run `fm tasks --help` for available commands."]);
		}
	} catch (error) {
		return storeErrorExit(error);
	}
}

export default {
	name: "tasks",
	describe: "Canonical backlog ledger + live fleet task system (add/list/show/start/done/reopen/update/block/unblock/hold/unhold/ready/mv/prune/render/fleet).",
	run,
};
