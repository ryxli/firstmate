// fm verb: merge-local - trunk-mode land: fast-forward the project's default
// branch to the crewmate's fm/<id> branch after approval.
//
// Narrow exception to hard rule #1: only mode=trunk, only after cap/yolo
// approval, clean fast-forward only. Usage: fm merge-local <task-id>

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { landAfterFfMerge } from "../lib/artifact";
import { ffResolveDefaultBranch } from "../lib/ff";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || join(fmHome, "state");
}

// Mirrors `grep '^prefix=' meta | cut -d= -f2-`: first line starting with
// prefix=, everything after the first '='.
function metaField(contents: string, prefix: string): string {
	for (const line of contents.split(/\r?\n/)) {
		if (line.startsWith(prefix)) return line.slice(prefix.length);
	}
	return "";
}

function gitCapture(cwd: string, args: string[]): { status: number; stdout: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	return { status: result.status ?? 1, stdout: (result.stdout ?? "").replace(/\r?\n+$/, "") };
}

function gitOk(cwd: string, args: string[]): boolean {
	const result = spawnSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "ignore", "ignore"] });
	return (result.status ?? 1) === 0;
}

// Mirrors the script's default_branch(): resolve from cached origin/HEAD
// first, else fall back to a local main/master guess.
function defaultBranch(proj: string): string | undefined {
	const cached = ffResolveDefaultBranch(proj);
	if (cached) return cached;
	for (const branch of ["main", "master"]) {
		if (gitOk(proj, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) return branch;
	}
	return undefined;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const id = args[0];
	if (!id) {
		process.stderr.write("usage: fm merge-local <task-id>\n");
		return 1;
	}

	const state = resolveState();
	const metaPath = join(state, `${id}.meta`);
	if (!existsSync(metaPath)) {
		process.stderr.write(`error: no meta for task ${id} at ${metaPath}\n`);
		return 1;
	}
	const metaContents = readFileSync(metaPath, "utf8");

	const proj = metaField(metaContents, "project=");
	const mode = metaField(metaContents, "mode=");
	if (mode !== "trunk") {
		process.stderr.write(`error: task ${id} is mode=${mode}, not trunk; use gh-axi pr merge / pr-check\n`);
		return 1;
	}

	const branch = `fm/${id}`;
	if (!gitOk(proj, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
		process.stderr.write(`error: branch ${branch} does not exist in ${proj}\n`);
		return 1;
	}

	const def = defaultBranch(proj);
	if (!def) {
		process.stderr.write(`error: cannot determine default branch for ${proj}; expected origin/HEAD, main, or master\n`);
		return 1;
	}

	// The project's main checkout must be on its default branch and clean, so
	// the fast-forward lands predictably (firstmate never writes here
	// otherwise).
	const curRes = gitCapture(proj, ["symbolic-ref", "--short", "HEAD"]);
	const cur = curRes.status === 0 ? curRes.stdout : "";
	if (cur !== def) {
		process.stderr.write(`error: ${proj} is on '${cur}', expected default branch '${def}'; cannot merge safely\n`);
		return 1;
	}
	const statusRes = spawnSync("git", ["-C", proj, "status", "--porcelain"], { encoding: "utf8" });
	if ((statusRes.stdout ?? "").split(/\r?\n/)[0]) {
		process.stderr.write(`error: ${proj} has a dirty working tree; refusing to merge into it\n`);
		return 1;
	}

	// Clean fast-forward only: def must be an ancestor of branch.
	if (!gitOk(proj, ["merge-base", "--is-ancestor", def, branch])) {
		process.stderr.write(`REFUSED: ${branch} is not a fast-forward of ${def} (it has diverged).\n`);
		process.stderr.write(`Have the crewmate rebase ${branch} onto ${def}, then retry.\n`);
		return 1;
	}

	const before = gitCapture(proj, ["rev-parse", "--short", def]).stdout;
	const mergeRes = spawnSync("git", ["-C", proj, "merge", "--ff-only", branch], { stdio: ["ignore", "ignore", "inherit"] });
	if ((mergeRes.status ?? 1) !== 0) return mergeRes.status ?? 1;
	const after = gitCapture(proj, ["rev-parse", "--short", def]).stdout;

	const afterFull = gitCapture(proj, ["rev-parse", def]).stdout;
	try {
		landAfterFfMerge(id, { trunkSha: afterFull, branch: def, repo: proj });
	} catch {
		// No accepted artifact yet - legacy merge-local without spine record remains valid.
	}
	process.stdout.write(`merged ${branch} into local ${def} (${before} -> ${after}) in ${proj}\n`);
	return 0;
}

export default {
	name: "merge-local",
	describe: "Fast-forward a trunk-mode project's default branch to the crewmate's fm/<id> branch after cap approval.",
	run,
};
