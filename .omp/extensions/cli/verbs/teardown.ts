// fm verb: teardown - tear down a finished task: remove the herdr
// workspace/worktree or retire a secondmate home, close the herdr pane, clear
// volatile state, refresh/prune the project's clone for PR-based ship tasks,
// then print a backlog-refresh reminder.
// Ported behavior-preserving from the former sbin/fm teardown.
//
// REFUSES if the worktree holds work not on any remote. A fork counts as a
// remote, so upstream-contribution PRs pushed to a fork satisfy this in any
// mode. local-only projects additionally accept work merged into the local
// default branch (firstmate performs that merge on the cap's approval) as a
// fallback for the common case where there is no remote at all.
//
// Scout tasks (kind=scout in meta) carve out of that check: their worktree is
// declared scratch and the report at data/<task-id>/report.md is the work
// product - teardown proceeds once the report exists, and refuses without it.
//
// Secondmates (kind=secondmate in meta) are retired explicitly. Normal
// teardown refuses while their home has in-flight crewmate meta files;
// --force is the approved discard path that prevalidates child removal
// targets, discards child work, kills child panes, and removes the retired
// home. Removing a herdr-managed home calls "herdr worktree remove" to close
// the workspace and prune the git worktree cleanly. A plain-clone home is
// removed with rm -rf.
//
// Usage: fm teardown <task-id> [--force]
//   --force skips the unpushed-work check for ordinary tasks and discards
//   secondmate child work for kind=secondmate. Only use it when the cap has
//   explicitly said to discard the work.
//
// The backlog reminder always points at the native `fm tasks done` /
// `fm tasks ready` subcommands (see verbs/tasks.ts; `fm task` is its
// explicit zero-ambiguity singular alias, verbs/task.ts).
//
// sbin/fm fleet-sync has itself been ported to the `fleet-sync` verb, so
// the post-teardown refresh below shells out to `fm fleet-sync` rather than a
// bash script that no longer exists.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffResolveDefaultBranch } from "../lib/ff";
import { metaValue, resolveLivePane } from "../lib/herdr";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const SUB_HOME_MARKER = ".fm-secondmate-home";

// TeardownAbort: bash's `set -eu` aborts the WHOLE script the instant an
// unprotected (bare, not `||`-guarded) command fails - including deep inside
// nested function calls, per bash's documented rule that -e is only ever
// suspended for the full recursive execution of a function/compound command
// whose OWN call site is itself protected (an if-condition, or non-last leg
// of && / ||). remove_firstmate_home and cleanup_firstmate_home_children are
// invoked bare at every call site in the original script (never behind an
// `if`/`||`), so any failure anywhere inside them - including in their own
// recursive self-calls - must unwind the whole run(), not just that call.
// Thrown only by those two functions; run() converts it to `return 1`.
class TeardownAbort extends Error {}

// Module-scoped, set once at the top of run() - mirrors the bash script's
// global FM_ROOT/FM_HOME/STATE/DATA/SECONDMATE_REG variables that every
// helper function below reads.
let FM_ROOT = REPO_ROOT;
let FM_HOME = REPO_ROOT;
let STATE = "";
let DATA = "";
let SECONDMATE_REG = "";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isSymlinkPath(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function rmIfExists(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// best-effort, mirrors `rm -f`
	}
}

function readLines(file: string): string[] {
	const content = readFileSync(file, "utf8");
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) lines.pop();
	return lines;
}

