// fm verb: fleet-sync - refresh project clones: fast-forward the checked-out
// local default branch to origin/<default> when safe, and prune local
// branches whose upstream tracking branch is gone (the remote branch was
// deleted, i.e. its PR merged) and that no worktree still needs.
// Ported behavior-preserving from the former sbin/fm fleet-sync, using the
// shared cli/lib/ff.ts fast-forward core (ported from sbin/fm-ff-lib.sh).
//
// Skips local-only/no-origin projects, dirty clones, non-default checkouts,
// diverged branches, and fetch/fast-forward failures without forcing or
// stashing.
// Pruning never deletes the checked-out branch or a branch that still has a
// worktree, so it cannot discard unlanded work; set FM_FLEET_PRUNE=0 to
// disable it.
// Usage: fm fleet-sync [<project-dir>]

import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import { ffFirstLine, ffRefreshOrigin, ffResolveDefaultBranch, ffSafeFastForward, ffSkip } from "../lib/ff";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

function resolveRoot(): string {
	return process.env.FM_ROOT_OVERRIDE?.trim() || REPO_ROOT;
}

function resolveHome(fmRoot: string): string {
	return process.env.FM_HOME?.trim() || process.env.FM_ROOT_OVERRIDE?.trim() || fmRoot;
}

function resolveProjects(fmHome: string): string {
	return process.env.FM_PROJECTS_OVERRIDE?.trim() || join(fmHome, "projects");
}

