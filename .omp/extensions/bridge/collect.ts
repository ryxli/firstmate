// Canonical typed FleetSnapshot collector shared by /bridge, AXI, and visual views.
//
// The default read is deliberately bounded: fleet files plus one `herdr pane list`
// inventory. It never calls GitHub or OMP statistics. Metrics opt in to the one
// additional `omp stats --json` read and reuse the task inventory for all counts.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	basename,
	buildSnapshot,
	canonicalTaskKey,
	isTerminalStatus,
	publicStatusState,
	normalizeHomePath,
	resolveHomePane,
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
	parseMeta,
	parseSecondmateHomes,
	render,
	type ArtifactRow,
} from "./fleet";
import { listActiveArtifacts, resolveDataDir } from "../cli/lib/artifact";

export interface CollectOptions {
	includeMetrics?: boolean;
	statsFile?: string;
	maxLivePanes?: number;
	startingMain?: boolean;
}

const DEFAULT_MAX_LIVE_PANES = 200;
export const MAX_HOME_DISCOVERY = 64;
export const MAX_HOME_DISCOVERY_DEPTH = 8;
export const MAX_MANIFEST_FILES = 512;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_DEPTH = 16;

function canonicalPath(path?: string): string {
	const value = path?.trim() ?? "";
	if (!value) return "";
	try {
		return realpathSync(value).replace(/\/+$/, "");
	} catch {
		return resolve(value).replace(/\/+$/, "");
	}
}

function normalizeSessionPath(path?: string): string | undefined {
	const value = canonicalPath(path);
	return value || undefined;
}


function normalizePaneCap(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_LIVE_PANES;
	return Math.max(0, Math.min(DEFAULT_MAX_LIVE_PANES, Math.trunc(value)));
}
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

function isMainHomeMarker(dir: string): boolean {
	return (existsSync(join(dir, "sbin", "fm")) || existsSync(join(dir, "sbin", "fm-spawn.sh"))) && !existsSync(join(dir, ".fm-secondmate-home"));
}

function isExplicitMainHome(dir: string): boolean {
	return existsSync(join(dir, "AGENTS.md")) && !existsSync(join(dir, ".fm-secondmate-home"));
}

