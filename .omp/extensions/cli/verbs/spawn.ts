// fm verb: spawn - spawn a direct report: a crewmate in a git worktree, or a
// secondmate in its isolated firstmate home.
// Ported behavior-preserving from the former sbin/fm spawn, which sourced
// sbin/fm-identity-lib.sh, sbin/fm-herdr-lib.sh, sbin/fm-spawn-lib.sh, and
// sbin/fm-tasks-axi-lib.sh. Their TS equivalents (lib/identity.ts,
// lib/herdr.ts, lib/spawn.ts) are imported below.
// Backlog bookkeeping (appendBacklogInflight) is unconditional: it always
// records the dispatched task through the native `fm tasks add --start` verb
// (verbs/tasks.ts) - the single executable task system - never an external
// tool probe.
//
// Usage: fm spawn <task-id> <project-dir> [--scout]
//        fm spawn <task-id> <project-dir> --visible [harness|launch-command] [--scout] [--workspace=<id>] [--tab=<id>] [--crew-model=<model>]
//        fm spawn <task-id> [<firstmate-home>] --secondmate [--workspace=<id>] [--tab=<id>]
//   Visible ship/scout workers use config/crew-harness unless a bare adapter
//   name (omp|claude|codex|opencode|pi) or raw launch command overrides it.
//   Secondmates always launch through their home-local fm start.
//   --scout records kind=scout in the task's meta (report deliverable, scratch worktree;
//   see AGENTS.md section 6); --secondmate records kind=secondmate and launches in a
//   provisioned firstmate home; the default is kind=ship.
// Batch dispatch: pass one or more `id=repo` pairs instead of a single <id> <project>:
//     fm spawn fix-a-k3=projects/foo add-b-q7=projects/bar [--scout]
//   Each pair re-execs `sbin/fm spawn` in single-task mode.
//
// Worktrees are created with `git worktree add` at $FM_WORKTREE_BASE/<id>
// (default: $FM_HOME/worktrees/<id>). Ship and scout tasks are prepared for
// OMP Task delivery by default. `--visible` instead launches the crewmate in a
// Herdr pane directly in the worktree directory. Secondmates remain visible.
//
// On success prints either:
//   prepared <id> delivery=omp-task kind=<ship|scout> mode=<mode> yolo=<on|off> worktree=<path> brief=<path>
// or, for visible workers:
//   spawned <id> harness=<name> kind=<ship|scout|secondmate> mode=<mode> yolo=<on|off> pane=<pane-id> worktree=<path>

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorName, workerLabel } from "../lib/identity";
import { getHarnessAdapter } from "../lib/harness-adapters";
import { herdrPaneAgentProcessVerdict, herdrReapHuskSlot, jsonGet, metaSet, metaValue } from "../lib/herdr";
import { shellQuote } from "../lib/spawn";
import {
	injectOmpAppendSystemPrompts,
	parseOmpLaunchCommand,
} from "../lib/omp-system-context";
import { crewRoleContract } from "../lib/role-contract";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const DEFAULT_FM_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

const SUB_HOME_MARKER = ".fm-secondmate-home";

type Kind = "ship" | "scout" | "secondmate";

function envOrUndefined(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

interface Paths {
	fmRoot: string;
	fmHome: string;
	state: string;
	data: string;
	projects: string;
	config: string;
}

function resolvePaths(): Paths {
	const codeRootOverride = envOrUndefined("FM_CODE_ROOT_OVERRIDE");
	const rootOverride = envOrUndefined("FM_ROOT_OVERRIDE");
	const fmRoot = codeRootOverride ?? rootOverride ?? DEFAULT_FM_ROOT;
	const fmHome = envOrUndefined("FM_HOME") ?? rootOverride ?? fmRoot;
	// Plain concatenation, not path.join: these mirror the former script's
	// literal `"$FM_HOME/state"`-style bash interpolation exactly (never run
	// through `cd`/`pwd`), so an FM_HOME value with an unusual trailing slash
	// (e.g. a $TMPDIR that already ends in "/") is preserved byte-for-byte
	// instead of being silently normalized the way node's path.join would.
	const state = envOrUndefined("FM_STATE_OVERRIDE") ?? `${fmHome}/state`;
	const data = envOrUndefined("FM_DATA_OVERRIDE") ?? `${fmHome}/data`;
	const projects = envOrUndefined("FM_PROJECTS_OVERRIDE") ?? `${fmHome}/projects`;
	const config = envOrUndefined("FM_CONFIG_OVERRIDE") ?? `${fmHome}/config`;
	return { fmRoot, fmHome, state, data, projects, config };
}

type Result<T> = { ok: true; value: T } | { ok: false };

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

// --- argument parsing ---------------------------------------------------------

interface ParsedArgs {
	kind: Kind;
	workspace: string;
	tab: string;
	crewModel: string;
	crewModelExplicit: boolean;
	visible: boolean;
	pos: string[];
}

// parseArgs: mirrors the former script's while/case flag loop. Returns an
// error string (already formatted, no trailing newline) when a value flag is
// given with no following value, matching the bash script's `exit 2`.
function parseArgs(args: string[]): ParsedArgs | { error: string } {
	let kind: Kind = "ship";
	let workspace = envOrUndefined("FM_SPAWN_WORKSPACE") ?? "";
	let tab = "";
	let crewModel = envOrUndefined("FM_CREW_MODEL") ?? "";
	let crewModelExplicit = false;
	let visible = false;
	const pos: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--scout") {
			kind = "scout";
		} else if (a === "--secondmate") {
			kind = "secondmate";
		} else if (a === "--visible") {
			visible = true;
		} else if (a.startsWith("--workspace=")) {
			workspace = a.slice("--workspace=".length);
		} else if (a === "--workspace") {
			i += 1;
			if (i >= args.length) return { error: "error: --workspace requires a value" };
			workspace = args[i];
		} else if (a.startsWith("--crew-model=")) {
			crewModel = a.slice("--crew-model=".length);
			crewModelExplicit = true;
		} else if (a === "--crew-model") {
			i += 1;
			if (i >= args.length) return { error: "error: --crew-model requires a value" };
			crewModel = args[i];
			crewModelExplicit = true;
		} else if (a.startsWith("--tab=")) {
			tab = a.slice("--tab=".length);
		} else if (a === "--tab") {
			i += 1;
			if (i >= args.length) return { error: "error: --tab requires a value" };
			tab = args[i];
		} else {
			pos.push(a);
		}
	}

	return { kind, workspace, tab, crewModel, crewModelExplicit, visible, pos };
}

