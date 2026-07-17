// fm verb: update - self-update a running firstmate and its secondmates to the
// latest origin.
// Ported behavior-preserving from the former sbin/fm update.
//
// Mechanical half of the /updatefirstmate skill. Fast-forwards the running
// firstmate repo's default branch from origin, then fast-forwards every
// registered secondmate home (each a herdr-managed git worktree of this repo,
// or a standalone clone) the same way. FAST-FORWARD ONLY, exactly like
// fm fleet-sync: never force, never create a merge commit, never stash;
// advance a target only when it is a clean fast-forward, otherwise skip and
// report. A tracked-files fast-forward never touches the gitignored operational
// dirs (data/, state/, config/, projects/, .no-mistakes/), so a secondmate's
// in-flight work is never disrupted. Worktrees of this repo share one object
// store, so a single fetch refreshes them all; standalone-clone homes are
// fetched on their own. Secondmate homes are leased at a detached HEAD on the
// default branch, so a fast-forward there advances HEAD only and never touches
// any other worktree's checkout or the shared `main` branch.
//
// --adopt-remote is the one deliberate, cap-approved exception to the
// fast-forward-only rule, run on the OTHER machine after a sanctioned
// force-with-lease history rewrite of a harness-layer repo. For each target it
// hard-resets the local default branch to origin/<default> ONLY when all three
// hold: origin's history was rewritten (local and origin/<default> have
// diverged), the local branch has zero unpushed commits (every local commit was
// already published on origin, verified against the origin/<default> reflog),
// and the working tree is clean. Every other case refuses with a one-line
// reason (dirty tree, local-only commits, not diverged so the normal
// fast-forward applies, detached HEAD, ...). Nothing under projects/ is ever
// touched, and default mode behavior is completely unchanged.
//
// It does NOT re-read AGENTS.md or nudge secondmates itself - those are LLM /
// tmux actions the skill performs. The verb's job is the safe git mechanics
// plus a parseable summary telling the caller what to do next:
//   - one status line per target (updated/adopted/already current/skipped)
//   - reread-firstmate: yes|no    (did the running firstmate's instructions change)
//   - nudge-secondmates: <window-targets...>|none   (updated live secondmates to nudge)
//
// Usage: fm update [--repair-links] [--adopt-remote] [--help]

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffFirstLine, ffRefreshOrigin, ffResolveDefaultBranch, ffSafeFastForward, ffSkip } from "../lib/ff";
import { shellQuote } from "../lib/spawn";

const CANONICAL_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const SUB_HOME_MARKER = ".fm-secondmate-home";

function usage(): void {
	process.stderr.write("usage: fm update [--repair-links] [--adopt-remote] [--help]\n");
}

// --- small fs predicates, mirroring the bash script's `[ -d ]`/`[ -f ]`/`[ -L ]` tests --

