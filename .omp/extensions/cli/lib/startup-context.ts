// Startup static fleet context: typed decision body → bounded operator summary.
// Efficiency: eliminate O(fleet history) startup growth; hard UTF-8 ceiling 8000 bytes.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BacklogStore, readyTasks } from "./backlog-store";

export const FM_START_STATIC_CONTEXT_ENV = "FM_START_STATIC_CONTEXT";

/** Hard ceiling for the visible startup message (UTF-8 bytes). */
export const STARTUP_SUMMARY_MAX_BYTES = 8000;

/** Cap for every free-text field in the summary. */
export const STARTUP_FIELD_MAX_BYTES = 160;

/** Cap for every row collection in the typed body. */
export const STARTUP_COLLECTION_CAP = 3;

export interface CommandResult {
	args: string[];
	status: number;
	stdout: string;
	stderr: string;
}

export interface StartupFailure {
	step: string;
	command: string[];
	status: number;
	stdout: string;
	stderr: string;
	reason: string;
}

export interface StartupContextResult {
	staticFleet: string;
	fleetStatus: number;
	diagnostics: CommandResult[];
}

export interface StartupContextOptions {
	fmBin: string;
	home: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type StartupContextOutcome =
	| { ok: true; context: StartupContextResult }
	| { ok: false; failure: StartupFailure; diagnostics: CommandResult[] };

export interface FleetSnapshotLike {
	generatedAt?: string;
	home?: string | null;
	identity?: unknown;
	topology?: unknown;
	health?: unknown;
	activation?: unknown;
	mates?: unknown[];
	agents?: unknown[];
	pending?: unknown[];
	attention?: unknown[];
	tasks?: unknown[];
	otherLivePanes?: unknown[];
	notes?: unknown[];
}

export interface StartupAttentionRow {
	key: string;
	cls: string;
	reason: string;
	pr?: string;
}

export interface StartupActiveRow {
	key: string;
	pr?: string;
}

export interface StartupDecisionBody {
	schema: "fm-start-static/2";
	static_as_of: string;
	active: { home: string; role: "firstmate" };
	health: { state: string; exceptions: string[]; omitted: number };
	attention: StartupAttentionRow[];
	attention_total: number;
	active_work: StartupActiveRow[];
	active_work_total: number;
	queue: { queued_count: number; ready_count: number; next_ready: string | null };
	omitted: {
		attention: number;
		active_work: number;
		queued: number;
		panes: number;
		agents: number;
		notes: number;
	};
	fleet_status: string;
}

export interface RenderStaticFleetOpts {
	/** Override ready list for tests; default loads home backlog via readyTasks. */
	readyIds?: string[];
	readyCount?: number;
	/** Injected ceiling for fallback tests. */
	maxBytes?: number;
	fieldMaxBytes?: number;
	/** Injected clock for Local footer (tests). */
	now?: Date;
}

function runFm(options: StartupContextOptions, args: string[]): CommandResult {
	const result = spawnSync(options.fmBin, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
	});
	return {
		args,
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? (result.error ? result.error.message : ""),
	};
}

function failure(step: string, result: CommandResult, reason: string): StartupFailure {
	return { step, command: result.args, status: result.status, stdout: result.stdout, stderr: result.stderr, reason };
}

function blockingBootstrapLines(stdout: string): string[] {
	return stdout.split(/\r?\n/).filter(line => /^(MISSING|MISSING_EXT|NEEDS_GH_AUTH)(:|$)/.test(line));
}

function unresolvedIdentityReasons(stdout: string): string[] {
	return stdout.split(/\r?\n/)
		.filter(line => line.startsWith("UNRESOLVED"))
		.map(line => line.split("\t")[3] ?? "unknown");
}

