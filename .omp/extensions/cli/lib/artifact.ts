// Thin artifact spine: durable data/artifacts/<taskId>.json + volatile attention
// under state/. Semantics: WorkerLoop → proven land via existing landers →
// teardown dispose. Predicates are split: dependency ≠ dispose ≠ attention.
// Efficiency: removes false-satisfied deps and false-safe teardowns without a
// parallel deliverer product.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffResolveDefaultBranch } from "./ff";

export type ReviewState =
	| "enabled"
	| "candidate"
	| "revise"
	| "accepted"
	| "abandoned"
	| "superseded";

export type DeliveryState = "queued" | "running" | "blocked" | "landed";
export type DeliveryMode = "trunk" | "pr";

export interface AcceptedRevision {
	revisionNumber: number;
	patchRef: string;
	parentSha: string;
	patchId: string;
	candidateSha: string;
}

export interface CandidateRevision extends AcceptedRevision {
	filesChanged: string[];
	evidence: string[];
	feedback?: { why: string; mustChange: string; mustRemain: string; nextAcceptanceBar: string; priorPatchIds: string[] };
	submittedAt: string;
}

export interface DeliveryReceipt {
	type: string;
	at: string;
	idempotencyKey: string;
	detail?: Record<string, unknown>;
}

export interface AcceptanceVerdict {
	by: string;
	at: string;
	criteria: string[];
	note?: string;
}

export interface ArtifactRecord {
	taskId: string;
	project: string;
	reviewState: ReviewState;
	delivery: null | { mode: DeliveryMode; state: DeliveryState; receipts: DeliveryReceipt[] };
	revisions: CandidateRevision[];
	acceptedRevision?: AcceptedRevision;
	acceptance?: AcceptanceVerdict;
	provenance?: { supersedes?: string; supersededBy?: string };
	workerBound: boolean;
	abandonReason?: string;
	/** Cap-authorized discard; required for safeToDispose when not landed. */
	discardAuthorization?: DeliveryReceipt;
	updatedAt: string;
}

export interface LandProof {
	candidateSha: string;
	patchId: string;
	trunkSha: string;
	method: "ff-merge" | "patch-id-on-trunk" | "merge-commit";
	patchEquivalent: true;
	repo: string;
	branch: string;
}

export class ArtifactError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactError";
	}
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function resolveHomeRoot(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	return process.env.FM_HOME?.trim() || rootOverride || fmRoot;
}

export function resolveDataDir(): string {
	return process.env.FM_DATA_OVERRIDE?.trim() || join(resolveHomeRoot(), "data");
}

export function resolveStateDir(): string {
	return process.env.FM_STATE_OVERRIDE?.trim() || join(resolveHomeRoot(), "state");
}

export function resolveProjectsDir(): string {
	return process.env.FM_PROJECTS_OVERRIDE?.trim() || join(resolveHomeRoot(), "projects");
}

/** Durable owner for accepted commit+verdict records. */
export function artifactPath(taskId: string, dataDir = resolveDataDir()): string {
	return join(dataDir, "artifacts", `${taskId}.json`);
}

/** Legacy volatile path - read-only migration fallback. */
function legacyArtifactPath(taskId: string, stateDir = resolveStateDir()): string {
	return join(stateDir, `${taskId}.artifact.json`);
}

export function canonicalizeDeliveryMode(raw: string): DeliveryMode {
	return raw === "trunk" ? "trunk" : "pr";
}

export function isTrunkMode(mode: string): boolean {
	return canonicalizeDeliveryMode(mode) === "trunk";
}

function nowIso(): string {
	return new Date().toISOString();
}

function writeAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Read-only artifact load: never migrates legacy state into data/artifacts/. */
export function readArtifactPure(taskId: string, dataDir = resolveDataDir()): ArtifactRecord | null {
	const durable = artifactPath(taskId, dataDir);
	if (existsSync(durable)) {
		try {
			return JSON.parse(readFileSync(durable, "utf8")) as ArtifactRecord;
		} catch {
			return null;
		}
	}
	const legacy = legacyArtifactPath(taskId);
	if (existsSync(legacy)) {
		try {
			return JSON.parse(readFileSync(legacy, "utf8")) as ArtifactRecord;
		} catch {
			return null;
		}
	}
	return null;
}

