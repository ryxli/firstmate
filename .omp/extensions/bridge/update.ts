import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { manifestHash, sourceRootForHome } from "./collect";
import { ensureSecondmateHomeSkills, isSecondmateHome } from "../cli/lib/ensure-home-skills";

export const CAPABILITY_REGISTRY_SCHEMA = "firstmate.capability-registry/v2" as const;
export const UPDATE_TRANSACTION_SCHEMA = "firstmate.fleet-update/v1" as const;

const LEGACY_CAPABILITY_REGISTRY_SCHEMA = "firstmate.capability-registry/v1";

export type ProbeResult = unknown;

export interface CapabilitySelector {
	role?: string;
	id?: string;
	kind?: string;
}

export interface CapabilityTarget {
	id: string;
	surfaces: string[];
	home: string;
	sourceRevision?: string;
	requiredProbe?: ProbeResult;
	reloadTarget?: string;
	allowDetached?: boolean;
	enabled?: boolean;
	selector?: CapabilitySelector;
}

export interface CapabilityRegistry {
	schema?: string;
	sourceRevision?: string;
	requiredProbe?: ProbeResult;
	path: string;
	relativePath: string;
	digest: string;
	targets: CapabilityTarget[];
}

export interface SessionIdentity {
	pane_id?: string;
	session_id?: string;
	session_path?: string;
}

export interface UpdateProof {
	source_revision: string;
	manifest_sha256: string | null;
	session_identity: SessionIdentity | null;
	required_probe_result: ProbeResult | null;
}

export type UpdateStatus = "ready" | "pending" | "failed";

export interface TargetUpdateResult {
	target: string;
	home: string;
	status: UpdateStatus;
	outcome: UpdateStatus;
	action: "fast-forward" | "reload" | "noop" | "none";
	reason?: string;
	proof: UpdateProof;
}

export interface FleetUpdateResult {
	schema: typeof UPDATE_TRANSACTION_SCHEMA;
	source_revision: string;
	registry: { path: string; sha256: string };
	results: TargetUpdateResult[];
	targets: TargetUpdateResult[];
	transaction: string;
}

export interface UpdateOptions {
	sourceHome?: string;
	operationalHome?: string;
	registryPath?: string;
	transactionPath?: string;
	reloadScript?: string;
	now?: string;
}

interface RawPane extends SessionIdentity {
	agent?: string;
	agent_status?: string;
	cwd?: string;
}

interface PaneInventory {
	available: boolean;
	panes: RawPane[];
	reason?: string;
}

interface Receipt {
	schema?: string;
	pane_id?: string;
	session_id?: string;
	session_path?: string;
	started_at?: string;
	manifest_sha256?: string;
	manifest?: unknown[];
	source_revision?: string;
	required_probe_result?: ProbeResult;
	required_probe?: ProbeResult;
	capability_probe?: ProbeResult;
	probe_result?: ProbeResult;
}

interface TransactionTarget {
	home: string;
	status: UpdateStatus;
	proof: UpdateProof;
	action: TargetUpdateResult["action"];
	reason?: string;
	updated_at: string;
}

interface TransactionState {
	schema: typeof UPDATE_TRANSACTION_SCHEMA;
	source_revision: string;
	registry_sha256: string;
	targets: Record<string, TransactionTarget>;
	updated_at: string;
}

interface GitResult {
	ok: boolean;
	stdout: string;
}