// isBatchDispatch: true when POS[0] has the `id=repo` shape (contains '=' and
// the part before the first '=' contains no '/'). Mirrors the bash script's
// idpart/case check, which only ever looks at the FIRST positional.
function isBatchDispatch(pos: string[]): boolean {
	if (pos.length === 0) return false;
	const first = pos[0];
	const eqIdx = first.indexOf("=");
	if (eqIdx === -1) return false;
	const idpart = first.slice(0, eqIdx);
	return !idpart.includes("/");
}

// runBatch: re-execs `sbin/fm spawn` once per `id=repo` pair. Faithfully
// mirrors the bash for-loop: a malformed pair or a --secondmate combination
// prints its own error and sets rc, but the loop keeps going (rc is only ever
// set, never reset, so the last-set value wins at the end).
function runBatch(pos: string[], kind: Kind, workspace: string, crewModel: string, crewModelExplicit: boolean, visible: boolean, fmRoot: string): number {
	let rc = 0;
	for (const pair of pos) {
		const eqIdx = pair.indexOf("=");
		if (eqIdx === -1) {
			process.stderr.write(`error: batch dispatch expects every argument as id=repo; got '${pair}'\n`);
			rc = 2;
			continue;
		}
		const pairId = pair.slice(0, eqIdx);
		const pairRepo = pair.slice(eqIdx + 1);
		const workspaceArgs = workspace ? ["--workspace", workspace] : [];
		const crewModelArgs = crewModelExplicit ? ["--crew-model", crewModel] : [];
		const visibleArgs = visible ? ["--visible"] : [];

		if (kind === "secondmate") {
			process.stderr.write("error: batch dispatch does not support --secondmate; spawn each secondmate explicitly\n");
			rc = 2;
			continue;
		}

		const args =
			kind === "scout"
				? ["spawn", pairId, pairRepo, "--scout", ...visibleArgs, ...workspaceArgs, ...crewModelArgs]
				: ["spawn", pairId, pairRepo, ...visibleArgs, ...workspaceArgs, ...crewModelArgs];
		const res = spawnSync(join(fmRoot, "sbin", "fm"), args, {
			stdio: "inherit",
			env: { ...process.env, FM_SPAWN_NO_GUARD: "1" },
		});
		if (res.status !== 0) {
			process.stderr.write(`batch: FAILED to spawn ${pairId} (${pairRepo})\n`);
			rc = 1;
		}
	}
	return rc;
}

// --- launch templates ----------------------------------------------------------
// Launch templates per adapter. No turn-end hook placeholders needed since
// herdr tracks agent status natively. __BRIEF__ is still used. These are
// empirically verified strings; never reword them.
export const LAUNCH_TEMPLATES: Record<string, string> = {
	omp: 'omp --auto-approve "$(cat __BRIEF__)"',
	claude: 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions "$(cat __BRIEF__)"',
	codex: 'codex --dangerously-bypass-approvals-and-sandbox "$(cat __BRIEF__)"',
	opencode: 'OPENCODE_CONFIG_CONTENT=\'{"permission":{"*":"allow"}}\' opencode --prompt "$(cat __BRIEF__)"',
	pi: 'pi "$(cat __BRIEF__)"',
};

export function launchTemplate(harness: string, crewModel?: string): string | null {
	if (!getHarnessAdapter(harness)) return null;
	const sqModel = crewModel ? shellQuote(crewModel) : "";
	switch (harness) {
		case "omp":
			return sqModel
				? `omp --model ${sqModel} --auto-approve "$(cat __BRIEF__)"`
				: LAUNCH_TEMPLATES.omp;
		case "claude":
			return sqModel
				? `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --model ${sqModel} --dangerously-skip-permissions "$(cat __BRIEF__)"`
				: LAUNCH_TEMPLATES.claude;
		case "codex":
			return sqModel
				? `codex --model ${sqModel} --dangerously-bypass-approvals-and-sandbox "$(cat __BRIEF__)"`
				: LAUNCH_TEMPLATES.codex;
		case "opencode":
			return sqModel
				? `OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}' opencode --model ${sqModel} --prompt "$(cat __BRIEF__)"`
				: LAUNCH_TEMPLATES.opencode;
		case "pi":
			return sqModel ? `pi --model ${sqModel} "$(cat __BRIEF__)"` : LAUNCH_TEMPLATES.pi;
		default:
			return null;
	}
}

// firstCommandWordFromRaw: skip any leading VAR=value environment assignments
// in a raw launch command, then return the basename of the first real word.
// Mirrors the bash inline loop's `[A-Za-z_]*=*` glob case pattern exactly
// (starts with a letter/underscore, contains '=' anywhere after).
function firstCommandWordFromRaw(cmd: string): string {
	for (const word of cmd.split(/\s+/)) {
		if (!word) continue;
		if (/^[A-Za-z_].*=/.test(word)) continue;
		const parts = word.split("/");
		return parts[parts.length - 1];
	}
	return "";
}

function crewHarness(fmRoot: string): string {
	const res = spawnSync(join(fmRoot, "sbin", "fm"), ["harness", "crew"], { encoding: "utf8" });
	if (res.error || res.status !== 0) return "";
	return (res.stdout ?? "").replace(/\r?\n+$/, "");
}

// --- secondmate registry -------------------------------------------------------

type RegistryKey = "home" | "workspace" | "name" | "projects";