export function loadArtifact(taskId: string, dataDir = resolveDataDir()): ArtifactRecord | null {
	const durable = artifactPath(taskId, dataDir);
	if (existsSync(durable)) return JSON.parse(readFileSync(durable, "utf8")) as ArtifactRecord;
	const legacy = legacyArtifactPath(taskId);
	if (existsSync(legacy)) {
		const record = JSON.parse(readFileSync(legacy, "utf8")) as ArtifactRecord;
		saveArtifact(record, dataDir); // migrate forward once
		return record;
	}
	return null;
}

export function saveArtifact(record: ArtifactRecord, dataDir = resolveDataDir()): void {
	record.updatedAt = nowIso();
	writeAtomic(artifactPath(record.taskId, dataDir), record);
	syncAttentionIndex(dataDir);
}

function syncAttentionIndex(dataDir = resolveDataDir()): void {
	const stateDir = resolveStateDir();
	mkdirSync(stateDir, { recursive: true });
	const active = listArtifactRecords(dataDir).filter(needsAttention);
	writeAtomic(
		join(stateDir, ".artifact-attention.json"),
		active.map(r => ({
			taskId: r.taskId,
			reviewState: r.reviewState,
			deliveryState: r.delivery?.state ?? null,
			updatedAt: r.updatedAt,
		})),
	);
}

/** Pure listing: durable + legacy reads only; never migrates. */
export function listArtifactsPure(dataDir = resolveDataDir(), stateDir?: string): ArtifactRecord[] {
	const dir = join(dataDir, "artifacts");
	const out: ArtifactRecord[] = [];
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ArtifactRecord);
			} catch {
				/* skip */
			}
		}
	}
	const legacyState = stateDir ?? (dataDir.endsWith("/data") ? join(dirname(dataDir), "state") : resolveStateDir());
	if (existsSync(legacyState)) {
		for (const name of readdirSync(legacyState)) {
			if (!name.endsWith(".artifact.json")) continue;
			const taskId = name.replace(/\.artifact\.json$/, "");
			if (out.some(r => r.taskId === taskId)) continue;
			try {
				out.push(JSON.parse(readFileSync(join(legacyState, name), "utf8")) as ArtifactRecord);
			} catch {
				/* skip */
			}
		}
	}
	return out;
}

