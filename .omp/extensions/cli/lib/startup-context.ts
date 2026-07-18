import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FM_START_STATIC_CONTEXT_ENV = "FM_START_STATIC_CONTEXT";

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

interface FleetSnapshotLike {
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

function sortByJson<T>(items: T[] | undefined): T[] {
	return [...(items ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compactTaskBuckets(tasks: unknown[] | undefined): Record<string, unknown[]> {
	const buckets: Record<string, unknown[]> = { inflight: [], queued: [], review_ready: [] };
	for (const item of tasks ?? []) {
		const task = item as Record<string, unknown>;
		const row = {
			key: task.key ?? task.id,
			owner: task.owner,
			project: task.project,
			workerState: task.workerState,
			note: task.note,
			pr: task.pr,
		};
		if (task.state === "inflight") buckets.inflight.push(row);
		else if (task.state === "queued") buckets.queued.push(row);
		if (task.pr && task.merged !== true) buckets.review_ready.push(row);
	}
	return {
		inflight: sortByJson(buckets.inflight),
		queued: sortByJson(buckets.queued),
		review_ready: sortByJson(buckets.review_ready),
	};
}

function compactAgents(agents: unknown[] | undefined): unknown[] {
	return sortByJson((agents ?? []).map(item => {
		const agent = item as Record<string, unknown>;
		return {
			key: agent.key ?? agent.id,
			owner: agent.owner,
			kind: agent.kind,
			status: agent.status,
			liveStatus: agent.liveStatus,
			pane: agent.pane,
			project: agent.project,
			topology: agent.topology,
		};
	}));
}

function compactAttention(snapshot: FleetSnapshotLike): unknown[] {
	return sortByJson((snapshot.attention ?? snapshot.pending ?? []).map(item => {
		const pending = item as Record<string, unknown>;
		return {
			key: pending.key ?? pending.id,
			class: pending.cls,
			home: pending.home,
			reason: pending.reason,
		};
	}));
}

export function renderStaticFleet(snapshot: FleetSnapshotLike, home: string, fleetStatus: number): string {
	const generatedAt = snapshot.generatedAt ?? new Date(0).toISOString();
	const payload = {
		schema: "fm-start-static/1",
		provenance: {
			command: "fm start preflight",
			snapshot_command: "fm fleet snapshot --json",
			fleet_status: fleetStatus === 0 ? "ok" : `degraded-exit-${fleetStatus}`,
		},
		static_as_of: generatedAt,
		active: {
			home: snapshot.home ?? home,
			role: "firstmate",
		},
		health: snapshot.health ?? null,
		activation: snapshot.activation ?? null,
		identity: snapshot.identity ?? null,
		topology: snapshot.topology ?? null,
		mates: sortByJson(snapshot.mates),
		live_agents: compactAgents(snapshot.agents),
		attention: compactAttention(snapshot),
		tasks: compactTaskBuckets(snapshot.tasks),
		live_panes: sortByJson(snapshot.otherLivePanes),
		known_blockers: compactAttention(snapshot).filter(item => String((item as Record<string, unknown>).class ?? "").includes("BLOCK")),
		notes: sortByJson(snapshot.notes),
	};
	return JSON.stringify(payload, null, 2);
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

	return { ok: true, context: { staticFleet: renderStaticFleet(snapshot, options.home, fleet.status), fleetStatus: fleet.status, diagnostics } };
}