// secondmateRegistryValue: mirrors the bash sed extraction against the last
// matching `- <id> ...` line in data/secondmates.md.
function secondmateRegistryValue(dataDir: string, id: string, key: RegistryKey): string | null {
	const reg = `${dataDir}/secondmates.md`;
	if (!existsSync(reg)) return null;
	const lines = readFileSync(reg, "utf8").split(/\r?\n/);
	const matches = lines.filter(l => new RegExp(`^- ${id}( |$)`).test(l));
	if (matches.length === 0) return null;
	const line = matches[matches.length - 1];
	let m: RegExpMatchArray | null;
	switch (key) {
		case "home":
			m = line.match(/^[^(]*\(home: ([^;)]*)/);
			break;
		case "workspace":
			m = line.match(/^[^(]*\(home: [^;)]*; workspace: ([^;)]*)/);
			break;
		case "name":
			m = line.match(/.*name:\s*([^;]*);/);
			break;
		case "projects":
			m = line.match(/^[^(]*\(home: [^;)]*;.*projects: ([^;)]*); added /);
			break;
	}
	const value = m ? m[1] : null;
	return value && value.length > 0 ? value : null;
}

// replaceRegisteredSecondmateWorkspace: rewrite the one `- <id> ...` registry
// line's `workspace: <old>;` to `workspace: <new>;`. Prints its own error and
// returns false on any of: missing registry, more than one matching line, or
// no matching `workspace: <old>;` token - mirroring the awk script's exit
// codes 2/3/4, which the bash caller collapses to one generic message anyway.
function replaceRegisteredSecondmateWorkspace(dataDir: string, id: string, oldWorkspace: string, newWorkspace: string): boolean {
	const reg = `${dataDir}/secondmates.md`;
	if (!existsSync(reg)) {
		process.stderr.write(`error: no secondmate registry at ${reg}\n`);
		return false;
	}
	const lines = readFileSync(reg, "utf8").split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const prefix = `- ${id} `;
	const needle = `workspace: ${oldWorkspace};`;
	const replacement = `workspace: ${newWorkspace};`;
	let updated = 0;
	let failed = false;
	const out: string[] = [];
	for (const line of lines) {
		if (line.startsWith(prefix)) {
			updated += 1;
			if (updated > 1) {
				failed = true;
				break;
			}
			const pos = line.indexOf(needle);
			if (pos === -1) {
				failed = true;
				break;
			}
			out.push(line.slice(0, pos) + replacement + line.slice(pos + needle.length));
		} else {
			out.push(line);
		}
	}
	if (failed || updated === 0) {
		process.stderr.write(`error: could not update workspace registration for secondmate ${id}\n`);
		return false;
	}
	const content = out.map(l => `${l}\n`).join("");
	let tempPath = "";
	try {
		const prefix = `${reg}.tmp-${process.pid}-${Date.now()}-`;
		for (let attempt = 0; ; attempt += 1) {
			const candidate = `${prefix}${attempt}`;
			tempPath = candidate;
			try {
				writeFileSync(candidate, content, { encoding: "utf8", flag: "wx" });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					tempPath = "";
					continue;
				}
				throw error;
			}
		}
		renameSync(tempPath, reg);
		tempPath = "";
		return true;
	} catch {
		if (tempPath) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// best-effort cleanup of an incomplete sibling
			}
		}
		process.stderr.write(`error: could not update workspace registration for secondmate ${id}\n`);
		return false;
	}
}

// replaceSecondmateMetaWorkspace: a no-op success when the meta file does not
// exist yet (matches the bash guard `[ -f "$meta" ] || return 0`), since the
// final meta write later in the spawn always overwrites the file wholesale.
function replaceSecondmateMetaWorkspace(metaPath: string, workspace: string, id: string): boolean {
	if (!existsSync(metaPath)) return true;
	try {
		metaSet(metaPath, "workspace", workspace);
		return true;
	} catch {
		process.stderr.write(`error: could not update workspace metadata for secondmate ${id}\n`);
		return false;
	}
}

// appendBacklogInflight: record a dispatched ship/scout task before returning
// success, via the native `fm tasks add --start` verb (verbs/tasks.ts) - the
// single source of truth for backlog mutation. Best-effort: every failure
// path is swallowed (the caller never lets this affect the spawn's own exit
// code), matching the bash `|| true`.
function appendBacklogInflight(dataDir: string, fmRoot: string, fmHome: string, id: string, repo: string, kind: string): void {
	const backlog = `${dataDir}/backlog.md`;

	try {
		mkdirSync(dataDir, { recursive: true });
	} catch {
		return;
	}
	if (!existsSync(backlog)) {
		try {
			writeFileSync(backlog, "## In flight\n\n## Queued\n\n## Done\n");
		} catch {
			return;
		}
	}

	const text = readFileSync(backlog, "utf8");
	if (new RegExp(`^- \\[ \\] ${id}( |-|$)`, "m").test(text)) return;

	spawnSync(join(fmRoot, "sbin", "fm"), ["tasks", "add", id, `${kind} task`, "--kind", kind, "--repo", repo, "--start"], {
		cwd: fmHome,
		env: { ...process.env, FM_HOME: fmHome },
		stdio: "ignore",
	});
}

// --- secondmate home validation ------------------------------------------------

function pathIsAncestorOf(ancestor: string, path: string): boolean {
	if (!ancestor || !path) return false;
	if (ancestor === path) return false;
	return path.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
}

// resolvedExistingDir: <path> must be an existing directory; returns its
// physical (symlink-resolved) path, mirroring `cd "$path" && pwd -P`.
function resolvedExistingDir(path: string): Result<string> {
	if (!isDirectory(path)) {
		process.stderr.write(`error: firstmate home does not exist or is not a directory: ${path}\n`);
		return { ok: false };
	}
	return { ok: true, value: realpathSync(path) };
}

function resolveProjectDirArg(projectsDir: string, pathArg: string): string {
	if (pathArg.startsWith("projects/")) return `${projectsDir}/${pathArg.slice("projects/".length)}`;
	return pathArg;
}

// cdPwd: mirrors `cd "$(resolve_project_dir_arg ...)" && pwd` (logical, not
// physical - symlink components in pathArg are not resolved).
function cdPwd(pathArg: string): Result<string> {
	const abs = resolve(process.cwd(), pathArg);
	if (!isDirectory(abs)) {
		process.stderr.write(`error: cd: ${pathArg}: No such file or directory\n`);
		return { ok: false };
	}
	return { ok: true, value: abs };
}

function homeHasSharedCodeLinks(home: string): boolean {
	return isSymlink(`${home}/AGENTS.md`) || isSymlink(`${home}/sbin`);
}

function homeNeedsSharedCodeRepair(home: string): boolean {
	if (homeHasSharedCodeLinks(home)) return true;
	const missingAgents = !existsSync(`${home}/AGENTS.md`);
	const missingSbin = !existsSync(`${home}/sbin`);
	return (missingAgents || missingSbin) && existsSync(`${home}/config/identity`);
}

// validateFirstmateOperationalDirs: each of data/state/config/projects must
// resolve to a real path inside the secondmate home, and outside both the
// active firstmate home and the firstmate repo.
function validateFirstmateOperationalDirs(absHome: string, absActiveHome: string, absRoot: string): Result<true> {
	for (const name of ["data", "state", "config", "projects"]) {
		const dir = `${absHome}/${name}`;
		if (isSymlink(dir) && !existsSync(dir)) {
			process.stderr.write(`error: secondmate ${name} directory must resolve inside the secondmate home: ${dir}\n`);
			return { ok: false };
		}
		let absDir: string;
		if (isDirectory(dir)) {
			absDir = realpathSync(dir);
		} else if (existsSync(dir)) {
			process.stderr.write(`error: secondmate ${name} path is not a directory: ${dir}\n`);
			return { ok: false };
		} else {
			absDir = dir;
		}
		if (!pathIsAncestorOf(absHome, absDir)) {
			process.stderr.write(`error: secondmate ${name} directory must resolve inside the secondmate home: ${dir}\n`);
			return { ok: false };
		}
		if (absDir === absActiveHome || pathIsAncestorOf(absActiveHome, absDir)) {
			process.stderr.write(`error: secondmate ${name} directory cannot be inside the active firstmate home: ${dir}\n`);
			return { ok: false };
		}
		if (absDir === absRoot || pathIsAncestorOf(absRoot, absDir)) {
			process.stderr.write(`error: secondmate ${name} directory cannot be inside the firstmate repo: ${dir}\n`);
			return { ok: false };
		}
	}
	return { ok: true, value: true };
}

