// fm verb: home-seed - transactional provisioning and routing for persistent
// secondmate homes.
// Ported behavior-preserving from the former sbin/fm home-seed, with the
// shared ship omp-extension symlink logic it sourced from
// sbin/fm-ship-ext-lib.sh now imported from ../lib/ship-ext (linkShipExtensions).
//
// Usage: fm home-seed <id> <home|-> <project>...
//   Provision <home> as an isolated firstmate home. If <home> is "-", create a
//   fresh herdr-managed git worktree of the firstmate repo alongside the repo
//   (at <parent-of-repo>/fm-sm-<id>). The herdr workspace ID is stored in
//   data/secondmates.md so teardown can remove the workspace cleanly. Projects
//   are cloned from the active home into the secondmate home's projects/
//   directory. That project list is non-exclusive provisioning data. The
//   charter brief is copied to data/charter.md, a .fm-secondmate-home marker
//   is written, and data/secondmates.md is updated.
//   Seeding is transactional: on validation, clone, init, or registry failure,
//   generated briefs, new homes, new project clones, and registry edits are
//   rolled back. Herdr-created homes are removed via "herdr worktree remove"
//   on rollback; a failed removal warns because the workspace may still exist.
//   Set FM_SECONDMATE_CHARTER='<charter>' to seed from inline charter text
//   when no filled charter brief exists. Set FM_SECONDMATE_SCOPE='<scope>' to
//   override the registry routing scope. Otherwise the registry summary and
//   scope are derived from the filled charter brief.
// Usage: fm home-seed validate
//   Refuse duplicate ids, duplicate homes, and nested or overlapping homes in
//   data/secondmates.md.

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMateHomeLayout } from "../lib/mate-home-layout";
import { syncHomeSkills } from "../lib/home-skills";
import { ensureMateMiseToml } from "../lib/mise-home";
import { linkShipExtensions } from "../lib/ship-ext";
import { identityValue, assertIdentityDisplayName } from "../lib/identity";
import { parseSecondmateRegistryLine } from "../lib/secondmate-registry";

// Canonical repo root, resolved from this module's own physical location
// (four directories up from .omp/extensions/cli/verbs/) - independent of
// FM_ROOT_OVERRIDE, matching the bash script's SCRIPT_DIR-based resolution.
// This is what the ship extension symlink source is always read from, since
// the bash script derived ext_src from SCRIPT_DIR too, never from FM_ROOT.
const CANONICAL_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

const SUB_HOME_MARKER = ".fm-secondmate-home";

interface Ctx {
	fmRoot: string;
	fmHome: string;
	data: string;
	projectsDir: string;
	reg: string;
}

class SeedFailure extends Error {}

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	throw new SeedFailure(message);
}

function envOr(name: string, fallback: string): string {
	const value = process.env[name];
	return value !== undefined && value !== "" ? value : fallback;
}

function usage(): void {
	process.stderr.write("usage: fm home-seed <id> <home|-> <project>...\n");
	process.stderr.write("       fm home-seed validate\n");
	process.stderr.write("       fm link-ship-ext <id|home-path>  # refresh extension symlinks without re-seeding\n");
}

// ---- generic fs/path helpers -------------------------------------------------