/** Resolve the main home from explicit cwd, env, process cwd, then known clones. */
export function resolveMainHome(cwd?: string): string | null {
	const findHome = (start: string): string | null => {
		let dir = start;
		for (let i = 0; i < 64; i++) {
			if (isMainHomeMarker(dir)) return dir;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return null;
	};
	if (cwd && cwd.length > 0) {
		const explicitPath = cwd.replace(/\/+$/, "");
		if (isExplicitMainHome(explicitPath)) return explicitPath;
		const explicit = findHome(explicitPath);
		if (explicit) return explicit;
	}
	// FM_HOME / FIRSTMATE_HOME pin the sole discovery root - never fall through
	// to cwd walk-up or hardcoded clone paths (sandbox isolation for finish/fleet).
	const pinnedHome = (process.env.FM_HOME?.trim() || process.env.FIRSTMATE_HOME?.trim() || "").replace(/\/+$/, "");
	if (pinnedHome) return pinnedHome;

	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	if (rootOverride) {
		const envPath = rootOverride.replace(/\/+$/, "");
		if (isExplicitMainHome(envPath)) return envPath;
		const envHome = findHome(envPath);
		if (envHome) return envHome;
	}
	const current = findHome(process.cwd());
	if (current) return current;
	for (const candidate of [join(homedir(), "code", "harness", "firstmate"), join(homedir(), "code", "firstmate")]) {
		if (isMainHomeMarker(candidate)) return candidate;
	}
	return null;
}

/** Read one home's backlog, metadata, and matching status files. */
export function readRawHome(homePath: string, isMain: boolean, depth = 0): RawHome {
	const backlogText = readFileOrNull(join(homePath, "data", "backlog.md"));
	const statePath = isMain ? (process.env.FM_STATE_OVERRIDE?.trim() || join(homePath, "state")) : join(homePath, "state");
	const metas: { id: string; text: string }[] = [];
	const statuses: Record<string, string> = {};
	const statusMtimes: Record<string, number> = {};
	let entries: string[] = [];
	try {
		entries = existsSync(statePath) ? readdirSync(statePath) : [];
	} catch {
		entries = [];
	}
	for (const name of entries) {
		if (!name.endsWith(".meta")) continue;
		const id = name.slice(0, -5);
		const text = readFileOrNull(join(statePath, name));
		if (text === null) continue;
		metas.push({ id, text });
		const statusPath = join(statePath, `${id}.status`);
		const status = readFileOrNull(statusPath);
		if (status !== null) {
			statuses[id] = status;
			try {
				statusMtimes[id] = Math.floor(statSync(statusPath).mtimeMs / 1000);
			} catch {
				// The status may disappear between the read and stat.
			}
		}
	}
	const receiptValue = parseJson(readFileOrNull(join(statePath, "activation-receipt.json")) ?? "");
	const receipt = validActivationReceipt(receiptValue) ? receiptValue : undefined;
	const activationPane = stringValue(receipt?.pane_id);
	return { path: homePath, pathKey: canonicalPath(homePath), statePath, isMain, backlogText, metas, statuses, statusMtimes, depth, activationPane };
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
	const cwd = text("cwd") ?? text("foreground_cwd");
	return {
		pane_id: text("pane_id") ?? text("id"),
		agent_status: text("agent_status") ?? text("status"),
		cwd,
		cwdKey: cwd ? canonicalPath(cwd) : undefined,
		workspace_id: text("workspace_id"),
		workspace_label: text("workspace_label"),
		tab_id: text("tab_id"),
		tab_label: text("tab_label"),
		label: text("label"),
		agent: text("agent") ?? stringValue(legacy?.agent),
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
		pane: pane?.pane_id,
		tab: pane?.tab_id ?? meta.raw.tab,
		tabLabel: pane?.tab_label,
		workspace: pane?.workspace_id ?? meta.raw.workspace,
		workspaceLabel: pane?.workspace_label,
		cwd: pane?.cwd,
		agentStatus: pane?.agent_status,
		degraded: meta.pane && pane?.pane_id ? undefined : meta.pane ? "missing-pane" : "state-only",
	};
}

function paneForTrackedAgent(home: ParsedHome, meta: { pane?: string; home?: string; kind?: string; raw: Record<string, string> }, byPane: Map<string, HerdrAgent>): HerdrAgent | undefined {
	if (!meta.pane) return undefined;
	const pane = byPane.get(meta.pane);
	if (!pane || (pane.agent && pane.agent !== "omp")) return undefined;
	const expected = meta.kind === "secondmate" && meta.home
		? canonicalPath(meta.home)
		: meta.raw.worktree
			? canonicalPath(meta.raw.worktree)
			: canonicalPath(home.path);
	const cwd = pane.cwdKey ?? canonicalPath(pane.cwd);
	return expected && cwd === expected ? pane : undefined;
}

function buildAgents(homes: ParsedHome[], panes: HerdrAgent[], owners: Map<string, string>): AgentRow[] {
	const byPane = new Map<string, HerdrAgent>();
	for (const pane of panes) if (pane.pane_id) byPane.set(pane.pane_id, pane);
	const agents: AgentRow[] = [];
	for (const home of homes) {
		const owner = owners.get(home.pathKey ?? normalizeHomePath(home.path)) ?? home.label;
		if (home.isMain) {
			const supervisor = paneForHome(home.path, homes, panes);
			if (supervisor) {
				agents.push({
					key: canonicalTaskKey(owner, "supervisor"),
					id: "supervisor",
					owner,
					kind: "supervisor",
					status: supervisor.agent_status,
					liveStatus: supervisor.agent_status,
					statusText: "",
					pane: supervisor.pane_id,
					home: home.path,
					depth: home.depth,
					topology: { home: home.path, pane: supervisor.pane_id, cwd: supervisor.cwd, workspace: supervisor.workspace_id, workspaceLabel: supervisor.workspace_label, tab: supervisor.tab_id, tabLabel: supervisor.tab_label, agentStatus: supervisor.agent_status },
				});
			}
		}
		for (const agent of home.agents) {
			const pane = paneForTrackedAgent(home, agent.meta, byPane);
			const statusFile = agent.status;
			const liveStatus = pane?.agent_status;
			const persistedStatus = publicStatusState(statusFile);
			// A validated live pane drives display state. The parsed file remains
			// separate for disposition/attention and is the offline fallback.
			const status = liveStatus ?? persistedStatus;
			const statusText = liveStatus ? undefined : statusFile?.text;
			agents.push({
				key: canonicalTaskKey(owner, agent.id),
				id: agent.id,
				owner,
				kind: agent.meta.kind,
				status,
				statusText,
				statusFile,
				liveStatus,
				statusMtime: agent.statusMtime,
				depth: home.depth,
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

function humanAge(seconds: number): string {
	if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
	if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
	if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
	return `${seconds}s`;
}
export function attentionFor(agents: AgentRow[], homes: ParsedHome[], now: string): PendingItem[] {
	const ownerByHome = resolveOwnerByHome(homes);
	const blast = new Map<string, number>();
	for (const home of homes) {
		const owner = ownerByHome.get(home.pathKey ?? normalizeHomePath(home.path)) ?? home.label;
		const blockedBy = /blocked-by:\s*([a-z0-9][a-z0-9-]*)/gi;
		for (const match of (home.backlogText ?? "").matchAll(blockedBy)) {
			const key = canonicalTaskKey(owner, match[1]);
			blast.set(key, (blast.get(key) ?? 0) + 1);
		}
	}
	const parsedNow = Date.parse(now);
	const nowSeconds = Number.isFinite(parsedNow) ? Math.floor(parsedNow / 1000) : Math.floor(Date.now() / 1000);
	const rows: Array<PendingItem & { severity: number; blast: number; ageSec: number; proximity: number }> = [];
	for (const agent of agents) {
		const file = agent.statusFile;
		const fileTerminal = isTerminalStatus(file);
		const fileState = fileTerminal ? (file?.state ?? "") : "";
		const fileText = fileTerminal ? (file?.text ?? "").toLowerCase() : "";
		const live = (agent.liveStatus ?? agent.status ?? "").toLowerCase();
		let clsRank = 0;
		let severity = 0;
		let tag = "UNBOUND";
		if (agent.kind === "secondmate") {
			if (fileState === "failed" || live === "failed") {
				clsRank = 4;
				severity = 2;
				tag = "FAILED (secondmate)";
			} else if (fileState === "needs-decision" || live === "needs-decision") {
				clsRank = 4;
				severity = 1;
				tag = "NEEDS DECISION (secondmate)";
			} else if (fileState === "blocked" || live === "blocked") {
				clsRank = 4;
				severity = 1;
				tag = "BLOCKED (secondmate)";
			} else if (live === "unknown" || live === "") {
				tag = "UNBOUND (secondmate)";
			} else {
				clsRank = 1;
				tag = "secondmate idle";
			}
		} else if (fileTerminal && fileState === "failed") {
			clsRank = 4;
			severity = 2;
			tag = "FAILED";
		} else if (fileTerminal && fileState === "needs-decision") {
			clsRank = 4;
			severity = 1;
			tag = "NEEDS DECISION";
		} else if (fileTerminal && fileState === "blocked") {
			clsRank = 4;
			severity = 1;
			tag = "BLOCKED";
		} else if (fileTerminal && /\bready in branch\b/i.test(fileText)) {
			clsRank = 3;
			severity = 1;
			tag = "READY (branch)";
		} else if (fileTerminal && /\bchecks green\b|\bpr ready\b/i.test(fileText)) {
			clsRank = 3;
			severity = 1;
			tag = "PR READY";
		} else if (fileTerminal && fileState === "done") {
			clsRank = 3;
			severity = /\bmerged\b/i.test(fileText) ? 0 : 1;
			tag = severity === 0 ? "MERGED (teardown)" : "DONE (review)";
		} else if (fileTerminal && /\bmerged\b/i.test(fileText)) {
			clsRank = 3;
			severity = 0;
			tag = "MERGED (teardown)";
		} else if (live === "failed") {
			clsRank = 4;
			severity = 2;
			tag = "FAILED (live)";
		} else if (live === "needs-decision") {
			clsRank = 4;
			severity = 1;
			tag = "NEEDS DECISION (live)";
		} else if (live === "blocked") {
			clsRank = 4;
			severity = 1;
			tag = "BLOCKED (frozen)";
		} else if (live === "working") {
			clsRank = 2;
			tag = "working";
		} else if (live === "done") {
			clsRank = 3;
			tag = "done (closeout)";
		} else if (live === "idle") {
			clsRank = 1;
			tag = "idle";
		} else if (live === "unknown" || live === "") {
			tag = "UNBOUND";
		} else {
			clsRank = 1;
			tag = live;
		}
		const blastCount = blast.get(agent.key) ?? 0;
		const ageSec = agent.statusMtime ? Math.max(0, nowSeconds - agent.statusMtime) : 0;
		const proximity = -(agent.depth ?? 0);
		const extras: string[] = [];
		if (fileTerminal && file?.text && clsRank >= 3) extras.push(file.text.slice(0, 64));
		if (blastCount > 0) extras.push(`blocks ${blastCount}`);
		if (ageSec >= 60 && clsRank >= 3) extras.push(humanAge(ageSec));
		if (proximity < 0 && clsRank >= 3) extras.push("forwarded");
		rows.push({
			key: agent.key,
			cls: clsRank === 4 ? "CAP-BLOCKED" : clsRank === 3 ? "REVIEW-READY" : clsRank === 2 ? "IN-FLIGHT" : clsRank === 1 ? "DORMANT" : "UNKNOWN",
			clsRank,
			home: basename(agent.home),
			id: agent.id,
			reason: `${tag}${extras.length ? ` - ${extras.join(", ")}` : ""}`,
			severity,
			blast: 1 + blastCount,
			ageSec,
			proximity,
		});
	}
	return rows
		.sort((a, b) => b.clsRank - a.clsRank || b.severity - a.severity || b.blast - a.blast || b.ageSec - a.ageSec || b.proximity - a.proximity || a.id.localeCompare(b.id) || (a.key ?? "").localeCompare(b.key ?? ""))
		.map(({ severity: _severity, blast: _blast, ageSec: _ageSec, proximity: _proximity, ...row }) => row);
}


function paneForHome(home: string, homes: ParsedHome[], panes: HerdrAgent[]): HerdrAgent | undefined {
	const parsed = homes.find(candidate => canonicalPath(candidate.path) === canonicalPath(home));
	if (!parsed) return undefined;
	const byPane = new Map<string, HerdrAgent>();
	for (const pane of panes) if (pane.pane_id) byPane.set(pane.pane_id, pane);
	return resolveHomePane(parsed, homes, byPane, panes);
}

function topologyForFleet(homePaths: string[], panes: HerdrAgent[], homes: ParsedHome[], main: string | null, herdrOk: boolean, startingMain = false): TopologySummary {
	const summary: TopologySummary = { state: "unknown", present: 0, missing: 0, incomplete: 0, reason: "herdr-unavailable" };
	for (const home of homePaths) {
		const pane = paneForHome(home, homes, panes);
		if (!pane) summary.missing += 1;
		else if (pane.agent !== "omp" && !(startingMain && main && canonicalPath(home) === canonicalPath(main))) summary.incomplete += 1;
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


function validActivationReceipt(value: unknown): value is Record<string, unknown> {
	const record = objectRecord(value);
	if (!record || record.schema !== "firstmate.activation-receipt/v1") return false;
	if (!stringValue(record.pane_id)) return false;
	const sessionId = stringValue(record.session_id);
	const sessionPath = stringValue(record.session_path);
	if ((record.session_id !== undefined && !sessionId) || (record.session_path !== undefined && !sessionPath) || (!sessionId && !sessionPath)) return false;
	const startedAt = stringValue(record.started_at);
	if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return false;
	const digest = stringValue(record.manifest_sha256);
	if (!digest || !/^[0-9a-f]{64}$/i.test(digest)) return false;
	const manifest = arrayValue(record.manifest);
	if (manifest.length === 0) return false;
	const paths = new Set<string>();
	const entries: { path: string; sha256: string }[] = [];
	for (const entry of manifest) {
		const item = objectRecord(entry);
		const path = stringValue(item?.path);
		const sha256 = stringValue(item?.sha256);
		if (!path || path.startsWith("/") || path.includes("..") || !sha256 || !/^[0-9a-f]{64}$/i.test(sha256) || paths.has(path)) return false;
		paths.add(path);
		entries.push({ path, sha256: sha256.toLowerCase() });
	}
	if (!paths.has("AGENTS.md")) return false;
	const hash = createHash("sha256");
	for (const entry of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.sha256);
		hash.update("\0");
	}
	return hash.digest("hex") === digest.toLowerCase();
}

function activationFor(homePaths: string[], panes: HerdrAgent[], homes: ParsedHome[], main: string | null, notes: string[]): { activation: ActivationSummary; identity: IdentitySummary } {
	const activation: ActivationSummary = { state: "unknown", total: homePaths.length, fresh: 0, stale: 0, unknown: 0 };
	const identity: IdentitySummary = { state: "unknown", bound: 0, mismatch: 0, unknown: 0 };
	for (const home of homePaths) {
		const pane = paneForHome(home, homes, panes);
		let activationState: "fresh" | "stale" | "unknown" = "unknown";
		let identityState: "bound" | "mismatch" | "unknown" = "unknown";
		const parsedHome = homes.find(candidate => canonicalPath(candidate.path) === canonicalPath(home));
		const statePath = parsedHome?.statePath ?? join(home, "state");
		const receiptValue = parseJson(readFileOrNull(join(statePath, "activation-receipt.json")) ?? "");
		const receiptRecord = validActivationReceipt(receiptValue) ? receiptValue : undefined;
		if (receiptValue !== undefined && receiptValue !== null && !receiptRecord) notes.push(`activation receipt malformed for ${home}`);
		if (pane && receiptRecord) {
			const current = manifestHash(home);
			const manifest = receiptRecord.manifest_sha256 as string;
			if (current.reason) notes.push(`activation manifest degraded for ${home}: ${current.reason}`);
			const sessionPath = normalizeSessionPath(pane.agent_session_path);
			const sessionId = pane.agent_session_id;
			const receiptPath = normalizeSessionPath(stringValue(receiptRecord.session_path));
			const receiptId = stringValue(receiptRecord.session_id);
			if (sessionPath || sessionId) {
				const paneMatches = receiptRecord.pane_id === pane.pane_id;
				const pathMatches = !sessionPath || sessionPath === receiptPath;
				const idMatches = !sessionId || sessionId === receiptId;
				identityState = paneMatches && pathMatches && idMatches ? "bound" : "mismatch";
			}
			if (current.hash === manifest) activationState = "fresh";
			else if (current.hash) activationState = "stale";
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

interface ManifestHashResult {
	hash?: string;
	reason?: string;
}

export function sourceRootForHome(home: string): string | undefined {
	const configured = process.env.FM_FLEET_SOURCE_HOME?.trim() || process.env.FM_ROOT_OVERRIDE?.trim() || process.env.FM_ROOT?.trim();
	if (configured) return resolve(configured);
	const configuredHome = process.env.FM_HOME?.trim();
	if (configuredHome && existsSync(join(configuredHome, ".git")) && existsSync(join(configuredHome, ".omp", "fleet-capabilities.json"))) return resolve(configuredHome);
	const extensions = join(home, ".omp", "extensions");
	let entries: string[];
	try {
		entries = readdirSync(extensions);
	} catch {
		return undefined;
	}
	for (const entry of entries.sort()) {
		let cursor: string;
		try {
			cursor = realpathSync(join(extensions, entry));
		} catch {
			continue;
		}
		while (cursor !== dirname(cursor)) {
			if (cursor.endsWith("/.omp/extensions") && existsSync(join(dirname(dirname(cursor)), ".omp", "fleet-capabilities.json"))) {
				return dirname(dirname(cursor));
			}
			cursor = dirname(cursor);
		}
	}
	return undefined;
}

export function manifestHash(home: string): ManifestHashResult {
	const paths: string[] = ["AGENTS.md"];
	const sizes = new Map<string, number>();
	let totalBytes = 0;
	let reason: string | undefined;
	const addPath = (relativePath: string, size: number): boolean => {
		if (paths.length >= MAX_MANIFEST_FILES) {
			reason = "file-count limit reached";
			return false;
		}
		if (totalBytes + size > MAX_MANIFEST_BYTES) {
			reason = "byte-count limit reached";
			return false;
		}
		paths.push(relativePath);
		sizes.set(relativePath, size);
		totalBytes += size;
		return true;
	};
	const registryRoot = sourceRootForHome(home) ?? home;
	try {
		const registry = statSync(join(registryRoot, ".omp", "fleet-capabilities.json"));
		if (registry.isFile()) addPath(".omp/fleet-capabilities.json", registry.size);
	} catch {
		// A missing source registry is reported by the update controller.
	}
	try {
		const agents = statSync(join(home, "AGENTS.md"));
		if (!agents.isFile()) return { reason: "AGENTS.md is not a regular file" };
		if (totalBytes + agents.size > MAX_MANIFEST_BYTES) return { reason: "byte-count limit reached" };
		sizes.set("AGENTS.md", agents.size);
		totalBytes += agents.size;
	} catch {
		return { reason: "AGENTS.md is unreadable" };
	}
	const extensions = join(home, ".omp", "extensions");
	const visitedDirs = new Set<string>();
	const walk = (dir: string, depth: number): void => {
		if (reason) return;
		let dirStat;
		try {
			dirStat = statSync(dir);
			const realDir = realpathSync(dir);
			if (visitedDirs.has(realDir)) return;
			visitedDirs.add(realDir);
		} catch {
			return;
		}
		if (!dirStat.isDirectory()) return;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			return;
		}
		if (depth >= MAX_MANIFEST_DEPTH && entries.length > 0) {
			reason = "directory-depth limit reached";
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry);
			try {
				const linkStat = lstatSync(path);
				if (linkStat.isSymbolicLink()) {
					const targetStat = statSync(path);
					if (targetStat.isDirectory()) walk(path, depth + 1);
					else if (targetStat.isFile() && !addPath(path.slice(home.length + 1), targetStat.size)) return;
				} else if (linkStat.isDirectory()) {
					walk(path, depth + 1);
				} else if (linkStat.isFile() && !addPath(path.slice(home.length + 1), linkStat.size)) {
					return;
				}
			} catch {
				reason = "manifest entry unreadable";
				return;
			}
			if (reason) return;
		}
	};
	walk(extensions, 0);
	if (reason) return { reason };
	const entries: { path: string; sha256: string }[] = [];
	for (const relativePath of paths.sort()) {
		try {
			const expectedSize = sizes.get(relativePath);
			const readRoot = relativePath === ".omp/fleet-capabilities.json" ? registryRoot : home;
			const bytes = readFileSync(join(readRoot, relativePath));
			if (expectedSize !== undefined && bytes.byteLength !== expectedSize) return { reason: "manifest entry changed during read" };
			entries.push({ path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex") });
		} catch {
			return { reason: "manifest entry unreadable" };
		}
	}
	const hash = createHash("sha256");
	for (const entry of entries) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.sha256);
		hash.update("\0");
	}
	return { hash: hash.digest("hex") };
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

async function collectMetrics(snapshot: FleetSnapshot, home: string, statsFile: string | undefined, notes: string[]): Promise<FleetMetrics | undefined> {
	let statsText: string;
	if (statsFile !== undefined) {
		const file = readFileOrNull(statsFile);
		if (file === null) {
			notes.push(`fleet metrics unavailable: stats file missing: ${statsFile}`);
			return undefined;
		}
		statsText = file;
	} else {
		const result = await run(["omp", "stats", "--json"], 10000);
		if (!result.ok) {
			notes.push("fleet metrics unavailable: omp stats --json failed");
			return undefined;
		}
		statsText = result.stdout;
	}
	const parsed = parseJson(statsText);
	const root = objectRecord(parsed);
	if (!root || !Array.isArray(root.byFolder)) {
		notes.push(`fleet metrics unavailable: malformed stats JSON${statsFile ? ` in ${statsFile}` : ""}`);
		return undefined;
	}
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
			cache_read_tokens: numberValue(folder.totalCacheReadTokens ?? folder.cacheReadTokens ?? folder.cache_read_tokens),
			cache_write_tokens: numberValue(folder.totalCacheWriteTokens ?? folder.cacheWriteTokens ?? folder.cache_write_tokens),
			input_tokens: numberValue(folder.totalInputTokens),
			failed_requests: numberValue(folder.failedRequests),
		};
	});
	const productive = new Set(["supervisor", "secondmate", "crew"]);
	const agg = (roles: Set<string>) => {
		const selected = byFolder.filter(folder => roles.has(folder.role));
		const cost = selected.reduce((sum, folder) => sum + folder.cost_usd, 0);
		const tokens = selected.reduce((sum, folder) => sum + folder.tokens, 0);
		const requests = selected.reduce((sum, folder) => sum + folder.requests, 0);
		const input = selected.reduce((sum, folder) => sum + folder.input_tokens, 0);
		const cacheRead = selected.reduce((sum, folder) => sum + folder.cache_read_tokens, 0);
		const cacheWrite = selected.reduce((sum, folder) => sum + folder.cache_write_tokens, 0);
		const failures = selected.reduce((sum, folder) => sum + folder.failed_requests, 0);
		return { cost, tokens, requests, cache_hit_rate: input + cacheRead + cacheWrite ? cacheRead / (input + cacheRead + cacheWrite) : 0, error_rate: requests ? failures / requests : 0 };
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
		by_agent_type: arrayValue(root.byAgentType)
			.map(objectRecord)
			.filter((value): value is Record<string, unknown> => value !== null)
			.map(value => ({
				agent_type: stringValue(value.agentType) ?? stringValue(value.agent_type) ?? "",
				cost_usd: Number(numberValue(value.totalCost ?? value.cost_usd).toFixed(4)),
				tokens: numberValue(value.totalInputTokens ?? value.input_tokens) + numberValue(value.totalOutputTokens ?? value.output_tokens),
			})),
		gaps: ["exact per-task cost (needs task-to-folder-to-landed join)", "live escalation precision/recall (needs an escalation log)", "cycle time + autonomous task horizon (needs dispatch/landed timestamps)"],
	};
}

/** Read one complete fleet snapshot. Default mode never calls GitHub or OMP stats. */
export async function collectSnapshot(now = new Date().toISOString(), cwd?: string, options: CollectOptions = {}): Promise<FleetSnapshot> {
	const notes: string[] = [];
	const discoveredMain = resolveMainHome(cwd);
	const main = discoveredMain ? discoveredMain.replace(/\/+$/, "") : null;
	const rawHomes: RawHome[] = [];
	const homePaths: string[] = [];
	if (!main) {
		notes.push("could not locate the firstmate home");
	} else {
		const queue: Array<{ path: string; isMain: boolean; depth: number }> = [{ path: main, isMain: true, depth: 0 }];
		const seenHomes = new Set<string>([canonicalPath(main)]);
		let homeLimitNoted = false;
		let depthLimitNoted = false;
		while (queue.length) {
			const current = queue.shift()!;
			homePaths.push(current.path);
			if (!existsSync(current.path)) {
				notes.push(`secondmate home not found: ${current.path}`);
				continue;
			}
			rawHomes.push(readRawHome(current.path, current.isMain, current.depth));
			const secondmatesText = readFileOrNull(join(current.path, "data", "secondmates.md"));
			const rawHome = rawHomes[rawHomes.length - 1];
			const metadataHomes = rawHome.metas
				.map(({ id, text }) => parseMeta(id, text))
				.filter(meta => meta.kind === "secondmate" && Boolean(meta.home))
				.map(meta => meta.home as string);
			if (!secondmatesText && current.isMain && metadataHomes.length === 0) {
				notes.push("data/secondmates.md missing - only the main home is shown");
			}
			const childPaths = [...(secondmatesText ? parseSecondmateHomes(secondmatesText) : []), ...metadataHomes];
			for (const childPath of childPaths) {
				const child = childPath.replace(/\/+$/, "");
				const childKey = canonicalPath(child);
				const childDepth = current.depth + 1;
				if (seenHomes.has(childKey)) continue;
				if (childDepth > MAX_HOME_DISCOVERY_DEPTH) {
					if (!depthLimitNoted) {
						notes.push(`secondmate discovery depth limit reached at ${current.path}`);
						depthLimitNoted = true;
					}
					continue;
				}
				if (seenHomes.size >= MAX_HOME_DISCOVERY) {
					if (!homeLimitNoted) {
						notes.push(`secondmate discovery home-count limit reached at ${current.path}`);
						homeLimitNoted = true;
					}
					break;
				}
				seenHomes.add(childKey);
				if (existsSync(child)) queue.push({ path: child, isMain: false, depth: childDepth });
				else {
					homePaths.push(child);
					notes.push(`secondmate home not found: ${child}`);
				}
			}
		}
	}
	const homes = rawHomes.map(raw => {
		const home = parseHome(raw);
		return {
			...home,
			label: raw.isMain ? basename(raw.pathKey ?? canonicalPath(raw.path)) : home.label,
			agents: home.agents.map(agent => ({
				...agent,
				meta: {
					...agent.meta,
					homeKey: agent.meta.home ? canonicalPath(agent.meta.home) : undefined,
					worktreeKey: agent.meta.raw.worktree ? canonicalPath(agent.meta.raw.worktree) : undefined,
				},
			})),
		};
	});
	const live = await fetchPaneInventory(normalizePaneCap(options.maxLivePanes));
	if (!live.ok) notes.push("herdr pane inventory unavailable - live topology omitted");
	const byPane = new Map<string, HerdrAgent>();
	for (const pane of live.panes) if (pane.pane_id) byPane.set(pane.pane_id, pane);
	const base = buildSnapshot(homes, byPane, live.panes, new Map(), [], now, notes);
	const owners = resolveOwnerByHome(homes);
	const agents = buildAgents(homes, live.panes, owners);
	const attention = attentionFor(agents, homes, now);
	// Thin artifact spine: active state/<id>.artifact.json rows only (no parallel history API).
	try {
		const dataDir = main ? join(main, "data") : resolveDataDir();
		const active = listActiveArtifacts(dataDir);
		base.artifacts = active.map(
			(r): ArtifactRow => ({
				id: r.taskId,
				taskId: r.taskId,
				project: r.project,
				reviewState: r.reviewState,
				deliveryState: r.delivery?.state ?? null,
				mode: r.delivery?.mode ?? null,
				workerBound: r.workerBound,
				active: true,
				updatedAt: r.updatedAt,
			}),
		);
		const mainHome = homes.find(h => h.isMain);
		const owner =
			(mainHome && owners.get(mainHome.pathKey ?? normalizeHomePath(mainHome.path))) ||
			mainHome?.label ||
			"firstmate";
		for (const row of base.artifacts) {
			if (row.reviewState === "candidate" || row.reviewState === "revise") {
				attention.push({
					key: `${owner}/${row.taskId}`,
					cls: "REVIEW-READY",
					clsRank: 3,
					home: owner,
					id: row.taskId,
					reason: `ARTIFACT (${row.reviewState})`,
				});
			} else if (row.deliveryState === "blocked") {
				attention.push({
					key: `${owner}/${row.taskId}`,
					cls: "CAP-BLOCKED",
					clsRank: 4,
					home: owner,
					id: row.taskId,
					reason: "ARTIFACT (delivery blocked)",
				});
			}
		}
	} catch {
		notes.push("artifact records unavailable");
	}
	base.schema = "fleet-snapshot/1";
	base.home = main;
	base.homePaths = homePaths;
	base.agents = agents;
	base.attention = attention;
	base.pending = attention.filter(item => item.clsRank >= 3);
	const activationCheck = activationFor(homePaths, live.panes, homes, main, notes);
	base.activation = activationCheck.activation;
	base.identity = activationCheck.identity;
	base.topology = topologyForFleet(homePaths, live.panes, homes, main, live.ok, options.startingMain);
	const missingHomes = notes.filter(note => note.startsWith("secondmate home not found:")).length;
	const boundedDegradation = notes.some(note => note.includes("limit reached") || note.startsWith("activation manifest degraded"));
	base.health = {
		state: !main ? "unknown" : live.ok && missingHomes === 0 && !boundedDegradation && base.activation.state === "fresh" && base.topology.state === "complete" && base.identity.state !== "mismatch" ? "healthy" : "degraded",
		herdr: live.ok ? "ok" : "unavailable",
		homes: homePaths.length,
		missingHomes,
		livePanes: live.panes.length,
	};
	if (options.includeMetrics && main) {
		const metrics = await collectMetrics(base, main, options.statsFile ?? process.env.FM_FLEET_STATS_FILE, notes);
		if (metrics) base.metrics = metrics;
	}
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

function taskAttentionKey(task: TaskRow): string {
	return task.key ?? `${task.owner}/${task.id}`;
}

/**
 * Task list ranked by fleet attention first (cap-blocked/review-ready rows
 * surface before ordinary state ordering), then by state, then id. Shared by
 * `fm fleet tasks`/`fm fleet task get` and the `fm tasks fleet` facet so both
 * surfaces stay byte-identical.
 *
 * Default (no state, full=false): actionable-only - excludes Done history.
 * Pass state=done or full=true to include retained Done rows.
 */
export function rankedTasks(
	snapshot: FleetSnapshot,
	state?: TaskRow["state"],
	opts: { full?: boolean } = {},
): TaskRow[] {
	const attention = new Map((snapshot.attention ?? snapshot.pending).map((row, index) => [row.key ?? `${row.home}/${row.id}`, { rank: row.clsRank, index }]));
	const stateRank: Record<TaskRow["state"], number> = { inflight: 3, queued: 2, done: 1 };
	return snapshot.tasks
		.filter(task => {
			if (state) return task.state === state;
			if (opts.full) return true;
			return task.state !== "done";
		})
		.slice()
		.sort((a, b) => {
			const aa = attention.get(taskAttentionKey(a));
			const bb = attention.get(taskAttentionKey(b));
			return (bb?.rank ?? stateRank[b.state]) - (aa?.rank ?? stateRank[a.state]) || (aa?.index ?? 9999) - (bb?.index ?? 9999) || taskAttentionKey(a).localeCompare(taskAttentionKey(b));
		});
}

/** Compact default fleet board: attention + active artifacts + non-done tasks. */
export function actionableFleetView(snapshot: FleetSnapshot): Record<string, unknown> {
	const attention = snapshot.attention ?? snapshot.pending;
	return {
		schema: "fleet-actionable/1",
		generatedAt: snapshot.generatedAt,
		home: snapshot.home,
		activation: snapshot.activation,
		health: snapshot.health,
		attention,
		artifacts: snapshot.artifacts ?? [],
		tasks: rankedTasks(snapshot),
		notes: snapshot.notes,
	};
}
