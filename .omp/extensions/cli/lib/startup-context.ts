// Startup static fleet context: typed decision body → bounded operator summary.
// Efficiency: eliminate O(fleet history) startup growth; hard UTF-8 ceiling 8000 bytes.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BacklogStore, readyTasks } from "./backlog-store";
import { harnessPid, lockSnapshot, resolveLockPaths } from "./session-lock";

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

export type StartupRole = "firstmate" | "sub";

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
	active: { home: string; role: StartupRole; role_note?: string };
	health: { state: string; exceptions: string[]; omitted: number };
	attention: StartupAttentionRow[];
	active_work: StartupActiveRow[];
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
	role?: StartupRole;
	roleNote?: string;
	/** Override ready list for tests; default loads home backlog via readyTasks. */
	readyIds?: string[];
	readyCount?: number;
	/** Injected ceiling for fallback tests. */
	maxBytes?: number;
	fieldMaxBytes?: number;
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
	const budget = Math.max(0, maxBytes - ellipsisBytes);
	let end = budget;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
	return `${buf.subarray(0, end).toString("utf8")}${ellipsis}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function taskKey(task: Record<string, unknown>): string {
	return String(task.key ?? task.id ?? "");
}

export function resolveStartupRole(): { role: StartupRole; note?: string } {
	const snap = lockSnapshot(resolveLockPaths());
	if (snap.state !== "live") return { role: "firstmate" };
	const self = harnessPid() ?? process.pid;
	if (snap.pid === self || snap.pid === process.pid) return { role: "firstmate" };
	return { role: "sub", note: "another firstmate is active" };
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

function healthExceptions(snapshot: FleetSnapshotLike, fleetStatus: number, fieldMax: number): { state: string; exceptions: string[]; omitted: number } {
	const health = asRecord(snapshot.health);
	const topology = asRecord(snapshot.topology);
	const identity = asRecord(snapshot.identity);
	const activation = asRecord(snapshot.activation);
	const state = String(health.state ?? (fleetStatus === 0 ? "healthy" : "degraded")).toUpperCase();
	const raw: string[] = [];
	if (fleetStatus !== 0) raw.push(`fleet snapshot exit ${fleetStatus}`);
	const missingHomes = Number(health.missingHomes ?? 0);
	if (missingHomes > 0) raw.push(`${missingHomes} secondmate home${missingHomes === 1 ? "" : "s"} missing`);
	if (String(health.herdr ?? "") === "unavailable") raw.push("herdr unavailable");
	if (String(topology.state ?? "") === "incomplete") {
		raw.push(truncateUtf8(String(topology.reason || "topology incomplete"), fieldMax));
	}
	if (String(identity.state ?? "") === "mismatch") raw.push("identity mismatch");
	if (String(activation.state ?? "") === "stale") raw.push("activation stale");
	const capped = raw.slice(0, STARTUP_COLLECTION_CAP).map(line => truncateUtf8(line, fieldMax));
	return { state, exceptions: capped, omitted: Math.max(0, raw.length - capped.length) };
}

function buildAttention(snapshot: FleetSnapshotLike, fieldMax: number): { rows: StartupAttentionRow[]; omitted: number } {
	// Preserve authoritative fleet attention order; do not re-rank.
	const source = [...(snapshot.attention ?? snapshot.pending ?? [])] as Record<string, unknown>[];
	const rows: StartupAttentionRow[] = [];
	for (const item of source.slice(0, STARTUP_COLLECTION_CAP)) {
		const key = truncateUtf8(String(item.key ?? item.id ?? ""), fieldMax);
		if (!key) continue;
		const cls = truncateUtf8(String(item.cls ?? item.class ?? "attention"), fieldMax);
		const reason = truncateUtf8(String(item.reason ?? ""), fieldMax);
		const prRaw = item.pr != null ? String(item.pr) : "";
		const row: StartupAttentionRow = { key, cls, reason };
		if (prRaw) row.pr = truncateUtf8(prRaw, fieldMax);
		rows.push(row);
	}
	return { rows, omitted: Math.max(0, source.length - rows.length) };
}

function buildActiveWork(snapshot: FleetSnapshotLike, fieldMax: number): { rows: StartupActiveRow[]; omitted: number } {
	const seen = new Set<string>();
	const all: StartupActiveRow[] = [];
	for (const item of snapshot.tasks ?? []) {
		const task = item as Record<string, unknown>;
		const key = taskKey(task);
		if (!key || seen.has(key)) continue;
		const inflight = task.state === "inflight";
		const reviewReady = Boolean(task.pr) && task.merged !== true;
		if (!inflight && !reviewReady) continue;
		seen.add(key);
		const row: StartupActiveRow = { key: truncateUtf8(key, fieldMax) };
		if (task.pr) row.pr = truncateUtf8(String(task.pr), fieldMax);
		all.push(row);
	}
	const rows = all.slice(0, STARTUP_COLLECTION_CAP);
	return { rows, omitted: Math.max(0, all.length - rows.length) };
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
	const roleInfo = opts.role
		? { role: opts.role, note: opts.roleNote }
		: resolveStartupRole();
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
	const notes = snapshot.notes?.length ?? 0;
	const idleAgents = idleAgentCount(snapshot.agents);

	return {
		schema: "fm-start-static/2",
		static_as_of: snapshot.generatedAt ?? new Date(0).toISOString(),
		active: {
			home: String(snapshot.home ?? home),
			role: roleInfo.role,
			...(roleInfo.note ? { role_note: roleInfo.note } : {}),
		},
		health,
		attention: attention.rows,
		active_work: activeWork.rows,
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
			notes,
		},
		fleet_status: fleetStatus === 0 ? "ok" : `degraded-exit-${fleetStatus}`,
	};
}

function formatAsOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${day} ${hh}:${mm} UTC`;
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
export function formatStartupSummary(body: StartupDecisionBody): string {
	const lines: string[] = ["FIRSTMATE START"];
	lines.push(`As of: ${formatAsOf(body.static_as_of)}`);
	if (body.active.role === "sub") {
		lines.push(`Role: sub - ${body.active.role_note ?? "another firstmate is active"}`);
	} else {
		lines.push("Role: firstmate");
	}

	const healthState =
		body.fleet_status !== "ok" && body.health.state === "HEALTHY" ? "DEGRADED" : body.health.state;
	lines.push(`Health: ${healthState}`);
	for (const ex of body.health.exceptions) {
		lines.push(`  - ${ex}`);
	}
	if (body.health.omitted > 0) lines.push(`  - (+${body.health.omitted} more)`);

	lines.push("");
	lines.push(`Needs attention: ${body.attention.length}`);
	body.attention.forEach((row, i) => {
		const label = clsLabel(row.cls).padEnd(14);
		lines.push(`  ${i + 1}. ${label} ${row.key}`);
		if (row.pr) lines.push(`     PR: ${row.pr}`);
		else if (row.reason) lines.push(`     ${row.reason}`);
	});

	lines.push("");
	lines.push(`Active work: ${body.active_work.length}`);
	for (const row of body.active_work) {
		lines.push(`  - ${row.key}`);
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
	return `${lines.join("\n")}\n`;
}

function formatMinimalFallback(body: StartupDecisionBody): string {
	return [
		"FIRSTMATE START",
		`As of: ${formatAsOf(body.static_as_of)}`,
		`Role: ${body.active.role}${body.active.role === "sub" ? " - another firstmate is active" : ""}`,
		`Health: ${body.health.state}`,
		`Needs attention: ${body.attention.length} (see fm fleet)`,
		`Active work: ${body.active_work.length}`,
		`Queue: ${body.queue.queued_count} total, ${body.queue.ready_count} ready`,
		"Omitted: bound fallback",
		"Refresh: fm fleet",
		"",
	].join("\n");
}

export function enforceStartupByteBound(summary: string, body: StartupDecisionBody, maxBytes = STARTUP_SUMMARY_MAX_BYTES): string {
	if (Buffer.byteLength(summary, "utf8") <= maxBytes) return summary;
	const minimal = formatMinimalFallback(body);
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
	const body = buildStartupDecisionBody(snapshot, home, fleetStatus, opts);
	const summary = formatStartupSummary(body);
	return enforceStartupByteBound(summary, body, opts.maxBytes ?? STARTUP_SUMMARY_MAX_BYTES);
}

export function mainHomeStructurally(home: string): boolean {
	return !existsSync(join(home, ".fm-secondmate-home"));
}

export function registryBlock(home: string, repoRoot: string): string[] {
	const registries: string[] = [];
	for (const rel of ["data/projects.md", "data/secondmates.md", "data/cap.md"]) {
		try {
			registries.push(`## ${rel}\n\n${readFileSync(join(home, rel), "utf8").trim()}`);
		} catch {
			try {
				registries.push(`## ${rel}\n\n${readFileSync(join(repoRoot, rel), "utf8").trim()}`);
			} catch {
				// Local-layer file absent.
			}
		}
	}
	return registries;
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

	const fleet = run(["fleet", "snapshot", "--json"]);
	const snapshot = parseFleetSnapshot(fleet);
	if (!snapshot) return { ok: false, failure: failure("fleet snapshot --json", fleet, "fleet snapshot did not return parseable JSON"), diagnostics };

	return {
		ok: true,
		context: {
			staticFleet: renderStaticFleet(snapshot, options.home, fleet.status),
			fleetStatus: fleet.status,
			diagnostics,
		},
	};
}