function isDirectoryFollow(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFileFollow(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isSymlinkAt(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function existsFollow(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function isExecutableFile(path: string): boolean {
	try {
		const st = statSync(path);
		return st.isFile() && (st.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

// resolvePath(path): the physical path for an existing directory (mirrors `cd
// "$1" 2>/dev/null && pwd -P`), or the literal input when it is not a
// directory - so callers can still dedup/skip on it.
function resolvePath(path: string): string {
	if (!isDirectoryFollow(path)) return path;
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function resolvedExistingDir(path: string): string | null {
	if (!isDirectoryFollow(path)) return null;
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function pathIsAncestorOf(ancestor: string, path: string): boolean {
	if (!ancestor || !path) return false;
	if (ancestor === path) return false;
	return path.startsWith(`${ancestor}/`);
}

// --- git helpers -------------------------------------------------------------

function git(dir: string, args: string[]): { ok: boolean; stdout: string } {
	const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	return { ok: !res.error && res.status === 0, stdout: res.stdout ?? "" };
}

// defaultBranch(dir): the shared core (cached origin/HEAD) plus this caller's
// distinct fallback - origin/HEAD not cached locally, so query the remote.
function defaultBranch(dir: string): string | null {
	const cached = ffResolveDefaultBranch(dir);
	if (cached) return cached;
	const res = git(dir, ["remote", "show", "origin"]);
	const line = res.stdout.split(/\r?\n/).find(candidate => candidate.includes("HEAD branch:"));
	if (!line) return null;
	const fields = line.trim().split(/\s+/);
	const branch = fields[fields.length - 1];
	return branch && branch !== "(unknown)" ? branch : null;
}

// A single fetch refreshes every worktree that shares an object store, so fetch
// each distinct git-common-dir at most once.
function fetchOnce(dir: string, fetched: Set<string>): boolean {
	const commonRes = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const common = commonRes.ok ? commonRes.stdout.trim() : "";
	if (common && fetched.has(common)) return true;
	if (ffRefreshOrigin(dir).ok) {
		// Refresh cached origin/HEAD so a renamed default branch is detected correctly.
		git(dir, ["remote", "set-head", "origin", "--auto"]);
		if (common) fetched.add(common);
		return true;
	}
	return false;
}

// Which watched instruction paths changed between HEAD and base (comma list).
// These are the files a running agent actually reads or runs: its instructions
// (AGENTS.md, which CLAUDE.md symlinks), its skills, and its tooling (sbin/).
function changedInstr(dir: string, base: string): string {
	const changed: string[] = [];
	for (const p of ["AGENTS.md", "sbin", ".agents/skills"]) {
		const res = spawnSync("git", ["-C", dir, "diff", "--quiet", "HEAD", base, "--", p], { encoding: "utf8" });
		if (res.error || res.status !== 0) changed.push(p);
	}
	return changed.join(", ");
}

function dirtyStatus(dir: string, ignoreSeedMarker: boolean): string {
	const res = git(dir, ["status", "--porcelain"]);
	const lines = res.ok ? res.stdout.split(/\r?\n/).filter(line => line.length > 0) : [];
	if (ignoreSeedMarker) {
		const marker = `?? ${SUB_HOME_MARKER}`;
		return lines.find(line => line !== marker) ?? "";
	}
	return lines[0] ?? "";
}

// Was every commit on HEAD already published on origin/<default>? True when
// HEAD is an ancestor of the current or any recorded prior position of the
// remote-tracking ref (its reflog). After a remote history rewrite, a purely
// pulled local branch is an ancestor of the pre-rewrite position; an unpushed
// local commit is an ancestor of none. No reflog means it cannot be verified,
// so the caller refuses (fail closed).
function headPublishedOnOrigin(dir: string, defaultBr: string): boolean {
	const res = git(dir, ["rev-list", "-g", `refs/remotes/origin/${defaultBr}`]);
	const shas = res.stdout.split(/\r?\n/).filter(sha => sha.length > 0);
	return shas.some(sha => git(dir, ["merge-base", "--is-ancestor", "HEAD", sha]).ok);
}

interface TargetResult {
	status: "updated" | "current" | "skipped" | "adopted";
	instr: string;
}

// Shared pre-flight checks for both ff_target and adopt_target: directory,
// git repo, origin remote, fetch, default branch, base ref, current-branch
// acceptance (including the upstream-tracking fixup), and dirty-tree gate.
// Returns null (having already printed the skip line) when any check fails,
// or the resolved { base, defaultBr } when every check passes.
function preflight(
	dir: string,
	label: string,
	allowDetached: boolean,
	ignoreSeedMarker: boolean,
	fetched: Set<string>,
): { base: string; defaultBr: string } | null {
	if (!isDirectoryFollow(dir)) {
		ffSkip(label, "not a directory");
		return null;
	}
	if (!git(dir, ["rev-parse", "--is-inside-work-tree"]).ok) {
		ffSkip(label, `not a git repo (${dir})`);
		return null;
	}
	if (!git(dir, ["remote", "get-url", "origin"]).ok) {
		ffSkip(label, "no origin remote");
		return null;
	}
	if (!fetchOnce(dir, fetched)) {
		ffSkip(label, "fetch failed");
		return null;
	}

	let defaultBr = defaultBranch(dir) ?? "";
	if (!defaultBr) {
		ffSkip(label, "cannot determine default branch");
		return null;
	}
	let base = `origin/${defaultBr}`;
	if (!git(dir, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok) {
		ffSkip(label, `${base} does not exist`);
		return null;
	}

	const curRes = git(dir, ["symbolic-ref", "--short", "HEAD"]);
	const cur = curRes.ok ? curRes.stdout.trim() : "";
	if (!cur && !allowDetached) {
		ffSkip(label, `detached HEAD, expected ${defaultBr}`);
		return null;
	}
	if (cur && cur !== defaultBr) {
		// origin/HEAD may point to a branch that has diverged from the operator's
		// actual working branch (e.g. when a default-branch rename on the remote
		// wasn't reflected locally). Accept the current branch if its configured
		// upstream tracking ref is origin/<cur>.
		const upstreamRes = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
		const upstream = upstreamRes.ok ? upstreamRes.stdout.trim() : "";
		if (upstream && upstream === `origin/${cur}`) {
			defaultBr = cur;
			base = `origin/${cur}`;
		} else {
			ffSkip(label, `on ${cur}, expected ${defaultBr}`);
			return null;
		}
	}

	if (dirtyStatus(dir, ignoreSeedMarker)) {
		ffSkip(label, "dirty working tree");
		return null;
	}

	return { base, defaultBr };
}

// Fast-forward one target. Prints its status line.
function ffTarget(
	dir: string,
	label: string,
	allowDetached: boolean,
	ignoreSeedMarker: boolean,
	fetched: Set<string>,
): TargetResult {
	const pre = preflight(dir, label, allowDetached, ignoreSeedMarker, fetched);
	if (!pre) return { status: "skipped", instr: "" };
	const { base } = pre;

	const instr = changedInstr(dir, base);
	const ff = ffSafeFastForward(dir, "HEAD", base);
	switch (ff.result) {
		case "read-error":
			ffSkip(label, ff.which === "local" ? "cannot read HEAD" : `cannot read ${base}`);
			return { status: "skipped", instr: "" };
		case "current":
			process.stdout.write(`${label}: already current\n`);
			return { status: "current", instr: "" };
		case "diverged":
			ffSkip(label, `diverged from ${base}`);
			return { status: "skipped", instr: "" };
		case "ff-failed":
			ffSkip(label, `fast-forward failed: ${ff.detail}`);
			return { status: "skipped", instr: "" };
	}
	if (instr) process.stdout.write(`${label}: updated ${ff.before}..${ff.after} (instructions changed: ${instr})\n`);
	else process.stdout.write(`${label}: updated ${ff.before}..${ff.after}\n`);
	return { status: "updated", instr };
}

// Adopt-remote one target: after origin's default branch history was REWRITTEN
// (local and origin/<default> diverged), hard-reset the local default branch to
// origin/<default> - but only when the working tree is clean and every local
// commit was already published on origin, so no unpushed work can be discarded.
// Every other case refuses with a one-line reason. Prints its status line.
function adoptTarget(
	dir: string,
	label: string,
	allowDetached: boolean,
	ignoreSeedMarker: boolean,
	fetched: Set<string>,
): TargetResult {
	const pre = preflight(dir, label, allowDetached, ignoreSeedMarker, fetched);
	if (!pre) return { status: "skipped", instr: "" };
	const { base, defaultBr } = pre;

	const localRes = git(dir, ["rev-parse", "HEAD"]);
	if (!localRes.ok) {
		ffSkip(label, "cannot read HEAD");
		return { status: "skipped", instr: "" };
	}
	const localRev = localRes.stdout.trim();
	const remoteRes = git(dir, ["rev-parse", base]);
	if (!remoteRes.ok) {
		ffSkip(label, `cannot read ${base}`);
		return { status: "skipped", instr: "" };
	}
	const remoteRev = remoteRes.stdout.trim();

	if (localRev === remoteRev) {
		ffSkip(label, "already current, nothing to adopt");
		return { status: "skipped", instr: "" };
	}
	if (git(dir, ["merge-base", "--is-ancestor", "HEAD", base]).ok) {
		ffSkip(label, `not diverged from ${base}, normal fast-forward applies`);
		return { status: "skipped", instr: "" };
	}
	if (git(dir, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
		ffSkip(label, `local-only commits ahead of ${base}, nothing to adopt`);
		return { status: "skipped", instr: "" };
	}
	if (!headPublishedOnOrigin(dir, defaultBr)) {
		ffSkip(label, "local-only commits present, refusing to discard");
		return { status: "skipped", instr: "" };
	}

	const instr = changedInstr(dir, base);
	const before = git(dir, ["rev-parse", "--short", "HEAD"]).stdout.trim();
	const resetCmd = `git -C ${shellQuote(dir)} reset --hard ${shellQuote(base)} 2>&1`;
	const resetRes = spawnSync("sh", ["-c", resetCmd], { encoding: "utf8" });
	if (resetRes.error || resetRes.status !== 0) {
		ffSkip(label, `hard reset failed: ${ffFirstLine(resetRes.stdout ?? "")}`);
		return { status: "skipped", instr: "" };
	}
	const after = git(dir, ["rev-parse", "--short", "HEAD"]).stdout.trim();
	if (instr) process.stdout.write(`${label}: adopted ${before}..${after} (instructions changed: ${instr})\n`);
	else process.stdout.write(`${label}: adopted ${before}..${after}\n`);
	return { status: "adopted", instr };
}

// Dispatch one target through the selected mode: the fast-forward default, or
// the adopt-remote recovery when --adopt-remote was given.
function updateTarget(
	adoptRemote: boolean,
	dir: string,
	label: string,
	allowDetached: boolean,
	ignoreSeedMarker: boolean,
	fetched: Set<string>,
): TargetResult {
	return adoptRemote
		? adoptTarget(dir, label, allowDetached, ignoreSeedMarker, fetched)
		: ffTarget(dir, label, allowDetached, ignoreSeedMarker, fetched);
}

// --- secondmate home validation, mirroring validate_secondmate_home/validate_operational_dirs --

type ValidateResult = { home: string } | { error: string };

function validateOperationalDirs(absHome: string, absActiveHome: string, absRoot: string): string | null {
	for (const name of ["data", "state", "config", "projects"]) {
		const dir = join(absHome, name);
		if (isSymlinkAt(dir) && !existsFollow(dir)) {
			return `secondmate ${name} directory must resolve inside the secondmate home`;
		}
		let absDir: string;
		if (isDirectoryFollow(dir)) {
			try {
				absDir = realpathSync(dir);
			} catch {
				return `secondmate ${name} directory cannot be resolved`;
			}
		} else if (existsFollow(dir)) {
			return `secondmate ${name} path is not a directory`;
		} else {
			absDir = dir;
		}
		if (!pathIsAncestorOf(absHome, absDir)) {
			return `secondmate ${name} directory must resolve inside the secondmate home`;
		}
		if (absDir === absActiveHome || pathIsAncestorOf(absActiveHome, absDir)) {
			return `secondmate ${name} directory cannot be inside the active firstmate home`;
		}
		if (absDir === absRoot || pathIsAncestorOf(absRoot, absDir)) {
			return `secondmate ${name} directory cannot be inside the firstmate repo`;
		}
	}
	return null;
}

function validateSecondmateHome(id: string, home: string, fmRoot: string, fmHome: string): ValidateResult {
	const absHome = resolvedExistingDir(home);
	if (absHome === null) return { error: "not a directory" };
	const absActiveHome = resolvedExistingDir(fmHome);
	if (absActiveHome === null) return { error: "active firstmate home is not a directory" };
	const absRoot = resolvedExistingDir(fmRoot);
	if (absRoot === null) return { error: "firstmate repo is not a directory" };

	if (absHome === "/") return { error: "secondmate home cannot be the filesystem root" };
	if (absHome === absActiveHome) return { error: "secondmate home cannot be the active firstmate home" };
	if (absHome === absRoot) return { error: "secondmate home cannot be the firstmate repo" };
	if (pathIsAncestorOf(absActiveHome, absHome)) return { error: "secondmate home cannot be inside the active firstmate home" };
	if (pathIsAncestorOf(absRoot, absHome)) return { error: "secondmate home cannot be inside the firstmate repo" };
	if (pathIsAncestorOf(absHome, absActiveHome)) return { error: "secondmate home cannot be an ancestor of the active firstmate home" };
	if (pathIsAncestorOf(absHome, absRoot)) return { error: "secondmate home cannot be an ancestor of the firstmate repo" };

	const dirsError = validateOperationalDirs(absHome, absActiveHome, absRoot);
	if (dirsError) return { error: dirsError };

	const markerPath = join(absHome, SUB_HOME_MARKER);
	if (isSymlinkAt(markerPath)) return { error: "secondmate marker must not be a symlink" };
	if (!isFileFollow(markerPath)) return { error: "not a seeded secondmate home" };
	let markerId = "";
	try {
		markerId = readFileSync(markerPath, "utf8").replace(/\n+$/, "");
	} catch {
		markerId = "";
	}
	if (markerId !== id) return { error: `marked for secondmate ${markerId || "unknown"}, expected ${id}` };
	if (!isFileFollow(join(absHome, "AGENTS.md"))) return { error: "not a firstmate home (missing AGENTS.md)" };
	const sbinPath = join(absHome, "sbin");
	if (!isDirectoryFollow(sbinPath) && !isSymlinkAt(sbinPath)) return { error: "not a firstmate home (missing sbin/)" };

	return { home: absHome };
}

// --- secondmate discovery + processing --------------------------------------

interface Ctx {
	fmRoot: string;
	fmRootReal: string;
	fmHome: string;
	adoptRemote: boolean;
	repairLinks: boolean;
	fetched: Set<string>;
	seenHomes: Set<string>;
	nudgeWindows: string[];
}

function processSecondmate(id: string, home: string, pane: string, ctx: Ctx): void {
	if (!id || !home) return;
	let homeReal = resolvePath(home);
	if (homeReal === ctx.fmRootReal) return;

	// Symlink-backed homes do not have their own git checkout. Verify their shared
	// code links on every update, and repair only when explicitly requested.
	const fmCli = join(ctx.fmRoot, "sbin", "fm");
	if (isDirectoryFollow(home) && isExecutableFile(fmCli) && !git(home, ["rev-parse", "--is-inside-work-tree"]).ok) {
		const linkMode = ctx.repairLinks ? "--repair" : "--check";
		const cmd = `${shellQuote(fmCli)} home-link ${shellQuote(home)} ${linkMode} 2>&1`;
		const helper = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
		const linkOut = (helper.stdout ?? "").replace(/\n+$/, "");
		if (helper.error || helper.status !== 0) {
			process.stdout.write(`secondmate ${id}: skipped: link check failed: ${linkOut}\n`);
			return;
		}
		const validated = validateSecondmateHome(id, home, ctx.fmRoot, ctx.fmHome);
		if ("error" in validated) {
			process.stdout.write(`secondmate ${id}: skipped: unsafe home: ${validated.error}\n`);
			return;
		}
		homeReal = validated.home;
		if (ctx.seenHomes.has(homeReal)) return;
		ctx.seenHomes.add(homeReal);
		process.stdout.write(`secondmate ${id}: symlink home verified\n`);
		return;
	}

	const validated = validateSecondmateHome(id, home, ctx.fmRoot, ctx.fmHome);
	if ("error" in validated) {
		process.stdout.write(`secondmate ${id}: skipped: unsafe home: ${validated.error}\n`);
		return;
	}
	homeReal = validated.home;
	if (ctx.seenHomes.has(homeReal)) return;
	ctx.seenHomes.add(homeReal);

	const result = updateTarget(ctx.adoptRemote, homeReal, `secondmate ${id}`, true, true, ctx.fetched);
	if ((result.status === "updated" || result.status === "adopted") && pane) {
		ctx.nudgeWindows.push(`fm-${id}`);
	}
}

function lastFieldValue(lines: string[], prefix: string): string {
	const matches = lines.filter(line => line.startsWith(prefix));
	if (matches.length === 0) return "";
	const last = matches[matches.length - 1];
	const idx = last.indexOf("=");
	return idx === -1 ? "" : last.slice(idx + 1);
}

function parseRegistryLine(line: string): { id: string; home: string } | null {
	if (!line.startsWith("- ")) return null;
	const idMatch = line.match(/^- (\S+) - /);
	const id = idMatch ? idMatch[1] : "";
	const homeMatch = line.match(/\(home:\s*([^;]*);/);
	const home = homeMatch ? homeMatch[1].replace(/\s+$/, "") : "";
	return { id, home };
}

// --- main --------------------------------------------------------------------

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	let repairLinks = false;
	let adoptRemote = false;
	for (const arg of args) {
		if (arg === "--repair-links") repairLinks = true;
		else if (arg === "--adopt-remote") adoptRemote = true;
		else if (arg === "--help" || arg === "-h") {
			usage();
			return 0;
		} else {
			usage();
			return 1;
		}
	}

	const codeRootOverride = process.env.FM_CODE_ROOT_OVERRIDE?.trim();
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = codeRootOverride || rootOverride || CANONICAL_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const state = process.env.FM_STATE_OVERRIDE?.trim() || join(fmHome, "state");
	const secondmatesMd = join(fmHome, "data", "secondmates.md");

	const fetched = new Set<string>();
	const seenHomes = new Set<string>();
	const nudgeWindows: string[] = [];
	const ctx: Ctx = { fmRoot, fmRootReal: resolvePath(fmRoot), fmHome, adoptRemote, repairLinks, fetched, seenHomes, nudgeWindows };

	// --- main firstmate repo ---------------------------------------------------

	let rereadFirstmate = "no";
	const mainResult = updateTarget(adoptRemote, fmRoot, "firstmate", false, false, fetched);
	if ((mainResult.status === "updated" || mainResult.status === "adopted") && mainResult.instr) {
		rereadFirstmate = "yes";
	}

	// --- secondmates -------------------------------------------------------------

	// Live direct reports first: state/<id>.meta with kind=secondmate carries the
	// authoritative home= path.
	if (isDirectoryFollow(state)) {
		let entries: string[] = [];
		try {
			entries = readdirSync(state).filter(name => name.endsWith(".meta")).sort();
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			const metaPath = join(state, entry);
			if (!isFileFollow(metaPath)) continue;
			let text: string;
			try {
				text = readFileSync(metaPath, "utf8");
			} catch {
				continue;
			}
			const lines = text.split(/\r?\n/);
			if (!lines.some(line => line.startsWith("kind=secondmate"))) continue;
			const id = entry.slice(0, -".meta".length);
			const home = lastFieldValue(lines, "home=");
			const pane = lastFieldValue(lines, "pane=");
			processSecondmate(id, home, pane, ctx);
		}
	}

	// Registry backstop: a secondmate registered in data/secondmates.md but without
	// a live meta (e.g. between restarts) is still its persistent on-disk home.
	if (existsSync(secondmatesMd) && isFileFollow(secondmatesMd)) {
		let text = "";
		try {
			text = readFileSync(secondmatesMd, "utf8");
		} catch {
			text = "";
		}
		for (const rawLine of text.split(/\r?\n/)) {
			const parsed = parseRegistryLine(rawLine);
			if (!parsed) continue;
			processSecondmate(parsed.id, parsed.home, "", ctx);
		}
	}

	// --- caller action summary ---------------------------------------------------

	process.stdout.write(`reread-firstmate: ${rereadFirstmate}\n`);
	process.stdout.write(`nudge-secondmates: ${nudgeWindows.length ? nudgeWindows.join(" ") : "none"}\n`);

	return 0;
}

export default {
	name: "update",
	describe: "Self-update a running firstmate and its secondmates to the latest origin.",
	run,
};
