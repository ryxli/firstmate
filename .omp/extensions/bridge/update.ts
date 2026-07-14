import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { manifestHash } from "./collect";

export const CAPABILITY_REGISTRY_SCHEMA = "firstmate.capability-registry/v1" as const;
export const UPDATE_TRANSACTION_SCHEMA = "firstmate.fleet-update/v1" as const;

export type ProbeResult = unknown;

export interface CapabilityTarget {
	id: string;
	home: string;
	sourceRevision?: string;
	requiredProbe?: ProbeResult;
	reloadTarget?: string;
	allowDetached?: boolean;
	enabled?: boolean;
}

export interface CapabilityRegistry {
	schema?: string;
	sourceRevision?: string;
	requiredProbe?: ProbeResult;
	path: string;
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
		join(home, "data", "fleet-capabilities.json"),
		join(home, "data", "capability-registry.json"),
		join(home, "data", "capabilities.json"),
		join(home, "state", "capability-registry.json"),
	];
}

function targetRecords(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.map(objectRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
	const record = objectRecord(value);
	if (!record) return [];
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

function normalizeTarget(entry: Record<string, unknown>, registry: Record<string, unknown>, index: number): CapabilityTarget | null {
	const home = stringValue(entry.home) ?? stringValue(entry.path) ?? stringValue(entry.home_path);
	if (!home) return null;
	const id = stringValue(entry.id) ?? stringValue(entry.name) ?? `target-${index + 1}`;
	const sourceRevision = stringValue(entry.source_revision) ?? stringValue(entry.sourceRevision) ?? stringValue(entry.revision) ?? stringValue(entry.loaded_revision) ?? stringValue(registry.source_revision) ?? stringValue(registry.sourceRevision);
	let requiredProbe: unknown = entry.required_probe_result ?? entry.required_probe ?? entry.probe_result ?? entry.probe ?? entry.capability_probe;
	if (requiredProbe === undefined) requiredProbe = registry.required_probe_result ?? registry.required_probe ?? registry.probe_result ?? registry.probe;
	return {
		id,
		home,
		sourceRevision,
		requiredProbe,
		reloadTarget: stringValue(entry.reload_target) ?? stringValue(entry.reloadTarget) ?? stringValue(entry.pane),
		allowDetached: typeof entry.allow_detached === "boolean" ? entry.allow_detached : typeof entry.allowDetached === "boolean" ? entry.allowDetached : undefined,
		enabled: entry.enabled === false ? false : undefined,
	};
}

export function readCapabilityRegistry(home: string, explicitPath?: string): { registry?: CapabilityRegistry; error?: string } {
	const paths = explicitPath ? [explicitPath] : candidateRegistryPaths(home);
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
	if (schema && schema !== CAPABILITY_REGISTRY_SCHEMA) return { error: `unsupported capability registry schema: ${schema}` };
	const targets = records.map((entry, index) => normalizeTarget(entry, root ?? {}, index)).filter((entry): entry is CapabilityTarget => entry !== null);
	if (targets.length !== records.length) return { error: `capability registry contains an invalid target: ${path}` };
	if (new Set(targets.map(target => target.id)).size !== targets.length) return { error: `capability registry contains duplicate target ids: ${path}` };
	if (targets.length === 0) return { error: `capability registry has no targets: ${path}` };
	const registryRoot = root ?? {};
	return {
		registry: {
			schema: stringValue(registryRoot.schema),
			sourceRevision: stringValue(registryRoot.source_revision) ?? stringValue(registryRoot.sourceRevision),
			requiredProbe: registryRoot.required_probe_result ?? registryRoot.required_probe ?? registryRoot.probe_result ?? registryRoot.probe,
			path,
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
	if (override) return { revision: override };
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

function defaultBranch(home: string): string | undefined {
	const head = git(home, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head.ok && head.stdout.startsWith("origin/")) return head.stdout.slice("origin/".length);
	const remote = git(home, ["remote", "show", "origin"]);
	const match = /HEAD branch:\s*(\S+)/.exec(remote.stdout);
	if (match && match[1] !== "(unknown)") return match[1];
	for (const branch of ["main", "master"]) if (git(home, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return branch;
	return undefined;
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
	if (before.stdout === sourceRevision) return { status: "current", before: before.stdout, after: before.stdout };
	if (!git(home, ["remote", "get-url", "origin"]).ok) return { status: "pending", reason: "home has no origin remote" };
	const branch = git(home, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const detached = !branch.ok || !branch.stdout;
	const allowDetached = target.allowDetached ?? existsSync(join(home, ".fm-secondmate-home"));
	if (detached && !allowDetached) return { status: "pending", reason: "detached HEAD" };
	if (!detached) {
		const expected = defaultBranch(home);
		if (!expected) return { status: "pending", reason: "default branch unavailable" };
		if (branch.stdout !== expected) {
			const upstream = git(home, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
			if (!upstream.ok || upstream.stdout !== `origin/${branch.stdout}`) return { status: "pending", reason: `on ${branch.stdout}, expected ${expected}` };
		}
	}
	if (hasDirtyFiles(home)) return { status: "pending", reason: "dirty working tree" };
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
			agent: stringValue(record.agent),
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
		const value = objectRecord(parseJson(readFileSync(join(state, "activation-receipt.json"), "utf8")));
		return value as Receipt | null ?? undefined;
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
	const receiptHasId = Boolean(receipt.session_id);
	const receiptHasPath = Boolean(receipt.session_path);
	const paneHasId = Boolean(pane.session_id);
	const paneHasPath = Boolean(pane.session_path);
	if (!paneHasId && !paneHasPath) return false;
	return (receiptHasId && paneHasId && receipt.session_id === pane.session_id) || (receiptHasPath && paneHasPath && canonicalPath(receipt.session_path!) === canonicalPath(pane.session_path!));
}

function manifestForHome(home: string): string | null {
	return manifestHash(home).hash ?? null;
}

function receiptShapeComplete(receipt: Receipt | undefined, target: CapabilityTarget): boolean {
	if (target.requiredProbe === undefined) return false;
	if (!receipt || !receipt.schema?.startsWith("firstmate.activation-receipt/v")) return false;
	if (!receipt.source_revision || !receipt.manifest_sha256 || !/^[0-9a-f]{64}$/i.test(receipt.manifest_sha256)) return false;
	if (!receipt.pane_id || (!receipt.session_id && !receipt.session_path)) return false;
	return canonicalJson(receiptProbe(receipt)) === canonicalJson(target.requiredProbe);
}

function receiptComplete(receipt: Receipt | undefined, target: CapabilityTarget, sourceRevision: string, manifest: string | null): boolean {
	if (!receiptShapeComplete(receipt, target)) return false;
	return receipt!.source_revision === sourceRevision && Boolean(manifest) && receipt!.manifest_sha256!.toLowerCase() === manifest!.toLowerCase();
}

function proofFor(sourceRevision: string, manifest: string | null, receipt: Receipt | undefined, target: CapabilityTarget): UpdateProof {
	return {
		source_revision: sourceRevision,
		manifest_sha256: manifest,
		session_identity: receiptIdentity(receipt),
		required_probe_result: target.requiredProbe === undefined ? null : target.requiredProbe,
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

function runReload(script: string, target: CapabilityTarget, operationalHome: string): { ok: boolean; reason?: string } {
	const reloadTarget = target.reloadTarget ?? `fm-${target.id}`;
	try {
		const result = spawnSync(script, [reloadTarget], {
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

function previousProofIsCurrent(previous: TransactionTarget | undefined, target: CapabilityTarget, sourceRevision: string, manifest: string | null, receipt: Receipt | undefined, pane: RawPane | undefined): boolean {
	const identity = receiptIdentity(receipt);
	return previous?.status === "ready" && previous.home === target.home && previous.proof.source_revision === sourceRevision && previous.proof.manifest_sha256 === manifest && canonicalJson(previous.proof.session_identity) === canonicalJson(identity) && receiptComplete(receipt, target, sourceRevision, manifest) && boundSession(receipt, pane);
}

export async function updateFleet(options: UpdateOptions = {}): Promise<FleetUpdateResult> {
	const sourceHome = options.sourceHome ?? process.env.FM_FLEET_SOURCE_HOME ?? process.env.FM_ROOT_OVERRIDE ?? process.cwd();
	const operationalHome = options.operationalHome ?? process.env.FM_HOME ?? sourceHome;
	const transactionPath = options.transactionPath ?? process.env.FM_FLEET_UPDATE_STATE ?? join(process.env.FM_STATE_OVERRIDE ?? join(operationalHome, "state"), "fleet-update.json");
	const now = options.now ?? new Date().toISOString();
	const source = readSourceRevision(sourceHome);
	if (!source.revision) throw new Error(source.error ?? "source revision unavailable");
	const loaded = readCapabilityRegistry(operationalHome, options.registryPath);
	if (!loaded.registry) throw new Error(loaded.error ?? "capability registry unavailable");
	const registry = loaded.registry;
	const transaction = loadTransaction(transactionPath);
	const inventory = paneInventory();
	const results: TargetUpdateResult[] = [];
	const nextState: TransactionState = {
		schema: UPDATE_TRANSACTION_SCHEMA,
		source_revision: source.revision,
		registry_sha256: registry.digest,
		targets: {},
		updated_at: now,
	};
	const reloadScript = options.reloadScript ?? process.env.FM_FLEET_RELOAD_SCRIPT ?? join(sourceHome, "sbin", "fm-reload.sh");

	for (const target of registry.targets) {
		if (target.enabled === false) {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, null, undefined, target), "target disabled");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		const receiptBefore = readReceipt(target.home, operationalHome);
		const paneBefore = targetPane(target, receiptBefore, inventory);
		const manifestBefore = manifestForHome(target.home);
		const previous = transaction?.source_revision === source.revision && transaction.registry_sha256 === registry.digest ? transaction.targets[target.id] : undefined;
		if (previousProofIsCurrent(previous, target, source.revision, manifestBefore, receiptBefore, paneBefore)) {
			const result = targetResult(target, "ready", "noop", previous!.proof);
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}

		const currentRevision = git(target.home, ["rev-parse", "HEAD"]);
		const affected = !currentRevision.ok || currentRevision.stdout !== source.revision || !receiptComplete(receiptBefore, target, source.revision, manifestBefore);
		if (!affected) {
			const result = targetResult(target, "ready", "noop", proofFor(source.revision, manifestBefore, receiptBefore, target));
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}

		let manifest = manifestBefore;
		let receipt = receiptBefore;
		let inventoryAfter = inventory;
		let pane = paneBefore;
		if (!inventoryAfter.available) {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt, target), inventoryAfter.reason ?? "pane inventory unavailable");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		if (!pane) {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt, target), "session unavailable");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		if (pane.agent !== "omp" || pane.agent_status !== "idle") {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt, target), pane.agent_status === "working" ? "session working" : "session stopped or unavailable");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		if (!boundSession(receipt, pane)) {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt, target), "session unbound");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		if (!receiptShapeComplete(receipt, target)) {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt, target), "receipt incomplete");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		let ff: FastForwardResult = { status: "current" };
		if (!currentRevision.ok || currentRevision.stdout !== source.revision) ff = fastForwardTarget(target, source.revision);
		manifest = manifestForHome(target.home);
		receipt = readReceipt(target.home, operationalHome);
		inventoryAfter = paneInventory();
		pane = targetPane(target, receipt, inventoryAfter);
		if (ff.status === "pending") {
			const result = targetResult(target, "pending", "none", proofFor(source.revision, manifest, receipt, target), ff.reason);
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		if (!inventoryAfter.available || !pane || pane.agent !== "omp" || pane.agent_status !== "idle" || !boundSession(receipt, pane)) {
			const result = targetResult(target, "pending", ff.status === "updated" ? "fast-forward" : "none", proofFor(source.revision, manifest, receipt, target), "session changed or unavailable");
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		if (receiptComplete(receipt, target, source.revision, manifest)) {
			const result = targetResult(target, "ready", ff.status === "updated" ? "fast-forward" : "noop", proofFor(source.revision, manifest, receipt, target));
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}

		const reloaded = runReload(reloadScript, target, operationalHome);
		if (!reloaded.ok) {
			const result = targetResult(target, "failed", "none", proofFor(source.revision, manifest, receipt, target), reloaded.reason);
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		manifest = manifestForHome(target.home);
		receipt = readReceipt(target.home, operationalHome);
		inventoryAfter = paneInventory();
		pane = targetPane(target, receipt, inventoryAfter);
		if (inventoryAfter.available && pane && pane.agent === "omp" && pane.agent_status === "idle" && boundSession(receipt, pane) && receiptComplete(receipt, target, source.revision, manifest)) {
			const result = targetResult(target, "ready", "reload", proofFor(source.revision, manifest, receipt, target));
			results.push(result);
			nextState.targets[target.id] = stateTarget(result, now);
			persistTransaction(transactionPath, nextState);
			continue;
		}
		const result = targetResult(target, "pending", "reload", proofFor(source.revision, manifest, receipt, target), "reload receipt incomplete or session unavailable");
		results.push(result);
		nextState.targets[target.id] = stateTarget(result, now);
		persistTransaction(transactionPath, nextState);
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