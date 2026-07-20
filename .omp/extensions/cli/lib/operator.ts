// Operator finish surface helpers: compact receipts + resumable fm finish <id>.
// Efficiency: one judgment verb (accept) and one drain verb (finish <id>) replace
// the multi-lever artifact ceremony; FM_HOME isolation is a hard prerequisite.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import {
	type ArtifactRecord,
	appendReceipt,
	canonicalizeDeliveryMode,
	deriveCandidateFromGit,
	isLanded,
	isTrunkMode,
	landAfterFfMerge,
	landAtMergeSha,
	loadArtifact,
	projectRepo,
	resolveHomeRoot,
	resolveStateDir,
	saveArtifact,
	submitCandidate,
} from "./artifact";
import { BacklogStore } from "./backlog-store";
import { ffResolveDefaultBranch } from "./ff";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

export function receiptLine(message: string): void {
	process.stdout.write(`${message}\n`);
}

export function shortSha(sha: string): string {
	return sha.length > 12 ? sha.slice(0, 12) : sha;
}

export function metaField(contents: string, prefix: string): string {
	for (const line of contents.split(/\r?\n/)) {
		if (line.startsWith(prefix)) return line.slice(prefix.length);
	}
	return "";
}

export function readTaskMeta(taskId: string): { path: string; text: string } | null {
	const path = join(resolveStateDir(), `${taskId}.meta`);
	if (!existsSync(path)) return null;
	return { path, text: readFileSync(path, "utf8") };
}

/** Match `done: PR https://...` (optional trailing `; ...` fields). */
const DONE_PR_RE = /\bdone:\s*PR\s+(https:\/\/[^\s;]+)/i;

/**
 * Resolve PR URL from meta `pr=` or worker status `done: PR <url>`.
 * When found only in status, persist `pr=` onto meta so finish/checks stay durable.
 * Optional `fm pr-check` remains a helper; finish does not require it.
 */
export function resolvePrUrl(taskId: string): string {
	const meta = readTaskMeta(taskId);
	const fromMeta = meta ? metaField(meta.text, "pr=") : "";
	if (fromMeta) return fromMeta;

	const statusPath = join(resolveStateDir(), `${taskId}.status`);
	if (!existsSync(statusPath)) return "";
	const status = readFileSync(statusPath, "utf8");
	let found = "";
	for (const line of status.split(/\r?\n/)) {
		const m = DONE_PR_RE.exec(line);
		if (m) found = m[1];
	}
	if (!found) return "";

	if (meta?.path) {
		const lines = meta.text.split(/\r?\n/);
		if (!lines.some(l => l === `pr=${found}` || l.startsWith("pr="))) {
			appendFileSync(meta.path, meta.text.endsWith("\n") || meta.text.length === 0 ? `pr=${found}\n` : `\npr=${found}\n`);
		}
	}
	return found;
}

export function releaseWorkerPane(taskId: string): void {
	const meta = readTaskMeta(taskId);
	if (!meta) return;
	const pane = metaField(meta.text, "pane=");
	if (!pane) return;
	spawnSync("herdr", ["pane", "close", pane], { stdio: ["ignore", "ignore", "ignore"] });
}

function hasReceipt(record: ArtifactRecord, type: string): boolean {
	return Boolean(record.delivery?.receipts.some(r => r.type === type));
}

function gitOk(cwd: string, args: string[]): boolean {
	return (spawnSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "ignore", "ignore"] }).status ?? 1) === 0;
}

function gitOut(cwd: string, args: string[]): string {
	const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return (res.stdout ?? "").replace(/\r?\n+$/, "");
}

