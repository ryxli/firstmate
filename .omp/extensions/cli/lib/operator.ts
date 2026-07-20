// Operator finish surface helpers: compact receipts + resumable fm finish <id>.
// Efficiency: one judgment verb (accept) and one drain verb (finish <id>) replace
// the multi-lever artifact ceremony; FM_HOME isolation is a hard prerequisite.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

export type PrQueryResult = { state: string; mergeSha: string | null };

export type PrQuery = (prUrl: string) => PrQueryResult;

export function parsePrUrl(url: string): { repo: string; number: string } {
	const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url.trim());
	if (!m) throw new Error(`unrecognized PR URL: ${url}`);
	return { repo: m[1], number: m[2] };
}

/** Query PR merge state via gh-axi API (TOON output; no raw gh / JSON assumption). */
export function queryPrMergeState(prUrl: string): PrQueryResult {
	const { repo, number } = parsePrUrl(prUrl);
	const path = `/repos/${repo}/pulls/${number}`;
	const res = spawnSync("bunx", ["gh-axi", "api", path], { encoding: "utf8" });
	const out = `${res.stdout ?? ""}`.trim();
	const err = `${res.stderr ?? ""}`.trim();
	if ((res.status ?? 1) !== 0) {
		throw new Error(err || out || `gh-axi api ${path} failed`);
	}
	return parseGhAxiPullToon(out);
}

/**
 * Parse gh-axi `api /repos/.../pulls/N` TOON output.
 * Reads top-level fields `merged`, `state`, and `merge_commit_sha` only.
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
	if (merged) return { state: "MERGED", mergeSha };
	const raw = String(row.state ?? "").toUpperCase();
	if (raw === "OPEN") return { state: "OPEN", mergeSha: null };
	if (raw === "CLOSED") return { state: "CLOSED", mergeSha: null };
	return { state: raw || "UNKNOWN", mergeSha };
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
		const prUrl = metaField(readTaskMeta(taskId)?.text ?? "", "pr=");
		if (!prUrl) {
			return {
				ok: false,
				stopped: true,
				lines: [`error: ${taskId} has no pr= in meta; record the PR URL first`],
				next: `fm pr-check ${taskId} <pr-url>`,
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
					const prUrl = metaField(readTaskMeta(taskId)?.text ?? "", "pr=");
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