function listArtifactRecords(dataDir = resolveDataDir()): ArtifactRecord[] {
	const dir = join(dataDir, "artifacts");
	const out: ArtifactRecord[] = [];
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ArtifactRecord);
			} catch {
				/* skip */
			}
		}
	}
	// legacy scan once (may migrate via loadArtifact)
	const stateDir = resolveStateDir();
	if (existsSync(stateDir)) {
		for (const name of readdirSync(stateDir)) {
			if (!name.endsWith(".artifact.json")) continue;
			const taskId = name.replace(/\.artifact\.json$/, "");
			if (out.some(r => r.taskId === taskId)) continue;
			const r = loadArtifact(taskId, dataDir);
			if (r) out.push(r);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Predicates (do not conflate)
// ---------------------------------------------------------------------------

export function isLanded(record: ArtifactRecord): boolean {
	return record.reviewState === "accepted" && record.delivery?.state === "landed";
}

/**
 * Read-only dependency satisfaction. Never migrates artifacts or rewrites attention.
 * Use on fleet check / any transitively read-only path.
 */
export function dependencySatisfiedPure(taskId: string, dataDir = resolveDataDir(), seen = new Set<string>()): boolean {
	if (seen.has(taskId)) return false;
	seen.add(taskId);
	const r = readArtifactPure(taskId, dataDir);
	if (!r) return false;
	if (isLanded(r)) return true;
	if (r.reviewState === "superseded" && r.provenance?.supersededBy) {
		return dependencySatisfiedPure(r.provenance.supersededBy, dataDir, seen);
	}
	return false;
}

/** Dependency satisfied: landed, or a declared successor chain that eventually landed. */
export function dependencySatisfied(taskId: string, dataDir = resolveDataDir(), seen = new Set<string>()): boolean {
	if (seen.has(taskId)) return false;
	seen.add(taskId);
	const r = loadArtifact(taskId, dataDir);
	if (!r) return false;
	if (isLanded(r)) return true;
	if (r.reviewState === "superseded" && r.provenance?.supersededBy) {
		return dependencySatisfied(r.provenance.supersededBy, dataDir, seen);
	}
	return false;
}

/** Safe to dispose scaffolding: landed, or explicit discard authorization. */
export function safeToDispose(record: ArtifactRecord): boolean {
	if (isLanded(record)) return true;
	return record.discardAuthorization?.type === "discard_authorized";
}

export function authorizeDiscard(record: ArtifactRecord, by: string, reason: string): void {
	record.discardAuthorization = {
		type: "discard_authorized",
		at: nowIso(),
		idempotencyKey: `discard:${record.taskId}:${reason}`,
		detail: { by, reason },
	};
}

export function needsAttention(record: ArtifactRecord): boolean {
	if (record.reviewState === "candidate" || record.reviewState === "revise") return true;
	if (record.reviewState === "enabled" && record.workerBound) return false;
	if (record.reviewState === "accepted" && record.delivery) {
		return record.delivery.state === "queued" || record.delivery.state === "running" || record.delivery.state === "blocked";
	}
	return false;
}

export function listActiveArtifacts(dataDir = resolveDataDir()): ArtifactRecord[] {
	return listArtifactRecords(dataDir).filter(needsAttention);
}

export function ensureArtifact(taskId: string, project: string, dataDir = resolveDataDir()): ArtifactRecord {
	const existing = loadArtifact(taskId, dataDir);
	if (existing) return existing;
	const record: ArtifactRecord = {
		taskId,
		project,
		reviewState: "enabled",
		delivery: null,
		revisions: [],
		workerBound: true,
		updatedAt: nowIso(),
	};
	saveArtifact(record, dataDir);
	return record;
}

export function submitCandidate(
	record: ArtifactRecord,
	input: {
		patchRef: string;
		parentSha: string;
		patchId: string;
		candidateSha: string;
		filesChanged?: string[];
		evidence?: string[];
	},
): void {
	if (record.reviewState === "accepted" || record.reviewState === "abandoned" || record.reviewState === "superseded") {
		throw new ArtifactError(`submitCandidate refused: reviewState=${record.reviewState}`);
	}
	record.revisions.push({
		revisionNumber: record.revisions.length + 1,
		patchRef: input.patchRef,
		parentSha: input.parentSha,
		patchId: input.patchId,
		candidateSha: input.candidateSha,
		filesChanged: input.filesChanged ?? [],
		evidence: input.evidence ?? [],
		submittedAt: nowIso(),
	});
	record.reviewState = "candidate";
	record.workerBound = true;
}

export function revise(
	record: ArtifactRecord,
	packet: { why: string; mustChange: string; mustRemain: string; nextAcceptanceBar: string; priorPatchIds: string[] },
): void {
	if (record.reviewState === "accepted" || record.reviewState === "abandoned" || record.reviewState === "superseded") {
		throw new ArtifactError("revise refused: accepted artifacts never reopen; supersede instead");
	}
	const last = record.revisions[record.revisions.length - 1];
	if (last) last.feedback = packet;
	record.reviewState = "revise";
	record.workerBound = true;
}

export function accept(
	record: ArtifactRecord,
	mode: DeliveryMode,
	verdict: { by: string; criteria: string[]; note?: string },
): void {
	if (record.reviewState !== "candidate") throw new ArtifactError("accept requires reviewState=candidate");
	const last = record.revisions[record.revisions.length - 1];
	if (!last) throw new ArtifactError("accept requires a submitted revision");
	if (record.acceptedRevision) throw new ArtifactError("acceptedRevision already frozen");
	if (!verdict.by.trim()) throw new ArtifactError("accept requires verdict.by");
	record.acceptedRevision = {
		revisionNumber: last.revisionNumber,
		patchRef: last.patchRef,
		parentSha: last.parentSha,
		patchId: last.patchId,
		candidateSha: last.candidateSha,
	};
	record.acceptance = {
		by: verdict.by.trim(),
		at: nowIso(),
		criteria: [...verdict.criteria],
		note: verdict.note,
	};
	record.reviewState = "accepted";
	record.workerBound = false;
	record.delivery = {
		mode,
		state: "queued",
		receipts: [
			{
				type: "integrate_queued",
				at: nowIso(),
				idempotencyKey: `integrate_queued:${record.taskId}:${last.patchId}`,
				detail: { mode },
			},
		],
	};
}

export function abandon(record: ArtifactRecord, reason: string): void {
	if (record.reviewState === "abandoned" || record.reviewState === "superseded") {
		throw new ArtifactError(`already ${record.reviewState}`);
	}
	if (record.delivery?.state === "landed") throw new ArtifactError("already landed");
	record.reviewState = "abandoned";
	record.abandonReason = reason;
	record.workerBound = false;
}

export function supersede(record: ArtifactRecord, successorTaskId: string): void {
	if (record.reviewState !== "accepted") throw new ArtifactError("supersede requires accepted artifact");
	record.reviewState = "superseded";
	record.workerBound = false;
	record.provenance = { ...(record.provenance ?? {}), supersededBy: successorTaskId };
}

export function appendReceipt(record: ArtifactRecord, type: string, idempotencyKey: string, detail?: Record<string, unknown>): boolean {
	if (!record.delivery) return false;
	if (record.delivery.receipts.some(r => r.idempotencyKey === idempotencyKey)) return false;
	record.delivery.receipts.push({ type, at: nowIso(), idempotencyKey, detail });
	return true;
}

// ---------------------------------------------------------------------------
// Git proof helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return {
		status: result.status ?? 1,
		stdout: (result.stdout ?? "").replace(/\r?\n+$/, ""),
		stderr: (result.stderr ?? "").replace(/\r?\n+$/, ""),
	};
}