// validateFirstmateHomeForSpawn: the full pre-launch validation gate for a
// secondmate home - existence, disjointness from the active home and the
// firstmate repo, seed marker match, and (for a non-git symlink-backed home)
// a repair of the shared AGENTS.md/sbin links before launch.
function validateFirstmateHomeForSpawn(id: string, home: string, fmRoot: string, fmHome: string): Result<string> {
	const homeRes = resolvedExistingDir(home);
	if (!homeRes.ok) return homeRes;
	const absHome = homeRes.value;
	const activeRes = resolvedExistingDir(fmHome);
	if (!activeRes.ok) return activeRes;
	const absActiveHome = activeRes.value;
	const rootRes = resolvedExistingDir(fmRoot);
	if (!rootRes.ok) return rootRes;
	const absRoot = rootRes.value;

	if (absHome === "/") {
		process.stderr.write(`error: secondmate home cannot be the filesystem root: ${home}\n`);
		return { ok: false };
	}
	if (absHome === absActiveHome) {
		process.stderr.write(`error: secondmate home cannot be the active firstmate home: ${home}\n`);
		return { ok: false };
	}
	if (absHome === absRoot) {
		process.stderr.write(`error: secondmate home cannot be the firstmate repo: ${home}\n`);
		return { ok: false };
	}
	if (pathIsAncestorOf(absActiveHome, absHome)) {
		process.stderr.write(`error: secondmate home cannot be inside the active firstmate home: ${home}\n`);
		return { ok: false };
	}
	if (pathIsAncestorOf(absRoot, absHome)) {
		process.stderr.write(`error: secondmate home cannot be inside the firstmate repo: ${home}\n`);
		return { ok: false };
	}
	if (pathIsAncestorOf(absHome, absActiveHome)) {
		process.stderr.write(`error: secondmate home cannot be an ancestor of the active firstmate home: ${home}\n`);
		return { ok: false };
	}
	if (pathIsAncestorOf(absHome, absRoot)) {
		process.stderr.write(`error: secondmate home cannot be an ancestor of the firstmate repo: ${home}\n`);
		return { ok: false };
	}

	const dirsRes = validateFirstmateOperationalDirs(absHome, absActiveHome, absRoot);
	if (!dirsRes.ok) return dirsRes;

	const marker = `${absHome}/${SUB_HOME_MARKER}`;
	if (!existsSync(marker)) {
		process.stderr.write(`error: firstmate home ${home} is not a seeded secondmate home\n`);
		return { ok: false };
	}
	const markerId = readFileSync(marker, "utf8").trim();
	if (markerId !== id) {
		process.stderr.write(`error: firstmate home ${home} is marked for secondmate ${markerId || "unknown"}, expected ${id}\n`);
		return { ok: false };
	}

	// Symlink-backed homes retain only operational directories. Repair their
	// shared instruction/tool links before launch. A non-git legacy home with
	// both AGENTS.md and sbin/ as real paths is self-contained, not a partial
	// link home.
	const isGitRepo = spawnSync("git", ["-C", absHome, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status === 0;
	if (!isGitRepo && homeNeedsSharedCodeRepair(absHome)) {
		const repairRes = spawnSync(join(fmRoot, "sbin", "fm"), ["home-link", absHome, "--repair"], {
			stdio: ["ignore", "ignore", "inherit"],
		});
		if (repairRes.status !== 0) {
			process.stderr.write(`error: failed to repair shared-code links in secondmate home ${home}\n`);
			return { ok: false };
		}
	}

	if (!existsSync(`${absHome}/AGENTS.md`)) {
		process.stderr.write(`error: ${home} is not a firstmate home (missing AGENTS.md)\n`);
		return { ok: false };
	}
	if (!isDirectory(`${absHome}/sbin`) && !isSymlink(`${absHome}/sbin`)) {
		process.stderr.write(`error: ${home} is not a firstmate home (missing sbin/)\n`);
		return { ok: false };
	}


	return { ok: true, value: absHome };
}

// --- pre-spawn duplicate-pane guard --------------------------------------------

// findMatchingPaneId: the pane_id of the first Herdr agent pane whose cwd
// equals <cwd>, or "" when none match. Plain shell panes can legitimately
// remain in a persistent mate workspace and must not block a new agent.
function findMatchingPaneId(cwd: string): string {
	const res = spawnSync("herdr", ["pane", "list"], { encoding: "utf8" });
	try {
		const parsed = JSON.parse(res.stdout ?? "") as {
			result?: { panes?: Array<{ pane_id?: string; cwd?: string; agent_session?: unknown }> };
		};
		const panes = parsed?.result?.panes ?? [];
		for (const p of panes) {
			if (!p?.agent_session || p.cwd !== cwd) continue;
			const pane = p.pane_id ?? "";
			if (pane && herdrPaneAgentProcessVerdict(pane) !== "shell") return pane;
		}
	} catch {
		// best-effort, mirrors the python helper's `2>/dev/null || true`
	}
	return "";
}

// Close only the exact managed shell tab recorded for this mate. Same-CWD
// user shell tabs are intentionally not considered cleanup candidates.
function closeRecordedSecondmateShellTab(
	workspace: string,
	cwd: string,
	keepTab: string,
	recordedTab: string,
	registeredWorkspace: string,
): boolean {
	if (!recordedTab || recordedTab === keepTab) return true;
	if (registeredWorkspace && registeredWorkspace !== workspace) return true;
	const res = spawnSync("herdr", ["pane", "list", "--workspace", workspace], { encoding: "utf8" });
	if (res.error || res.status !== 0) {
		process.stderr.write(`error: cannot inspect stale panes in secondmate workspace ${workspace}\n`);
		return false;
	}
	try {
		const parsed = JSON.parse(res.stdout ?? "") as {
			result?: { panes?: Array<{ pane_id?: string; tab_id?: string; workspace_id?: string; cwd?: string }> };
		};
		const panes = parsed?.result?.panes ?? [];
		const recordedPanes = panes.filter(pane => pane.tab_id === recordedTab);
		// The tab has already gone away, so there is nothing left to reap.
		if (recordedPanes.length === 0) return true;
		// The workspace-scoped listing is the topology proof. If Herdr includes
		// an explicit workspace field, reject any contradictory observation.
		if (recordedPanes.some(pane => pane.workspace_id && pane.workspace_id !== workspace)) return true;
		// Never close a tab unless every pane in that exact tab is positively
		// identified as a shell in the expected working directory.
		if (!recordedPanes.every(pane => pane.cwd === cwd && pane.pane_id && herdrPaneAgentProcessVerdict(pane.pane_id) === "shell")) return true;
		const close = spawnSync("herdr", ["tab", "close", recordedTab], { encoding: "utf8" });
		if (close.error || close.status !== 0) {
			process.stderr.write(`error: failed to close stale secondmate shell tab ${recordedTab}\n`);
			return false;
		}
		return true;
	} catch {
		process.stderr.write(`error: cannot parse secondmate workspace panes for ${workspace}\n`);
		return false;
	}
}

function closeCreatedSecondmateWorkspace(workspace: string, id: string): void {
	if (!workspace) return;
	const close = spawnSync("herdr", ["workspace", "close", workspace], { encoding: "utf8" });
	if (close.error || close.status !== 0) {
		process.stderr.write(`error: failed to close recovered workspace ${workspace} for secondmate ${id}\n`);
	}
}

interface WorkspaceRecovery {
	workspace: string;
	createdWorkspace: string;
	previousWorkspace: string;
}

function establishedWorkspaceId(createJson: string, temporaryLabel: string): string {
	const direct = jsonGet(createJson, "result", "workspace", "workspace_id");
	if (direct) return direct;

	const listRes = spawnSync("herdr", ["workspace", "list"], { encoding: "utf8" });
	if (listRes.error || listRes.status !== 0) return "";
	try {
		const parsed = JSON.parse(listRes.stdout ?? "") as {
			result?: { workspaces?: Array<{ workspace_id?: unknown; label?: unknown }> };
		};
		const matches = (parsed.result?.workspaces ?? []).filter(
			workspace => workspace?.label === temporaryLabel && typeof workspace.workspace_id === "string" && workspace.workspace_id.length > 0,
		);
		return matches.length === 1 ? (matches[0].workspace_id as string) : "";
	} catch {
		return "";
	}
}

function rollbackRecoveredWorkspace(
	dataDir: string,
	state: string,
	id: string,
	replacementWorkspace: string,
	previousWorkspace: string,
): boolean {
	let registryRolledBack = false;
	try {
		registryRolledBack = replaceRegisteredSecondmateWorkspace(dataDir, id, replacementWorkspace, previousWorkspace);
	} catch {
		registryRolledBack = false;
	}
	if (!registryRolledBack) {
		process.stderr.write(`error: retaining recovered workspace ${replacementWorkspace} because registry rollback failed\n`);
		return false;
	}

	const metaPath = `${state}/${id}.meta`;
	if (replaceSecondmateMetaWorkspace(metaPath, previousWorkspace, id)) return true;

	// A failed meta rollback leaves the durable state ambiguous. Restore the
	// registry to the replacement so it cannot point at a workspace we close.
	let registryRestoredToReplacement = false;
	try {
		registryRestoredToReplacement = replaceRegisteredSecondmateWorkspace(dataDir, id, previousWorkspace, replacementWorkspace);
	} catch {
		registryRestoredToReplacement = false;
	}
	if (!registryRestoredToReplacement) {
		process.stderr.write(`error: retaining recovered workspace ${replacementWorkspace} because meta rollback failed and registry restoration failed\n`);
	} else {
		process.stderr.write(`error: retaining recovered workspace ${replacementWorkspace} because meta rollback failed\n`);
	}
	return false;
}

// recoverMissingRegisteredSecondmateWorkspace: for a registered secondmate
// workspace, rename an existing Herdr workspace to the mate display label, or
// when it is missing (herdr restarted with a fresh layout), create a
// replacement under a unique temporary label. Establish its ID, rename it to
// the display label, and only then update registry + meta. Every failed
// post-create step closes only the established replacement after durable
// rollback succeeds.
function recoverMissingRegisteredSecondmateWorkspace(params: {
	kind: Kind;
	workspace: string;
	id: string;
	dataDir: string;
	state: string;
	projAbs: string;
	label: string;
}): WorkspaceRecovery | null {
	const { kind, workspace, id, dataDir, state, projAbs, label } = params;
	if (kind !== "secondmate") return { workspace, createdWorkspace: "", previousWorkspace: "" };
	if (!workspace) return { workspace, createdWorkspace: "", previousWorkspace: "" };
	const registeredWorkspace = secondmateRegistryValue(dataDir, id, "workspace") ?? "";
	if (workspace !== registeredWorkspace) return { workspace, createdWorkspace: "", previousWorkspace: "" };

	const getRes = spawnSync("herdr", ["workspace", "get", workspace], { encoding: "utf8" });
	if (getRes.status === 0) {
		// Existing registered workspace: rename to the mate display label before
		// spawn continues. No durable registry/meta mutation on this path.
		const renameRes = spawnSync("herdr", ["workspace", "rename", workspace, label], { encoding: "utf8" });
		if (renameRes.error || renameRes.status !== 0) {
			process.stderr.write(`error: herdr workspace rename failed for secondmate ${id}\n`);
			process.stderr.write(`${(renameRes.stdout ?? "") + (renameRes.stderr ?? "")}\n`);
			return null;
		}
		return { workspace, createdWorkspace: "", previousWorkspace: "" };
	}

	const combined = (getRes.stdout ?? "") + (getRes.stderr ?? "");
	if (!/"code":"workspace_not_found"|workspace .+ not found/.test(combined)) {
		process.stderr.write(`error: could not verify registered workspace ${workspace} for secondmate ${id}\n`);
		process.stderr.write(`${combined}\n`);
		return null;
	}

	const temporaryLabel = `${label} [fm-recovery-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}]`;
	const createRes = spawnSync("herdr", ["workspace", "create", "--cwd", projAbs, "--label", temporaryLabel, "--no-focus"], {
		encoding: "utf8",
	});
	if (createRes.error || createRes.status !== 0) {
		process.stderr.write(`error: herdr workspace create failed while recovering secondmate ${id}\n`);
		process.stderr.write(`${(createRes.stdout ?? "") + (createRes.stderr ?? "")}\n`);
		return null;
	}
	const replacementJson = createRes.stdout ?? "";
	const replacementWorkspace = establishedWorkspaceId(replacementJson, temporaryLabel);
	if (!replacementWorkspace) {
		process.stderr.write(`error: herdr workspace create did not establish a workspace_id while recovering secondmate ${id}\n`);
		process.stderr.write(`${replacementJson}\n`);
		return null;
	}

	const renameRes = spawnSync("herdr", ["workspace", "rename", replacementWorkspace, label], { encoding: "utf8" });
	if (renameRes.error || renameRes.status !== 0) {
		process.stderr.write(`error: herdr workspace rename failed for recovered secondmate ${id}\n`);
		closeCreatedSecondmateWorkspace(replacementWorkspace, id);
		return null;
	}

	let registryUpdated = false;
	try {
		registryUpdated = replaceRegisteredSecondmateWorkspace(dataDir, id, workspace, replacementWorkspace);
	} catch {
		process.stderr.write(`error: could not update workspace registration for secondmate ${id}\n`);
	}
	if (!registryUpdated) {
		closeCreatedSecondmateWorkspace(replacementWorkspace, id);
		return null;
	}
	const metaPath = `${state}/${id}.meta`;
	if (!replaceSecondmateMetaWorkspace(metaPath, replacementWorkspace, id)) {
		if (rollbackRecoveredWorkspace(dataDir, state, id, replacementWorkspace, workspace)) {
			closeCreatedSecondmateWorkspace(replacementWorkspace, id);
		}
		return null;
	}
	return { workspace: replacementWorkspace, createdWorkspace: replacementWorkspace, previousWorkspace: workspace };
}


// --- main -----------------------------------------------------------------------

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const parsed = parseArgs(args);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 2;
	}
	const { kind, tab, crewModel, crewModelExplicit, visible: requestedVisible } = parsed;
	const visible = kind === "secondmate" || requestedVisible;
	let { workspace } = parsed;
	const { pos } = parsed;

	const { fmRoot, fmHome, state, data, projects, config } = resolvePaths();

	if (isBatchDispatch(pos)) {
		return runBatch(pos, kind, workspace, crewModel, crewModelExplicit, requestedVisible, fmRoot);
	}

	const id = pos[0];
	if (id === undefined) {
		process.stderr.write("error: fm spawn requires a task id\n");
		return 1;
	}

	let proj = "";
	let arg3 = "";
	let firstmateHome = "";

	if (kind === "secondmate") {
		const p1 = pos[1] ?? "";
		if (p1 === "" || ["omp", "claude", "codex", "opencode", "pi"].includes(p1)) {
			arg3 = p1;
		} else if (/\s/.test(p1)) {
			if (pos.length > 2 || isDirectory(p1)) {
				firstmateHome = p1;
				arg3 = pos[2] ?? "";
			} else {
				arg3 = p1;
			}
		} else {
			firstmateHome = p1;
			arg3 = pos[2] ?? "";
		}
	} else {
		proj = pos[1] ?? "";
		arg3 = pos[2] ?? "";
	}

	// Secondmates are always launched by their home-local fm start contract.
	// Explicit adapter names and raw commands would bypass that contract.
	if (kind === "secondmate" && arg3 !== "" && arg3 !== "omp") {
		process.stderr.write("error: fm spawn --secondmate uses fm start and does not accept a harness or launch command\n");
		return 1;
	}

	// Resolve the harness and its launch command for ship/scout tasks. A
	// non-flag string containing whitespace is a raw launch command; otherwise
	// resolve a named or auto-detected harness against the verified templates.
	let harness: string;
	let launch = "";
	let launchFromTemplate = false;
	if (kind === "secondmate") {
		harness = "omp";
	} else if (!visible) {
		if (arg3 !== "" || crewModelExplicit) {
			process.stderr.write("error: harness and --crew-model select a visible adapter; add --visible\n");
			return 1;
		}
		harness = "omp-task";
	} else if (/\s/.test(arg3)) {
		launch = arg3;
		harness = firstCommandWordFromRaw(launch);
	} else if (arg3 === "") {
		harness = crewHarness(fmRoot);
		const tmpl = launchTemplate(harness, crewModel);
		if (tmpl === null) {
			process.stderr.write(
				`error: no launch template for harness '${harness}' (from config/crew-harness or detection); pass a raw launch command to use an unverified adapter\n`,
			);
			return 1;
		}
		launch = tmpl;
		launchFromTemplate = true;
	} else {
		harness = arg3;
		const tmpl = launchTemplate(harness, crewModel);
		if (tmpl === null) {
			process.stderr.write(`error: unknown harness '${harness}'; pass a raw launch command to use an unverified adapter\n`);
			return 1;
		}
		launch = tmpl;
		launchFromTemplate = true;
	}
	// Capture the supervisor's last managed tab before recovery or the new
	// spawn overwrites this mate's metadata.
	let recordedSecondmateTab = "";
	let registeredSecondmateWorkspace = "";
	if (kind === "secondmate") {
		const ownMeta = `${state}/${id}.meta`;
		try {
			recordedSecondmateTab = metaValue(ownMeta, "tab");
		} catch {
			recordedSecondmateTab = "";
		}
		if (!firstmateHome) firstmateHome = metaValue(ownMeta, "home");
		registeredSecondmateWorkspace = secondmateRegistryValue(data, id, "workspace") ?? "";
		if (!firstmateHome) {
			firstmateHome = secondmateRegistryValue(data, id, "home") ?? "";
		}
		if (!workspace) {
			workspace = secondmateRegistryValue(data, id, "workspace") ?? "";
		}
	}

	let projAbs: string;
	let wt: string;
	let brief = "";

	if (kind === "secondmate") {
		if (!firstmateHome) {
			process.stderr.write(`error: no firstmate home supplied or registered for ${id}\n`);
			return 1;
		}
		const validated = validateFirstmateHomeForSpawn(id, firstmateHome, fmRoot, fmHome);
		if (!validated.ok) return 1;
		projAbs = validated.value;
		wt = projAbs;
	} else {
		const cdRes = cdPwd(resolveProjectDirArg(projects, proj));
		if (!cdRes.ok) return 1;
		projAbs = cdRes.value;
		wt = "";
		brief = `${data}/${id}/brief.md`;
	}

	// Pre-spawn guard: refuse if a Herdr agent pane already has cwd == the
	// secondmate home. Plain shell panes in that home are not duplicate mates.
	if (kind === "secondmate" && !envOrUndefined("FM_SPAWN_FORCE")) {
		const guardPane = findMatchingPaneId(wt);
		if (guardPane) {
			process.stderr.write(
				`error: secondmate ${id} already has a live pane at ${wt} (pane ${guardPane}); set FM_SPAWN_FORCE=1 to override\n`,
			);
			return 1;
		}
	}

	if (kind !== "secondmate") {
		if (!existsSync(brief)) {
			process.stderr.write(`error: no brief at ${brief}\n`);
			return 1;
		}
	}

	// Preflight: validate harness binary and worktree base before creating anything.
	if (kind !== "secondmate") {
		const preflightHarness = visible ? harness : "omp";
		const pre = spawnSync(join(fmRoot, "sbin", "fm"), ["resolve-spawn", projAbs, preflightHarness], { stdio: "inherit" });
		if (pre.status !== 0) return pre.status ?? 1;
	}

	// Visible ship and scout workers must be created in the spawning
	// firstmate's own workspace, never whichever workspace happens to be
	// focused. Explicit --workspace and FM_SPAWN_WORKSPACE values are
	// deliberate overrides. This runs after preflight so a missing-binary abort
	// surfaces its own error first.
	if (visible && kind !== "secondmate" && !workspace) {
		const cur = spawnSync("herdr", ["pane", "current"], { encoding: "utf8" });
		const text = cur.status === 0 ? (cur.stdout ?? "") : "";
		workspace = jsonGet(text, "result", "pane", "workspace_id");
		if (!workspace) {
			process.stderr.write(
				`error: cannot resolve this firstmate's herdr workspace for ${kind} spawn ${id}; pass --workspace <id> or set FM_SPAWN_WORKSPACE\n`,
			);
			return 1;
		}
	}

	// Create a git worktree for ship/scout tasks.
	if (kind !== "secondmate") {
		const wtbase = envOrUndefined("FM_WORKTREE_BASE") ?? `${fmHome}/worktrees`;
		mkdirSync(wtbase, { recursive: true });
		wt = `${wtbase}/${id}`;
		if (existsSync(wt)) {
			process.stderr.write(`error: worktree ${wt} already exists\n`);
			return 1;
		}
		let added = spawnSync("git", ["-C", projAbs, "worktree", "add", "-b", `fm/${id}`, wt, "HEAD"], { stdio: "ignore" }).status === 0;
		if (!added) {
			added = spawnSync("git", ["-C", projAbs, "worktree", "add", wt, "HEAD"], { stdio: "ignore" }).status === 0;
		}
		if (!added) {
			process.stderr.write(`error: git worktree add failed for ${projAbs} -> ${wt}\n`);
			return 1;
		}
	}

	const cleanupTaskWorktree = (): void => {
		if (kind === "secondmate" || !existsSync(wt)) return;
		const removed = spawnSync("git", ["-C", projAbs, "worktree", "remove", "--force", wt], { stdio: "ignore" }).status === 0;
		if (removed) return;
		try {
			rmSync(wt, { recursive: true, force: true });
		} catch {
			// Best-effort fallback after the owning git command failed.
		}
	};

	// Per-project delivery mode + yolo flag.
	let mode: string;
	let yolo: string;
	let secondmateProjects = "";
	let launchCmd = "";
	if (kind === "secondmate") {
		mode = "secondmate";
		yolo = "off";
		secondmateProjects = secondmateRegistryValue(data, id, "projects") ?? "";
		const sqHome = shellQuote(projAbs);
		launchCmd = `FM_HOME=${sqHome} ${sqHome}/sbin/fm start`;
	} else {
		const pm = spawnSync(join(fmRoot, "sbin", "fm"), ["project-mode", basename(projAbs)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
		const parts = (pm.stdout ?? "").trim().split(/\s+/);
		mode = parts[0] ?? "trunk";
		yolo = parts[1] ?? "off";
		if (visible) {
			const sqBrief = shellQuote(brief);
			launchCmd = launch.split("__BRIEF__").join(sqBrief);
			if (launchFromTemplate && harness === "omp") {
				if (!parseOmpLaunchCommand(launchCmd)) {
					process.stderr.write(`error: cannot inject OMP system context into launch command for ${id}\n`);
					return 1;
				}
				const contract = crewRoleContract({
					home: projAbs,
					mainHome: fmHome,
					crewId: id,
					launchingSupervisor: supervisorName(config),
				});
				const beforeInject = launchCmd;
				launchCmd = injectOmpAppendSystemPrompts(launchCmd, [contract]);
				if (launchCmd === beforeInject || !launchCmd.includes("--append-system-prompt=")) {
					process.stderr.write(`error: OMP system-context injection failed for ${id}\n`);
					return 1;
				}
			}
		}
	}
	const paneCmd = visible ? `${launchCmd}; exec "\${SHELL:-/bin/zsh}" -l` : "";

	// Workspace, tab, and pane labels are display-only. The unique task id is
	// the durable Herdr registration slot, while the harness keeps its
	// integration identity.
	const label = kind === "secondmate" ? (secondmateRegistryValue(data, id, "name") ?? id) : workerLabel(config, id, envOrUndefined("FM_TASK_LABEL"));

	if (!visible) {
		try {
			mkdirSync(state, { recursive: true });
			writeFileSync(
				`${state}/${id}.meta`,
				[
					`worktree=${wt}`,
					`project=${projAbs}`,
					"harness=omp-task",
					"delivery=omp-task",
					`kind=${kind}`,
					`mode=${mode}`,
					`yolo=${yolo}`,
					`worker=${label}`,
					`supervisor=${supervisorName(config)}`,
				]
					.map(l => `${l}\n`)
					.join(""),
			);
		} catch {
			cleanupTaskWorktree();
			process.stderr.write(`error: could not write spawn metadata for ${id}\n`);
			return 1;
		}

		try {
			appendBacklogInflight(data, fmRoot, fmHome, id, basename(projAbs), kind);
		} catch {
			rmSync(`${state}/${id}.meta`, { force: true });
			cleanupTaskWorktree();
			process.stderr.write(`error: could not record prepared task ${id} in the backlog\n`);
			return 1;
		}

		process.stdout.write(`prepared ${id} delivery=omp-task kind=${kind} mode=${mode} yolo=${yolo} worktree=${wt} brief=${brief}\n`);
		return 0;
	}

	const agentSlot = id;
	const agentIdentity = harness;

	const recovered = recoverMissingRegisteredSecondmateWorkspace({ kind, workspace, id, dataDir: data, state, projAbs, label });
	if (recovered === null) return 1;
	workspace = recovered.workspace;
	let createdWorkspace = recovered.createdWorkspace;
	const previousWorkspace = recovered.previousWorkspace;

	let createdTab = false;
	let tabId = tab;

	function cleanupFailedSpawn(): void {
		if (createdTab && tabId) {
			spawnSync("herdr", ["tab", "close", tabId], { stdio: "ignore" });
		}
		if (createdWorkspace) {
			const replacementWorkspace = createdWorkspace;
			if (rollbackRecoveredWorkspace(data, state, id, replacementWorkspace, previousWorkspace)) {
				closeCreatedSecondmateWorkspace(replacementWorkspace, id);
				createdWorkspace = "";
			}
		}
		if (kind !== "secondmate" && existsSync(wt)) {
			const removed = spawnSync("git", ["-C", projAbs, "worktree", "remove", "--force", wt], { stdio: "ignore" }).status === 0;
			if (!removed) {
				try {
					rmSync(wt, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			}
		}
	}

	// Create a replacement tab before reaping a restored husk. A
	// caller-supplied tab is already an explicit replacement surface;
	// otherwise this keeps a husk from ever being the workspace's last tab.
	let rootPane = "";
	if (!tabId) {
		const tabArgs: string[] = [];
		if (workspace) tabArgs.push("--workspace", workspace);
		const tabRes = spawnSync("herdr", ["tab", "create", ...tabArgs, "--label", label, "--cwd", wt, "--no-focus"], {
			encoding: "utf8",
		});
		if (tabRes.status !== 0) {
			cleanupFailedSpawn();
			process.stderr.write(`error: herdr tab create failed for ${id}\n`);
			process.stderr.write(`${(tabRes.stdout ?? "") + (tabRes.stderr ?? "")}\n`);
			return 1;
		}
		const tabJson = tabRes.stdout ?? "";
		tabId = jsonGet(tabJson, "result", "tab", "tab_id");
		rootPane = jsonGet(tabJson, "result", "root_pane", "pane_id");
		if (!tabId) {
			cleanupFailedSpawn();
			process.stderr.write(`error: herdr tab create did not return a tab_id for ${id}\n`);
			process.stderr.write(`${tabJson}\n`);
			return 1;
		}
		createdTab = true;
	}
	if (!(await herdrReapHuskSlot(agentSlot))) {
		cleanupFailedSpawn();
		return 1;
	}
	if (kind === "secondmate" && workspace && !closeRecordedSecondmateShellTab(workspace, wt, tabId, recordedSecondmateTab, registeredSecondmateWorkspace)) {
		cleanupFailedSpawn();
		return 1;
	}

	// Keep Python tooling from littering homes/worktrees. FM_AGENT_SLOT tells
	// fm-identity that Herdr already owns the canonical routing name, avoiding
	// a redundant agent.rename that would reset native status to unknown.
	const startRes = spawnSync(
		"herdr",
		["agent", "start", agentSlot, "--cwd", wt, "--tab", tabId, "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", `FM_AGENT_SLOT=${agentSlot}`, "--no-focus", "--", "sh", "-c", paneCmd],
		{ encoding: "utf8" },
	);
	if (startRes.status !== 0) {
		cleanupFailedSpawn();
		process.stderr.write(`error: herdr agent start failed for ${id}\n`);
		process.stderr.write(`${(startRes.stdout ?? "") + (startRes.stderr ?? "")}\n`);
		return 1;
	}
	const launchJson = startRes.stdout ?? "";
	const pane = jsonGet(launchJson, "result", "agent", "pane_id");
	if (!pane) {
		cleanupFailedSpawn();
		process.stderr.write(`error: herdr agent start did not return a pane_id for ${id}\n`);
		process.stderr.write(`${launchJson}\n`);
		return 1;
	}
	if (rootPane && rootPane !== pane) {
		spawnSync("herdr", ["pane", "close", rootPane], { stdio: "ignore" });
	}
	spawnSync("herdr", ["pane", "rename", pane, label], { stdio: "ignore" });

	try {
		mkdirSync(state, { recursive: true });
		const metaLines: string[] = [
			`pane=${pane}`,
			`worktree=${wt}`,
			`project=${projAbs}`,
			`harness=${harness}`,
			`kind=${kind}`,
			`mode=${mode}`,
			`yolo=${yolo}`,
			`tab=${tabId}`,
			`worker=${label}`,
			`supervisor=${supervisorName(config)}`,
			`agent_slot=${agentSlot}`,
			`agent_identity=${agentIdentity}`,
		];
		if (kind !== "secondmate" && crewModel) metaLines.push(`crew_model=${crewModel}`);
		if (kind === "secondmate") {
			metaLines.push(`home=${projAbs}`);
			metaLines.push(`projects=${secondmateProjects}`);
			if (workspace) metaLines.push(`workspace=${workspace}`);
		}
		writeFileSync(`${state}/${id}.meta`, metaLines.map(l => `${l}\n`).join(""));
	} catch {
		cleanupFailedSpawn();
		process.stderr.write(`error: could not write spawn metadata for ${id}\n`);
		return 1;
	}

	if (kind !== "secondmate") {
		try {
			appendBacklogInflight(data, fmRoot, fmHome, id, basename(projAbs), kind);
		} catch {
			// best-effort
		}
	}

	process.stdout.write(`spawned ${id} harness=${harness} kind=${kind} mode=${mode} yolo=${yolo} pane=${pane} worktree=${wt}\n`);
	return 0;
}

export default {
	name: "spawn",
	describe: "Prepare background work or spawn a visible crewmate/secondmate.",
	surface: "captain" as const,
	help: {
		usage:
			"fm spawn <task-id> <project-dir> [--scout]\n" +
			"fm spawn <task-id> <project-dir> --visible [harness|launch-command] [--scout] [--workspace=<id>] [--tab=<id>] [--crew-model=<model>]\n" +
			"fm spawn <task-id> [<firstmate-home>] --secondmate [--workspace=<id>] [--tab=<id>]",
		description: "Prepare a pane-free OMP Task worktree by default; --visible launches the crewmate in Herdr. Secondmates are always visible.",
		commands: [
			{
				command: "spawn <task-id> <project-dir> [--scout]",
				description: "Prepare an isolated worktree and pane-free lifecycle metadata for OMP Task delivery.",
			},
			{
				command: "spawn <task-id> <project-dir> --visible …",
				description: "Launch an explicit visible ship/scout worker in Herdr.",
			},
			{
				command: "spawn <task-id> … --secondmate",
				description: "Launch a secondmate in its provisioned firstmate home.",
			},
		],
		notes: [
			"Batch form: fm spawn id=repo … for multiple crewmate tasks.",
			"`--help` / `-h` are never task ids or paths.",
		],
	},
	run,
};
