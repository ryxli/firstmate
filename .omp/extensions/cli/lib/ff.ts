// fm lib: ff - shared fast-forward-only git mechanics for firstmate.
// Ported behavior-preserving from sbin/fm-ff-lib.sh.
//
// Sourced (in bash) by fm update (self-update of the firstmate repo +
// secondmate homes) and fm fleet-sync (refresh of project clones). Both
// perform the same fast-forward-only core: resolve the default branch from
// cached origin/HEAD, fetch origin, confirm the local ref is a clean ancestor
// of origin, then apply `git merge --ff-only`. This library holds exactly
// that shared core so the two callers cannot drift.
//
// It deliberately does NOT hold the parts that legitimately differ between the
// callers - each wrapper keeps its own distinct semantics:
//   - the default-branch FALLBACK when origin/HEAD is not cached (fm update
//     queries the remote; fm fleet-sync guesses local main/master);
//   - fetch deduplication across worktrees + origin/HEAD refresh (fm update);
//   - detached-HEAD / upstream-fixup acceptance (fm update);
//   - the on-default-branch requirement, project-mode gating, and gone-branch
//     pruning (fm fleet-sync);
//   - every human-facing status line's wording (each caller formats its own).
//
// All functions here have real callers: ffFirstLine and ffSkip in both
// fm update and fm fleet-sync; ffResolveDefaultBranch, ffRefreshOrigin,
// and ffSafeFastForward in both as well. FF_* globals in the bash version
// become plain return values here (no shared mutable state needed in TS).

import { spawnSync } from "node:child_process";
import { shellQuote } from "./spawn";

// ffFirstLine(text): the first line of text with runs of whitespace collapsed
// to single spaces. Turns multi-line git error output into a one-line skip reason.
export function ffFirstLine(text: string): string {
	const first = text.split(/\r?\n/, 1)[0] ?? "";
	return first.replace(/\s+/g, " ");
}

// ffSkip(label, reason): print the shared "skipped" status-line format both
// callers use, to stdout. The reason text is supplied by the caller so each
// keeps its own wording. Mirrors the bash function's direct `printf`.
export function ffSkip(label: string, reason: string): void {
	process.stdout.write(`${label}: skipped: ${reason}\n`);
}

function git(dir: string, args: string[]): { ok: boolean; stdout: string } {
	const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	return { ok: !res.error && res.status === 0, stdout: res.stdout ?? "" };
}

// ffResolveDefaultBranch(dir): the default branch resolved from the locally
// cached origin/HEAD - the resolution path that is semantically identical in
// both callers. Returns null when origin/HEAD is not cached, leaving the
// caller to apply its own fallback (remote query vs local main/master guess),
// a deliberately distinct per-caller semantic that stays in each wrapper.
export function ffResolveDefaultBranch(dir: string): string | null {
	const res = git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	const ref = res.stdout.trim();
	if (!ref) return null;
	return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

export interface FfRefreshResult {
	ok: boolean;
	/** Combined stdout+stderr of the fetch, for a caller that wants a detailed skip reason (fm update ignores it). */
	output: string;
}

// ffRefreshOrigin(dir): fetch origin with --prune --quiet. Combines
// stdout+stderr via a real `2>&1` shell redirection (see ffSafeFastForward)
// so .output matches bash's `$(... 2>&1)` capture exactly.
export function ffRefreshOrigin(dir: string): FfRefreshResult {
	const cmd = `git -C ${shellQuote(dir)} fetch origin --prune --quiet 2>&1`;
	const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
	return { ok: !res.error && res.status === 0, output: res.stdout ?? "" };
}

export type FfOutcome = "current" | "updated" | "diverged" | "read-error" | "ff-failed";

export interface FfResult {
	result: FfOutcome;
	/** Set when result === "updated": the short sha of ref before the merge. */
	before?: string;
	/** Set when result === "updated": the short sha of ref after the merge. */
	after?: string;
	/** Set when result === "ff-failed": one-line detail from the merge failure. */
	detail?: string;
	/** Set when result === "read-error": which rev-parse failed. */
	which?: "local" | "remote";
}

// ffSafeFastForward(dir, ref, base): fast-forward <ref> to <base> in <dir>
// after the clean-ancestor checks, using `git merge --ff-only`. This is the
// pure git core; the caller classifies the result via .result and formats
// every status line itself.
export function ffSafeFastForward(dir: string, ref: string, base: string): FfResult {
	const localRes = git(dir, ["rev-parse", ref]);
	if (!localRes.ok) return { result: "read-error", which: "local" };
	const localRev = localRes.stdout.trim();

	const remoteRes = git(dir, ["rev-parse", base]);
	if (!remoteRes.ok) return { result: "read-error", which: "remote" };
	const remoteRev = remoteRes.stdout.trim();

	if (localRev === remoteRev) return { result: "current" };

	const ancestor = git(dir, ["merge-base", "--is-ancestor", ref, base]);
	if (!ancestor.ok) return { result: "diverged" };

	const before = git(dir, ["rev-parse", "--short", ref]).stdout.trim();
	// Combine stdout+stderr via a real `2>&1` shell redirection (not a
	// post-hoc concatenation of two separately-captured streams) so the
	// captured text - and in particular its first line, what ffFirstLine
	// reports - matches exactly what the bash version's `$(... 2>&1)` sees.
	const mergeCmd = `git -C ${shellQuote(dir)} merge --ff-only ${shellQuote(base)} 2>&1`;
	const mergeRes = spawnSync("sh", ["-c", mergeCmd], { encoding: "utf8" });
	if (mergeRes.error || mergeRes.status !== 0) {
		return { result: "ff-failed", detail: ffFirstLine(mergeRes.stdout ?? "") };
	}
	const after = git(dir, ["rev-parse", "--short", ref]).stdout.trim();
	return { result: "updated", before, after };
}