function gitOk(cwd: string, args: string[]): boolean {
	return git(cwd, args).status === 0;
}

export function projectRepo(project: string): string {
	return join(resolveProjectsDir(), project);
}

export function defaultBranch(proj: string): string | undefined {
	const cached = ffResolveDefaultBranch(proj);
	if (cached) return cached;
	for (const branch of ["main", "master"]) {
		if (gitOk(proj, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) return branch;
	}
	return undefined;
}

/** Stable patch-id for a commit's patch (first field of `git patch-id --stable`). */
export function patchIdForCommit(proj: string, sha: string): string | null {
	const show = spawnSync("git", ["-C", proj, "show", sha, "--format=", "--patch"], { encoding: "utf8" });
	if ((show.status ?? 1) !== 0 || !show.stdout?.trim()) return null;
	const pid = spawnSync("git", ["patch-id", "--stable"], { input: show.stdout, encoding: "utf8" });
	if ((pid.status ?? 1) !== 0) return null;
	return (pid.stdout ?? "").trim().split(/\s+/)[0] || null;
}

export function patchIdForRange(proj: string, parentSha: string, candidateSha: string): string | null {
	const diff = spawnSync(
		"git",
		["-C", proj, "diff", `${parentSha}..${candidateSha}`],
		{ encoding: "utf8" },
	);
	if ((diff.status ?? 1) !== 0 || !diff.stdout?.trim()) return null;
	const pid = spawnSync("git", ["patch-id", "--stable"], { input: diff.stdout, encoding: "utf8" });
	if ((pid.status ?? 1) !== 0) return null;
	return (pid.stdout ?? "").trim().split(/\s+/)[0] || null;
}

export function deriveCandidateFromGit(
	proj: string,
	candidateSha: string,
	parentSha?: string,
): { parentSha: string; patchId: string; candidateSha: string; filesChanged: string[] } {
	if (!gitOk(proj, ["cat-file", "-e", `${candidateSha}^{commit}`])) {
		throw new ArtifactError(`candidateSha not in repo: ${candidateSha}`);
	}
	let parent = parentSha ?? "";
	if (!parent) {
		parent = git(proj, ["rev-parse", `${candidateSha}^`]).stdout;
		if (!parent) throw new ArtifactError(`cannot resolve parent of ${candidateSha}`);
	} else if (!gitOk(proj, ["cat-file", "-e", `${parent}^{commit}`])) {
		throw new ArtifactError(`parentSha not in repo: ${parent}`);
	}
	const patchId = patchIdForRange(proj, parent, candidateSha) || patchIdForCommit(proj, candidateSha);
	if (!patchId) throw new ArtifactError(`cannot compute patch-id for ${parent}..${candidateSha}`);
	const files = git(proj, ["diff", "--name-only", `${parent}..${candidateSha}`]).stdout
		.split(/\r?\n/)
		.filter(Boolean);
	return { parentSha: parent, patchId, candidateSha, filesChanged: files };
}

/**
 * Prove the accepted patch is on trunk (patch-id equivalence) and mark landed.
 * Refuses arbitrary notes as proof.
 */
export function reconcileLanded(
	taskId: string,
	opts: { method?: LandProof["method"]; dataDir?: string } = {},
): ArtifactRecord {
	const dataDir = opts.dataDir ?? resolveDataDir();
	const record = loadArtifact(taskId, dataDir);
	if (!record) throw new ArtifactError(`no artifact for ${taskId}`);
	if (record.reviewState !== "accepted" || !record.delivery || !record.acceptedRevision) {
		throw new ArtifactError(`reconcileLanded requires accepted artifact with delivery`);
	}
	if (record.delivery.state === "landed") return record;

	const proj = projectRepo(record.project);
	if (!existsSync(proj)) throw new ArtifactError(`project missing: ${proj}`);
	const branch = defaultBranch(proj);
	if (!branch) throw new ArtifactError("cannot determine default branch");

	const accepted = record.acceptedRevision;
	if (!gitOk(proj, ["cat-file", "-e", `${accepted.candidateSha}^{commit}`])) {
		throw new ArtifactError(`candidateSha missing from repo: ${accepted.candidateSha}`);
	}
	const derivedId = patchIdForRange(proj, accepted.parentSha, accepted.candidateSha) || patchIdForCommit(proj, accepted.candidateSha);
	if (!derivedId) throw new ArtifactError("cannot derive patch-id from candidate");
	if (derivedId !== accepted.patchId) {
		throw new ArtifactError(`stored patchId ${accepted.patchId} != derived ${derivedId}`);
	}

	const trunkSha = git(proj, ["rev-parse", branch]).stdout;
	if (!trunkSha) throw new ArtifactError("cannot rev-parse trunk");

	// Reachability of candidate tip OR patch-id match on trunk history since parent.
	let method: LandProof["method"] = opts.method ?? "patch-id-on-trunk";
	const ancestor = gitOk(proj, ["merge-base", "--is-ancestor", accepted.candidateSha, trunkSha]);
	if (ancestor) {
		method = opts.method ?? "ff-merge";
	} else {
		const log = git(proj, ["log", "--format=%H", `${accepted.parentSha}..${trunkSha}`]);
		if (log.status !== 0) throw new ArtifactError(`cannot walk trunk history: ${log.stderr}`);
		const shas = log.stdout.split(/\r?\n/).filter(Boolean);
		let found = false;
		for (const sha of shas) {
			const pid = patchIdForCommit(proj, sha);
			if (pid === accepted.patchId) {
				found = true;
				break;
			}
		}
		if (!found) {
			record.delivery.state = "blocked";
			appendReceipt(record, "conflict", `block:patch-missing:${taskId}:${accepted.patchId}`, {
				reason: "accepted patch-id not found on trunk; not landed",
				trunkSha,
				patchId: accepted.patchId,
			});
			saveArtifact(record, dataDir);
			throw new ArtifactError(`patch-id ${accepted.patchId} not present on ${branch} (${trunkSha})`);
		}
		method = "patch-id-on-trunk";
	}

	const proof: LandProof = {
		candidateSha: accepted.candidateSha,
		patchId: accepted.patchId,
		trunkSha,
		method,
		patchEquivalent: true,
		repo: proj,
		branch,
	};
	appendReceipt(record, "landed", `landed:${taskId}:${accepted.patchId}`, { ...proof });
	record.delivery.state = "landed";
	saveArtifact(record, dataDir);
	return record;
}

/** After trunk FF integrate: prove candidate is ancestor of trunk, then land. */
export function landAfterFfMerge(taskId: string, detail: { trunkSha: string; branch: string; repo: string }, dataDir = resolveDataDir()): ArtifactRecord {
	const record = loadArtifact(taskId, dataDir);
	if (!record?.acceptedRevision || !record.delivery) {
		throw new ArtifactError(`landAfterFfMerge requires accepted artifact for ${taskId}`);
	}
	if (record.delivery.state === "landed") return record;
	const proj = detail.repo;
	const cand = record.acceptedRevision.candidateSha;
	if (!gitOk(proj, ["merge-base", "--is-ancestor", cand, detail.trunkSha])) {
		throw new ArtifactError(`FF land refused: ${cand} is not ancestor of ${detail.trunkSha}`);
	}
	const derivedId =
		patchIdForRange(proj, record.acceptedRevision.parentSha, cand) || patchIdForCommit(proj, cand);
	if (derivedId && derivedId !== record.acceptedRevision.patchId) {
		throw new ArtifactError(`patchId mismatch after FF: stored ${record.acceptedRevision.patchId} != ${derivedId}`);
	}
	const proof: LandProof = {
		candidateSha: cand,
		patchId: record.acceptedRevision.patchId,
		trunkSha: detail.trunkSha,
		method: "ff-merge",
		patchEquivalent: true,
		repo: proj,
		branch: detail.branch,
	};
	appendReceipt(record, "landed", `landed:${taskId}:${record.acceptedRevision.patchId}`, { ...proof });
	record.delivery.state = "landed";
	saveArtifact(record, dataDir);
	return record;
}

/**
 * Land from a remote merge SHA (PR observation). Does not require local default
 * branch to be current - only that mergeSha is present and carries the accepted patch-id.
 */
export function landAtMergeSha(
	taskId: string,
	detail: { mergeSha: string; branch: string; repo: string; method?: LandProof["method"] },
	dataDir = resolveDataDir(),
): ArtifactRecord {
	const record = loadArtifact(taskId, dataDir);
	if (!record?.acceptedRevision || !record.delivery) {
		throw new ArtifactError(`landAtMergeSha requires accepted artifact for ${taskId}`);
	}
	if (record.delivery.state === "landed") return record;
	const proj = detail.repo;
	const accepted = record.acceptedRevision;
	if (!gitOk(proj, ["cat-file", "-e", `${detail.mergeSha}^{commit}`])) {
		throw new ArtifactError(`mergeSha missing from repo: ${detail.mergeSha}`);
	}
	const want = accepted.patchId;
	let found = false;
	if (detail.mergeSha === accepted.candidateSha || gitOk(proj, ["merge-base", "--is-ancestor", accepted.candidateSha, detail.mergeSha])) {
		found = true;
	} else {
		const mergePid = patchIdForCommit(proj, detail.mergeSha);
		if (mergePid === want) found = true;
		else {
			const log = git(proj, ["log", "--format=%H", `${accepted.parentSha}..${detail.mergeSha}`]);
			for (const sha of log.stdout.split(/\r?\n/).filter(Boolean)) {
				if (patchIdForCommit(proj, sha) === want) {
					found = true;
					break;
				}
			}
		}
	}
	if (!found) {
		throw new ArtifactError(`accepted patch-id ${want} not found in merge ${detail.mergeSha}`);
	}
	const proof: LandProof = {
		candidateSha: accepted.candidateSha,
		patchId: accepted.patchId,
		trunkSha: detail.mergeSha,
		method: detail.method ?? "merge-commit",
		patchEquivalent: true,
		repo: proj,
		branch: detail.branch,
	};
	appendReceipt(record, "landed", `landed:${taskId}:${accepted.patchId}`, { ...proof });
	record.delivery.state = "landed";
	saveArtifact(record, dataDir);
	return record;
}