function usage(): void {
	process.stderr.write("usage: fm fleet-sync [<project-dir>]\n");
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function git(dir: string, args: string[]): { ok: boolean; stdout: string } {
	const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	return { ok: !res.error && res.status === 0, stdout: res.stdout ?? "" };
}

// Mirrors the script's project_label(): the basename when PROJ sits under the
// resolved projects dir or under a literal "projects/" prefix, otherwise the
// argument verbatim.
function projectLabel(proj: string, projectsDir: string): string {
	if (proj.startsWith(`${projectsDir}/`)) return basename(proj);
	if (proj.startsWith("projects/")) return basename(proj);
	return proj;
}

// Mirrors default_branch(): the cached origin/HEAD default branch, falling
// back to a local main/master guess when origin/HEAD is not cached.
function defaultBranch(proj: string): string | null {
	const resolved = ffResolveDefaultBranch(proj);
	if (resolved) return resolved;
	for (const branch of ["main", "master"]) {
		if (git(proj, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return branch;
	}
	return null;
}

// Mirrors project_mode(): shell out to `fm project-mode <label>`, discarding
// stderr, falling back to "direct-PR off" only if the subcommand itself fails.
function projectMode(fmRoot: string, label: string): string {
	const res = spawnSync(join(fmRoot, "sbin", "fm"), ["project-mode", label], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const line = !res.error && res.status === 0 ? (res.stdout ?? "").trim() : "direct-PR off";
	return line.split(/\s+/)[0] ?? "";
}

// Mirrors prune_gone_branches(): delete local branches whose upstream
// tracking branch is gone, as long as nothing still needs them. Never the
// checked-out branch, and never a branch that still has a worktree.
function pruneGoneBranches(proj: string, label: string): void {
	const pruneEnv = process.env.FM_FLEET_PRUNE;
	const effective = pruneEnv === undefined || pruneEnv === "" ? "1" : pruneEnv;
	if (effective === "0") return;

	const worktreeRes = git(proj, ["worktree", "list", "--porcelain"]);
	const worktreeBranches = new Set<string>();
	for (const line of worktreeRes.stdout.split("\n")) {
		if (line.startsWith("branch refs/heads/")) worktreeBranches.add(line.slice("branch refs/heads/".length));
	}

	const currentRes = git(proj, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const current = currentRes.ok ? currentRes.stdout.trim() : "";

	const refsRes = git(proj, ["for-each-ref", "--format=%(refname:short) %(upstream:track)", "refs/heads"]);
	for (const line of refsRes.stdout.split("\n")) {
		if (!line) continue;
		const idx = line.indexOf(" ");
		const branch = idx === -1 ? line : line.slice(0, idx);
		const track = idx === -1 ? "" : line.slice(idx + 1);
		if (track !== "[gone]") continue;
		if (!branch) continue;
		if (branch === current) continue;
		if (worktreeBranches.has(branch)) continue;
		const del = spawnSync("git", ["-C", proj, "branch", "-D", "--", branch], { encoding: "utf8" });
		if (!del.error && del.status === 0) process.stdout.write(`${label}: pruned ${branch}\n`);
	}
}

function syncProject(proj: string, fmRoot: string, projectsDir: string): void {
	const label = projectLabel(proj, projectsDir);

	if (!isDirectory(proj)) {
		process.stdout.write(`${label}: skipped: not a directory\n`);
		return;
	}
	if (!git(proj, ["rev-parse", "--is-inside-work-tree"]).ok) {
		process.stdout.write(`${label}: skipped: not a git repo\n`);
		return;
	}

	const mode = projectMode(fmRoot, label);
	if (mode === "local-only") {
		process.stdout.write(`${label}: skipped: local-only project\n`);
		return;
	}
	if (!git(proj, ["remote", "get-url", "origin"]).ok) {
		process.stdout.write(`${label}: skipped: no origin remote\n`);
		return;
	}

	const refresh = ffRefreshOrigin(proj);
	if (!refresh.ok) {
		let reason = "fetch failed";
		if (refresh.output.length > 0) reason = `${reason}: ${ffFirstLine(refresh.output)}`;
		ffSkip(label, reason);
		return;
	}

	pruneGoneBranches(proj, label);

	const DEFAULT = defaultBranch(proj);
	if (!DEFAULT) {
		process.stdout.write(`${label}: skipped: cannot determine default branch\n`);
		return;
	}
	const BASE = `origin/${DEFAULT}`;
	if (!git(proj, ["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`]).ok) {
		process.stdout.write(`${label}: skipped: ${BASE} does not exist\n`);
		return;
	}

	const curRes = git(proj, ["symbolic-ref", "--short", "HEAD"]);
	const cur = curRes.ok ? curRes.stdout.trim() : "";
	if (cur !== DEFAULT) {
		const curDisplay = cur || "detached HEAD";
		process.stdout.write(`${label}: skipped: on ${curDisplay}, expected ${DEFAULT}\n`);
		return;
	}
	if (git(proj, ["status", "--porcelain"]).stdout.length > 0) {
		process.stdout.write(`${label}: skipped: dirty working tree\n`);
		return;
	}
	if (!git(proj, ["rev-parse", "--verify", "--quiet", `${DEFAULT}^{commit}`]).ok) {
		process.stdout.write(`${label}: skipped: local ${DEFAULT} does not exist\n`);
		return;
	}

	const result = ffSafeFastForward(proj, DEFAULT, BASE);
	switch (result.result) {
		case "read-error":
			if (result.which === "local") ffSkip(label, `cannot read local ${DEFAULT}`);
			else ffSkip(label, `cannot read ${BASE}`);
			return;
		case "current":
			process.stdout.write(`${label}: already current\n`);
			return;
		case "diverged":
			ffSkip(label, `local ${DEFAULT} has diverged from ${BASE}`);
			return;
		case "ff-failed": {
			let reason = "fast-forward failed";
			if (result.detail) reason = `${reason}: ${result.detail}`;
			ffSkip(label, reason);
			return;
		}
	}
	process.stdout.write(`${label}: synced ${result.before}..${result.after}\n`);
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);

	if (args[0] === "--help" || args[0] === "-h") {
		usage();
		return 0;
	}
	if (args.length > 1) {
		usage();
		return 1;
	}

	const fmRoot = resolveRoot();
	const fmHome = resolveHome(fmRoot);
	const projectsDir = resolveProjects(fmHome);

	if (args.length === 1) {
		syncProject(args[0], fmRoot, projectsDir);
		return 0;
	}

	if (!isDirectory(projectsDir)) return 0;
	const entries = readdirSync(projectsDir).sort();
	for (const entry of entries) {
		const full = join(projectsDir, entry);
		if (!existsSync(full) || !isDirectory(full)) continue;
		syncProject(full, fmRoot, projectsDir);
	}
	return 0;
}

export default {
	name: "fleet-sync",
	describe: "Refresh project clones: fast-forward the checked-out local default branch and prune local branches whose upstream is gone.",
	run,
};