function existsPath(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function isDir(path: string): boolean {
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

function splitLinesNoTrailing(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function todayDate(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function capitalizeId(id: string): string {
	if (!id) return id;
	return id.charAt(0).toUpperCase() + id.slice(1);
}

// normalizeJoinedPath(prefix, tail): join a canonical prefix with a "/"-joined
// tail of path components that do not yet exist, resolving "." and ".."
// components against prefix without touching the filesystem. Mirrors the
// bash script's normalize_joined_path.
function normalizeJoinedPath(prefix: string, tail: string): string {
	let out = prefix !== "/" && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	if (out === "") out = "/";
	if (tail === "") return out;
	for (const component of tail.split("/")) {
		if (component === "" || component === ".") continue;
		if (component === "..") {
			if (out !== "/") {
				const idx = out.lastIndexOf("/");
				out = idx > 0 ? out.slice(0, idx) : "/";
			}
			continue;
		}
		out = out === "/" ? `/${component}` : `${out}/${component}`;
	}
	return out;
}

// resolvedPath(path): canonicalize path the same way the bash script's
// canonical_path_for_check does: follow symlinks through every EXISTING
// ancestor component (like realpath), but never resolve a symlink at the
// final leaf itself, and for a nonexistent path, canonicalize the deepest
// existing ancestor then append the remaining nonexistent tail literally.
// This asymmetry (leaf never dereferenced) is what lets the leaf-symlink
// checks elsewhere detect a symlinked marker/registry file.
function resolvedPath(inputPath: string): string {
	let probe = inputPath.startsWith("/") ? inputPath : join(process.cwd(), inputPath);
	while (probe !== "/" && probe.endsWith("/")) probe = probe.slice(0, -1);
	if (probe === "") probe = "/";

	if (existsPath(probe)) {
		if (isDir(probe)) return realpathSync(probe);
		return `${realpathSync(dirname(probe))}/${basename(probe)}`;
	}

	let tail = "";
	while (!existsPath(probe) && probe !== "/") {
		const b = basename(probe);
		tail = tail ? `${b}/${tail}` : b;
		probe = dirname(probe);
	}
	let prefix: string;
	if (isDir(probe)) {
		prefix = realpathSync(probe);
	} else if (existsPath(probe)) {
		prefix = `${realpathSync(dirname(probe))}/${basename(probe)}`;
	} else {
		prefix = "/";
	}
	return normalizeJoinedPath(prefix, tail);
}

function pathIsAncestorOf(ancestor: string, path: string): boolean {
	if (!ancestor || !path || ancestor === path) return false;
	return path.startsWith(`${ancestor}/`);
}

// ---- registry text helpers ---------------------------------------------------

// normalizeRegistryText(text): mirror the bash awk pipeline - strip ";" and
// "()" to spaces, squeeze whitespace runs, trim, and join every non-empty
// resulting line with a single space into one line.
function normalizeRegistryText(text: string): string {
	let out = "";
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/[;()]/g, " ").replace(/\s+/g, " ").trim();
		if (line !== "") out = out === "" ? line : `${out} ${line}`;
	}
	return out;
}

function briefSectionText(briefPath: string, heading: string): string {
	if (!existsSync(briefPath)) return "";
	const target = `# ${heading}`;
	const lines = readFileSync(briefPath, "utf8").split(/\r?\n/);
	let inSection = false;
	const collected: string[] = [];
	for (const line of lines) {
		if (line === target) {
			inSection = true;
			continue;
		}
		if (inSection && /^# /.test(line)) break;
		if (inSection) collected.push(line);
	}
	return collected.join("\n");
}

function registrySummaryForBrief(brief: string): string {
	const charterEnv = process.env.FM_SECONDMATE_CHARTER;
	if (charterEnv !== undefined && charterEnv !== "") return normalizeRegistryText(charterEnv);
	return normalizeRegistryText(briefSectionText(brief, "Charter"));
}

function registryScopeForBrief(brief: string): string {
	const scopeEnv = process.env.FM_SECONDMATE_SCOPE;
	if (scopeEnv !== undefined && scopeEnv !== "") return normalizeRegistryText(scopeEnv);
	return normalizeRegistryText(briefSectionText(brief, "Routing scope"));
}

function validateRegistryHomeText(home: string): void {
	if (home.includes(";") || home.includes(")") || home.includes("\n")) {
		fail(`error: secondmate home path contains registry delimiters: ${home}`);
	}
}

interface RegEntry {
	homeKey: string;
	id: string;
}

function readRegistryEntries(reg: string): RegEntry[] {
	if (!existsSync(reg)) return [];
	const entries: RegEntry[] = [];
	for (const line of splitLinesNoTrailing(readFileSync(reg, "utf8"))) {
		const parsed = parseSecondmateRegistryLine(line);
		if (!parsed || !parsed.home) continue;
		entries.push({ homeKey: resolvedPath(parsed.home), id: parsed.id });
	}
	return entries;
}

// validateRegistry: refuse duplicate homes, duplicate ids, and nested or
// overlapping homes, mirroring the bash script's three-stage awk checks
// (each stage short-circuits on its own failure, matching set -e's abort).
function validateRegistry(reg: string): { ok: true } | { ok: false; message: string } {
	const entries = readRegistryEntries(reg);

	const homeOwner = new Map<string, string>();
	const dupHomeLines: string[] = [];
	for (const e of entries) {
		if (homeOwner.has(e.homeKey)) {
			const owner = homeOwner.get(e.homeKey);
			if (owner !== e.id) dupHomeLines.push(`${e.homeKey}: ${owner}, ${e.id}`);
		} else {
			homeOwner.set(e.homeKey, e.id);
		}
	}
	if (dupHomeLines.length > 0) {
		return { ok: false, message: `error: duplicate secondmate home assignment:\n${dupHomeLines.join("\n")}` };
	}

	const idHome = new Map<string, string>();
	const dupIdLines: string[] = [];
	for (const e of entries) {
		if (idHome.has(e.id)) {
			dupIdLines.push(`${e.id}: ${idHome.get(e.id)}, ${e.homeKey}`);
		} else {
			idHome.set(e.id, e.homeKey);
		}
	}
	if (dupIdLines.length > 0) {
		return { ok: false, message: `error: duplicate secondmate id assignment:\n${dupIdLines.join("\n")}` };
	}

	const seen: RegEntry[] = [];
	const overlapLines: string[] = [];
	for (const e of entries) {
		for (const prior of seen) {
			if (pathIsAncestorOf(e.homeKey, prior.homeKey)) {
				overlapLines.push(`${e.homeKey} (${e.id}) contains ${prior.homeKey} (${prior.id})`);
			} else if (pathIsAncestorOf(prior.homeKey, e.homeKey)) {
				overlapLines.push(`${prior.homeKey} (${prior.id}) contains ${e.homeKey} (${e.id})`);
			}
		}
		seen.push(e);
	}
	if (overlapLines.length > 0) {
		return { ok: false, message: `error: overlapping secondmate home assignment:\n${overlapLines.join("\n")}` };
	}

	return { ok: true };
}

function runValidateRegistry(reg: string): boolean {
	const result = validateRegistry(reg);
	if (result.ok) return true;
	process.stderr.write(`${result.message}\n`);
	return false;
}

function registryHomeConflictForAssignment(
	reg: string,
	id: string,
	home: string,
): { type: "exact" | "overlap"; owner: string; home: string } | null {
	if (!existsSync(reg)) return null;
	const target = resolvedPath(home);
	for (const line of splitLinesNoTrailing(readFileSync(reg, "utf8"))) {
		const parsed = parseSecondmateRegistryLine(line);
		if (!parsed || !parsed.home) continue;
		const registeredId = parsed.id;
		const registeredKey = resolvedPath(parsed.home);
		if (registeredKey === target) {
			if (registeredId === id) continue;
			return { type: "exact", owner: registeredId, home: registeredKey };
		}
		if (pathIsAncestorOf(registeredKey, target) || pathIsAncestorOf(target, registeredKey)) {
			return { type: "overlap", owner: registeredId, home: registeredKey };
		}
	}
	return null;
}

function registryIdConflictForAssignment(reg: string, id: string, home: string): string | null {
	if (!existsSync(reg)) return null;
	const target = resolvedPath(home);
	for (const line of splitLinesNoTrailing(readFileSync(reg, "utf8"))) {
		const parsed = parseSecondmateRegistryLine(line);
		if (!parsed || !parsed.home) continue;
		const registeredId = parsed.id;
		if (registeredId !== id) continue;
		const registeredKey = resolvedPath(parsed.home);
		if (registeredKey === target) continue;
		return registeredKey;
	}
	return null;
}

function validateHomeAssignment(ctx: Ctx, id: string, home: string): void {
	const markerPath = join(home, SUB_HOME_MARKER);
	if (existsSync(markerPath)) {
		const markerId = readFileSync(markerPath, "utf8").replace(/\r?\n+$/, "");
		if (markerId !== id) {
			fail(`error: secondmate home ${home} is already marked for ${markerId || "unknown"}`);
		}
	}
	const idConflict = registryIdConflictForAssignment(ctx.reg, id, home);
	if (idConflict) {
		fail(`error: secondmate id ${id} is already registered to home ${idConflict}; retire it before assigning ${home}`);
	}
	const conflict = registryHomeConflictForAssignment(ctx.reg, id, home);
	if (!conflict) return;
	if (conflict.type === "exact") {
		fail(`error: secondmate home ${home} is already registered to ${conflict.owner}`);
	}
	fail(`error: secondmate home ${home} overlaps registered secondmate home ${conflict.home} for ${conflict.owner}`);
}

// ---- active-home / repo-root safety checks -----------------------------------

function refuseActiveHomePath(ctx: Ctx, home: string): void {
	const absHome = resolvedPath(home);
	const absActiveHome = resolvedPath(ctx.fmHome);
	const absRoot = resolvedPath(ctx.fmRoot);
	if (absHome === "/") fail(`error: secondmate home cannot be the filesystem root: ${home}`);
	if (absHome === absActiveHome) fail(`error: secondmate home cannot be the active firstmate home: ${home}`);
	if (absHome === absRoot) fail(`error: secondmate home cannot be the firstmate repo: ${home}`);
	if (pathIsAncestorOf(absActiveHome, absHome)) {
		fail(`error: secondmate home cannot be inside the active firstmate home: ${home}`);
	}
	if (pathIsAncestorOf(absRoot, absHome)) fail(`error: secondmate home cannot be inside the firstmate repo: ${home}`);
	if (pathIsAncestorOf(absHome, absActiveHome)) {
		fail(`error: secondmate home cannot be an ancestor of the active firstmate home: ${home}`);
	}
	if (pathIsAncestorOf(absHome, absRoot)) {
		fail(`error: secondmate home cannot be an ancestor of the firstmate repo: ${home}`);
	}
}

function validateOperationalDir(ctx: Ctx, home: string, name: string): void {
	const dir = join(home, name);
	if (isSymlinkPath(dir) && !existsPath(dir)) {
		fail(`error: secondmate ${name} directory must resolve inside the secondmate home: ${dir}`);
	}
	const absHome = resolvedPath(home);
	const absDir = resolvedPath(dir);
	const absActiveHome = resolvedPath(ctx.fmHome);
	const absRoot = resolvedPath(ctx.fmRoot);
	if (!pathIsAncestorOf(absHome, absDir)) {
		fail(`error: secondmate ${name} directory must resolve inside the secondmate home: ${dir}`);
	}
	if (absDir === absActiveHome || pathIsAncestorOf(absActiveHome, absDir)) {
		fail(`error: secondmate ${name} directory cannot be inside the active firstmate home: ${dir}`);
	}
	if (absDir === absRoot || pathIsAncestorOf(absRoot, absDir)) {
		fail(`error: secondmate ${name} directory cannot be inside the firstmate repo: ${dir}`);
	}
}

function validateOperationalDirs(ctx: Ctx, home: string): void {
	for (const name of ["data", "state", "config", "projects"]) validateOperationalDir(ctx, home, name);
}

function validateSeedLeafFiles(ctx: Ctx, home: string): void {
	const absHome = resolvedPath(home);
	for (const label of ["data/projects.md", "data/charter.md", SUB_HOME_MARKER, "config/identity"]) {
		const path = join(home, label);
		if (isSymlinkPath(path)) fail(`error: secondmate leaf file must not be a symlink: ${path}`);
		if (!existsSync(path)) continue;
		const absPath = resolvedPath(path);
		if (!absPath.startsWith(`${absHome}/`)) {
			fail(`error: secondmate leaf file must resolve inside the secondmate home: ${path}`);
		}
	}
}

function validateProjectDestination(ctx: Ctx, home: string, project: string): string {
	const projectsDirPath = join(home, "projects");
	const dst = join(projectsDirPath, project);
	const absHome = resolvedPath(home);
	const absProjects = resolvedPath(projectsDirPath);
	const absDst = resolvedPath(dst);
	const absActiveHome = resolvedPath(ctx.fmHome);
	const absRoot = resolvedPath(ctx.fmRoot);
	if (!pathIsAncestorOf(absHome, absProjects)) {
		fail(`error: secondmate projects directory must resolve inside the secondmate home: ${projectsDirPath}`);
	}
	if (!pathIsAncestorOf(absProjects, absDst)) {
		fail(`error: seeded project ${project} destination must resolve inside the secondmate projects directory: ${dst}`);
	}
	if (absDst === absActiveHome || pathIsAncestorOf(absActiveHome, absDst)) {
		fail(`error: seeded project ${project} destination cannot be inside the active firstmate home: ${dst}`);
	}
	if (absDst === absRoot || pathIsAncestorOf(absRoot, absDst)) {
		fail(`error: seeded project ${project} destination cannot be inside the firstmate repo: ${dst}`);
	}
	return absDst;
}

// ---- git / project helpers ----------------------------------------------------

function isGitRepo(path: string): boolean {
	const res = spawnSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
	return !res.error && res.status === 0;
}

function gitRemoteUrl(path: string): string {
	const res = spawnSync("git", ["-C", path, "remote", "get-url", "origin"], {
		stdio: ["ignore", "pipe", "ignore"],
		encoding: "utf8",
	});
	if (res.error || res.status !== 0) return "";
	return (res.stdout ?? "").replace(/\r?\n+$/, "");
}

function gitCloneQuiet(url: string, dst: string): void {
	const res = spawnSync("git", ["clone", "--quiet", url, dst], { stdio: "inherit" });
	if (res.status !== 0 || res.error) throw new SeedFailure("git clone failed");
}

// normalizeOriginUrl(repo, url): mirror the bash script's case-based
// classification - a scheme URL (file://, ssh://, https://, ...) or an
// scp-style "host:path" remote passes through unchanged; anything else is a
// filesystem path resolved relative to repo.
function normalizeOriginUrl(repo: string, url: string): string {
	if (url.includes("://")) return url;
	const colonIdx = url.indexOf(":");
	if (colonIdx !== -1) {
		const prefix = url.slice(0, colonIdx);
		if (!prefix.includes("/")) return url;
	}
	const cwd = process.cwd();
	process.chdir(repo);
	try {
		return resolvedPath(url);
	} finally {
		process.chdir(cwd);
	}
}

function sourceOriginUrl(project: string, mode: string, src: string): string {
	const url = gitRemoteUrl(src);
	if (!url) fail(`error: project ${project} is ${mode} but has no origin remote`);
	return normalizeOriginUrl(src, url);
}

function seededOriginUrl(project: string, dst: string, expected: string): string {
	const url = gitRemoteUrl(dst);
	if (!url) fail(`error: seeded project ${project} at ${dst} has no origin remote; expected ${expected}`);
	return normalizeOriginUrl(dst, url);
}

function queryProjectMode(ctx: Ctx, project: string): string {
	const res = spawnSync(join(ctx.fmRoot, "sbin", "fm"), ["project-mode", project], {
		stdio: ["ignore", "pipe", "inherit"],
		encoding: "utf8",
		env: { ...process.env, FM_HOME: ctx.fmHome, FM_DATA_OVERRIDE: ctx.data },
	});
	const firstLine = (res.stdout ?? "").split(/\r?\n/)[0] ?? "";
	return firstLine.trim().split(/\s+/)[0] ?? "";
}

function validateSeedProject(ctx: Ctx, project: string): void {
	const src = join(ctx.projectsDir, project);
	if (!existsSync(src)) fail(`error: project ${project} not found at ${src}`);
	if (!isGitRepo(src)) fail(`error: project ${project} is not a git repo`);
	const mode = queryProjectMode(ctx, project);
	if (mode === "trunk") {
		fail(`error: project ${project} is trunk; secondmate routes support only pr projects`);
	}
	const url = gitRemoteUrl(src);
	if (!url) fail(`error: project ${project} is ${mode} but has no origin remote`);
}

function cloneProject(ctx: Ctx, project: string, home: string): void {
	const src = join(ctx.projectsDir, project);
	const dst = validateProjectDestination(ctx, home, project);
	if (!existsSync(src)) fail(`error: project ${project} not found at ${src}`);
	if (!isGitRepo(src)) fail(`error: project ${project} is not a git repo`);
	const mode = queryProjectMode(ctx, project);
	if (mode === "trunk") {
		fail(`error: project ${project} is trunk; secondmate routes support only pr projects`);
	}
	if (existsSync(dst)) {
		if (!isDir(dst)) fail(`error: seeded project ${project} exists at ${dst} but is not a directory`);
		if (!isGitRepo(dst)) fail(`error: seeded project ${project} at ${dst} is not a git repo`);
		const url = sourceOriginUrl(project, mode, src);
		const dstUrl = seededOriginUrl(project, dst, url);
		if (dstUrl !== url) fail(`error: seeded project ${project} at ${dst} has origin ${dstUrl}; expected ${url}`);
		return;
	}
	const url = sourceOriginUrl(project, mode, src);
	gitCloneQuiet(url, dst);
}

function registryLineForProject(ctx: Ctx, project: string): string | null {
	const path = join(ctx.data, "projects.md");
	if (!existsSync(path)) return null;
	for (const line of splitLinesNoTrailing(readFileSync(path, "utf8"))) {
		const trimmed = line.trim();
		const fields = trimmed.length ? trimmed.split(/\s+/) : [];
		if (fields[0] === "-" && fields[1] === project) return line;
	}
	return null;
}

function syncProjectRegistry(ctx: Ctx, home: string, projects: string[]): void {
	const subReg = join(home, "data", "projects.md");
	const selected = new Set(projects);
	let kept: string[] = [];
	if (existsSync(subReg)) {
		kept = splitLinesNoTrailing(readFileSync(subReg, "utf8")).filter(line => {
			const trimmed = line.trim();
			const fields = trimmed.length ? trimmed.split(/\s+/) : [];
			return !(fields[0] === "-" && selected.has(fields[1] ?? ""));
		});
	}
	const today = todayDate();
	const appended = projects.map(project => registryLineForProject(ctx, project) ?? `- ${project} - cloned project (added ${today})`);
	writeFileSync(subReg, [...kept, ...appended].map(l => `${l}\n`).join(""));
}

function writeRegistry(ctx: Ctx, id: string, home: string, projectsCsv: string, briefPath: string, workspaceId: string): void {
	mkdirSync(ctx.data, { recursive: true });
	const scope = registryScopeForBrief(briefPath);
	const summary = registrySummaryForBrief(briefPath);
	const name = capitalizeId(id);
	const today = todayDate();
	let lines: string[] = [];
	if (existsSync(ctx.reg)) {
		const pattern = new RegExp(`^- ${id}( |$)`);
		lines = splitLinesNoTrailing(readFileSync(ctx.reg, "utf8")).filter(line => !pattern.test(line));
	}
	const entry = workspaceId
		? `- ${id} - ${summary} (home: ${home}; workspace: ${workspaceId}; name: ${name}; scope: ${scope}; projects: ${projectsCsv}; added ${today})`
		: `- ${id} - ${summary} (home: ${home}; name: ${name}; scope: ${scope}; projects: ${projectsCsv}; added ${today})`;
	lines.push(entry);
	writeFileSync(ctx.reg, lines.map(l => `${l}\n`).join(""));
}

function writeSeedIdentity(ctx: Ctx, home: string, id: string, role: string): void {
	const name = capitalizeId(id);
	const parent = identityValue(join(ctx.fmHome, "config"), "name") ?? "firstmate";
	const identityFile = join(home, "config", "identity");
	if (existsSync(identityFile)) {
		const line = readFileSync(identityFile, "utf8")
			.split(/\r?\n/)
			.find(l => /^schema_version[ \t]*=/.test(l));
		if (line !== undefined) {
			const value = line.replace(/^schema_version[ \t]*=[ \t]*/, "");
			if (value === "1") return;
		}
	}
	assertIdentityDisplayName(name, "name", identityFile);
	assertIdentityDisplayName(parent, "parent", identityFile);
	writeFileSync(identityFile, `schema_version=1\nname=${name}\nrole=${role}\nparent=${parent}\n`);
}

// ---- herdr worktree acquisition -----------------------------------------------

function acquireHerdrHome(ctx: Ctx, id: string): { workspaceId: string; home: string } {
	const smBase = envOr("FM_HERDR_SM_BASE", dirname(realpathSync(ctx.fmRoot)));
	const autoPath = join(smBase, `fm-sm-${id}`);
	const name = capitalizeId(id);
	const res = spawnSync(
		"herdr",
		["worktree", "create", "--cwd", ctx.fmRoot, "--branch", `sm/${id}`, "--path", autoPath, "--label", name, "--no-focus", "--json"],
		{ encoding: "utf8" },
	);
	if (res.error || res.status !== 0) {
		fail(`error: herdr worktree create failed for secondmate home ${autoPath}`);
	}
	const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	const wsMatch = combined.match(/"workspace_id":"([^"]*)"/);
	const workspaceId = wsMatch ? wsMatch[1] : "";
	if (!workspaceId) fail("error: herdr worktree create did not return a workspace_id");
	const homeMatch = combined.match(/"checkout_path":"([^"]*)"/);
	const home = homeMatch ? homeMatch[1] : autoPath;
	return { workspaceId, home };
}

function seedRemoveHerdrHome(workspaceId: string): void {
	if (!workspaceId) return;
	const res = spawnSync("herdr", ["worktree", "remove", "--workspace", workspaceId, "--force"], {
		stdio: "ignore",
	});
	if (res.status !== 0 || res.error) {
		process.stderr.write(`warning: failed to remove herdr workspace ${workspaceId} during seed rollback; workspace may still exist\n`);
	}
}

function verifyFirstmateHome(ctx: Ctx, home: string): string {
	refuseActiveHomePath(ctx, home);
	if (!isFile(join(home, "AGENTS.md"))) fail(`error: ${home} is not a firstmate home (missing AGENTS.md)`);
	const sbinPath = join(home, "sbin");
	if (!(isDir(sbinPath) || isSymlinkPath(sbinPath))) fail(`error: ${home} is not a firstmate home (missing sbin/)`);
	validateOperationalDirs(ctx, home);
	return realpathSync(home);
}

// ensureHome: the "requested_home != '-'" path - clone the firstmate repo into
// a fresh explicit path, or verify a pre-existing directory as-is.
function ensureHome(ctx: Ctx, home: string): string {
	refuseActiveHomePath(ctx, home);
	if (existsSync(home)) {
		if (!isDir(home)) fail(`error: ${home} exists and is not a directory`);
	} else {
		mkdirSync(dirname(home), { recursive: true });
		gitCloneQuiet(ctx.fmRoot, home);
	}
	return verifyFirstmateHome(ctx, home);
}

// ---- rollback bookkeeping ------------------------------------------------------

interface SeedState {
	committed: boolean;
	home: string;
	homeAcquired: boolean;
	homeCreated: boolean;
	homeBackedUp: boolean;
	backupDir: string;
	createdProjectsFile: string;
	createdExtLinksFile: string;
	createdSkillArtifactsFile: string;
	extDstExisted: boolean;
	skillsDirExisted: boolean;
	ompYmlExisted: boolean;
	parentRegExisted: boolean;
	parentBrief: string;
	parentBriefCreated: boolean;
	parentBriefDirCreated: boolean;
	subRegExisted: boolean;
	charterExisted: boolean;
	markerExisted: boolean;
	identityExisted: boolean;
	miseTomlCreated: boolean;
	herdrWorkspaceId: string;
}

function restoreSeedFile(existed: boolean, backup: string, path: string): void {
	if (existed) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			copyFileSync(backup, path);
		} catch {
			// best-effort restore, mirroring the bash script's `|| true`
		}
	} else {
		try {
			rmSync(path, { force: true });
		} catch {
			// best-effort removal
		}
	}
}