function defaultBranch(proj: string): string | undefined {
	const cached = ffResolveDefaultBranch(proj);
	if (cached) return cached;
	for (const branch of ["main", "master"]) {
		if (gitOk(proj, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) return branch;
	}
	return undefined;
}

function resolveFmBin(): string {
	return join(REPO_ROOT, "sbin", "fm");
}

function resolveBacklogPath(): string {
	return join(resolveHomeRoot(), "data", "backlog.md");
}

/** Fast-forward default branch to the frozen accepted SHA (not a drifting branch tip). */
export function integrateTrunk(
	taskId: string,
	proj: string,
	acceptedSha: string,
): { trunkSha: string; branch: string } {
	const modeMeta = readTaskMeta(taskId);
	const mode = modeMeta ? metaField(modeMeta.text, "mode=") : "";
	if (mode && !isTrunkMode(mode)) {
		throw new Error(`task ${taskId} is mode=${mode}, not trunk`);
	}
	const fullAccepted = gitOut(proj, ["rev-parse", acceptedSha]);
	if (!fullAccepted) throw new Error(`acceptedSha not in repo: ${acceptedSha}`);

	const branch = `fm/${taskId}`;
	if (!gitOk(proj, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
		throw new Error(`branch ${branch} does not exist in ${proj}`);
	}
	const tip = gitOut(proj, ["rev-parse", branch]);
	if (tip !== fullAccepted) {
		throw new Error(
			`${branch} advanced after accept (${shortSha(tip)} != ${shortSha(fullAccepted)}); refuse`,
		);
	}

	const def = defaultBranch(proj);
	if (!def) throw new Error(`cannot determine default branch for ${proj}`);
	const cur = gitOut(proj, ["symbolic-ref", "--short", "HEAD"]);
	if (cur !== def) {
		throw new Error(`${proj} is on '${cur}', expected default branch '${def}'`);
	}
	const dirty = spawnSync("git", ["-C", proj, "status", "--porcelain"], { encoding: "utf8" });
	if ((dirty.stdout ?? "").split(/\r?\n/)[0]) {
		throw new Error(`${proj} has a dirty working tree; refusing to merge`);
	}

	const before = gitOut(proj, ["rev-parse", def]);
	if (before === fullAccepted) {
		return { trunkSha: fullAccepted, branch: def };
	}
	if (!gitOk(proj, ["merge-base", "--is-ancestor", def, fullAccepted])) {
		throw new Error(`${shortSha(fullAccepted)} is not a fast-forward of ${def}`);
	}
	const mergeRes = spawnSync("git", ["-C", proj, "merge", "--ff-only", fullAccepted], {
		stdio: ["ignore", "ignore", "pipe"],
		encoding: "utf8",
	});
	if ((mergeRes.status ?? 1) !== 0) {
		throw new Error((mergeRes.stderr ?? "").trim() || `ff-only merge of ${shortSha(fullAccepted)} failed`);
	}
	const after = gitOut(proj, ["rev-parse", def]);
	if (after !== fullAccepted) {
		throw new Error(`default branch is ${shortSha(after)}, expected accepted ${shortSha(fullAccepted)}`);
	}
	return { trunkSha: after, branch: def };
}

export type PrQueryResult = {
	state: string;
	mergeSha: string | null;
	/** PR head commit OID when present in the API payload. */
	headSha?: string | null;
	/** owner/repo from the PR URL (base repository). */
	repo?: string;
};

export type PrQuery = (prUrl: string) => PrQueryResult;

export function parsePrUrl(url: string): { repo: string; number: string } {
	const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url.trim());
	if (!m) throw new Error(`unrecognized PR URL: ${url}`);
	return { repo: m[1], number: m[2] };
}

/** Parse git remote URL into owner/repo when it points at GitHub. */
export function resolveGithubRepoFromRemote(remoteUrl: string): string | null {
	const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
	const https = /github\.com[/:]([^/]+\/[^/]+)$/i.exec(trimmed.replace(/^ssh:\/\//i, ""));
	if (https) return https[1];
	const scp = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(trimmed);
	if (scp) return scp[1];
	return null;
}

/** Resolve the task project's GitHub owner/repo from origin, else null. */
export function resolveProjectGithubRepo(projectPath: string): string | null {
	if (!projectPath || !existsSync(projectPath)) return null;
	const remote = gitOut(projectPath, ["remote", "get-url", "origin"]);
	if (!remote) return null;
	return resolveGithubRepoFromRemote(remote);
}

function readPrHeadSha(row: Record<string, unknown>): string | null {
	const folded = row["head.sha"];
	if (typeof folded === "string" && folded.length > 0 && folded !== "null") return folded;
	const head = row.head;
	if (head && typeof head === "object" && !Array.isArray(head)) {
		const sha = (head as Record<string, unknown>).sha;
		if (typeof sha === "string" && sha.length > 0 && sha !== "null") return sha;
	}
	return null;
}

/** Query PR via gh-axi API (TOON). Honors FM_PR_API_FIXTURE for tests. */
export function queryPrMergeState(prUrl: string): PrQueryResult {
	const { repo, number } = parsePrUrl(prUrl);
	const fixture = process.env.FM_PR_API_FIXTURE?.trim();
	if (fixture) {
		const detail = parseGhAxiPullToon(readFileSync(fixture, "utf8"));
		return { ...detail, repo: detail.repo ?? repo };
	}
	const path = `/repos/${repo}/pulls/${number}`;
	const res = spawnSync("bunx", ["gh-axi", "api", path], { encoding: "utf8" });
	const out = `${res.stdout ?? ""}`.trim();
	const err = `${res.stderr ?? ""}`.trim();
	if ((res.status ?? 1) !== 0) {
		throw new Error(err || out || `gh-axi api ${path} failed`);
	}
	const detail = parseGhAxiPullToon(out);
	return { ...detail, repo: detail.repo ?? repo };
}

/**
 * Parse gh-axi `api /repos/.../pulls/N` TOON output.
 * Reads merged/state/merge_commit_sha and head SHA (nested head.sha or folded head.sha).
 */
export function parseGhAxiPullToon(text: string): PrQueryResult {
	let decoded: unknown;
	try {
		decoded = decode(text.trim());
	} catch (err) {
		throw new Error(`gh-axi api TOON decode failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error("gh-axi api TOON root is not an object");
	}
	const row = decoded as Record<string, unknown>;
	const merged = row.merged === true || row.merged === "true";
	const mergeRaw = row.merge_commit_sha;
	const mergeSha =
		typeof mergeRaw === "string" && mergeRaw.length > 0 && mergeRaw !== "null" ? mergeRaw : null;
	const headSha = readPrHeadSha(row);
	const base: PrQueryResult = { headSha, mergeSha };
	if (merged) return { ...base, state: "MERGED" };
	const raw = String(row.state ?? "").toUpperCase();
	if (raw === "OPEN") return { ...base, state: "OPEN" };
	if (raw === "CLOSED") return { ...base, state: "CLOSED" };
	return { ...base, state: raw || "UNKNOWN" };
}

function normalizeSha(sha: string): string {
	return sha.trim().toLowerCase();
}

/**
 * Before PR accept freezes: PR URL repo must match the project's origin GitHub
 * repo, and PR head SHA must equal the frozen candidate SHA.
 */
export function assertPrMatchesAccept(opts: {
	prUrl: string;
	candidateSha: string;
	projectPath: string;
	/** Injected owner/repo for tests; default resolves from project origin. */
	projectGithubRepo?: string;
	detail?: PrQueryResult;
	queryPr?: PrQuery;
}): { prUrl: string; headSha: string; repo: string } {
	const { prUrl, candidateSha, projectPath } = opts;
	const parsed = parsePrUrl(prUrl);
	const detail = opts.detail ?? (opts.queryPr ?? queryPrMergeState)(prUrl);
	const prRepo = (detail.repo ?? parsed.repo).toLowerCase();
	const projectRepoName = (opts.projectGithubRepo ?? resolveProjectGithubRepo(projectPath))?.toLowerCase();
	if (!projectRepoName) {
		throw new Error(
			`cannot resolve GitHub repo for project at ${projectPath}; set origin to github.com/owner/repo before accept`,
		);
	}
	if (prRepo !== projectRepoName) {
		throw new Error(`PR repo ${prRepo} does not match project origin ${projectRepoName}`);
	}
	const headSha = detail.headSha?.trim() ?? "";
	if (!headSha) {
		throw new Error(`PR ${prUrl} has no head SHA; cannot prove it matches the candidate`);
	}
	const want = normalizeSha(candidateSha);
	const got = normalizeSha(headSha);
	if (want !== got) {
		throw new Error(
			`PR head ${shortSha(headSha)} != candidate ${shortSha(candidateSha)}; refuse accept (stale or wrong PR)`,
		);
	}
	return { prUrl, headSha, repo: prRepo };
}

export type FinishStepResult = {
	ok: boolean;
	stopped?: boolean;
	waiting?: boolean;
	lines: string[];
	next?: string;
};

export type FinishOpts = {
	/** Injected PR query for tests; default uses gh-axi api. */
	queryPr?: PrQuery;
};

/**
 * Resumable per-task finish: integrate → land → backlog close → cleanup.
 * Each step is idempotent via delivery receipts / landed state.
 * PR mode is observation-only: waiting if not merged (never marks blocked).
 */
export function finishTask(taskId: string, opts: FinishOpts = {}): FinishStepResult {
	const lines: string[] = [];
	let record = loadArtifact(taskId);
	if (!record) {
		return { ok: false, lines: [`error: no artifact for ${taskId}`], next: `fm accept ${taskId}` };
	}
	if (record.reviewState !== "accepted" && !isLanded(record)) {
		return {
			ok: false,
			lines: [`error: ${taskId} reviewState=${record.reviewState}; accept before finish`],
			next: `fm accept ${taskId}`,
		};
	}
	if (!record.delivery) {
		return { ok: false, lines: [`error: ${taskId} has no delivery record`] };
	}

	const mode = canonicalizeDeliveryMode(record.delivery.mode);
	const proj = projectRepo(record.project);
	const patchId = record.acceptedRevision?.patchId ?? "unknown";
	let lastTrunkSha = "";

	// --- PR path: observation-only (no local trunk integrate) ---
	if (mode === "pr" && !isLanded(record)) {
		const prUrl = resolvePrUrl(taskId);
		if (!prUrl) {
			return {
				ok: false,
				stopped: true,
				lines: [
					`error: ${taskId} has no PR URL (meta pr= or status done: PR <url>); worker must report the URL before finish`,
				],
				next: `ensure status has done: PR <url>, then fm finish ${taskId}`,
			};
		}
		let status: PrQueryResult;
		try {
			status = (opts.queryPr ?? queryPrMergeState)(prUrl);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				stopped: true,
				lines: [`error: ${taskId}: cannot query PR - ${msg}`],
				next: `fm finish ${taskId}`,
			};
		}
		if (status.state !== "MERGED") {
			return {
				ok: false,
				waiting: true,
				lines: [`waiting ${taskId}: PR not merged`],
				next: `fm finish ${taskId}`,
			};
		}
		if (!status.mergeSha) {
			return {
				ok: false,
				stopped: true,
				lines: [`error: ${taskId}: PR merged but no merge commit OID`],
				next: `fm finish ${taskId}`,
			};
		}
		try {
			if (!gitOk(proj, ["cat-file", "-e", `${status.mergeSha}^{commit}`])) {
				// Best-effort fetch; still observation - do not advance local default.
				spawnSync("git", ["-C", proj, "fetch", "origin", status.mergeSha], {
					stdio: ["ignore", "ignore", "ignore"],
				});
			}
			landAtMergeSha(taskId, {
				mergeSha: status.mergeSha,
				branch: "origin",
				repo: proj,
				method: "merge-commit",
			});
			record = loadArtifact(taskId)!;
			lines.push(`landed ${taskId} as ${shortSha(status.mergeSha)}; patch-equivalent (pr)`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				stopped: true,
				lines: [...lines, `error: ${taskId}: land from PR merge failed - ${msg}`],
				next: `fm finish ${taskId}`,
			};
		}
	}

	// 1. Integrate (trunk only)
	if (mode === "trunk" && !isLanded(record) && !hasReceipt(record, "finish:integrated")) {
		const acceptedSha = record.acceptedRevision?.candidateSha;
		if (!acceptedSha) {
			return { ok: false, lines: [`error: ${taskId} missing acceptedRevision.candidateSha`] };
		}
		try {
			const { trunkSha, branch } = integrateTrunk(taskId, proj, acceptedSha);
			lastTrunkSha = trunkSha;
			record = loadArtifact(taskId)!;
			appendReceipt(record, "finish:integrated", `finish:integrated:${taskId}:${patchId}`, {
				trunkSha,
				branch,
				acceptedSha,
			});
			saveArtifact(record);
			lines.push(`integrated ${taskId} onto ${branch} (${shortSha(trunkSha)})`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			record = loadArtifact(taskId)!;
			if (record.delivery) record.delivery.state = "blocked";
			appendReceipt(record, "finish:integrate_blocked", `finish:integrate_blocked:${taskId}:${Date.now()}`, {
				reason: msg,
			});
			saveArtifact(record);
			return {
				ok: false,
				stopped: true,
				lines: [...lines, `blocked ${taskId}: integrate failed - ${msg}`],
				next: `restore fm/${taskId} to accepted SHA, then fm finish ${taskId}`,
			};
		}
	}

	// 2. Land (trunk)
	record = loadArtifact(taskId)!;
	if (mode === "trunk" && !isLanded(record)) {
		try {
			const def = defaultBranch(proj);
			const trunkSha = lastTrunkSha || (def ? gitOut(proj, ["rev-parse", def]) : "");
			const acceptedSha = record.acceptedRevision?.candidateSha ?? "";
			if (def && trunkSha && acceptedSha) {
				if (trunkSha !== gitOut(proj, ["rev-parse", acceptedSha])) {
					throw new Error(
						`default branch ${shortSha(trunkSha)} != accepted ${shortSha(acceptedSha)} before land`,
					);
				}
				landAfterFfMerge(taskId, { trunkSha, branch: def, repo: proj });
			} else {
				reconcileLanded(taskId);
			}
			record = loadArtifact(taskId)!;
			const trunk = String(
				record.delivery?.receipts.find(r => r.type === "landed")?.detail?.trunkSha ??
					record.acceptedRevision?.candidateSha ??
					"",
			);
			lines.push(`landed ${taskId} as ${shortSha(trunk)}; patch-equivalent`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			record = loadArtifact(taskId)!;
			if (record.delivery && record.delivery.state !== "landed") record.delivery.state = "blocked";
			saveArtifact(record);
			return {
				ok: false,
				stopped: true,
				lines: [...lines, `blocked ${taskId}: land failed - ${msg}`],
				next: `fix integrate, then fm finish ${taskId}`,
			};
		}
	} else if (isLanded(record) && !hasReceipt(record, "finish:landed_ack")) {
		appendReceipt(record, "finish:landed_ack", `finish:landed_ack:${taskId}:${patchId}`);
		saveArtifact(record);
		if (!lines.some(l => l.startsWith("landed "))) lines.push(`landed ${taskId}: already proven`);
	}

	// 3. Backlog close
	record = loadArtifact(taskId)!;
	if (!hasReceipt(record, "finish:backlog_done")) {
		const backlogPath = resolveBacklogPath();
		if (existsSync(backlogPath)) {
			try {
				const store = BacklogStore.load(backlogPath);
				if (store.get(taskId)) {
					const trunk = String(
						record.delivery?.receipts.find(r => r.type === "landed")?.detail?.trunkSha ??
							record.acceptedRevision?.candidateSha ??
							"landed",
					);
					const prUrl = resolvePrUrl(taskId);
					const proof = mode === "pr" && prUrl ? prUrl : `landed:${shortSha(trunk)}`;
					store.transition(taskId, "done", { proof });
					store.save();
					lines.push(`closed ${taskId} in backlog (${proof})`);
				} else {
					lines.push(`closed ${taskId}: no backlog row`);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					ok: false,
					stopped: true,
					lines: [...lines, `blocked ${taskId}: backlog close failed - ${msg}`],
					next: `fm finish ${taskId}`,
				};
			}
		}
		record = loadArtifact(taskId)!;
		appendReceipt(record, "finish:backlog_done", `finish:backlog_done:${taskId}:${patchId}`);
		saveArtifact(record);
	}

	// 4. Cleanup (teardown)
	record = loadArtifact(taskId)!;
	if (!hasReceipt(record, "finish:cleaned")) {
		const meta = readTaskMeta(taskId);
		if (meta) {
			const fm = resolveFmBin();
			const res = spawnSync(fm, ["teardown", taskId], {
				encoding: "utf8",
				env: { ...process.env, FM_HOME: resolveHomeRoot() },
			});
			if ((res.status ?? 1) !== 0) {
				const err = (res.stderr ?? res.stdout ?? "").trim().split(/\r?\n/).slice(0, 3).join("; ");
				return {
					ok: false,
					stopped: true,
					lines: [...lines, `blocked ${taskId}: cleanup failed - ${err || "teardown refused"}`],
					next: `fm teardown ${taskId}  # or fm finish ${taskId} after fixing`,
				};
			}
			lines.push(`cleaned ${taskId}; workspace removed`);
		} else {
			lines.push(`cleaned ${taskId}: no meta (already torn down)`);
		}
		record = loadArtifact(taskId) ?? record;
		if (record.delivery) {
			appendReceipt(record, "finish:cleaned", `finish:cleaned:${taskId}:${patchId}`);
			saveArtifact(record);
		}
	}

	lines.push(`finished ${taskId}`);
	return { ok: true, lines };
}

/** Resolve candidate sha from worktree HEAD or explicit --sha. */
export function resolveCandidateSha(taskId: string, project: string, explicit?: string): string {
	if (explicit) return explicit;
	const meta = readTaskMeta(taskId);
	const wt = meta ? metaField(meta.text, "worktree=") : "";
	if (wt && existsSync(wt) && gitOk(wt, ["rev-parse", "HEAD"])) {
		return gitOut(wt, ["rev-parse", "HEAD"]);
	}
	const branch = `fm/${taskId}`;
	const proj = projectRepo(project);
	if (gitOk(proj, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
		return gitOut(proj, ["rev-parse", branch]);
	}
	throw new Error(`cannot derive candidate sha for ${taskId}; pass --sha`);
}

export function deriveAndSubmitCandidate(
	record: ArtifactRecord,
	opts: { sha?: string; parent?: string },
): { candidateSha: string; parentSha: string; patchId: string } {
	const sha = resolveCandidateSha(record.taskId, record.project, opts.sha);
	const derived = deriveCandidateFromGit(projectRepo(record.project), sha, opts.parent);
	submitCandidate(record, {
		patchRef: `git:${derived.parentSha}..${derived.candidateSha}`,
		parentSha: derived.parentSha,
		patchId: derived.patchId,
		candidateSha: derived.candidateSha,
		filesChanged: derived.filesChanged,
		evidence: ["derived-from-git"],
	});
	return derived;
}