function linesToContent(lines: string[]): string {
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function atomicWrite(file: string, content: string): void {
	const tmp = `${file}.tmp.${process.pid}`;
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}

function git(dir: string, args: string[]): { ok: boolean; stdout: string } {
	const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return { ok: !res.error && res.status === 0, stdout: res.stdout ?? "" };
}

// gitInherited: like git(), but stdout is inherited (not captured) and only
// stderr is suppressed - mirrors a bash `cmd 2>/dev/null` where stdout is left
// unredirected.
function gitInherited(dir: string, args: string[]): boolean {
	const res = spawnSync("git", ["-C", dir, ...args], { stdio: ["ignore", "inherit", "ignore"] });
	return !res.error && res.status === 0;
}

// withSuppressedStderr: run fn with process.stderr.write silenced, mirroring
// a bash `2>/dev/null` around a single call. resolveLivePane writes its own
// error text directly to stderr, so this is how the caller "redirects" it.
function withSuppressedStderr<T>(fn: () => T): T {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return fn();
	} finally {
		process.stderr.write = original;
	}
}

// defaultBranch(proj): the cached origin/HEAD default branch, falling back to
// a local main/master guess when origin/HEAD is not cached. Reuses the shared
// ff lib's origin/HEAD resolution instead of re-porting it.
function defaultBranch(proj: string): string | null {
	const resolved = ffResolveDefaultBranch(proj);
	if (resolved) return resolved;
	for (const branch of ["main", "master"]) {
		if (git(proj, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return branch;
	}
	return null;
}

// backlogRefreshReminder: the reminder printed after a successful teardown.
// Always points at the native `fm tasks` subcommands (verbs/tasks.ts).
function backlogRefreshReminder(id: string, kind: string, mode: string, prUrl: string): string {
	let doneCmd: string;
	switch (kind) {
		case "scout":
			doneCmd = `fm tasks done ${id} --report data/${id}/report.md`;
			break;
		case "secondmate":
			doneCmd = `fm tasks done ${id} --note "retired"`;
			break;
		default:
			if (mode === "local-only") {
				doneCmd = `fm tasks done ${id} --note "local main"`;
			} else {
				doneCmd = `fm tasks done ${id} --pr ${prUrl || "PR_URL"}`;
			}
	}
	return `Backlog: ${id} just finished. Run ${doneCmd}, then run fm tasks ready for dependency-cleared candidates, check date gates, and dispatch only work whose blockers are gone and date is due.`;
}

// registryHomeForLine: extract the "home: <path>" field out of one
// secondmates.md registry line, e.g. `- ident - desc (home: /x; workspace: w1)`.
function registryHomeForLine(line: string): string {
	const m = /^[^(]*\(home: ([^;)]*);/.exec(line);
	return m ? m[1] : "";
}

function pathIsAncestorOf(ancestor: string, path: string): boolean {
	if (!ancestor || !path) return false;
	if (ancestor === path) return false;
	return path.startsWith(`${ancestor}/`);
}

// removalTargetAbsPath: the fully symlink-resolved absolute path of target -
// mirrors `cd "$target" && pwd -P` for a directory, or resolving just the
// parent for a non-directory (so a symlink target itself is not followed).
function removalTargetAbsPath(target: string): string {
	if (isDirectory(target)) return realpathSync(target);
	return join(realpathSync(dirname(target)), basename(target));
}

// registryWorkspaceIdForId: the workspace id recorded for a "- <id> ..."
// registry line, or "" if the registry is missing or has no match.
function registryWorkspaceIdForId(id: string, reg: string): string {
	if (!existsSync(reg)) return "";
	const re = new RegExp(`^- ${id} [^(]*\\(.*workspace: ([^;)]*).*`);
	for (const line of readFileSync(reg, "utf8").split(/\r?\n/)) {
		const m = re.exec(line);
		if (m) return m[1];
	}
	return "";
}

function worktreeRegisteredForProject(project: string, target: string): boolean {
	if (!project) return false;
	if (!isDirectory(project)) return false;
	const gitDirRes = spawnSync("git", ["-C", project, "rev-parse", "--git-dir"], { stdio: ["ignore", "ignore", "ignore"] });
	if (gitDirRes.error || gitDirRes.status !== 0) return false;
	const absTarget = removalTargetAbsPath(target);
	const listedRes = spawnSync("git", ["-C", project, "-c", "core.quotePath=false", "worktree", "list", "--porcelain"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (listedRes.error || listedRes.status !== 0) return false;
	for (const line of (listedRes.stdout ?? "").split(/\r?\n/)) {
		if (!line.startsWith("worktree ")) continue;
		let listedAbs = "";
		try {
			listedAbs = removalTargetAbsPath(line.slice("worktree ".length));
		} catch {
			listedAbs = "";
		}
		if (listedAbs === absTarget) return true;
	}
	return false;
}

// validateRemovalTarget: the shared safety gate for every rm -rf this verb
// performs. Refuses (printing "REFUSED: ..." to stderr and returning null)
// when target resolves to "/", the active firstmate home or repo root, or an
// ancestor/descendant of either. Returns "" as a no-op success for an empty
// or nonexistent target (the caller already checked existence in every real
// call site), or the resolved absolute path on success.
function validateRemovalTarget(target: string, label: string): string | null {
	if (!target) return "";
	if (!existsSync(target)) return "";
	const absTarget = removalTargetAbsPath(target);
	let absHome: string | null = null;
	try {
		absHome = realpathSync(FM_HOME);
	} catch {
		absHome = null;
	}
	const absRoot = realpathSync(FM_ROOT);

	if (absTarget === "" || absTarget === "/") {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target}\n`);
		return null;
	}
	if (absHome && absTarget === absHome) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target} is the active firstmate home\n`);
		return null;
	}
	if (absTarget === absRoot) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target} is the firstmate repo\n`);
		return null;
	}
	if (absHome && pathIsAncestorOf(absTarget, absHome)) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target} is an ancestor of the active firstmate home\n`);
		return null;
	}
	if (pathIsAncestorOf(absTarget, absRoot)) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target} is an ancestor of the firstmate repo\n`);
		return null;
	}
	if (absHome && pathIsAncestorOf(absHome, absTarget)) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target} is inside the active firstmate home\n`);
		return null;
	}
	if (pathIsAncestorOf(absRoot, absTarget)) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${target} is inside the firstmate repo\n`);
		return null;
	}
	return absTarget;
}

function registeredDescendantHomeForRemoval(reg: string, target: string): { id: string; home: string } | null {
	if (!existsSync(reg)) return null;
	for (const line of readFileSync(reg, "utf8").split(/\r?\n/)) {
		if (!line.startsWith("- ")) continue;
		const id = line.slice(2).split(" ")[0];
		const registeredHome = registryHomeForLine(line);
		if (!registeredHome) continue;
		let registeredAbs = "";
		try {
			registeredAbs = removalTargetAbsPath(registeredHome);
		} catch {
			registeredAbs = "";
		}
		if (!registeredAbs) continue;
		if (registeredAbs === target) continue;
		if (pathIsAncestorOf(target, registeredAbs)) return { id, home: registeredAbs };
	}
	return null;
}

function validateFirstmateOperationalDirsForRemoval(home: string, label: string): boolean {
	const absHome = removalTargetAbsPath(home);
	for (const name of ["data", "state", "config", "projects"]) {
		const dir = join(home, name);
		const symlink = isSymlinkPath(dir);
		const exists = existsSync(dir);
		if (!exists && !symlink) continue;
		if (symlink && !exists) {
			process.stderr.write(`REFUSED: unsafe ${label} ${name} directory ${dir} resolves outside the secondmate home\n`);
			return false;
		}
		let absDir = "";
		if (isDirectory(dir)) {
			absDir = realpathSync(dir);
		} else if (exists) {
			process.stderr.write(`REFUSED: unsafe ${label} ${name} path ${dir} is not a directory\n`);
			return false;
		}
		if (!absDir || !pathIsAncestorOf(absHome, absDir)) {
			process.stderr.write(`REFUSED: unsafe ${label} ${name} directory ${dir} resolves outside the secondmate home\n`);
			return false;
		}
	}
	return true;
}

function validateChildWorktreeForRemoval(target: string, project: string): string | null {
	if (!target) return "";
	if (!existsSync(target)) return "";
	const absTarget = validateRemovalTarget(target, "child worktree");
	if (absTarget === null) return null;
	let absHome: string | null = null;
	try {
		absHome = realpathSync(FM_HOME);
	} catch {
		absHome = null;
	}
	if (absHome && pathIsAncestorOf(absHome, absTarget)) {
		process.stderr.write(`REFUSED: unsafe child worktree removal target ${target} is inside the active firstmate home\n`);
		return null;
	}
	const absRoot = realpathSync(FM_ROOT);
	if (pathIsAncestorOf(absRoot, absTarget)) {
		process.stderr.write(`REFUSED: unsafe child worktree removal target ${target} is inside the firstmate repo\n`);
		return null;
	}
	if (!worktreeRegisteredForProject(project, target)) {
		process.stderr.write(
			`REFUSED: unsafe child worktree removal target ${target} is not a git worktree for ${project || "the recorded project"}\n`,
		);
		return null;
	}
	return absTarget;
}

function safeRmRf(target: string, label: string): boolean {
	if (!target) return true;
	if (validateRemovalTarget(target, label) === null) return false;
	if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	return true;
}

function safeRmRfChildWorktree(target: string, project: string): boolean {
	if (!target) return true;
	if (validateChildWorktreeForRemoval(target, project) === null) return false;
	if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	return true;
}

function validateFirstmateHomeForRemoval(home: string, label: string, expectedId?: string): string | null {
	if (!home) return "";
	if (!existsSync(home)) return "";
	const absHomePath = validateRemovalTarget(home, label);
	if (absHomePath === null) return null;
	const markerPath = join(absHomePath, SUB_HOME_MARKER);
	if (!isFile(markerPath)) {
		process.stderr.write(`REFUSED: unsafe ${label} removal target ${home} is not a seeded secondmate home\n`);
		return null;
	}
	if (expectedId) {
		let markerId = "";
		try {
			markerId = readFileSync(markerPath, "utf8").replace(/\n+$/, "");
		} catch {
			markerId = "";
		}
		if (markerId !== expectedId) {
			process.stderr.write(
				`REFUSED: unsafe ${label} removal target ${home} is marked for secondmate ${markerId || "unknown"}, expected ${expectedId}\n`,
			);
			return null;
		}
	}
	if (!validateFirstmateOperationalDirsForRemoval(absHomePath, label)) return null;
	let conflict = registeredDescendantHomeForRemoval(SECONDMATE_REG, absHomePath);
	if (!conflict) conflict = registeredDescendantHomeForRemoval(join(absHomePath, "data", "secondmates.md"), absHomePath);
	if (conflict) {
		process.stderr.write(
			`REFUSED: unsafe ${label} removal target ${home} contains registered secondmate home ${conflict.home} for ${conflict.id}\n`,
		);
		return null;
	}
	return absHomePath;
}

// removeFirstmateHome: both call sites in the original script invoke this
// bare (unprotected), so any failure here - a refused validation, a failed
// herdr workspace removal, or a refused rm -rf - aborts the whole teardown.
// See the TeardownAbort comment above for why this throws instead of
// returning a status the caller might (incorrectly, relative to bash) ignore.
function removeFirstmateHome(home: string, label: string, expectedId: string): void {
	if (!home) return;
	if (!existsSync(home)) return;
	const absHomePath = validateFirstmateHomeForRemoval(home, label, expectedId);
	if (absHomePath === null) throw new TeardownAbort();
	if (!absHomePath) return;
	const workspaceId = registryWorkspaceIdForId(expectedId, SECONDMATE_REG);
	if (workspaceId) {
		const res = spawnSync("herdr", ["worktree", "remove", "--workspace", workspaceId, "--force"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		if (res.error || res.status !== 0) {
			process.stderr.write(`error: herdr worktree remove failed for ${label} workspace ${workspaceId}; workspace may still exist\n`);
			throw new TeardownAbort();
		}
		return;
	}
	if (!safeRmRf(absHomePath, label)) throw new TeardownAbort();
}

function validateFirstmateHomeChildrenRemoval(home: string): boolean {
	const subState = join(home, "state");
	if (!isDirectory(subState)) return true;
	let entries: string[] = [];
	try {
		entries = readdirSync(subState).filter(n => n.endsWith(".meta")).sort();
	} catch {
		entries = [];
	}
	for (const name of entries) {
		const childMeta = join(subState, name);
		if (!existsSync(childMeta)) continue;
		const childId = name.slice(0, -".meta".length);
		const childWt = metaValue(childMeta, "worktree");
		let childKind = metaValue(childMeta, "kind");
		if (!childKind) childKind = "ship";
		if (childKind === "secondmate") {
			let childHome = metaValue(childMeta, "home");
			if (!childHome) childHome = childWt;
			if (validateFirstmateHomeForRemoval(childHome, "child firstmate home", childId) === null) return false;
			if (!validateFirstmateHomeChildrenRemoval(childHome)) return false;
		} else if (childWt && isDirectory(childWt)) {
			const childProj = metaValue(childMeta, "project");
			if (validateChildWorktreeForRemoval(childWt, childProj) === null) return false;
		}
	}
	return true;
}

// cleanupFirstmateHomeChildren: like removeFirstmateHome above, every call
// site (the main flow's top-level call, and this function's own recursive
// self-call) is bare/unprotected in the original script, so any failure -
// including one raised deep in a nested secondmate's children - aborts the
// whole teardown rather than merely skipping the rest of this loop.
function cleanupFirstmateHomeChildren(home: string): void {
	const subState = join(home, "state");
	if (!isDirectory(subState)) return;
	let entries: string[] = [];
	try {
		entries = readdirSync(subState).filter(n => n.endsWith(".meta")).sort();
	} catch {
		entries = [];
	}
	for (const name of entries) {
		const childMeta = join(subState, name);
		if (!existsSync(childMeta)) continue;
		const childId = name.slice(0, -".meta".length);
		const childWt = metaValue(childMeta, "worktree");
		const childProj = metaValue(childMeta, "project");
		let childKind = metaValue(childMeta, "kind");
		if (!childKind) childKind = "ship";

		const resolved = withSuppressedStderr(() => resolveLivePane(`fm-${childId}`, subState));
		const childPane = resolved ?? metaValue(childMeta, "pane");

		if (childPane) {
			spawnSync("herdr", ["pane", "close", childPane], { stdio: ["ignore", "inherit", "ignore"] });
		}
		if (childKind === "secondmate") {
			let childHome = metaValue(childMeta, "home");
			if (!childHome) childHome = childWt;
			if (childHome && isDirectory(childHome)) {
				cleanupFirstmateHomeChildren(childHome);
				removeFirstmateHome(childHome, "child firstmate home", childId);
			}
		} else if (childWt && isDirectory(childWt)) {
			if (validateChildWorktreeForRemoval(childWt, childProj) === null) throw new TeardownAbort();
			if (childProj && isDirectory(childProj)) {
				if (!gitInherited(childProj, ["worktree", "remove", "--force", childWt])) {
					if (!safeRmRfChildWorktree(childWt, childProj)) throw new TeardownAbort();
				}
				gitInherited(childProj, ["branch", "-D", `fm/${childId}`]);
			} else if (!safeRmRfChildWorktree(childWt, childProj)) {
				throw new TeardownAbort();
			}
		}

		const ck = childPane.replaceAll(":", "_");
		for (const suffix of [".status", ".check.sh", ".meta"]) rmIfExists(join(subState, `${childId}${suffix}`));
		for (const prefix of [".herdr-prev-status-", ".herdr-idle-count-", ".herdr-turn-", ".stale-"]) {
			rmIfExists(join(subState, `${prefix}${ck}`));
		}
	}
}

function removeSecondmateRegistryEntry(id: string): void {
	if (!existsSync(SECONDMATE_REG)) return;
	const re = new RegExp(`^- ${id}( |$)`);
	const filtered = readLines(SECONDMATE_REG).filter(line => !re.test(line));
	atomicWrite(SECONDMATE_REG, linesToContent(filtered));
}

// run(): thin wrapper that converts a TeardownAbort raised anywhere inside
// runInner (i.e. by removeFirstmateHome or cleanupFirstmateHomeChildren) into
// exit code 1, mirroring bash's `set -eu` script-wide abort for those two
// always-bare call sites. Nothing else in runInner throws.
async function run(argv: string[]): Promise<number> {
	try {
		return await runInner(argv);
	} catch (error) {
		if (error instanceof TeardownAbort) return 1;
		throw error;
	}
}

async function runInner(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const id = args[0];
	const force = args[1];
	if (!id) {
		process.stderr.write("Usage: fm teardown <task-id> [--force]\n");
		return 1;
	}

	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	FM_ROOT = rootOverride || REPO_ROOT;
	FM_HOME = process.env.FM_HOME?.trim() || rootOverride || FM_ROOT;
	STATE = process.env.FM_STATE_OVERRIDE?.trim() || join(FM_HOME, "state");
	DATA = process.env.FM_DATA_OVERRIDE?.trim() || join(FM_HOME, "data");
	SECONDMATE_REG = join(DATA, "secondmates.md");

	const meta = join(STATE, `${id}.meta`);
	if (!isFile(meta)) {
		process.stderr.write(`error: no meta for task ${id} at ${meta}\n`);
		return 1;
	}

	const wt = metaValue(meta, "worktree");
	let pane = metaValue(meta, "pane");
	const resolved = withSuppressedStderr(() => resolveLivePane(`fm-${id}`, STATE));
	pane = resolved ?? pane;
	const proj = metaValue(meta, "project");
	let homePath = metaValue(meta, "home");
	if (!homePath) homePath = wt;
	const prUrl = metaValue(meta, "pr");

	let kind = metaValue(meta, "kind");
	if (!kind) kind = "ship";
	let mode = metaValue(meta, "mode");
	if (!mode) mode = "direct-PR";

	if (kind === "secondmate") {
		if (validateFirstmateHomeForRemoval(homePath, "secondmate home", id) === null) return 1;
		if (force === "--force") {
			if (!validateFirstmateHomeChildrenRemoval(homePath)) return 1;
		}
	}

	if (kind === "secondmate" && force !== "--force") {
		const subState = join(homePath, "state");
		if (isDirectory(subState)) {
			let childMetas: string[] = [];
			try {
				childMetas = readdirSync(subState).filter(n => n.endsWith(".meta")).sort();
			} catch {
				childMetas = [];
			}
			if (childMetas.length > 0) {
				process.stderr.write(`REFUSED: secondmate ${id} still has in-flight work in ${subState}.\n`);
				process.stderr.write(`Found ${childMetas[0]}. Let that home finish or explicitly discard with --force.\n`);
				return 1;
			}
		}
	}

	if (kind === "secondmate" && force === "--force") {
		cleanupFirstmateHomeChildren(homePath);
	}

	if (isDirectory(wt) && force !== "--force") {
		if (kind === "secondmate") {
			// no-op: secondmate worktree safety is handled by the home checks above.
		} else if (kind === "scout") {
			const report = join(DATA, id, "report.md");
			if (!existsSync(report)) {
				process.stderr.write(`REFUSED: scout task ${id} has no report at ${report}.\n`);
				process.stderr.write(
					"The report is the work product. Have the crewmate write it (or get the cap's explicit OK to discard, then --force).\n",
				);
				return 1;
			}
		} else {
			const statusOut = git(wt, ["status", "--porcelain"]).stdout;
			const dirty = statusOut.split(/\r?\n/).find(line => line.length > 0 && !/^\?\? \.claude\//.test(line)) ?? "";
			const unpushedLines = git(wt, ["log", "--oneline", "HEAD", "--not", "--remotes", "--"]).stdout
				.split(/\r?\n/)
				.filter(line => line.length > 0)
				.slice(0, 5);
			const unpushed = unpushedLines.join("\n");

			if (unpushed && mode === "local-only") {
				const branch = defaultBranch(proj);
				if (!branch) {
					process.stderr.write(`REFUSED: cannot determine default branch for ${proj}; expected origin/HEAD, main, or master.\n`);
					return 1;
				}
				const unmergedLines = git(wt, ["log", "--oneline", "HEAD", "--not", branch, "--"]).stdout
					.split(/\r?\n/)
					.filter(line => line.length > 0)
					.slice(0, 5);
				const unmerged = unmergedLines.join("\n");
				if (dirty || unmerged) {
					process.stderr.write(`REFUSED: local-only worktree ${wt} has work not yet merged into ${branch} and not on any remote.\n`);
					if (dirty) process.stderr.write("uncommitted changes present\n");
					if (unmerged) process.stderr.write(`commits not yet on ${branch}:\n${unmerged}\n`);
					process.stderr.write(
						`Merge the branch into local ${branch} first (sbin/fm merge-local after the cap approves), or push to a fork/remote, or get the cap's explicit OK to discard, then --force.\n`,
					);
					return 1;
				}
			} else if (dirty || unpushed) {
				process.stderr.write(`REFUSED: worktree ${wt} has work not on any remote.\n`);
				if (dirty) process.stderr.write("uncommitted changes present\n");
				if (unpushed) process.stderr.write(`unpushed commits:\n${unpushed}\n`);
				process.stderr.write("Push the branch (or get the cap's explicit OK to discard, then --force).\n");
				return 1;
			}
		}
	}

	// Close the herdr agent pane (kills the process inside it).
	if (pane) spawnSync("herdr", ["pane", "close", pane], { stdio: ["ignore", "inherit", "ignore"] });

	// Remove the git worktree and its branch for ship/scout tasks.
	if (isDirectory(wt) && kind !== "secondmate") {
		if (proj && isDirectory(proj)) {
			if (!gitInherited(proj, ["worktree", "remove", "--force", wt])) {
				rmSync(wt, { recursive: true, force: true });
			}
			gitInherited(proj, ["branch", "-D", `fm/${id}`]);
		} else {
			rmSync(wt, { recursive: true, force: true });
		}
	}
	if (kind === "secondmate") {
		removeFirstmateHome(homePath, "secondmate home", id);
		removeSecondmateRegistryEntry(id);
	}

	const paneKey = pane.replaceAll(":", "_");
	for (const suffix of [".status", ".check.sh", ".meta"]) rmIfExists(join(STATE, `${id}${suffix}`));
	for (const prefix of [".herdr-prev-status-", ".herdr-idle-count-", ".herdr-turn-", ".stale-"]) {
		rmIfExists(join(STATE, `${prefix}${paneKey}`));
	}

	if (kind !== "scout" && kind !== "secondmate" && mode !== "local-only") {
		spawnSync(join(FM_ROOT, "sbin", "fm"), ["fleet-sync", proj], { stdio: ["ignore", "inherit", "inherit"] });
	}

	process.stdout.write(`teardown ${id} complete (pane ${pane}, worktree ${wt})\n`);
	process.stdout.write(`${backlogRefreshReminder(id, kind, mode, prUrl)}\n`);
	return 0;
}

export default {
	name: "teardown",
	describe: "Tear down a finished task's worktree/pane/state, or retire a secondmate home, then print a backlog refresh reminder.",
	run,
};