function readTrackedPaths(file: string): string[] {
	if (!existsSync(file)) return [];
	return splitLinesNoTrailing(readFileSync(file, "utf8")).filter(l => l.length > 0);
}

// seedRollbackTarget: refuse to remove anything that is, contains, or is
// contained by the active firstmate home or the firstmate repo. Returns the
// safe absolute target, or null (having already warned to stderr) when the
// removal must be skipped rather than aborting the whole rollback.
function seedRollbackTarget(ctx: Ctx, target: string, label: string): string | null {
	if (!target) return null;
	if (target === "/") {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target}\n`);
		return null;
	}
	const absTarget = resolvedPath(target);
	const absHome = resolvedPath(ctx.fmHome);
	const absRoot = resolvedPath(ctx.fmRoot);
	if (absTarget === absHome) {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target} is the active firstmate home\n`);
		return null;
	}
	if (absTarget === absRoot) {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target} is the firstmate repo\n`);
		return null;
	}
	if (pathIsAncestorOf(absTarget, absHome)) {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target} is an ancestor of the active firstmate home\n`);
		return null;
	}
	if (pathIsAncestorOf(absTarget, absRoot)) {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target} is an ancestor of the firstmate repo\n`);
		return null;
	}
	if (pathIsAncestorOf(absHome, absTarget)) {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target} is inside the active firstmate home\n`);
		return null;
	}
	if (pathIsAncestorOf(absRoot, absTarget)) {
		process.stderr.write(`REFUSED: unsafe ${label} rollback target ${target} is inside the firstmate repo\n`);
		return null;
	}
	return absTarget;
}

