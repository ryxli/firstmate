// Canonical typed FleetSnapshot collector shared by /bridge, AXI, and visual views.
//
// The default read is deliberately bounded: fleet files plus one `herdr pane list`
// inventory. It never calls GitHub or OMP statistics. Metrics opt in to the one
// additional `omp stats --json` read and reuse the task inventory for all counts.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	basename,
	buildSnapshot,
	canonicalTaskKey,
	normalizeHomePath,
	resolveOwnerByHome,
	type AgentRow,
	type ActivationSummary,
	type BacklogSection,
	type BridgeView,
	type FleetMetrics,
	type FleetSnapshot,
	type IdentitySummary,
	type HerdrAgent,
	type ParsedHome,
	type PendingItem,
	type RawHome,
	type TaskRow,
	type Topology,
	type TopologySummary,
	parseHome,
	parseSecondmateHomes,
	render,
} from "./fleet";

export interface CollectOptions {
	includeMetrics?: boolean;
	statsFile?: string;
	maxLivePanes?: number;
}

const DEFAULT_MAX_LIVE_PANES = 200;

function readFileOrNull(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

function objectRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function isMainHome(dir: string): boolean {
	return existsSync(join(dir, "sbin", "fm-spawn.sh")) && !existsSync(join(dir, ".fm-secondmate-home"));
}

/** Resolve the main home from explicit env, cwd ancestry, then known clones. */
export function resolveMainHome(cwd?: string): string | null {
	const env = process.env.FM_HOME?.trim() || process.env.FIRSTMATE_HOME?.trim();
	if (env && isMainHome(env)) return env;
	let dir = cwd && cwd.length > 0 ? cwd : process.cwd();
	for (let i = 0; i < 64; i++) {
		if (isMainHome(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const candidate of [join(homedir(), "code", "harness", "firstmate"), join(homedir(), "code", "firstmate")]) {
		if (isMainHome(candidate)) return candidate;
	}
	return null;
}

/** Read one home's backlog, metadata, and matching status files. */
export function readRawHome(homePath: string, isMain: boolean): RawHome {
	const backlogText = readFileOrNull(join(homePath, "data", "backlog.md"));
	const stateDir = join(homePath, "state");
	const metas: { id: string; text: string }[] = [];
	const statuses: Record<string, string> = {};
	let entries: string[] = [];
	try {
		entries = existsSync(stateDir) ? readdirSync(stateDir) : [];
	} catch {
		entries = [];
	}
	for (const name of entries) {
		if (!name.endsWith(".meta")) continue;
		const id = name.slice(0, -5);
		const text = readFileOrNull(join(stateDir, name));
		if (text === null) continue;
		metas.push({ id, text });
		const status = readFileOrNull(join(stateDir, `${id}.status`));
		if (status !== null) statuses[id] = status;
	}
	return { path: homePath, isMain, backlogText, metas, statuses };
}

interface Spawned {
	ok: boolean;
	stdout: string;
}
/** Run one read-only command with a hard timeout. */
function run(argv: string[], timeoutMs: number): Spawned {
	try {
		const result = spawnSync(argv[0], argv.slice(1), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		});
		return { ok: result.status === 0, stdout: result.stdout ?? "" };
	} catch {
		return { ok: false, stdout: "" };
	}
}

function paneFromRecord(value: unknown): HerdrAgent | null {
	const record = objectRecord(value);
	if (!record) return null;
	const text = (key: string): string | undefined => stringValue(record[key]);
	const legacy = objectRecord(record.agent_session);
	const legacyValue = stringValue(legacy?.value);
	const legacyKind = stringValue(legacy?.kind);
	const legacyPath = legacyValue && (legacyKind === "path" || legacyKind === "session_path" || legacyKind === "file" || (!legacyKind && legacyValue.startsWith("/"))) ? legacyValue : undefined;
	const legacyId = legacyValue && (legacyKind === "id" || legacyKind === "session_id") ? legacyValue : undefined;
	return {
		pane_id: text("pane_id") ?? text("id"),
		agent_status: text("agent_status") ?? text("status"),
		name: text("name") ?? text("display_agent"),
		cwd: text("cwd") ?? text("foreground_cwd"),
		workspace_id: text("workspace_id"),
		workspace_label: text("workspace_label"),
		tab_id: text("tab_id"),
		tab_label: text("tab_label"),
		label: text("label"),
		agent: text("agent"),
		agent_session_path: text("agent_session_path") ?? legacyPath,
		agent_session_id: text("agent_session_id") ?? legacyId,
		agent_session: record.agent_session,
	};
}

function parsePaneInventory(text: string, cap: number): { panes: HerdrAgent[]; ok: boolean } {
	const root = objectRecord(parseJson(text));
	const result = objectRecord(root?.result);
	const raw = arrayValue(result?.panes ?? root?.panes ?? root?.agents);
	const panes = raw.map(paneFromRecord).filter((pane): pane is HerdrAgent => pane !== null).slice(0, cap);
	return { panes, ok: root !== null && (Array.isArray(result?.panes) || Array.isArray(root?.panes) || Array.isArray(root?.agents)) };
}

async function fetchPaneInventory(cap: number): Promise<{ panes: HerdrAgent[]; ok: boolean }> {
	const fixture = process.env.FM_FLEET_PANES_FILE;
	if (fixture) return parsePaneInventory(readFileOrNull(fixture) ?? "", cap);
	const result = run(["herdr", "pane", "list"], 5000);
	if (!result.ok) return { panes: [], ok: false };
	return parsePaneInventory(result.stdout, cap);
}

function topologyForAgent(home: ParsedHome, meta: { pane?: string; raw: Record<string, string> }, pane: HerdrAgent | undefined): Topology {
	return {
		home: home.path,
		pane: meta.pane,
		tab: pane?.tab_id ?? meta.raw.tab,
		tabLabel: pane?.tab_label,
		workspace: pane?.workspace_id ?? meta.raw.workspace,
		workspaceLabel: pane?.workspace_label,
		cwd: pane?.cwd,
		agentStatus: pane?.agent_status,
		degraded: meta.pane && pane?.pane_id ? undefined : meta.pane ? "missing-pane" : "state-only",
	};
}

function buildAgents(homes: ParsedHome[], panes: HerdrAgent[], owners: Map<string, string>): AgentRow[] {
	const byPane = new Map<string, HerdrAgent>();
	for (const pane of panes) if (pane.pane_id) byPane.set(pane.pane_id, pane);
	const agents: AgentRow[] = [];
	for (const home of homes) {
		const owner = owners.get(normalizeHomePath(home.path)) ?? home.label;
		if (home.isMain) {
			const supervisor = panes.find(pane => normalizeHomePath(pane.cwd) === normalizeHomePath(home.path));
			if (supervisor) {
				agents.push({
					key: canonicalTaskKey(owner, "supervisor"),
					id: "supervisor",
					owner,
					kind: "supervisor",
					status: supervisor.agent_status,
					statusText: "",
					pane: supervisor.pane_id,
					home: home.path,
					topology: { home: home.path, pane: supervisor.pane_id, cwd: supervisor.cwd, workspace: supervisor.workspace_id, workspaceLabel: supervisor.workspace_label, tab: supervisor.tab_id, tabLabel: supervisor.tab_label, agentStatus: supervisor.agent_status },
				});
			}
		}
		for (const agent of home.agents) {
			const pane = agent.meta.pane ? byPane.get(agent.meta.pane) : undefined;
			agents.push({
				key: canonicalTaskKey(owner, agent.id),
				id: agent.id,
				owner,
				kind: agent.meta.kind,
				status: agent.status?.state ?? pane?.agent_status,
				statusText: agent.status?.text,
				pane: agent.meta.pane,
				worker: agent.meta.raw.worker,
				domain: agent.meta.raw.domain,
				project: agent.meta.raw.project,
				mode: agent.meta.mode,
				home: home.path,
				topology: topologyForAgent(home, agent.meta, pane),
			});
		}
	}
	return agents.sort((a, b) => a.key.localeCompare(b.key));
}


function attentionFor(agents: AgentRow[]): PendingItem[] {
	const rows: PendingItem[] = [];
	for (const agent of agents) {
		const state = (agent.status ?? "").toLowerCase();
		const text = (agent.statusText ?? "").toLowerCase();
		let clsRank = 0;
		let cls = "UNKNOWN";
		if (agent.kind === "secondmate" && !["failed", "needs-decision", "blocked"].includes(state)) continue;
		if (["failed", "needs-decision", "blocked"].includes(state)) {
			clsRank = 4;
			cls = "CAPTAIN-BLOCKED";
		} else if (state === "done" || text.includes("ready in branch") || text.includes("checks green") || text.includes("pr ready")) {
			clsRank = 3;
			cls = "REVIEW-READY";
		} else if (state === "working") {
			clsRank = 2;
			cls = "IN-FLIGHT";
		}
		if (clsRank < 3) continue;
		const detail = agent.statusText ? ` - ${agent.statusText}` : "";
		rows.push({ key: agent.key, cls, clsRank, home: basename(agent.home), id: agent.id, reason: `${cls}${detail}` });
	}
	return rows.sort((a, b) => b.clsRank - a.clsRank || (a.key ?? "").localeCompare(b.key ?? ""));
}
function paneForHome(home: string, homes: ParsedHome[], panes: HerdrAgent[]): HerdrAgent | undefined {
	const direct = panes.find(candidate => normalizeHomePath(candidate.cwd) === normalizeHomePath(home));
	if (direct) return direct;
	const link = homes.flatMap(parent => parent.agents).find(agent => agent.meta.kind === "secondmate" && agent.meta.home && normalizeHomePath(agent.meta.home) === normalizeHomePath(home) && agent.meta.pane);
	return link?.meta.pane ? panes.find(candidate => candidate.pane_id === link.meta.pane) : undefined;
}

function topologyForFleet(homePaths: string[], panes: HerdrAgent[], homes: ParsedHome[], main: string | null, herdrOk: boolean): TopologySummary {
	const summary: TopologySummary = { state: "unknown", present: 0, missing: 0, incomplete: 0, reason: "herdr-unavailable" };
	for (const home of homePaths) {
		const pane = paneForHome(home, homes, panes);
		if (!pane) summary.missing += 1;
		else if (pane.agent !== "omp") summary.incomplete += 1;
		else summary.present += 1;
	}
	if (!herdrOk) return summary;
	if (!main) {
		summary.reason = "missing-main-home";
		return summary;
	}
	if (!paneForHome(main, homes, panes)) {
		summary.reason = "missing-current-pane";
		return summary;
	}
	if (summary.incomplete > 0) {
		summary.state = "incomplete";
		summary.reason = "expected-pane-not-omp";
	} else if (summary.missing > 0) {
		summary.state = "incomplete";
		summary.reason = "expected-pane-unavailable";
	} else {
		summary.state = "complete";
		summary.reason = "expected-omp-panes-present";
	}
	return summary;
}


function activationFor(homePaths: string[], panes: HerdrAgent[], homes: ParsedHome[], main: string | null): { activation: ActivationSummary; identity: IdentitySummary } {
	const activation: ActivationSummary = { state: "unknown", total: homePaths.length, fresh: 0, stale: 0, unknown: 0 };
	const identity: IdentitySummary = { state: "unknown", bound: 0, mismatch: 0, unknown: 0 };
	for (const home of homePaths) {
		const pane = paneForHome(home, homes, panes);
		let activationState: "fresh" | "stale" | "unknown" = "unknown";
		let identityState: "bound" | "mismatch" | "unknown" = "unknown";
		const receiptRecord = objectRecord(parseJson(readFileOrNull(join(home, "state", "activation-receipt.json")) ?? ""));
		if (pane && receiptRecord?.schema === "firstmate.activation-receipt/v1") {
			const current = manifestHash(home);
			const manifest = stringValue(receiptRecord.manifest_sha256);
			const sessionPath = pane.agent_session_path;
			const sessionId = pane.agent_session_id;
			const receiptPath = stringValue(receiptRecord.session_path);
			const receiptId = stringValue(receiptRecord.session_id);
			if (sessionPath || sessionId) {
				const paneMatches = !receiptRecord.pane_id || receiptRecord.pane_id === pane.pane_id;
				const pathMatches = !sessionPath || sessionPath === receiptPath;
				const idMatches = !sessionId || sessionId === receiptId;
				identityState = paneMatches && pathMatches && idMatches ? "bound" : "mismatch";
			}
			if (current && manifest && current === manifest) activationState = "fresh";
			else if (current && manifest) activationState = "stale";
		}
		activation[activationState] += 1;
		identity[identityState] += 1;
	}
	if (activation.total === 0 || !main) activation.state = "unknown";
	else if (activation.stale > 0) activation.state = "stale";
	else if (activation.unknown > 0) activation.state = "unknown";
	else activation.state = "fresh";
	if (identity.bound + identity.mismatch + identity.unknown === 0 || !main) identity.state = "unknown";
	else if (identity.mismatch > 0) identity.state = "mismatch";
	else if (identity.unknown > 0) identity.state = "unknown";
	else identity.state = "bound";
	return { activation, identity };
}
function manifestHash(home: string): string | undefined {
	const paths: string[] = ["AGENTS.md"];
	const extensions = join(home, ".omp", "extensions");
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry);
			try {
				readFileSync(path);
				paths.push(path.slice(home.length + 1));
			} catch {
				walk(path);
			}
		}
	};
	walk(extensions);
	const entries: { path: string; sha256: string }[] = [];
	for (const relativePath of paths.sort()) {
		try {
			const digest = createHash("sha256").update(readFileSync(join(home, relativePath))).digest("hex");
			entries.push({ path: relativePath, sha256: digest });
		} catch {
			return undefined;
		}
	}
	if (!entries.length || entries.length !== paths.length) return undefined;
	const hash = createHash("sha256");
	for (const entry of entries) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.sha256);
		hash.update("\0");
	}
	return hash.digest("hex");
}