function parseFleetSnapshot(result: CommandResult): FleetSnapshotLike | undefined {
	try {
		const parsed = JSON.parse(result.stdout.trim()) as FleetSnapshotLike;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Truncate to at most maxBytes UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	const ellipsis = "…";
	const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
	// Need room for at least one complete code point plus the ellipsis, or return "".
	if (maxBytes < ellipsisBytes + 1) return "";
	const budget = maxBytes - ellipsisBytes;
	let end = budget;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
	if (end <= 0) return "";
	return `${buf.subarray(0, end).toString("utf8")}${ellipsis}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function taskKey(task: Record<string, unknown>): string {
	return String(task.key ?? task.id ?? "");
}

function loadReadyFromBacklog(home: string): { readyCount: number; nextReady: string | null } {
	const path = join(home, "data", "backlog.md");
	if (!existsSync(path)) return { readyCount: 0, nextReady: null };
	try {
		const store = BacklogStore.load(path);
		const ready = readyTasks(store.list());
		return { readyCount: ready.length, nextReady: ready[0]?.id ?? null };
	} catch {
		return { readyCount: 0, nextReady: null };
	}
}

function noteCoveredByStructured(note: string, structured: string[], missingHomes: number): boolean {
	const n = note.toLowerCase().trim();
	if (!n) return true;
	for (const s of structured) {
		if (n === s.toLowerCase().trim()) return true;
	}
	// missingHomes is secondmate-only; only suppress that exact note class.
	if (missingHomes > 0 && n.startsWith("secondmate home not found:")) return true;
	if (structured.some(s => /herdr unavailable/i.test(s)) && /herdr.*unavailable|pane inventory unavailable/.test(n)) {
		return true;
	}
	return false;
}

function healthExceptions(
	snapshot: FleetSnapshotLike,
	fleetStatus: number,
	fieldMax: number,
): { state: string; exceptions: string[]; omitted: number; notesOmitted: number } {
	const health = asRecord(snapshot.health);
	const topology = asRecord(snapshot.topology);
	const identity = asRecord(snapshot.identity);
	const activation = asRecord(snapshot.activation);
	const state = String(health.state ?? (fleetStatus === 0 ? "healthy" : "degraded")).toUpperCase();
	const structured: string[] = [];
	if (fleetStatus !== 0) structured.push(`fleet snapshot exit ${fleetStatus}`);
	const missingHomes = Number(health.missingHomes ?? 0);
	if (missingHomes > 0) {
		structured.push(`${missingHomes} secondmate home${missingHomes === 1 ? "" : "s"} missing`);
	}
	if (String(health.herdr ?? "") === "unavailable") structured.push("herdr unavailable");
	if (String(topology.state ?? "") === "incomplete") {
		structured.push(truncateUtf8(String(topology.reason || "topology incomplete"), fieldMax));
	}
	if (String(identity.state ?? "") === "mismatch") structured.push("identity mismatch");
	if (String(activation.state ?? "") === "stale") structured.push("activation stale");

	// Notes are already degradation diagnostics from collectSnapshot - keep source order,
	// no keyword severity classifier. Dedup against structured facts, then take first three.
	const notes = (snapshot.notes ?? []).map(n => String(n)).filter(Boolean);
	const noteKeep: string[] = [];
	let notesOmitted = 0;
	for (const note of notes) {
		if (noteCoveredByStructured(note, structured, missingHomes)) {
			// Represented by the structured exception - not an omission.
			continue;
		}
		if (noteKeep.length < STARTUP_COLLECTION_CAP) {
			noteKeep.push(truncateUtf8(note, fieldMax));
		} else {
			notesOmitted += 1;
		}
	}

	const merged = [...structured.map(s => truncateUtf8(s, fieldMax)), ...noteKeep];
	const exceptions = merged.slice(0, STARTUP_COLLECTION_CAP);
	// Notes that made the keep list but lost the final exception slot still count as omitted.
	const shown = new Set(exceptions);
	for (const note of noteKeep) {
		if (!shown.has(note)) notesOmitted += 1;
	}
	return {
		state,
		exceptions,
		omitted: Math.max(0, merged.length - exceptions.length),
		notesOmitted,
	};
}

function buildAttention(
	snapshot: FleetSnapshotLike,
	fieldMax: number,
): { rows: StartupAttentionRow[]; total: number; omitted: number } {
	// Prefer snapshot.pending (already clsRank >= 3). Fall back to filtering attention.
	// Preserve authoritative order; do not re-rank.
	const ranked = Array.isArray(snapshot.pending)
		? ([...(snapshot.pending ?? [])] as Record<string, unknown>[])
		: ([...(snapshot.attention ?? [])] as Record<string, unknown>[]).filter(
				item => Number(item.clsRank ?? 0) >= 3,
			);
	const rows: StartupAttentionRow[] = [];
	for (const item of ranked.slice(0, STARTUP_COLLECTION_CAP)) {
		const key = truncateUtf8(String(item.key ?? item.id ?? ""), fieldMax);
		if (!key) continue;
		const cls = truncateUtf8(String(item.cls ?? item.class ?? "attention"), fieldMax);
		const reason = truncateUtf8(String(item.reason ?? ""), fieldMax);
		const prRaw = item.pr != null ? String(item.pr) : "";
		const row: StartupAttentionRow = { key, cls, reason };
		if (prRaw) row.pr = truncateUtf8(prRaw, fieldMax);
		rows.push(row);
	}
	return { rows, total: ranked.length, omitted: Math.max(0, ranked.length - rows.length) };
}

function buildActiveWork(
	snapshot: FleetSnapshotLike,
	fieldMax: number,
): { rows: StartupActiveRow[]; total: number; omitted: number } {
	const seen = new Set<string>();
	const all: StartupActiveRow[] = [];
	for (const item of snapshot.tasks ?? []) {
		const task = item as Record<string, unknown>;
		const key = taskKey(task);
		if (!key || seen.has(key)) continue;
		// Canonical active state only - review-ready lives in attention.
		if (task.state !== "inflight") continue;
		seen.add(key);
		const row: StartupActiveRow = { key: truncateUtf8(key, fieldMax) };
		if (task.pr) row.pr = truncateUtf8(String(task.pr), fieldMax);
		all.push(row);
	}
	const rows = all.slice(0, STARTUP_COLLECTION_CAP);
	return { rows, total: all.length, omitted: Math.max(0, all.length - rows.length) };
}

function idleAgentCount(agents: unknown[] | undefined): number {
	let n = 0;
	for (const item of agents ?? []) {
		const a = item as Record<string, unknown>;
		const live = String(a.liveStatus ?? a.status ?? "").toLowerCase();
		if (!live || live === "idle" || live === "unknown") n += 1;
	}
	return n;
}

export function buildStartupDecisionBody(
	snapshot: FleetSnapshotLike,
	home: string,
	fleetStatus: number,
	opts: RenderStaticFleetOpts = {},
): StartupDecisionBody {
	const fieldMax = opts.fieldMaxBytes ?? STARTUP_FIELD_MAX_BYTES;
	const attention = buildAttention(snapshot, fieldMax);
	const activeWork = buildActiveWork(snapshot, fieldMax);
	const queued = (snapshot.tasks ?? []).filter(item => (item as Record<string, unknown>).state === "queued");
	const readyFromBacklog = loadReadyFromBacklog(home);
	const readyCount = opts.readyCount ?? readyFromBacklog.readyCount;
	const nextReadyRaw =
		opts.readyIds && opts.readyIds.length > 0
			? opts.readyIds[0]
			: readyFromBacklog.nextReady;
	const health = healthExceptions(snapshot, fleetStatus, fieldMax);
	const panes = snapshot.otherLivePanes?.length ?? 0;
	const idleAgents = idleAgentCount(snapshot.agents);

	return {
		schema: "fm-start-static/2",
		static_as_of: snapshot.generatedAt ?? new Date(0).toISOString(),
		active: {
			home: truncateUtf8(String(snapshot.home ?? home), fieldMax),
			role: "firstmate",
		},
		health: { state: health.state, exceptions: health.exceptions, omitted: health.omitted },
		attention: attention.rows,
		attention_total: attention.total,
		active_work: activeWork.rows,
		active_work_total: activeWork.total,
		queue: {
			queued_count: queued.length,
			ready_count: readyCount,
			next_ready: nextReadyRaw ? truncateUtf8(nextReadyRaw, fieldMax) : null,
		},
		omitted: {
			attention: attention.omitted,
			active_work: activeWork.omitted,
			queued: Math.max(0, queued.length - (nextReadyRaw ? 1 : 0)),
			panes,
			agents: idleAgents,
			notes: health.notesOmitted,
		},
		fleet_status: fleetStatus === 0 ? "ok" : `degraded-exit-${fleetStatus}`,
	};
}

function formatLocalTime(when: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	}).formatToParts(when);
	const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function asOfStamp(iso: string, fallback = new Date()): string {
	const d = new Date(iso);
	return formatLocalTime(Number.isNaN(d.getTime()) ? fallback : d);
}

function clsLabel(cls: string): string {
	const lower = cls.toLowerCase();
	if (lower.includes("review")) return "review-ready";
	if (lower.includes("block")) return "blocked";
	if (lower.includes("fail")) return "failed";
	if (lower.includes("decision") || lower.includes("needs")) return "needs-decision";
	return truncateUtf8(cls.toLowerCase().replace(/_/g, "-"), 24);
}

/** Format typed body as the visible operator summary (human + model). */
export function formatStartupSummary(body: StartupDecisionBody, now = new Date()): string {
	const lines: string[] = ["FIRSTMATE START"];
	lines.push(`Home: ${body.active.home}`);

	const healthState =
		body.fleet_status !== "ok" && body.health.state === "HEALTHY" ? "DEGRADED" : body.health.state;
	lines.push(`Health: ${healthState}`);
	for (const ex of body.health.exceptions) {
		lines.push(`  - ${ex}`);
	}
	if (body.health.omitted > 0) lines.push(`  - (+${body.health.omitted} more)`);

	lines.push("");
	if (body.attention_total === 0) {
		lines.push("Needs attention: none");
	} else {
		lines.push(`Needs attention: ${body.attention_total} total, showing ${body.attention.length}`);
		body.attention.forEach((row, i) => {
			const label = clsLabel(row.cls).padEnd(14);
			lines.push(`  ${i + 1}. ${label} ${row.key}`);
			if (row.reason) lines.push(`     ${row.reason}`);
			if (row.pr) lines.push(`     PR: ${row.pr}`);
		});
	}

	lines.push("");
	if (body.active_work_total === 0) {
		lines.push("Active work: none");
	} else {
		lines.push(`Active work: ${body.active_work_total} total, showing ${body.active_work.length}`);
		for (const row of body.active_work) {
			lines.push(`  - ${row.key}`);
		}
	}

	lines.push("");
	lines.push(`Queue: ${body.queue.queued_count} total, ${body.queue.ready_count} ready`);
	if (body.queue.next_ready) lines.push(`Next ready: ${body.queue.next_ready}`);

	const omittedParts: string[] = [];
	if (body.omitted.queued > 0) omittedParts.push(`${body.omitted.queued} queued`);
	if (body.omitted.attention > 0) omittedParts.push(`${body.omitted.attention} attention`);
	if (body.omitted.active_work > 0) omittedParts.push(`${body.omitted.active_work} active`);
	if (body.omitted.agents > 0) omittedParts.push(`${body.omitted.agents} idle agents`);
	if (body.omitted.panes > 0) omittedParts.push(`${body.omitted.panes} unrelated panes`);
	if (body.omitted.notes > 0) omittedParts.push(`${body.omitted.notes} notes`);
	if (omittedParts.length > 0) {
		lines.push("");
		lines.push(`Omitted: ${omittedParts.join(", ")}`);
	}
	lines.push("Refresh: fm fleet");
	lines.push(`As of: ${asOfStamp(body.static_as_of, now)}`);
	return `${lines.join("\n")}\n`;
}

function formatMinimalFallback(body: StartupDecisionBody, now = new Date()): string {
	return [
		"FIRSTMATE START",
		`Home: ${body.active.home}`,
		`Health: ${body.health.state}`,
		body.attention_total === 0
			? "Needs attention: none"
			: `Needs attention: ${body.attention_total} total, showing ${body.attention.length} (see fm fleet)`,
		body.active_work_total === 0
			? "Active work: none"
			: `Active work: ${body.active_work_total} total, showing ${body.active_work.length}`,
		`Queue: ${body.queue.queued_count} total, ${body.queue.ready_count} ready`,
		"Omitted: bound fallback",
		"Refresh: fm fleet",
		`As of: ${asOfStamp(body.static_as_of, now)}`,
		"",
	].join("\n");
}

export function enforceStartupByteBound(
	summary: string,
	body: StartupDecisionBody,
	maxBytes = STARTUP_SUMMARY_MAX_BYTES,
	now = new Date(),
): string {
	if (Buffer.byteLength(summary, "utf8") <= maxBytes) return summary;
	const minimal = formatMinimalFallback(body, now);
	if (Buffer.byteLength(minimal, "utf8") <= maxBytes) return minimal;
	return truncateUtf8(minimal, maxBytes);
}

/**
 * Build the visible startup static context: bounded multiline operator summary.
 * Not JSON/TOON - fm-start-static displays the string verbatim.
 */
export function renderStaticFleet(
	snapshot: FleetSnapshotLike,
	home: string,
	fleetStatus: number,
	opts: RenderStaticFleetOpts = {},
): string {
	const now = opts.now ?? new Date();
	const body = buildStartupDecisionBody(snapshot, home, fleetStatus, opts);
	const summary = formatStartupSummary(body, now);
	return enforceStartupByteBound(summary, body, opts.maxBytes ?? STARTUP_SUMMARY_MAX_BYTES, now);
}

export function mainHomeStructurally(home: string): boolean {
	return !existsSync(join(home, ".fm-secondmate-home"));
}

/** Hard ceiling for the normalized `data/cap.md` admission payload (UTF-8 bytes). */
export const CAP_CONTEXT_MAX_BYTES = 3010;

/** Successful-start stub only; fault procedure bodies stay demand-loaded. */
export const STARTUP_PRELOAD_STUB =
	"`fm start` completed deterministic startup checks before launch.\n" +
	"The startup fleet summary is a static snapshot; use `fm fleet` for current operational state.\n";

export class CapContextOversizeError extends Error {
	readonly path: string;
	readonly actualBytes: number;
	readonly maxBytes: number;

	constructor(path: string, actualBytes: number, maxBytes: number) {
		super(`data/cap.md exceeds cap context ceiling: ${actualBytes} > ${maxBytes} bytes (${path})`);
		this.name = "CapContextOversizeError";
		this.path = path;
		this.actualBytes = actualBytes;
		this.maxBytes = maxBytes;
	}
}

/** Normalize trailing newlines to exactly one; do not trim leading or interior whitespace. */
export function normalizeCapPayload(raw: string): string {
	return raw.replace(/\n+$/u, "") + "\n";
}

/**
 * Admit home-local `data/cap.md` only. Never falls back to a tracked/repo copy.
 * Missing file → null. Oversize after normalization → CapContextOversizeError.
 * Returns the normalized admitted payload exactly once (file heading preserved).
 */
export function capContextBlock(home: string, maxBytes = CAP_CONTEXT_MAX_BYTES): string | null {
	const path = join(home, "data", "cap.md");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const admitted = normalizeCapPayload(raw);
	const actualBytes = Buffer.byteLength(admitted, "utf8");
	if (actualBytes > maxBytes) throw new CapContextOversizeError(path, actualBytes, maxBytes);
	return admitted;
}

/**
 * Main-firstmate system-prompt preload: stub + optional bounded cap preferences.
 * Preserves the cap payload's terminal newline in the join:
 * stub_without_trailing_newlines + "\\n\\n" + normalized_cap.
 */
export function mainPreloadBlock(home: string, maxBytes = CAP_CONTEXT_MAX_BYTES): string {
	const stub = STARTUP_PRELOAD_STUB.replace(/\n+$/u, "");
	const cap = capContextBlock(home, maxBytes);
	if (cap === null) return stub;
	return `${stub}\n\n${cap}`;
}

export async function runStartupContext(options: StartupContextOptions): Promise<StartupContextOutcome> {
	const diagnostics: CommandResult[] = [];
	const run = (args: string[]): CommandResult => {
		const result = runFm(options, args);
		diagnostics.push(result);
		return result;
	};

	const bootstrap = run(["bootstrap"]);
	const blockers = blockingBootstrapLines(bootstrap.stdout);
	if (bootstrap.status !== 0 || blockers.length > 0) {
		return { ok: false, failure: failure("bootstrap", bootstrap, blockers.length > 0 ? `blocking bootstrap diagnostics: ${blockers.join("; ")}` : "bootstrap command failed"), diagnostics };
	}

	let identity = run(["identity-migrate", "check"]);
	if (identity.status !== 0) {
		const reasons = unresolvedIdentityReasons(identity.stdout);
		if (reasons.length === 0 || reasons.some(reason => reason !== "unversioned" && reason !== "no-identity")) {
			return { ok: false, failure: failure("identity-migrate check", identity, "identity check has unresolved homes that cannot be safely migrated"), diagnostics };
		}
		const migrate = run(["identity-migrate", "migrate"]);
		if (migrate.status !== 0) return { ok: false, failure: failure("identity-migrate migrate", migrate, "identity migration failed"), diagnostics };
		identity = run(["identity-migrate", "check"]);
		if (identity.status !== 0) return { ok: false, failure: failure("identity-migrate recheck", identity, "identity check still unresolved after migration"), diagnostics };
	}

	let home = run(["home", "check", "--all"]);
	if (home.status !== 0) {
		const repair = run(["home", "repair", "--all"]);
		if (repair.status !== 0) return { ok: false, failure: failure("home repair --all", repair, "home repair failed after observed drift"), diagnostics };
		home = run(["home", "check", "--all"]);
		if (home.status !== 0) return { ok: false, failure: failure("home check --all recheck", home, "home check still reports drift after repair"), diagnostics };
	}

	const lavish = run(["lavish-open", "--recover"]);
	if (lavish.status !== 0) return { ok: false, failure: failure("lavish-open --recover", lavish, "lavish recovery failed"), diagnostics };

	const fleet = run(["fleet", "snapshot", "--json", "--starting-main"]);
	const snapshot = parseFleetSnapshot(fleet);
	if (!snapshot) return { ok: false, failure: failure("fleet snapshot --json --starting-main", fleet, "fleet snapshot did not return parseable JSON"), diagnostics };

	return {
		ok: true,
		context: {
			staticFleet: renderStaticFleet(snapshot, options.home, fleet.status),
			fleetStatus: fleet.status,
			diagnostics,
		},
	};
}