function seedRemoveCreatedHome(ctx: Ctx, home: string): void {
	const abs = seedRollbackTarget(ctx, home, "created home");
	if (!abs) return;
	try {
		rmSync(abs, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

function seedProjectRollbackTarget(ctx: Ctx, target: string, home: string): string | null {
	const absTarget = seedRollbackTarget(ctx, target, "created project");
	if (!absTarget) return null;
	const absHome = resolvedPath(home);
	const absProjects = resolvedPath(join(home, "projects"));
	if (!pathIsAncestorOf(absHome, absProjects)) {
		process.stderr.write(`REFUSED: unsafe created project rollback target ${target} has projects directory outside the secondmate home\n`);
		return null;
	}
	if (!pathIsAncestorOf(absProjects, absTarget)) {
		process.stderr.write(`REFUSED: unsafe created project rollback target ${target} is outside the secondmate projects directory\n`);
		return null;
	}
	return absTarget;
}

function seedRemoveCreatedProject(ctx: Ctx, target: string, home: string): void {
	const abs = seedProjectRollbackTarget(ctx, target, home);
	if (!abs) return;
	try {
		rmSync(abs, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

function rollback(ctx: Ctx, state: SeedState): void {
	if (state.parentBrief && state.parentBriefCreated) {
		try {
			rmSync(state.parentBrief, { force: true });
		} catch {
			// best-effort
		}
	}
	if (state.parentBrief && state.parentBriefDirCreated) {
		try {
			rmdirSync(dirname(state.parentBrief));
		} catch {
			// non-empty or already gone; ignore, mirrors bash's `rmdir ... || true`
		}
	}

	if (state.home && state.home !== "/") {
		if (state.homeAcquired) {
			seedRemoveHerdrHome(state.herdrWorkspaceId);
		} else if (state.homeCreated) {
			seedRemoveCreatedHome(ctx, state.home);
		} else {
			for (const p of readTrackedPaths(state.createdProjectsFile)) seedRemoveCreatedProject(ctx, p, state.home);
			for (const link of readTrackedPaths(state.createdExtLinksFile)) {
				try {
					rmSync(link, { force: true });
				} catch {
					// best-effort
				}
			}
			for (const path of readTrackedPaths(state.createdSkillArtifactsFile)) {
				try {
					rmSync(path, { force: true, recursive: true });
				} catch {
					// best-effort
				}
			}
			if (!state.skillsDirExisted) {
				try {
					rmdirSync(join(state.home, ".omp", "skills"));
				} catch {
					// non-empty or already gone; ignore
				}
			}
			if (!state.ompYmlExisted) {
				try {
					rmSync(join(state.home, "config", "omp.yml"), { force: true });
				} catch {
					// best-effort
				}
			}
			if (!state.extDstExisted) {
				try {
					rmdirSync(join(state.home, ".omp", "extensions"));
				} catch {
					// non-empty or already gone; ignore
				}
				try {
					rmdirSync(join(state.home, ".omp"));
				} catch {
					// non-empty or already gone; ignore
				}
			}
			if (state.homeBackedUp) {
				restoreSeedFile(state.markerExisted, join(state.backupDir, "marker"), join(state.home, SUB_HOME_MARKER));
				restoreSeedFile(state.charterExisted, join(state.backupDir, "charter.md"), join(state.home, "data", "charter.md"));
				restoreSeedFile(state.subRegExisted, join(state.backupDir, "sub-projects.md"), join(state.home, "data", "projects.md"));
				restoreSeedFile(state.identityExisted, join(state.backupDir, "identity"), join(state.home, "config", "identity"));
				if (state.miseTomlCreated) {
					try {
						rmSync(join(state.home, ".mise.toml"), { force: true });
					} catch {
						// best-effort removal
					}
				}
			}
		}
	}

	if (state.backupDir) {
		restoreSeedFile(state.parentRegExisted, join(state.backupDir, "parent-secondmates.md"), ctx.reg);
		try {
			rmSync(state.backupDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

// ---- charter brief scaffold ---------------------------------------------------

function runFmBriefScaffold(ctx: Ctx, id: string, projects: string[]): void {
	// `fm brief` (ported to TypeScript) is the current form of the former
	// sbin/fm brief; flags are scanned independent of position, so this id-
	// then-flag order matches the bash script's original invocation exactly.
	const res = spawnSync(join(ctx.fmRoot, "sbin", "fm"), ["brief", id, "--secondmate", ...projects], { stdio: "inherit" });
	if (res.status !== 0 || res.error) throw new SeedFailure("fm brief --secondmate scaffold failed");
}

// ---- main seed transaction -----------------------------------------------------

function seedHome(ctx: Ctx, id: string, requestedHome: string, projects: string[]): number {
	if (projects.length === 0) {
		process.stderr.write("error: secondmate needs at least one project\n");
		return 1;
	}

	mkdirSync(ctx.data, { recursive: true });
	if (!runValidateRegistry(ctx.reg)) return 1;

	try {
		for (const project of projects) validateSeedProject(ctx, project);
	} catch (err) {
		if (err instanceof SeedFailure) return 1;
		throw err;
	}

	const backupDir = mkdtempSync(join(envOr("TMPDIR", "/tmp"), "fm-home-seed."));
	const state: SeedState = {
		committed: false,
		home: "",
		homeAcquired: false,
		homeCreated: false,
		homeBackedUp: false,
		backupDir,
		createdProjectsFile: join(backupDir, "created-projects"),
		createdExtLinksFile: join(backupDir, "created-ext-links"),
		createdSkillArtifactsFile: join(backupDir, "created-skill-artifacts"),
		extDstExisted: false,
		skillsDirExisted: false,
		ompYmlExisted: false,
		parentRegExisted: false,
		parentBrief: join(ctx.data, "mates", id, "brief.md"),
		parentBriefCreated: false,
		parentBriefDirCreated: false,
		subRegExisted: false,
		charterExisted: false,
		markerExisted: false,
		identityExisted: false,
		miseTomlCreated: false,
		herdrWorkspaceId: "",
	};
	writeFileSync(state.createdProjectsFile, "");
	writeFileSync(state.createdExtLinksFile, "");
	writeFileSync(state.createdSkillArtifactsFile, "");

	try {
		if (existsSync(ctx.reg)) {
			state.parentRegExisted = true;
			copyFileSync(ctx.reg, join(state.backupDir, "parent-secondmates.md"));
		}

		let home: string;
		if (requestedHome === "-") {
			state.homeAcquired = true;
			const acquired = acquireHerdrHome(ctx, id);
			state.herdrWorkspaceId = acquired.workspaceId;
			state.home = acquired.home;
			home = verifyFirstmateHome(ctx, acquired.home);
		} else {
			const requestedAbs = resolvedPath(requestedHome);
			refuseActiveHomePath(ctx, requestedAbs);
			validateHomeAssignment(ctx, id, requestedAbs);
			state.home = requestedAbs;
			if (!existsSync(requestedAbs)) state.homeCreated = true;
			home = ensureHome(ctx, requestedAbs);
		}
		state.home = home;
		validateRegistryHomeText(home);
		validateHomeAssignment(ctx, id, home);
		const layout = ensureMateHomeLayout(home);
		if (!layout.ok) {
			const first = layout.issues[0];
			fail(`error: mate-home layout blocked at ${first?.rel ?? home}: ${first?.detail ?? "unknown"}`);
		}
		validateOperationalDirs(ctx, home);
		validateSeedLeafFiles(ctx, home);

		const subReg = join(home, "data", "projects.md");
		if (existsSync(subReg)) {
			state.subRegExisted = true;
			copyFileSync(subReg, join(state.backupDir, "sub-projects.md"));
		}
		const charterPath = join(home, "data", "charter.md");
		if (existsSync(charterPath)) {
			state.charterExisted = true;
			copyFileSync(charterPath, join(state.backupDir, "charter.md"));
		}
		const markerPath = join(home, SUB_HOME_MARKER);
		if (existsSync(markerPath)) {
			state.markerExisted = true;
			copyFileSync(markerPath, join(state.backupDir, "marker"));
		}
		const identityPath = join(home, "config", "identity");
		if (existsSync(identityPath)) {
			state.identityExisted = true;
			copyFileSync(identityPath, join(state.backupDir, "identity"));
		}
		state.homeBackedUp = true;

		const extSrc = join(CANONICAL_ROOT, ".omp", "extensions");
		const extResult = linkShipExtensions(home, extSrc, { verbose: false, trackFile: state.createdExtLinksFile });
		state.extDstExisted = extResult.dstExisted;
		mkdirSync(join(home, ".omp"), { recursive: true });
		state.skillsDirExisted = existsSync(join(home, ".omp", "skills"));
		state.ompYmlExisted = existsSync(join(home, "config", "omp.yml"));
		const miseResult = ensureMateMiseToml(home, true);
		if (miseResult.status.startsWith("blocked:")) fail(`error: unable to seed mise config at ${miseResult.path}: ${miseResult.status}`);
		state.miseTomlCreated = miseResult.created;

		const skillsResult = syncHomeSkills(home, {
			bootstrapManifests: true,
			trackFile: state.createdSkillArtifactsFile,
			quiet: true,
			codeRoot: CANONICAL_ROOT,
			fmHome: ctx.fmHome,
		});
		if (!skillsResult.ok) {
			fail(`error: home-skills sync failed during seed: ${skillsResult.status}`);
		}

		if (!existsSync(state.parentBrief)) {
			const charterEnv = process.env.FM_SECONDMATE_CHARTER;
			if (!(charterEnv !== undefined && charterEnv !== "")) {
				fail(
					`error: no filled secondmate charter brief at ${state.parentBrief}; set FM_SECONDMATE_CHARTER or scaffold one and replace {TASK}`,
				);
			}
			if (!existsSync(join(ctx.data, id))) state.parentBriefDirCreated = true;
			runFmBriefScaffold(ctx, id, projects);
			state.parentBriefCreated = true;
		}
		if (readFileSync(state.parentBrief, "utf8").includes("{TASK}")) {
			fail(`error: secondmate charter brief at ${state.parentBrief} still contains {TASK}; fill it before seeding`);
		}
		const charterSummary = registrySummaryForBrief(state.parentBrief);
		if (!charterSummary) {
			fail(`error: secondmate charter brief at ${state.parentBrief} has an empty Charter section; fill it before seeding`);
		}
		const charterScope = registryScopeForBrief(state.parentBrief);
		if (!charterScope) {
			fail(`error: secondmate charter brief at ${state.parentBrief} has an empty Routing scope section; fill it before seeding`);
		}

		for (const project of projects) {
			const projectDst = validateProjectDestination(ctx, home, project);
			if (!existsSync(projectDst)) appendFileSync(state.createdProjectsFile, `${projectDst}\n`);
			cloneProject(ctx, project, home);
		}
		syncProjectRegistry(ctx, home, projects);

		copyFileSync(state.parentBrief, charterPath);

		const projectsCsv = projects.join(", ");
		writeFileSync(markerPath, `${id}\n`);
		writeSeedIdentity(ctx, home, id, charterSummary);
		writeRegistry(ctx, id, home, projectsCsv, state.parentBrief, state.herdrWorkspaceId);
		if (!runValidateRegistry(ctx.reg)) throw new SeedFailure("post-write registry validation failed");

		state.committed = true;
		rmSync(state.backupDir, { recursive: true, force: true });
		process.stdout.write(`home=${home}\n`);
		return 0;
	} catch (err) {
		if (!(err instanceof SeedFailure)) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`error: ${message}\n`);
		}
		rollback(ctx, state);
		return 1;
	}
}

// ---- CLI entry ------------------------------------------------------------------

function buildCtx(): Ctx {
	const fmRoot = envOr("FM_ROOT_OVERRIDE", CANONICAL_ROOT);
	const fmHome = envOr("FM_HOME", fmRoot);
	const data = envOr("FM_DATA_OVERRIDE", join(fmHome, "data"));
	const projectsDir = envOr("FM_PROJECTS_OVERRIDE", join(fmHome, "projects"));
	const reg = join(data, "secondmates.md");
	return { fmRoot, fmHome, data, projectsDir, reg };
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const ctx = buildCtx();
	const first = args[0];

	if (first === "validate") {
		if (args.length !== 1) {
			usage();
			return 1;
		}
		return runValidateRegistry(ctx.reg) ? 0 : 1;
	}
	if (first === undefined || first === "-h" || first === "--help") {
		usage();
		return 0;
	}
	if (args.length < 3) {
		usage();
		return 1;
	}
	const [id, home, ...projects] = args;
	return seedHome(ctx, id, home, projects);
}

export default {
	name: "home-seed",
	describe: "Provision and route a persistent secondmate home (transactional, with full rollback).",
	run,
};