function taskCounts(tasks: TaskRow[]): { landed: number; inflight: number; queued: number } {
	return {
		landed: tasks.filter(task => task.state === "done").length,
		inflight: tasks.filter(task => task.state === "inflight").length,
		queued: tasks.filter(task => task.state === "queued").length,
	};
}

function folderOf(path: string, homeDir: string): string {
	return (homeDir && path.startsWith(homeDir) ? path.slice(homeDir.length) : path).replace(/\//g, "-");
}

function workspaceName(home: string): string {
	return readFileOrNull(join(home, "config", "workspace"))?.trim() || process.env.HOSTNAME || "unknown";
}

async function collectMetrics(snapshot: FleetSnapshot, home: string, statsFile?: string): Promise<FleetMetrics> {
	const statsText = statsFile ? readFileOrNull(statsFile) ?? "" : (await run(["omp", "stats", "--json"], 10000)).stdout;
	const root = objectRecord(parseJson(statsText)) ?? {};
	const folders = arrayValue(root.byFolder).map(objectRecord).filter((value): value is Record<string, unknown> => value !== null);
	const homeDir = process.env.HOME ?? homedir();
	const worktreeBase = process.env.FM_WORKTREE_BASE ?? join(home, "worktrees");
	const smFolders = new Set((snapshot.homePaths ?? []).filter(path => path !== home).map(path => folderOf(path, homeDir)));
	const homeFolder = folderOf(home, homeDir);
	const worktreeFolder = folderOf(worktreeBase, homeDir);
	const classify = (folder: string): string => {
		if (folder === homeFolder) return "supervisor";
		if (smFolders.has(folder) || folder.includes("-fm-sm-")) return "secondmate";
		if (["fm-demo", "fm-bench", "fmplain"].some(token => folder.includes(token))) return "ephemeral";
		if (worktreeFolder && folder.includes(worktreeFolder)) return "crew";
		return "other";
	};
	const byFolder = folders.map(folder => {
		const name = stringValue(folder.folder) ?? "";
		return {
			folder: name,
			role: classify(name),
			cost_usd: Number(numberValue(folder.totalCost).toFixed(4)),
			tokens: numberValue(folder.totalInputTokens) + numberValue(folder.totalOutputTokens),
			cache_hit_rate: numberValue(folder.cacheRate),
			error_rate: numberValue(folder.errorRate),
			requests: numberValue(folder.totalRequests),
		};
	});
	const productive = new Set(["supervisor", "secondmate", "crew"]);
	const agg = (roles: Set<string>) => {
		const selected = byFolder.filter(folder => roles.has(folder.role));
		const cost = selected.reduce((sum, folder) => sum + folder.cost_usd, 0);
		const tokens = selected.reduce((sum, folder) => sum + folder.tokens, 0);
		const requests = selected.reduce((sum, folder) => sum + folder.requests, 0);
		const input = selected.reduce((sum, folder) => sum + folder.tokens, 0);
		return { cost, tokens, requests, cache_hit_rate: input ? selected.reduce((sum, folder) => sum + folder.cache_hit_rate * folder.tokens, 0) / input : 0, error_rate: requests ? selected.reduce((sum, folder) => sum + folder.error_rate * folder.requests, 0) / requests : 0 };
	};
	const prod = agg(productive);
	const supervisor = agg(new Set(["supervisor"]));
	const counts = taskCounts(snapshot.tasks);
	const byRole: Record<string, number> = {};
	for (const role of ["supervisor", "secondmate", "crew", "ephemeral", "other"]) byRole[role] = byFolder.filter(folder => folder.role === role).reduce((sum, folder) => sum + folder.cost_usd, 0);
	return {
		schema: "fm-kpi/1",
		workspace: workspaceName(home),
		generated: snapshot.generatedAt,
		source: "omp stats --json + FleetSnapshot task inventory",
		window: "cumulative (omp stats lifetime)",
		cost_usd_productive: Number(prod.cost.toFixed(4)),
		tokens_productive: prod.tokens,
		cache_hit_rate: Number(prod.cache_hit_rate.toFixed(4)),
		error_rate: Number(prod.error_rate.toFixed(4)),
		supervisor_overhead_cost: prod.cost ? Number((supervisor.cost / prod.cost).toFixed(4)) : null,
		supervisor_overhead_tokens: prod.tokens ? Number((supervisor.tokens / prod.tokens).toFixed(4)) : null,
		tasks_landed: counts.landed,
		tasks_in_flight: counts.inflight,
		tasks_queued: counts.queued,
		cost_per_landed_usd: counts.landed ? Number((prod.cost / counts.landed).toFixed(4)) : null,
		tokens_per_landed: counts.landed ? Math.round(prod.tokens / counts.landed) : null,
		by_role: byRole,
		by_folder: byFolder,
		by_agent_type: arrayValue(root.byAgentType).map(objectRecord).filter((value): value is Record<string, unknown> => value !== null),
		gaps: ["exact per-task cost (needs task-to-folder-to-landed join)", "live escalation precision/recall (needs an escalation log)", "cycle time + autonomous task horizon (needs dispatch/landed timestamps)"],
	};
}

/** Read one complete fleet snapshot. Default mode never calls GitHub or OMP stats. */
export async function collectSnapshot(now = new Date().toISOString(), cwd?: string, options: CollectOptions = {}): Promise<FleetSnapshot> {
	const notes: string[] = [];
	const main = resolveMainHome(cwd);
	const rawHomes: RawHome[] = [];
	const homePaths: string[] = [];
	if (!main) {
		notes.push("could not locate the firstmate home");
	} else {
		const queue: Array<{ path: string; isMain: boolean }> = [{ path: main, isMain: true }];
		const seenHomes = new Set<string>();
		while (queue.length) {
			const current = queue.shift()!;
			const normalized = normalizeHomePath(current.path);
			if (seenHomes.has(normalized)) continue;
			seenHomes.add(normalized);
			homePaths.push(current.path);
			if (!existsSync(current.path)) {
				notes.push(`secondmate home not found: ${current.path}`);
				continue;
			}
			rawHomes.push(readRawHome(current.path, current.isMain));
			const secondmatesText = readFileOrNull(join(current.path, "data", "secondmates.md"));
			if (!secondmatesText) {
				if (current.isMain) notes.push("data/secondmates.md missing - only the main home is shown");
				continue;
			}
			for (const childPath of parseSecondmateHomes(secondmatesText)) {
				if (seenHomes.has(normalizeHomePath(childPath))) continue;
				if (existsSync(childPath)) queue.push({ path: childPath, isMain: false });
				else {
					seenHomes.add(normalizeHomePath(childPath));
					homePaths.push(childPath);
					notes.push(`secondmate home not found: ${childPath}`);
				}
			}
		}
	}
	const homes = rawHomes.map(parseHome);
	const live = await fetchPaneInventory(options.maxLivePanes ?? DEFAULT_MAX_LIVE_PANES);
	if (!live.ok) notes.push("herdr pane inventory unavailable - live topology omitted");
	const byPane = new Map<string, HerdrAgent>();
	for (const pane of live.panes) if (pane.pane_id) byPane.set(pane.pane_id, pane);
	const base = buildSnapshot(homes, byPane, live.panes, new Map(), [], now, notes);
	const owners = resolveOwnerByHome(homes);
	const agents = buildAgents(homes, live.panes, owners);
	const attention = attentionFor(agents);
	base.schema = "fleet-snapshot/1";
	base.home = main;
	base.homePaths = homePaths;
	base.agents = agents;
	base.attention = attention;
	base.pending = attention;
	const activationCheck = activationFor(homePaths, live.panes, homes, main);
	base.activation = activationCheck.activation;
	base.identity = activationCheck.identity;
	base.topology = topologyForFleet(homePaths, live.panes, homes, main, live.ok);
	const missingHomes = notes.filter(note => note.startsWith("secondmate home not found:")).length;
	base.health = {
		state: !main ? "unknown" : live.ok && missingHomes === 0 && base.activation.state === "fresh" && base.topology.state === "complete" && base.identity.state !== "mismatch" ? "healthy" : "degraded",
		herdr: live.ok ? "ok" : "unavailable",
		homes: homePaths.length,
		missingHomes,
		livePanes: live.panes.length,
	};
	if (options.includeMetrics && main) base.metrics = await collectMetrics(base, main, options.statsFile ?? process.env.FM_FLEET_STATS_FILE);
	return base;
}

/** Read the canonical snapshot and render the /bridge board. */
export async function collectAndRender(now = new Date().toISOString(), cwd?: string, view: BridgeView = "roster"): Promise<string> {
	return render(await collectSnapshot(now, cwd), view);
}

export function findTask(snapshot: FleetSnapshot, id: string): { task?: TaskRow; candidates: string[] } {
	const exact = snapshot.tasks.filter(task => task.key === id);
	if (exact.length === 1) return { task: exact[0], candidates: [] };
	if (exact.length > 1) return { candidates: exact.map(task => task.key ?? canonicalTaskKey(task.owner, task.id)) };
	const candidates = snapshot.tasks.filter(task => task.id === id).map(task => task.key ?? canonicalTaskKey(task.owner, task.id));
	return candidates.length === 1 ? { task: snapshot.tasks.find(task => (task.key ?? canonicalTaskKey(task.owner, task.id)) === candidates[0]), candidates } : { candidates };
}

export function findAgent(snapshot: FleetSnapshot, id: string): { agent?: AgentRow; candidates: string[] } {
	const exact = (snapshot.agents ?? []).filter(agent => agent.key === id);
	if (exact.length === 1) return { agent: exact[0], candidates: [] };
	if (exact.length > 1) return { candidates: exact.map(agent => agent.key) };
	const candidates = (snapshot.agents ?? []).filter(agent => agent.id === id).map(agent => agent.key);
	return candidates.length === 1 ? { agent: snapshot.agents?.find(agent => agent.key === candidates[0]), candidates } : { candidates };
}

export function normalizeTaskState(value: string): BacklogSection | undefined {
	if (value === "in-flight" || value === "inflight") return "inflight";
	if (value === "queued") return "queued";
	if (value === "done") return "done";
	return undefined;
}
