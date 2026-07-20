// fm verb: review-diff - diff a crewmate task's branch against the
// authoritative default branch.
// Ported behavior-preserving from the former sbin/fm review-diff.
//
// Pooled project clones do not keep their local default branch current, so
// this compares remote-backed projects against origin/<default> after
// fetching the default branch, and trunk projects against the local
// default branch.
// Usage: fm review-diff <task-id> [--stat]
//   --stat prints only the stat summary; default prints stat summary plus full diff.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || join(fmHome, "state");
}

function usage(): void {
	process.stderr.write("usage: fm review-diff <task-id> [--stat]\n");
}

// Mirrors `grep '^prefix=' meta | cut -d= -f2-`: first line starting with
// prefix=, everything after the first '='.
function metaField(contents: string, prefix: string): string {
	for (const line of contents.split(/\r?\n/)) {
		if (line.startsWith(prefix)) return line.slice(prefix.length);
	}
	return "";
}

interface GitResult {
	status: number;
	stdout: string;
}

// Captures stdout, discards stderr into the string too (git prints its own
// errors there; callers that need them shown pass through inherit instead).
function gitCapture(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return { status: result.status ?? 1, stdout: (result.stdout ?? "").replace(/\r?\n+$/, "") };
}

// Runs git with stdio inherited (stdout+stderr passed straight through), the
// way the former script's unguarded commands behaved under `set -eu`: on
// failure, git has already printed its own error, so the caller just needs
// to exit with the same status.
function gitInherit(cwd: string, args: string[]): number {
	const result = spawnSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "inherit", "inherit"] });
	return result.status ?? 1;
}

function defaultBranch(proj: string): string | undefined {
	const ref = gitCapture(proj, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (ref.status === 0 && ref.stdout) {
		return ref.stdout.startsWith("origin/") ? ref.stdout.slice("origin/".length) : ref.stdout;
	}
	for (const branch of ["main", "master"]) {
		const verify = spawnSync("git", ["-C", proj, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		if ((verify.status ?? 1) === 0) return branch;
	}
	return undefined;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);

	if (args[0] === "--help" || args[0] === "-h") {
		usage();
		return 0;
	}

	const id = args[0] ?? "";
	if (!id) {
		usage();
		return 1;
	}

	let statOnly = false;
	const second = args[1];
	if (second === undefined) {
		// stat + full diff (default)
	} else if (second === "--stat") {
		statOnly = true;
	} else {
		usage();
		return 1;
	}

	if (args.length > 2) {
		usage();
		return 1;
	}

	const state = resolveState();
	const metaPath = join(state, `${id}.meta`);
	if (!existsSync(metaPath)) {
		process.stderr.write(`error: no meta for task ${id} at ${metaPath}\n`);
		return 1;
	}
	const metaContents = readFileSync(metaPath, "utf8");

	const wt = metaField(metaContents, "worktree=");
	const proj = metaField(metaContents, "project=");
	if (!wt) {
		process.stderr.write(`error: meta for task ${id} is missing worktree=\n`);
		return 1;
	}
	if (!proj) {
		process.stderr.write(`error: meta for task ${id} is missing project=\n`);
		return 1;
	}
	if (!existsSync(wt)) {
		process.stderr.write(`error: worktree for task ${id} is missing: ${wt}\n`);
		return 1;
	}
	if (!existsSync(proj)) {
		process.stderr.write(`error: project for task ${id} is missing: ${proj}\n`);
		return 1;
	}

	const defaultBr = defaultBranch(proj);
	if (!defaultBr) {
		process.stderr.write(`error: cannot determine default branch for ${proj}; expected origin/HEAD, main, or master\n`);
		return 1;
	}

	let branch = `fm/${id}`;
	const branchExists = gitCapture(wt, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (branchExists.status !== 0) {
		const current = gitCapture(wt, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		branch = current.status === 0 ? current.stdout : "";
		if (!branch) {
			process.stderr.write(`error: branch fm/${id} does not exist and worktree ${wt} is detached\n`);
			return 1;
		}
		const currentExists = gitCapture(wt, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		if (currentExists.status !== 0) {
			process.stderr.write(`error: branch ${branch} does not exist in ${wt}\n`);
			return 1;
		}
	}

	let base: string;
	const hasOrigin = spawnSync("git", ["-C", proj, "remote", "get-url", "origin"], { stdio: ["ignore", "ignore", "ignore"] });
	if ((hasOrigin.status ?? 1) === 0) {
		// Update the remote-tracking ref itself; a bare single-branch fetch can
		// leave origin/<default> stale on some Git versions and only refresh
		// FETCH_HEAD.
		const fetchStatus = gitInherit(wt, ["fetch", "origin", `+refs/heads/${defaultBr}:refs/remotes/origin/${defaultBr}`, "--quiet"]);
		if (fetchStatus !== 0) return fetchStatus;
		base = `origin/${defaultBr}`;
	} else {
		base = defaultBr;
	}

	const baseExists = gitCapture(wt, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
	if (baseExists.status !== 0) {
		process.stderr.write(`error: base ${base} does not exist in ${wt}\n`);
		return 1;
	}
	const branchResolves = gitCapture(wt, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
	if (branchResolves.status !== 0) {
		process.stderr.write(`error: branch ${branch} does not resolve in ${wt}\n`);
		return 1;
	}

	process.stdout.write(`diff base: ${base}\n`);

	const quiet = spawnSync("git", ["-C", wt, "diff", "--quiet", `${base}...${branch}`, "--"]);
	if ((quiet.status ?? 1) === 0) {
		process.stdout.write(`no changes vs ${base}\n`);
		return 0;
	}

	const statStatus = gitInherit(wt, ["diff", "--stat", `${base}...${branch}`, "--"]);
	if (statStatus !== 0) return statStatus;

	if (!statOnly) {
		process.stdout.write("\n");
		const diffStatus = gitInherit(wt, ["diff", `${base}...${branch}`, "--"]);
		if (diffStatus !== 0) return diffStatus;
	}

	return 0;
}

export default {
	name: "review-diff",
	describe: "Diff a crewmate task's branch against the authoritative default branch.",
	run,
};