interface FastForwardResult {
	status: "current" | "updated" | "pending";
	reason?: string;
	before?: string;
	after?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalPath(path: string): string {
	try {
		return resolve(path).replace(/\/+$/, "");
	} catch {
		return path.replace(/\/+$/, "");
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function supportedRequiredProbe(value: unknown): boolean {
	const probe = objectRecord(value);
	return Boolean(probe && Object.keys(probe).length === 1 && probe.activation === "ok");
}

function registryDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function candidateRegistryPaths(home: string): string[] {
	const configured = process.env.FM_FLEET_CAPABILITY_REGISTRY || process.env.FM_CAPABILITY_REGISTRY;
	if (configured?.trim()) return [configured.trim()];
	return [
		join(home, ".omp", "fleet-capabilities.json"),
		join(home, ".omp", "capability-registry.json"),
		join(home, ".omp", "extensions", "bridge", "capability-registry.json"),
	];
}

function selectorValue(value: unknown): CapabilitySelector | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		if (!text) return undefined;
		const match = /^(?:role|kind|id)\s*[:=]\s*(.+)$/i.exec(text);
		if (match) {
			const key = text.slice(0, text.indexOf(match[1])).replace(/[:=\s]+$/, "").toLowerCase();
			return key === "id" ? { id: match[1].trim() } : key === "kind" ? { kind: match[1].trim() } : { role: match[1].trim() };
		}
		return { role: text };
	}
	const record = objectRecord(value);
	if (!record) return undefined;
	const role = stringValue(record.role);
	const id = stringValue(record.id) ?? stringValue(record.name);
	const kind = stringValue(record.kind) ?? stringValue(record.type);
	return role || id || kind ? { ...(role ? { role } : {}), ...(id ? { id } : {}), ...(kind ? { kind } : {}) } : undefined;
}

function selectorsFor(entry: Record<string, unknown>): CapabilitySelector[] {
	const raw = entry.selectors ?? entry.selector ?? (entry.role !== undefined ? { role: entry.role } : undefined);
	if (Array.isArray(raw)) return raw.map(selectorValue).filter((value): value is CapabilitySelector => value !== undefined);
	const selector = selectorValue(raw);
	return selector ? [selector] : [];
}

function targetRecords(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.map(objectRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
	const record = objectRecord(value);
	if (!record) return [];
	const roles = objectRecord(record.roles);
	if (Array.isArray(record.roles)) return targetRecords(record.roles);
	if (roles) {
		return Object.entries(roles).flatMap(([role, entry]) => {
			const child = objectRecord(entry);
			return child ? [{ ...child, id: child.id ?? role, selector: child.selector ?? { role } }] : [];
		});
	}
	for (const key of ["targets", "homes", "entries", "capabilities"]) {
		if (Array.isArray(record[key])) return targetRecords(record[key]);
		if (objectRecord(record[key])) return targetRecords(record[key]);
	}
	const mapped: Record<string, unknown>[] = [];
	for (const [home, entry] of Object.entries(record)) {
		const child = objectRecord(entry);
		if (child && (child.home || child.path || child.id || home.startsWith("/"))) mapped.push({ ...child, home: child.home ?? child.path ?? home });
	}
	return mapped;
}

function stringArray(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function normalizeSurface(value: string): string | undefined {
	const surface = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (!surface || surface.startsWith("/") || surface === ".." || surface.startsWith("../")) return undefined;
	return surface;
}

export interface TopologyCandidate {
	id: string;
	role: string;
	home: string;
}

export function topologyCandidates(root: string): TopologyCandidate[] {
	const candidates: TopologyCandidate[] = [{ id: "firstmate", role: "firstmate", home: canonicalPath(root) }];
	const seenHomes = new Set<string>([canonicalPath(root)]);
	const seenRegistries = new Set<string>();
	const visit = (home: string): void => {
		const registry = join(home, "data", "secondmates.md");
		const registryKey = canonicalPath(registry);
		if (seenRegistries.has(registryKey)) return;
		seenRegistries.add(registryKey);
		let text: string;
		try {
			text = readFileSync(registry, "utf8");
		} catch {
			return;
		}
		const re = /^-\s+(\S+)\s+-.*?\(home:\s*([^;)\s]+)/gm;
		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null) {
			const id = match[1].trim();
			const candidateHome = canonicalPath(match[2].trim());
			if (!id || seenHomes.has(candidateHome)) continue;
			seenHomes.add(candidateHome);
			candidates.push({ id, role: "secondmate", home: candidateHome });
			visit(candidateHome);
		}
	};
	visit(canonicalPath(root));
	return candidates;
}

function normalizeRole(value: string | undefined): string | undefined {
	const role = value?.trim().toLowerCase();
	if (!role) return undefined;
	if (role === "main" || role === "supervisor" || role === "firstmate") return "firstmate";
	if (role === "shipmate" || role === "secondmate") return "secondmate";
	return role;
}

function selectorMatches(selector: CapabilitySelector, candidate: TopologyCandidate): boolean {
	const role = normalizeRole(selector.role ?? selector.kind);
	if (role && role !== normalizeRole(candidate.role)) return false;
	if (selector.id && selector.id !== candidate.id && selector.id !== basenameOfPath(candidate.home)) return false;
	return Boolean(role || selector.id);
}

function basenameOfPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function normalizeTarget(entry: Record<string, unknown>, registry: Record<string, unknown>, index: number, baseHome: string): CapabilityTarget | null {
	const homeValue = stringValue(entry.home) ?? stringValue(entry.path) ?? stringValue(entry.home_path);
	const selectors = selectorsFor(entry);
	if (!homeValue && selectors.length === 0) return null;
	const home = homeValue ? resolve(baseHome, homeValue) : "";
	const id = stringValue(entry.id) ?? stringValue(entry.name) ?? `target-${index + 1}`;
	const surfaces = stringArray(entry.surfaces ?? entry.registered_surfaces ?? entry.surface_paths ?? entry.surface).map(normalizeSurface).filter((surface): surface is string => surface !== undefined);
	const sourceRevision = stringValue(entry.source_revision) ?? stringValue(entry.sourceRevision) ?? stringValue(entry.revision) ?? stringValue(entry.loaded_revision) ?? stringValue(registry.source_revision) ?? stringValue(registry.sourceRevision);
	let requiredProbe: unknown = entry.required_probe_result ?? entry.required_probe ?? entry.probe_result ?? entry.probe ?? entry.capability_probe;
	if (requiredProbe === undefined) requiredProbe = registry.required_probe_result ?? registry.required_probe ?? registry.probe_result ?? registry.probe;
	return {
		id,
		home,
		surfaces,
		sourceRevision,
		requiredProbe,
		reloadTarget: stringValue(entry.reload_target) ?? stringValue(entry.reloadTarget) ?? stringValue(entry.pane),
		allowDetached: typeof entry.allow_detached === "boolean" ? entry.allow_detached : typeof entry.allowDetached === "boolean" ? entry.allowDetached : undefined,
		enabled: entry.enabled === false ? false : undefined,
		...(selectors[0] ? { selector: selectors[0] } : {}),
	};
}
function registryPathAllowed(path: string): boolean {
	return !canonicalPath(path).split("/").some(segment => segment === "data" || segment === "state");
}


export function readCapabilityRegistry(home: string, explicitPath?: string): { registry?: CapabilityRegistry; error?: string } {
	const paths = explicitPath ? [explicitPath] : candidateRegistryPaths(home);
	if (paths.some(candidate => !registryPathAllowed(candidate))) return { error: "capability registry must live outside data and state" };
	const path = paths.find(candidate => existsSync(candidate));
	if (!path) return { error: "capability registry unavailable" };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { error: `capability registry unreadable: ${path}` };
	}
	const parsed = parseJson(text);
	const root = objectRecord(parsed);
	const records = targetRecords(parsed);
	if (!root && !Array.isArray(parsed)) return { error: `capability registry malformed: ${path}` };
	const schema = stringValue(root?.schema);
	if (schema && schema !== CAPABILITY_REGISTRY_SCHEMA && schema !== LEGACY_CAPABILITY_REGISTRY_SCHEMA) return { error: `unsupported capability registry schema: ${schema}` };
	const candidates = topologyCandidates(home);
	let unmatchedSelector = false;
	const expandedRecords = records.flatMap(entry => {
		const selectors = selectorsFor(entry);
		if (selectors.length === 0) return [entry];
		const selected = selectors.flatMap(selector => candidates.filter(candidate => selectorMatches(selector, candidate)).map(candidate => {
			const baseId = stringValue(entry.id) ?? candidate.id;
			const id = baseId === candidate.id ? baseId : `${baseId}:${candidate.id}`;
			return { ...entry, id, home: candidate.home, selector };
		}));
		if (selected.length === 0) unmatchedSelector = true;
		return selected;
	});
	if (unmatchedSelector) return { error: `capability registry selector matched no current home: ${path}` };
	const targets = expandedRecords.map((entry, index) => normalizeTarget(entry, root ?? {}, index, home)).filter((entry): entry is CapabilityTarget => entry !== null);
	if (targets.length !== expandedRecords.length || targets.some(target => target.surfaces.length === 0)) return { error: `capability registry contains an invalid target or no registered surfaces: ${path}` };
	const unsupportedProbe = targets.find(target => !supportedRequiredProbe(target.requiredProbe));
	if (unsupportedProbe) return { error: `unsupported required_probe_result schema for target ${unsupportedProbe.id}; only activation=ok is supported: ${path}` };
	if (new Set(targets.map(target => target.id)).size !== targets.length) return { error: `capability registry contains duplicate target ids: ${path}` };
	if (targets.length === 0) return { error: `capability registry has no targets: ${path}` };
	const registryRoot = root ?? {};
	const resolvedPath = canonicalPath(path);
	const rootKey = canonicalPath(home);
	const relativePath = resolvedPath.startsWith(`${rootKey}/`) ? resolvedPath.slice(rootKey.length + 1) : basenameOfPath(resolvedPath);
	return {
		registry: {
			schema: stringValue(registryRoot.schema),
			sourceRevision: stringValue(registryRoot.source_revision) ?? stringValue(registryRoot.sourceRevision),
			requiredProbe: registryRoot.required_probe_result ?? registryRoot.required_probe ?? registryRoot.probe_result ?? registryRoot.probe,
			path: resolvedPath,
			relativePath,
			digest: registryDigest(text),
			targets,
		},
	};
}

export function capabilityForHome(registry: CapabilityRegistry | undefined, home: string): CapabilityTarget | undefined {
	if (!registry) return undefined;
	const key = canonicalPath(home);
	return registry.targets.find(target => canonicalPath(target.home) === key);
}

export function readSourceRevision(sourceHome: string): { revision?: string; error?: string } {
	const override = process.env.FM_FLEET_SOURCE_REVISION?.trim();
	if (override) return /^[0-9a-f]{40}$/i.test(override) ? { revision: override } : { error: "source revision override is not a commit id" };
	const result = spawnSync("git", ["-C", sourceHome, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	if (result.status !== 0) return { error: `source revision unavailable: ${sourceHome}` };
	const revision = result.stdout.trim();
	return /^[0-9a-f]{40}$/i.test(revision) ? { revision } : { error: "source revision is not a commit id" };
}

function git(home: string, args: string[]): GitResult {
	try {
		const result = spawnSync("git", ["-C", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return { ok: result.status === 0, stdout: result.stdout?.trim() ?? "" };
	} catch {
		return { ok: false, stdout: "" };
	}
}
function changedPaths(sourceHome: string, fromRevision: string, toRevision: string): { paths?: string[]; reason?: string } {
	if (fromRevision === toRevision) return { paths: [] };
	const result = git(sourceHome, ["diff", "--name-only", "--no-renames", fromRevision, toRevision]);
	if (!result.ok) return { reason: "source change set unavailable" };
	return { paths: result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [] };
}

function targetSurfaceChanged(target: CapabilityTarget, paths: string[]): boolean {
	return paths.some(path => target.surfaces.some(surface => path === surface || path.startsWith(`${surface}/`)));
}


function fileHash(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

function sameSurfacePath(sourcePath: string, targetPath: string, visited = new Set<string>()): boolean {
	let sourceStat;
	let targetStat;
	try {
		sourceStat = statSync(sourcePath);
		targetStat = statSync(targetPath);
	} catch {
		return false;
	}
	try {
		if (realpathSync(sourcePath) === realpathSync(targetPath)) return true;
	} catch {
		// Fall back to content comparison when links resolve differently.
	}
	if (sourceStat.isFile() && targetStat.isFile()) {
		const sourceHash = fileHash(sourcePath);
		return sourceHash !== undefined && sourceHash === fileHash(targetPath);
	}
	if (!sourceStat.isDirectory() || !targetStat.isDirectory()) return false;
	let sourceReal: string;
	let targetReal: string;
	try {
		sourceReal = realpathSync(sourcePath);
		targetReal = realpathSync(targetPath);
	} catch {
		return false;
	}
	const key = `${sourceReal}\0${targetReal}`;
	if (visited.has(key)) return true;
	visited.add(key);
	let sourceEntries: string[];
	let targetEntries: string[];
	try {
		sourceEntries = readdirSync(sourcePath).sort();
		targetEntries = readdirSync(targetPath).sort();
	} catch {
		return false;
	}
	if (sourceEntries.length !== targetEntries.length || sourceEntries.some((entry, index) => entry !== targetEntries[index])) return false;
	return sourceEntries.every(entry => sameSurfacePath(join(sourcePath, entry), join(targetPath, entry), visited));
}

function surfacesMatchSource(target: CapabilityTarget, sourceHome: string, surfaces: string[]): boolean {
	return surfaces.every(surface => sameSurfacePath(join(sourceHome, surface), join(target.home, surface)));
}
function registryPathChanged(registry: CapabilityRegistry, paths: string[]): boolean {
	const relative = registry.relativePath.replace(/^\.\/+/, "");
	return paths.some(path => path.replace(/^\.\/+/, "") === relative);
}


function defaultBranch(home: string): string | undefined {
	const head = git(home, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head.ok && head.stdout.startsWith("origin/")) return head.stdout.slice("origin/".length);
	const remote = git(home, ["remote", "show", "origin"]);
	const match = /HEAD branch:\s*(\S+)/.exec(remote.stdout);
	if (match && match[1] !== "(unknown)") return match[1];
	for (const branch of ["main", "master"]) if (git(home, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return branch;
	return undefined;
}

function isNonGitSeededHome(home: string): boolean {
	return existsSync(join(home, ".fm-secondmate-home")) && !existsSync(join(home, ".git"));
}

function validRevision(value: string | undefined): string | undefined {
	return value && /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
}

function linkedSourceRevision(target: CapabilityTarget, receipt: Receipt | undefined, transaction: TransactionState | undefined): string | undefined {
	return validRevision(transaction?.source_revision) ?? validRevision(target.sourceRevision) ?? validRevision(receipt?.source_revision);
}

function targetHasDirtyFiles(home: string): boolean {
	return isNonGitSeededHome(home) ? false : hasDirtyFiles(home);
}

function hasDirtyFiles(home: string): boolean {
	const status = git(home, ["status", "--porcelain"]);
	if (!status.ok) return true;
	const marker = existsSync(join(home, ".fm-secondmate-home"));
	return status.stdout.split(/\r?\n/).filter(Boolean).some(line => !(marker && line === "?? .fm-secondmate-home"));
}

function fastForwardTarget(target: CapabilityTarget, sourceRevision: string): FastForwardResult {
	const home = target.home;
	if (!existsSync(home)) return { status: "pending", reason: "home unavailable" };
	if (!git(home, ["rev-parse", "--is-inside-work-tree"]).ok) return { status: "pending", reason: "home is not a git worktree" };
	const before = git(home, ["rev-parse", "HEAD"]);
	if (!before.ok || !/^[0-9a-f]{40}$/i.test(before.stdout)) return { status: "pending", reason: "home revision unavailable" };
	if (!git(home, ["remote", "get-url", "origin"]).ok) return { status: "pending", reason: "home has no origin remote" };
	const branch = git(home, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const detached = !branch.ok || !branch.stdout;
	const allowDetached = target.allowDetached ?? existsSync(join(home, ".fm-secondmate-home"));
	if (detached && !allowDetached) return { status: "pending", reason: "detached HEAD" };
	if (!detached) {
		const expected = defaultBranch(home);
		if (!expected) return { status: "pending", reason: "default branch unavailable" };
		if (branch.stdout !== expected) return { status: "pending", reason: `on ${branch.stdout}, expected ${expected}` };
	}
	if (hasDirtyFiles(home)) return { status: "pending", reason: "dirty working tree" };
	if (before.stdout === sourceRevision) return { status: "current", before: before.stdout, after: before.stdout };
	if (!git(home, ["fetch", "origin", "--prune", "--quiet"]).ok) return { status: "pending", reason: "fetch failed" };
	if (!git(home, ["cat-file", "-e", `${sourceRevision}^{commit}`]).ok) return { status: "pending", reason: "source revision unavailable in target" };
	if (!git(home, ["merge-base", "--is-ancestor", "HEAD", sourceRevision]).ok) return { status: "pending", reason: "diverged from source revision" };
	if (!git(home, ["merge", "--ff-only", sourceRevision]).ok) return { status: "pending", reason: "fast-forward failed" };
	const after = git(home, ["rev-parse", "HEAD"]);
	if (!after.ok || after.stdout !== sourceRevision) return { status: "pending", reason: "fast-forward proof unavailable", before: before.stdout };
	return { status: "updated", before: before.stdout, after: after.stdout };
}

function parsePanes(value: unknown): RawPane[] {
	const root = objectRecord(value);
	const result = objectRecord(root?.result);
	const raw = result?.panes ?? root?.panes ?? root?.agents;
	if (!Array.isArray(raw)) return [];
	const panes: Array<RawPane | null> = raw.map(item => {
		const record = objectRecord(item);
		if (!record) return null;
		const legacy = objectRecord(record.agent_session);
		const legacyValue = stringValue(legacy?.value);
		const legacyKind = stringValue(legacy?.kind);
		const sessionPath = stringValue(record.agent_session_path) ?? (legacyValue && (!legacyKind || ["path", "session_path", "file"].includes(legacyKind)) ? legacyValue : undefined);
		const sessionId = stringValue(record.agent_session_id) ?? (legacyValue && ["id", "session_id"].includes(legacyKind ?? "") ? legacyValue : undefined);
		return {
			pane_id: stringValue(record.pane_id) ?? stringValue(record.id),
			session_id: sessionId,
			session_path: sessionPath,
			agent: stringValue(record.agent) ?? stringValue(legacy?.agent),
			agent_status: stringValue(record.agent_status) ?? stringValue(record.status),
			cwd: stringValue(record.cwd) ?? stringValue(record.foreground_cwd),
		};
	});
	return panes.filter((pane): pane is RawPane => pane !== null && Boolean(pane.pane_id));
}

function paneInventory(): PaneInventory {
	const fixture = process.env.FM_FLEET_PANES_FILE;
	if (fixture) {
		try {
			return { available: true, panes: parsePanes(parseJson(readFileSync(fixture, "utf8"))) };
		} catch {
			return { available: false, panes: [], reason: "pane inventory unavailable" };
		}
	}
	try {
		const result = spawnSync("herdr", ["pane", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
		if (result.status !== 0) return { available: false, panes: [], reason: "pane inventory unavailable" };
		return { available: true, panes: parsePanes(parseJson(result.stdout ?? "")) };
	} catch {
		return { available: false, panes: [], reason: "pane inventory unavailable" };
	}
}

function readReceipt(home: string, operationalHome?: string): Receipt | undefined {
	const stateOverride = process.env.FM_STATE_OVERRIDE;
	const activeHome = operationalHome ?? process.env.FM_HOME;
	const state = stateOverride && activeHome && canonicalPath(activeHome) === canonicalPath(home) ? stateOverride : join(home, "state");
	try {
		const record = objectRecord(parseJson(readFileSync(join(state, "activation-receipt.json"), "utf8")));
		if (!record) return undefined;
		return {
			schema: stringValue(record.schema),
			pane_id: stringValue(record.pane_id),
			session_id: stringValue(record.session_id),
			session_path: stringValue(record.session_path),
			started_at: stringValue(record.started_at),
			manifest_sha256: stringValue(record.manifest_sha256),
			manifest: Array.isArray(record.manifest) ? record.manifest : undefined,
			source_revision: stringValue(record.source_revision),
			required_probe_result: record.required_probe_result,
			required_probe: record.required_probe,
			capability_probe: record.capability_probe,
			probe_result: record.probe_result,
		};
	} catch {
		return undefined;
	}
}

function receiptProbe(receipt: Receipt | undefined): ProbeResult | undefined {
	if (!receipt) return undefined;
	return receipt.required_probe_result ?? receipt.required_probe ?? receipt.capability_probe ?? receipt.probe_result;
}

function receiptIdentity(receipt: Receipt | undefined): SessionIdentity | null {
	if (!receipt || (!receipt.pane_id && !receipt.session_id && !receipt.session_path)) return null;
	return { pane_id: receipt.pane_id, session_id: receipt.session_id, session_path: receipt.session_path };
}

function targetPane(target: CapabilityTarget, receipt: Receipt | undefined, inventory: PaneInventory): RawPane | undefined {
	const homeKey = canonicalPath(target.home);
	const candidates = inventory.panes.filter(pane => pane.cwd && canonicalPath(pane.cwd) === homeKey);
	if (receipt?.pane_id) {
		const receiptPane = inventory.panes.find(pane => pane.pane_id === receipt.pane_id);
		return receiptPane && receiptPane.cwd && canonicalPath(receiptPane.cwd) === homeKey ? receiptPane : undefined;
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

function boundSession(receipt: Receipt | undefined, pane: RawPane | undefined): boolean {
	if (!receipt || !pane || !receipt.pane_id || receipt.pane_id !== pane.pane_id) return false;
	if (receipt.session_id && receipt.session_id !== pane.session_id) return false;
	if (receipt.session_path && (!pane.session_path || canonicalPath(receipt.session_path) !== canonicalPath(pane.session_path))) return false;
	return Boolean(receipt.session_id || receipt.session_path) && Boolean(pane.session_id || pane.session_path);
}

function liveCleanBoundSession(receipt: Receipt | undefined, pane: RawPane | undefined, home: string): boolean {
	return pane?.agent === "omp" && pane.agent_status === "idle" && boundSession(receipt, pane) && !targetHasDirtyFiles(home);
}

function manifestForHome(home: string): string | null {
	return manifestHash(home).hash ?? null;
}

function receiptManifestValid(manifest: unknown[] | undefined): boolean {
	if (!manifest?.length) return false;
	return manifest.every(entry => {
		const record = objectRecord(entry);
		return Boolean(stringValue(record?.path) && /^[0-9a-f]{64}$/i.test(stringValue(record?.sha256) ?? ""));
	});
}

function receiptShapeComplete(receipt: Receipt | undefined, target: CapabilityTarget): boolean {
	if (target.requiredProbe === undefined) return false;
	if (!receipt || !receipt.schema?.startsWith("firstmate.activation-receipt/v")) return false;
	if (!receipt.started_at || !Number.isFinite(Date.parse(receipt.started_at))) return false;
	if (!receipt.source_revision || !/^[0-9a-f]{40}$/i.test(receipt.source_revision)) return false;
	if (!receipt.manifest_sha256 || !/^[0-9a-f]{64}$/i.test(receipt.manifest_sha256) || !receiptManifestValid(receipt.manifest)) return false;
	if (!receipt.pane_id || (!receipt.session_id && !receipt.session_path)) return false;
	return canonicalJson(receiptProbe(receipt)) === canonicalJson(target.requiredProbe);
}

function receiptComplete(receipt: Receipt | undefined, target: CapabilityTarget, sourceRevision: string, manifest: string | null): boolean {
	if (!receiptShapeComplete(receipt, target)) return false;
	return receipt!.source_revision === sourceRevision && Boolean(manifest) && receipt!.manifest_sha256!.toLowerCase() === manifest!.toLowerCase();
}

function proofFor(sourceRevision: string, manifest: string | null, receipt: Receipt | undefined): UpdateProof {
	return {
		source_revision: sourceRevision,
		manifest_sha256: manifest,
		session_identity: receiptIdentity(receipt),
		required_probe_result: receiptProbe(receipt) ?? null,
	};
}

function loadTransaction(path: string): TransactionState | undefined {
	try {
		const value = objectRecord(parseJson(readFileSync(path, "utf8")));
		if (!value || value.schema !== UPDATE_TRANSACTION_SCHEMA || typeof value.targets !== "object") return undefined;
		return value as unknown as TransactionState;
	} catch {
		return undefined;
	}
}

function persistTransaction(path: string, state: TransactionState): void {
	mkdirSync(resolve(path, ".."), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

function runReload(script: string, paneId: string, operationalHome: string): { ok: boolean; reason?: string } {
	try {
		const result = spawnSync(script, [paneId], {
			cwd: operationalHome,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: Number(process.env.FM_FLEET_UPDATE_RELOAD_TIMEOUT_MS ?? 120_000),
			env: { ...process.env, FM_HOME: operationalHome },
		});
		if (result.status !== 0) return { ok: false, reason: `exact-session reload failed${result.stderr ? `: ${result.stderr.trim().split(/\r?\n/)[0]}` : ""}` };
		return { ok: true };
	} catch {
		return { ok: false, reason: "exact-session reload unavailable" };
	}
}

function targetResult(target: CapabilityTarget, status: UpdateStatus, action: TargetUpdateResult["action"], proof: UpdateProof, reason?: string): TargetUpdateResult {
	return { target: target.id, home: target.home, status, outcome: status, action, ...(reason ? { reason } : {}), proof };
}

function stateTarget(result: TargetUpdateResult, now: string): TransactionTarget {
	return { home: result.home, status: result.status, proof: result.proof, action: result.action, reason: result.reason, updated_at: now };
}


export async function updateFleet(options: UpdateOptions = {}): Promise<FleetUpdateResult> {
	const operationalHome = options.operationalHome ?? process.env.FM_HOME ?? process.cwd();
	const sourceHome = options.sourceHome ?? process.env.FM_FLEET_SOURCE_HOME ?? sourceRootForHome(operationalHome) ?? operationalHome;
	const transactionPath = options.transactionPath ?? process.env.FM_FLEET_UPDATE_STATE ?? join(process.env.FM_STATE_OVERRIDE ?? join(operationalHome, "state"), "fleet-update.json");
	const now = options.now ?? new Date().toISOString();
	const source = readSourceRevision(sourceHome);
	if (!source.revision) throw new Error(source.error ?? "source revision unavailable");
	const loaded = readCapabilityRegistry(sourceHome, options.registryPath);
	if (!loaded.registry) throw new Error(loaded.error ?? "capability registry unavailable");
	const registry = loaded.registry;
	const transaction = loadTransaction(transactionPath);
	const inventory = paneInventory();
	const results: TargetUpdateResult[] = [];
	const nextState: TransactionState = {
		schema: UPDATE_TRANSACTION_SCHEMA,
		source_revision: source.revision,
		registry_sha256: registry.digest,
		targets: transaction?.targets ? { ...transaction.targets } : {},
		updated_at: now,
	};
	const record = (result: TargetUpdateResult): void => {
		results.push(result);
		nextState.targets[result.target] = stateTarget(result, now);
		persistTransaction(transactionPath, nextState);
	};
	const reloadScript = options.reloadScript ?? process.env.FM_FLEET_RELOAD_SCRIPT ?? join(sourceHome, "sbin", "fm-reload.sh");
	const registryChangedSinceTransaction = Boolean(transaction?.registry_sha256 && transaction.registry_sha256 !== registry.digest);

	for (const target of registry.targets) {
		if (target.enabled === false) continue;
		const receiptBefore = readReceipt(target.home, operationalHome);
		const manifestBefore = manifestForHome(target.home);
		const inventoryBefore = inventory;
		const paneBefore = inventoryBefore.available ? targetPane(target, receiptBefore, inventoryBefore) : undefined;
		const nonGitSeeded = isNonGitSeededHome(target.home);
		const seededSourceHome = nonGitSeeded ? sourceRootForHome(target.home) ?? sourceHome : sourceHome;
		const linkedRevision = nonGitSeeded ? linkedSourceRevision(target, receiptBefore, transaction) : undefined;
		const canonicalRevision = nonGitSeeded ? readSourceRevision(seededSourceHome).revision : undefined;
		const seededRevision = linkedRevision ?? canonicalRevision;
		const currentRevision = nonGitSeeded
			? (seededRevision ? { ok: true, stdout: seededRevision } : { ok: false, stdout: "" })
			: git(target.home, ["rev-parse", "HEAD"]);
		if (!currentRevision.ok) {
			record(targetResult(target, "pending", "none", proofFor(source.revision, manifestBefore, receiptBefore), nonGitSeeded ? "home source revision unavailable" : "home revision unavailable"));
			continue;
		}
		const sourceAhead = currentRevision.stdout !== source.revision;
		let changes: { paths?: string[]; reason?: string } = { paths: [] };
		if (sourceAhead) {
			if (!git(sourceHome, ["cat-file", "-e", `${currentRevision.stdout}^{commit}`]).ok) {
				record(targetResult(target, "pending", "none", proofFor(source.revision, manifestBefore, receiptBefore), "target revision unavailable in source"));
				continue;
			}
			changes = changedPaths(sourceHome, currentRevision.stdout, source.revision);
			if (!changes.paths) {
				record(targetResult(target, "pending", "none", proofFor(source.revision, manifestBefore, receiptBefore), changes.reason));
				continue;
			}
		}
		const registryChanged = registryChangedSinceTransaction || (changes.paths ? registryPathChanged(registry, changes.paths) : false);
		const surfaceChanged = sourceAhead && Boolean(changes.paths && targetSurfaceChanged(target, changes.paths));
		const staleLiveSession = !receiptComplete(receiptBefore, target, source.revision, manifestBefore)
			&& receiptShapeComplete(receiptBefore, target)
			&& liveCleanBoundSession(receiptBefore, paneBefore, target.home);
		const stillReady = receiptComplete(receiptBefore, target, source.revision, manifestBefore)
			&& liveCleanBoundSession(receiptBefore, paneBefore, target.home);
		const priorNeedsRecheck = Boolean(transaction?.targets[target.id] && !stillReady);
		const firstTransactionCurrentTarget = !transaction && currentRevision.stdout === source.revision;
		if (!registryChanged && !surfaceChanged && (!staleLiveSession || sourceAhead) && !priorNeedsRecheck && !firstTransactionCurrentTarget) continue;

		let manifest = manifestBefore;
		let receipt = receiptBefore;
		let inventoryAfter = inventory;
		let pane = paneBefore;
		if (!inventoryAfter.available) {
			record(targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt), inventoryAfter.reason ?? "pane inventory unavailable"));
			continue;
		}
		if (!pane) {
			record(targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt), "session unavailable"));
			continue;
		}
		if (pane.agent !== "omp" || pane.agent_status !== "idle") {
			record(targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt), pane.agent_status === "working" ? "session working" : "session stopped or unavailable"));
			continue;
		}
		if (!boundSession(receipt, pane)) {
			record(targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt), "session unbound"));
			continue;
		}
		if (targetHasDirtyFiles(target.home)) {
			record(targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt), "target dirty"));
			continue;
		}

		let action: TargetUpdateResult["action"] = "none";
		if (sourceAhead && !nonGitSeeded) {
			const ff = fastForwardTarget(target, source.revision);
			if (ff.status === "pending") {
				record(targetResult(target, "pending", action, proofFor(source.revision, manifest, receipt), ff.reason));
				continue;
			}
			action = ff.status === "updated" ? "fast-forward" : "none";
			manifest = manifestForHome(target.home);
			receipt = readReceipt(target.home, operationalHome);
			inventoryAfter = paneInventory();
			pane = inventoryAfter.available ? targetPane(target, receipt, inventoryAfter) : undefined;
			if (!inventoryAfter.available || !pane || pane.agent !== "omp" || pane.agent_status !== "idle" || !boundSession(receipt, pane) || targetHasDirtyFiles(target.home)) {
				record(targetResult(target, "pending", action, proofFor(source.revision, manifest, receipt), targetHasDirtyFiles(target.home) ? "target dirty" : "session changed or unavailable"));
				continue;
			}
		} else if (sourceAhead) {
			manifest = manifestForHome(target.home);
			receipt = readReceipt(target.home, operationalHome);
		}
		if (receiptComplete(receipt, target, source.revision, manifest)) {
			record(targetResult(target, "ready", action === "fast-forward" ? "fast-forward" : "noop", proofFor(source.revision, manifest, receipt)));
			continue;
		}
		if (!receiptShapeComplete(receipt, target)) {
			record(targetResult(target, "pending", action, proofFor(source.revision, manifest, receipt), "receipt incomplete"));
			continue;
		}
		if (nonGitSeeded && !surfacesMatchSource(target, seededSourceHome, target.surfaces)) {
			record(targetResult(target, "pending", action, proofFor(source.revision, manifest, receipt), "registered surface diverged from canonical source"));
			continue;
		}

		if (!pane.pane_id) {
			record(targetResult(target, "pending", action, proofFor(source.revision, manifest, receipt), "session pane identity unavailable"));
			continue;
		}
		const verifiedPaneId = pane.pane_id;
		if (isSecondmateHome(target.home)) {
			const skills = ensureSecondmateHomeSkills(target.home, { quiet: true, fmHome: operationalHome });
			if (skills && !skills.ok) {
				record(targetResult(target, "failed", action, proofFor(source.revision, manifest, receipt), `home skills: ${skills.status}`));
				continue;
			}
		}
		const reloaded = runReload(reloadScript, verifiedPaneId, operationalHome);
		if (!reloaded.ok) {
			record(targetResult(target, "failed", action, proofFor(source.revision, manifest, receipt), reloaded.reason));
			continue;
		}
		manifest = manifestForHome(target.home);
		receipt = readReceipt(target.home, operationalHome);
		inventoryAfter = paneInventory();
		pane = inventoryAfter.available ? targetPane(target, receipt, inventoryAfter) : undefined;
		if (inventoryAfter.available && liveCleanBoundSession(receipt, pane, target.home) && receiptComplete(receipt, target, source.revision, manifest)) {
			record(targetResult(target, "ready", "reload", proofFor(source.revision, manifest, receipt)));
			continue;
		}
		record(targetResult(target, "pending", "reload", proofFor(source.revision, manifest, receipt), "reload receipt incomplete or session unavailable"));
	}

	persistTransaction(transactionPath, nextState);
	return {
		schema: UPDATE_TRANSACTION_SCHEMA,
		source_revision: source.revision,
		registry: { path: registry.path, sha256: registry.digest },
		results,
		targets: results,
		transaction: transactionPath,
	};
}