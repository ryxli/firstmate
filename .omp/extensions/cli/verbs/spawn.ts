// fm verb: spawn - spawn a direct report: a crewmate in a git worktree, or a
// secondmate in its isolated firstmate home.
// Ported behavior-preserving from the former sbin/fm spawn, which sourced
// sbin/fm-identity-lib.sh, sbin/fm-herdr-lib.sh, sbin/fm-spawn-lib.sh, and
// sbin/fm-tasks-axi-lib.sh. Their TS equivalents (lib/identity.ts,
// lib/herdr.ts, lib/spawn.ts) are imported below.
// The tasks-axi compatibility probe (fm-tasks-axi-lib.sh) has no standalone TS
// port yet, so its version-gate logic is reproduced locally in
// tasksAxiCompatible/tasksAxiVersionParts, used only by the best-effort
// backlog bookkeeping in appendBacklogInflight.
//
// Usage: fm spawn <task-id> <project-dir> [harness|launch-command] [--scout] [--workspace=<id>] [--tab=<id>] [--crew-model=<model>]
//        fm spawn <task-id> [<firstmate-home>] [harness|launch-command] --secondmate [--workspace=<id>] [--tab=<id>]
//   With no harness arg, the harness comes from fm harness crew (config/crew-harness,
//   falling back to firstmate's own harness). A bare adapter name (omp|claude|codex|
//   opencode|pi) overrides it for this spawn. A non-flag string containing whitespace
//   is treated as a RAW launch command - the escape hatch for verifying new adapters.
//   --scout records kind=scout in the task's meta (report deliverable, scratch worktree;
//   see AGENTS.md section 6); --secondmate records kind=secondmate and launches in a
//   provisioned firstmate home; the default is kind=ship.
// Batch dispatch: pass one or more `id=repo` pairs instead of a single <id> <project>:
//     fm spawn fix-a-k3=projects/foo add-b-q7=projects/bar [--scout]
//   Each pair re-execs `sbin/fm spawn` in single-task mode.
//
// Worktrees are created with `git worktree add` at $FM_WORKTREE_BASE/<id>
// (default: $FM_HOME/worktrees/<id>). herdr agent start launches the crewmate
// directly in the worktree directory. herdr tracks agent status natively, so
// no per-harness turn-end hook files are installed.
//
// On success prints:
//   spawned <id> harness=<name> kind=<ship|scout|secondmate> mode=<mode> yolo=<on|off> pane=<pane-id> worktree=<path>

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorName, workerLabel } from "../lib/identity";
import { herdrReapHuskSlot, jsonGet, metaSet, metaValue } from "../lib/herdr";
import { shellQuote } from "../lib/spawn";
import { crewRoleContract, ensureSecondmateParentIdentity, secondmateRoleContract } from "../lib/role-contract";

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
	const pos: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--scout") {
			kind = "scout";
		} else if (a === "--secondmate") {
			kind = "secondmate";
		} else if (a.startsWith("--workspace=")) {
			workspace = a.slice("--workspace=".length);
		} else if (a === "--workspace") {
			i += 1;
			if (i >= args.length) return { error: "error: --workspace requires a value" };
			workspace = args[i];
		} else if (a.startsWith("--crew-model=")) {
			crewModel = a.slice("--crew-model=".length);
		} else if (a === "--crew-model") {
			i += 1;
			if (i >= args.length) return { error: "error: --crew-model requires a value" };
			crewModel = args[i];
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

	return { kind, workspace, tab, crewModel, pos };
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
function runBatch(pos: string[], kind: Kind, workspace: string, crewModel: string, fmRoot: string): number {
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
		const crewModelArgs = crewModel ? ["--crew-model", crewModel] : [];

		if (kind === "secondmate") {
			process.stderr.write("error: batch dispatch does not support --secondmate; spawn each secondmate explicitly\n");
			rc = 2;
			continue;
		}

		const args =
			kind === "scout"
				? ["spawn", pairId, pairRepo, "--scout", ...workspaceArgs, ...crewModelArgs]
				: ["spawn", pairId, pairRepo, ...workspaceArgs, ...crewModelArgs];
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

export function injectOmpRoleContract(command: string, contract: string): string {
	if (!command.startsWith("omp")) return command;
	const rest = command.slice(3);
	return `omp --append-system-prompt=${shellQuote(contract)}${rest}`;
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
	writeFileSync(reg, out.map(l => `${l}\n`).join(""));
	return true;
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

// --- tasks-axi compatibility probe (best-effort backlog bookkeeping only) -----
// Mirrors sbin/fm-tasks-axi-lib.sh: compatible means tasks-axi --version
// reports 0.1.1 or newer.
function tasksAxiVersionParts(): [number, number, number] | null {
	const res = spawnSync("tasks-axi", ["--version"], { encoding: "utf8" });
	if (res.error || typeof res.stdout !== "string") return null;
	const m = res.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function tasksAxiCompatible(): boolean {
	const parts = tasksAxiVersionParts();
	if (!parts) return false;
	const [major, minor, patch] = parts;
	if (major > 0) return true;
	if (major === 0 && minor > 1) return true;
	if (major === 0 && minor === 1 && patch >= 1) return true;
	return false;
}

// appendBacklogInflight: record a dispatched ship/scout task before returning
// success. Best-effort: every failure path is swallowed (the caller never
// lets this affect the spawn's own exit code), matching the bash `|| true`.
function appendBacklogInflight(dataDir: string, fmHome: string, id: string, repo: string, kind: string): void {
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
	if (new RegExp(`^- (\\[ \\] |\\*\\*)${id}( |\\*|-|$)`, "m").test(text)) return;

	if (existsSync(`${fmHome}/.tasks.toml`) && tasksAxiCompatible()) {
		const res = spawnSync("tasks-axi", ["add", id, `${kind} task`, "--kind", kind, "--repo", repo, "--start"], {
			cwd: fmHome,
			stdio: "ignore",
		});
		if (res.status === 0) return;
	}

	const today = new Date().toISOString().slice(0, 10);
	const line = `- [ ] ${id} - ${kind} task (repo: ${repo}, since ${today})`;

	if (/^## In flight$/m.test(text)) {
		const lines = text.split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		const out: string[] = [];
		let inserted = false;
		for (const l of lines) {
			out.push(l);
			if (l === "## In flight" && !inserted) {
				out.push(line);
				inserted = true;
			}
		}
		try {
			writeFileSync(backlog, out.map(l => `${l}\n`).join(""));
		} catch {
			// best-effort
		}
	} else {
		try {
			appendFileSync(backlog, `## In flight\n${line}\n`);
		} catch {
			// best-effort
		}
	}
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

// findMatchingPaneId: the pane_id of the first live herdr pane whose cwd
// equals <cwd>, or "" when none match OR the match's pane_id is itself empty
// (mirrors the bash/python guard: an empty printed pane_id never trips the
// `[ -n "$_guard_pane" ]` check, so it is treated the same as no match).
function findMatchingPaneId(cwd: string): string {
	const res = spawnSync("herdr", ["pane", "list"], { encoding: "utf8" });
	try {
		const parsed = JSON.parse(res.stdout ?? "") as { result?: { panes?: Array<{ pane_id?: string; cwd?: string }> } };
		const panes = parsed?.result?.panes ?? [];
		for (const p of panes) {
			if (p && p.cwd === cwd) return p.pane_id ?? "";
		}
	} catch {
		// best-effort, mirrors the python helper's `2>/dev/null || true`
	}
	return "";
}

// recoverMissingRegisteredSecondmateWorkspace: when a registered workspace no
// longer exists (herdr restarted with a fresh layout), create a replacement
// workspace and durably update both the registry and this task's meta file.
// Returns the (possibly unchanged) workspace to use, or null on failure
// (having already written the error to stderr).
function recoverMissingRegisteredSecondmateWorkspace(params: {
	kind: Kind;
	workspace: string;
	id: string;
	dataDir: string;
	state: string;
	projAbs: string;
	label: string;
}): string | null {
	const { kind, workspace, id, dataDir, state, projAbs, label } = params;
	if (kind !== "secondmate") return workspace;
	if (!workspace) return workspace;
	const registeredWorkspace = secondmateRegistryValue(dataDir, id, "workspace") ?? "";
	if (workspace !== registeredWorkspace) return workspace;

	const getRes = spawnSync("herdr", ["workspace", "get", workspace], { encoding: "utf8" });
	if (getRes.status === 0) return workspace;

	const combined = (getRes.stdout ?? "") + (getRes.stderr ?? "");
	if (!/"code":"workspace_not_found"|workspace .+ not found/.test(combined)) {
		process.stderr.write(`error: could not verify registered workspace ${workspace} for secondmate ${id}\n`);
		process.stderr.write(`${combined}\n`);
		return null;
	}

	const createRes = spawnSync("herdr", ["workspace", "create", "--cwd", projAbs, "--label", label, "--no-focus"], {
		encoding: "utf8",
	});
	if (createRes.status !== 0) {
		process.stderr.write(`error: herdr workspace create failed while recovering secondmate ${id}\n`);
		process.stderr.write(`${(createRes.stdout ?? "") + (createRes.stderr ?? "")}\n`);
		return null;
	}
	const replacementJson = createRes.stdout ?? "";
	const replacementWorkspace = jsonGet(replacementJson, "result", "workspace", "workspace_id");
	if (!replacementWorkspace) {
		process.stderr.write(`error: herdr workspace create did not return a workspace_id while recovering secondmate ${id}\n`);
		process.stderr.write(`${replacementJson}\n`);
		return null;
	}

	if (!replaceRegisteredSecondmateWorkspace(dataDir, id, workspace, replacementWorkspace)) return null;
	const metaPath = `${state}/${id}.meta`;
	if (!replaceSecondmateMetaWorkspace(metaPath, replacementWorkspace, id)) {
		replaceRegisteredSecondmateWorkspace(dataDir, id, replacementWorkspace, workspace);
		return null;
	}
	return replacementWorkspace;
}

// --- main -----------------------------------------------------------------------

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const parsed = parseArgs(args);
	if ("error" in parsed) {
		process.stderr.write(`${parsed.error}\n`);
		return 2;
	}
	const { kind, tab, crewModel } = parsed;
	let { workspace } = parsed;
	const { pos } = parsed;

	const { fmRoot, fmHome, state, data, projects, config } = resolvePaths();

	if (isBatchDispatch(pos)) {
		return runBatch(pos, kind, workspace, crewModel, fmRoot);
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

	// Resolve the harness and its launch command. A non-flag string containing
	// whitespace is a raw launch command (the escape hatch for unverified
	// adapters); otherwise resolve a named or auto-detected harness against the
	// verified launch templates above.
	let harness: string;
	let launch: string;
	let launchFromTemplate = false;

	if (/\s/.test(arg3)) {
		launch = arg3;
		harness = firstCommandWordFromRaw(launch);
	} else if (arg3 === "") {
		harness = crewHarness(fmRoot);
		const tmpl = kind === "secondmate" ? launchTemplate(harness) : launchTemplate(harness, crewModel);
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
		const tmpl = kind === "secondmate" ? launchTemplate(harness) : launchTemplate(harness, crewModel);
		if (tmpl === null) {
			process.stderr.write(`error: unknown harness '${harness}'; pass a raw launch command to use an unverified adapter\n`);
			return 1;
		}
		launch = tmpl;
		launchFromTemplate = true;
	}

	// A secondmate resume: reuse the persisted home/workspace registration
	// instead of requiring them to be re-specified on every respawn.
	let secondmateResume = false;
	if (kind === "secondmate") {
		const ownMeta = `${state}/${id}.meta`;
		if (existsSync(ownMeta)) secondmateResume = true;
		if (!firstmateHome && secondmateResume) {
			firstmateHome = metaValue(ownMeta, "home");
		}
		if (!firstmateHome) {
			firstmateHome = secondmateRegistryValue(data, id, "home") ?? "";
		}
		if (!workspace) {
			workspace = secondmateRegistryValue(data, id, "workspace") ?? "";
		}
	}

	let projAbs: string;
	let wt: string;
	let brief: string;

	if (kind === "secondmate") {
		if (!firstmateHome) {
			process.stderr.write(`error: no firstmate home supplied or registered for ${id}\n`);
			return 1;
		}
		const validated = validateFirstmateHomeForSpawn(id, firstmateHome, fmRoot, fmHome);
		if (!validated.ok) return 1;
		projAbs = validated.value;
		wt = projAbs;
		const charterPath = `${projAbs}/data/charter.md`;
		brief = existsSync(charterPath) ? charterPath : `${data}/${id}/brief.md`;
	} else {
		const cdRes = cdPwd(resolveProjectDirArg(projects, proj));
		if (!cdRes.ok) return 1;
		projAbs = cdRes.value;
		wt = "";
		brief = `${data}/${id}/brief.md`;
	}

	// Pre-spawn guard: refuse if any herdr pane already has cwd == the
	// secondmate home. Prevents duplicate spawns when an existing session is
	// alive but hook-less (agent_status=unknown).
	if (kind === "secondmate" && !envOrUndefined("FM_SPAWN_FORCE")) {
		const guardPane = findMatchingPaneId(wt);
		if (guardPane) {
			process.stderr.write(
				`error: secondmate ${id} already has a live pane at ${wt} (pane ${guardPane}); set FM_SPAWN_FORCE=1 to override\n`,
			);
			return 1;
		}
	}

	if (!existsSync(brief)) {
		process.stderr.write(`error: no brief at ${brief}\n`);
		return 1;
	}

	// Preflight: validate harness binary and worktree base before creating anything.
	if (kind !== "secondmate") {
		const pre = spawnSync(join(fmRoot, "sbin", "fm"), ["resolve-spawn", projAbs, harness], { stdio: "inherit" });
		if (pre.status !== 0) return pre.status ?? 1;
	}

	// Ship and scout tabs must be created in the spawning firstmate's own
	// workspace, never whichever workspace happens to be focused. Explicit
	// --workspace and FM_SPAWN_WORKSPACE values are deliberate overrides. This
	// runs after preflight so a missing-binary abort surfaces its own error first.
	if (kind !== "secondmate" && !workspace) {
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

	// Per-project delivery mode + yolo flag.
	let mode: string;
	let yolo: string;
	let secondmateProjects = "";
	if (kind === "secondmate") {
		mode = "secondmate";
		yolo = "off";
		secondmateProjects = secondmateRegistryValue(data, id, "projects") ?? "";
	} else {
		const projName = basename(projAbs);
		const pm = spawnSync(join(fmRoot, "sbin", "fm"), ["project-mode", projName], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		});
		const parts = (pm.stdout ?? "").trim().split(/\s+/);
		mode = parts[0] ?? "";
		yolo = parts[1] ?? "";
	}

	// Build the launch command. A secondmate OMP respawn continues its
	// persisted session rather than injecting the charter as a new prompt.
	const sqBrief = shellQuote(brief);
	let launchCmd: string;
	if (harness === "omp" && kind === "secondmate" && secondmateResume) {
		launchCmd = "omp --auto-approve -c";
	} else {
		launchCmd = launch.split("__BRIEF__").join(sqBrief);
	}
	if (launchFromTemplate && kind === "secondmate" && harness === "omp" && existsSync(`${projAbs}/config/omp.yml`)) {
		const sqOmpConfig = shellQuote(`${projAbs}/config/omp.yml`);
		const stripped = launchCmd.startsWith("omp") ? launchCmd.slice(3) : launchCmd;
		launchCmd = `omp --config ${sqOmpConfig}${stripped}`;
	}
	if (harness === "omp") {
		const contract = kind === "secondmate"
			? secondmateRoleContract({ home: projAbs, mainHome: fmHome })
			: crewRoleContract({ home: projAbs, mainHome: fmHome, crewId: id, launchingSupervisor: supervisorName(config) });
		if (kind === "secondmate") ensureSecondmateParentIdentity(projAbs, supervisorName(config));
		launchCmd = injectOmpRoleContract(launchCmd, contract);
	}
	if (kind === "secondmate") {
		const sqHome = shellQuote(projAbs);
		launchCmd = `FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=${sqHome} ${launchCmd}`;
	}
	const paneCmd = `${launchCmd}; exec "\${SHELL:-/bin/zsh}" -l`;

	// The tab and pane label are display-only. The unique task id is the
	// durable herdr registration slot, while the harness keeps its integration
	// identity.
	const label = kind === "secondmate" ? (secondmateRegistryValue(data, id, "name") ?? "home") : workerLabel(config, id, envOrUndefined("FM_TASK_LABEL"));
	const agentSlot = id;
	const agentIdentity = harness;

	const recovered = recoverMissingRegisteredSecondmateWorkspace({ kind, workspace, id, dataDir: data, state, projAbs, label });
	if (recovered === null) return 1;
	workspace = recovered;

	let createdTab = false;
	let tabId = tab;

	function cleanupFailedSpawn(): void {
		if (createdTab && tabId) {
			spawnSync("herdr", ["tab", "close", tabId], { stdio: "ignore" });
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

	// PYTHONDONTWRITEBYTECODE keeps any Python tooling a crewmate/secondmate
	// runs from littering its worktree or home with __pycache__/*.pyc, the same
	// way herdr itself injects HERDR_SOCKET_PATH and friends into every pane it starts.
	const startRes = spawnSync(
		"herdr",
		["agent", "start", agentSlot, "--cwd", wt, "--tab", tabId, "--env", "PYTHONDONTWRITEBYTECODE=1", "--no-focus", "--", "sh", "-c", paneCmd],
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

	if (kind !== "secondmate") {
		try {
			appendBacklogInflight(data, fmHome, id, basename(projAbs), kind);
		} catch {
			// best-effort
		}
	}

	process.stdout.write(`spawned ${id} harness=${harness} kind=${kind} mode=${mode} yolo=${yolo} pane=${pane} worktree=${wt}\n`);
	return 0;
}

export default {
	name: "spawn",
	describe: "Spawn a direct report: a crewmate in a git worktree, or a secondmate in its isolated firstmate home.",
	run,
};
