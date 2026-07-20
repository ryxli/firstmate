// Per-home OMP skill isolation reconciler.
// Owns: manifests, effective set, managed links, omp.yml skills subtree, receipt.
// Path safety: mate-home-layout. Symlink ownership: managed-links / path-links.

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deepEqual,
	desiredSkillsSubtree,
	HomeSkillsConfigError,
	migrateLegacy,
	parseYamlObject,
} from "./home-skills-config";
import {
	assertRealLocalFileOrAbsent,
	MateHomePathError,
	requireHomeSkillsContainers,
} from "./mate-home-layout";
import { atomicWriteFile, classifyManagedLink, removeManagedSymlink, writeManagedSymlink } from "./managed-links";
import {
	existsFollow,
	existsLstat,
	isDirectoryFollow,
	isRealDirectory,
	isSymlink,
	normalizeExistingDir,
	normalizePath,
	resolveLinkTarget,
} from "./path-links";
import { parseSecondmateRegistryLine } from "./secondmate-registry";

export const HOME_SKILLS_RECEIPT = "home-skills.receipt.json";
export const SHARED_SKILLS_MANIFEST = "shared-skills";
export const LOCAL_SKILLS_MANIFEST = "local-skills";
export const SUB_HOME_MARKER = ".fm-secondmate-home";

const RECEIPT_VERSION = 1;
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const GLOB_META_RE = /[*?\[\]{}!\\]/;

export type HomeSkillsMode = "sync" | "check";

export interface HomeSkillsOptions {
	mode: HomeSkillsMode;
	target: string;
	codeRoot?: string;
	fmHome?: string;
	dataDir?: string;
	bootstrapManifests?: boolean;
	trackFile?: string;
	quiet?: boolean;
}

export interface HomeSkillsResult {
	ok: boolean;
	home: string;
	mode: HomeSkillsMode;
	status: string;
	effectiveNames: string[];
	lines: string[];
	trackedPaths: string[];
}

interface ReceiptLink {
	target: string;
	sourceRevision: string;
}

interface Receipt {
	version: number;
	generatedAt: string;
	codeRoot: string;
	codeRevision: string;
	links: Record<string, ReceiptLink>;
}

class HomeSkillsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HomeSkillsError";
	}
}

function envOr(name: string, fallback: string): string {
	const v = process.env[name];
	return v !== undefined && v !== "" ? v : fallback;
}

function fail(code: string, message: string): never {
	throw new HomeSkillsError(code, message);
}

function codeRevision(codeRoot: string): string {
	const res = spawnSync("git", ["-C", codeRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
	return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : "unknown";
}

function assertSkillName(name: string, where: string): void {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		fail("invalid-name", `${where}: invalid skill name`);
	}
	if (GLOB_META_RE.test(name) || !SKILL_NAME_RE.test(name)) {
		fail("invalid-name", `${where}: skill name is not a literal OMP-valid name: ${name}`);
	}
}

function parseManifest(text: string, path: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		assertSkillName(line, path);
		if (seen.has(line)) fail("duplicate-name", `${path}: duplicate skill name ${line}`);
		seen.add(line);
		names.push(line);
	}
	return names;
}

function frontmatterName(skillMd: string): string | null {
	let text: string;
	try {
		text = readFileSync(skillMd, "utf8");
	} catch {
		return null;
	}
	if (!text.startsWith("---")) return null;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return null;
	for (const raw of text.slice(3, end).split(/\r?\n/)) {
		const m = /^name:\s*(.+?)\s*$/.exec(raw);
		if (m) return m[1].replace(/^["'](.*)["']$/, "$1").trim();
	}
	return null;
}

function requireSkillDir(dir: string, expected: string, label: string): void {
	if (!isDirectoryFollow(dir)) fail("missing-source", `${label}: missing skill directory ${dir}`);
	const skillMd = join(dir, "SKILL.md");
	if (!existsSync(skillMd)) fail("invalid-skill", `${label}: missing SKILL.md in ${dir}`);
	const name = frontmatterName(skillMd);
	if (name === null) fail("invalid-skill", `${label}: SKILL.md missing name frontmatter in ${dir}`);
	if (name !== expected) {
		fail("name-mismatch", `${label}: directory/frontmatter name mismatch for ${expected} (frontmatter name: ${name})`);
	}
}

function readReceipt(path: string): Receipt | null {
	if (!existsLstat(path)) return null;
	assertRealLocalFileOrAbsent(path, "receipt");
	let obj: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("corrupt-receipt", `receipt root must be an object: ${path}`);
		obj = parsed as Record<string, unknown>;
	} catch (err) {
		if (err instanceof HomeSkillsError) throw err;
		fail("corrupt-receipt", `receipt is not valid JSON: ${path}`);
	}
	if (obj.version !== RECEIPT_VERSION) fail("corrupt-receipt", `receipt version unsupported at ${path}`);
	if (typeof obj.codeRoot !== "string" || typeof obj.codeRevision !== "string") {
		fail("corrupt-receipt", `receipt missing codeRoot/codeRevision at ${path}`);
	}
	if (!obj.links || typeof obj.links !== "object" || Array.isArray(obj.links)) {
		fail("corrupt-receipt", `receipt links must be an object at ${path}`);
	}
	const links: Record<string, ReceiptLink> = {};
	for (const [name, value] of Object.entries(obj.links as Record<string, unknown>)) {
		if (!value || typeof value !== "object") fail("corrupt-receipt", `receipt link ${name} malformed`);
		const entry = value as Record<string, unknown>;
		if (typeof entry.target !== "string" || typeof entry.sourceRevision !== "string") {
			fail("corrupt-receipt", `receipt link ${name} missing target/sourceRevision`);
		}
		links[name] = { target: entry.target, sourceRevision: entry.sourceRevision };
	}
	return {
		version: RECEIPT_VERSION,
		generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
		codeRoot: obj.codeRoot,
		codeRevision: obj.codeRevision,
		links,
	};
}

function homeForId(id: string, dataDir: string): string {
	const reg = join(dataDir, "secondmates.md");
	if (!existsSync(reg)) fail("missing-registry", `secondmates registry not found at ${reg}`);
	for (const line of readFileSync(reg, "utf8").split(/\r?\n/)) {
		const entry = parseSecondmateRegistryLine(line);
		if (entry?.id === id) {
			if (!entry.home) fail("missing-home", `no home entry for id '${id}'`);
			return entry.home;
		}
	}
	fail("missing-home", `id '${id}' not found in ${reg}`);
}

export function resolveHomeSkillsTarget(target: string, opts: { fmHome?: string; dataDir?: string } = {}): string {
	const fmHome = opts.fmHome ?? envOr("FM_HOME", REPO_ROOT);
	const dataDir = opts.dataDir ?? envOr("FM_DATA_OVERRIDE", join(fmHome, "data"));
	if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) return resolve(target);
	if (isDirectoryFollow(target)) return resolve(target);
	return resolve(homeForId(target, dataDir));
}

function listLocalSkillDirs(skillsDir: string): string[] {
	if (!isRealDirectory(skillsDir)) return [];
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter(e => !e.name.startsWith(".") && e.isDirectory() && !isSymlink(join(skillsDir, e.name)))
		.map(e => e.name)
		.sort();
}

function findLocalExtSkill(home: string, name: string): string | null {
	const extRoot = join(home, ".omp", "extensions");
	if (!isRealDirectory(extRoot)) return null;
	const extReal = realpathSync(extRoot);
	for (const entry of readdirSync(extRoot)) {
		if (entry.startsWith(".")) continue;
		const pack = join(extRoot, entry);
		if (!isRealDirectory(pack)) continue;
		const skillDir = join(pack, "skills", name);
		const skillMd = join(skillDir, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		try {
			if (!realpathSync(skillMd).startsWith(`${extReal}/`)) continue;
			requireSkillDir(skillDir, name, `local-skills:${name}`);
			return skillDir;
		} catch {
			continue;
		}
	}
	return null;
}

type LegacyAgents = "absent" | "remove-canonical" | "preserve-real" | "preserve-foreign" | "preserve-broken";

function classifyLegacyAgents(home: string, codeRoot: string): LegacyAgents {
	const agents = join(home, ".agents");
	if (!existsLstat(agents)) return "absent";
	if (!isSymlink(agents)) return "preserve-real";
	if (!existsFollow(agents)) return "preserve-broken";
	const expected = normalizePath(join(codeRoot, ".agents"));
	const actual = resolveLinkTarget(agents);
	if (actual === null) return "preserve-broken";
	if (expected !== null && actual === expected) return "remove-canonical";
	return "preserve-foreign";
}

interface Plan {
	home: string;
	skillsDir: string;
	effectiveNames: string[];
	sharedNames: string[];
	localDirNames: string[];
	localExtNames: string[];
	desiredLinks: Map<string, string>;
	receipt: Receipt | null;
	removeLinks: string[];
	refreshLinks: Array<{ name: string; target: string }>;
	createLinks: Array<{ name: string; target: string }>;
	legacyAgents: LegacyAgents;
	ompPath: string;
	ompDocument: Record<string, unknown>;
	ompExisted: boolean;
	desiredReceipt: Receipt;
}

function readManifestNames(path: string, label: string): string[] {
	if (!existsLstat(path)) return [];
	assertRealLocalFileOrAbsent(path, label);
	return parseManifest(readFileSync(path, "utf8"), path);
}

function buildPlan(home: string, codeRoot: string, opts: HomeSkillsOptions): Plan {
	requireHomeSkillsContainers(home, `state/${HOME_SKILLS_RECEIPT}`);
	const skillsDir = join(home, ".omp", "skills");
	const sharedPath = join(home, "config", SHARED_SKILLS_MANIFEST);
	const localPath = join(home, "config", LOCAL_SKILLS_MANIFEST);
	const ompPath = join(home, "config", "omp.yml");
	const receiptPath = join(home, "state", HOME_SKILLS_RECEIPT);
	const seeded = existsSync(join(home, SUB_HOME_MARKER)) && !isSymlink(join(home, SUB_HOME_MARKER));

	if (!opts.bootstrapManifests && seeded && !existsLstat(sharedPath)) {
		fail("migration-required", `missing ${sharedPath}; seeded homes require an explicit shared-skills manifest`);
	}

	const sharedNames = existsLstat(sharedPath) ? readManifestNames(sharedPath, "config/shared-skills") : [];
	const localExtNames = existsLstat(localPath) ? readManifestNames(localPath, "config/local-skills") : [];

	const desiredLinks = new Map<string, string>();
	for (const name of sharedNames) {
		const dir = join(codeRoot, ".agents", "skills", name);
		requireSkillDir(dir, name, `shared-skills:${name}`);
		const canonical = normalizePath(dir);
		if (!canonical) fail("missing-source", `shared skill source unresolvable: ${dir}`);
		desiredLinks.set(name, canonical);
	}

	const localDirNames: string[] = [];
	for (const name of listLocalSkillDirs(skillsDir)) {
		assertSkillName(name, `local .omp/skills/${name}`);
		requireSkillDir(join(skillsDir, name), name, `local .omp/skills/${name}`);
		localDirNames.push(name);
	}
	for (const name of localExtNames) {
		if (!findLocalExtSkill(home, name)) {
			fail("local-ext-missing", `config/local-skills name '${name}' does not resolve under this home's real .omp/extensions tree`);
		}
	}

	const ownership = new Map<string, string>();
	const claim = (name: string, source: string) => {
		const prev = ownership.get(name);
		if (prev) fail("duplicate-name", `skill name '${name}' claimed by both ${prev} and ${source}`);
		ownership.set(name, source);
	};
	for (const n of sharedNames) claim(n, "config/shared-skills");
	for (const n of localDirNames) claim(n, "local .omp/skills");
	for (const n of localExtNames) claim(n, "config/local-skills");
	const effectiveNames = [...ownership.keys()].sort();

	const receipt = readReceipt(receiptPath);
	const removeLinks: string[] = [];
	const refreshLinks: Array<{ name: string; target: string }> = [];
	const createLinks: Array<{ name: string; target: string }> = [];

	if (isRealDirectory(skillsDir)) {
		for (const entry of readdirSync(skillsDir)) {
			if (entry.startsWith(".")) continue;
			const path = join(skillsDir, entry);
			const desired = desiredLinks.get(entry) ?? null;
			const action = classifyManagedLink({
				linkPath: path,
				desiredTarget: desired,
				recordedTarget: receipt?.links[entry]?.target,
				exists: existsLstat(path),
				fail,
			});
			if (action === "remove") removeLinks.push(entry);
			if (action === "refresh" && desired) refreshLinks.push({ name: entry, target: desired });
			if (action === "create" && desired) createLinks.push({ name: entry, target: desired });
		}
	}
	for (const [name, target] of desiredLinks) {
		if (existsLstat(join(skillsDir, name))) continue;
		createLinks.push({ name, target });
	}

	const ompExisted = existsLstat(ompPath) && !isSymlink(ompPath);
	let ompDocument = ompExisted ? parseYamlObject(ompPath, "config/omp.yml") : {};
	ompDocument = migrateLegacy(ompDocument, home);
	ompDocument = { ...ompDocument, skills: desiredSkillsSubtree(effectiveNames) };

	const rev = codeRevision(codeRoot);
	const desiredReceipt: Receipt = {
		version: RECEIPT_VERSION,
		generatedAt: new Date().toISOString(),
		codeRoot,
		codeRevision: rev,
		links: Object.fromEntries([...desiredLinks].map(([name, target]) => [name, { target, sourceRevision: rev }])),
	};

	return {
		home,
		skillsDir,
		effectiveNames,
		sharedNames,
		localDirNames,
		localExtNames,
		desiredLinks,
		receipt,
		removeLinks,
		refreshLinks,
		createLinks,
		legacyAgents: classifyLegacyAgents(home, codeRoot),
		ompPath,
		ompDocument,
		ompExisted,
		desiredReceipt,
	};
}

function needsMutation(plan: Plan): boolean {
	if (plan.createLinks.length || plan.refreshLinks.length || plan.removeLinks.length) return true;
	if (plan.legacyAgents === "remove-canonical") return true;
	if (!plan.ompExisted) return true;
	if (!deepEqual(parseYamlObject(plan.ompPath, "config/omp.yml"), plan.ompDocument)) return true;
	if (!plan.receipt) return true;
	const cur = Object.keys(plan.receipt.links).sort();
	const next = Object.keys(plan.desiredReceipt.links).sort();
	if (cur.join("\0") !== next.join("\0")) return true;
	for (const name of next) {
		if (plan.receipt.links[name]?.target !== plan.desiredReceipt.links[name]?.target) return true;
	}
	return false;
}

function applyPlan(plan: Plan, opts: HomeSkillsOptions): string[] {
	const tracked: string[] = [];
	const track = (path: string) => {
		tracked.push(path);
		if (opts.trackFile) appendFileSync(opts.trackFile, `${path}\n`);
	};
	if (!isRealDirectory(plan.skillsDir)) {
		if (existsLstat(plan.skillsDir)) fail("symlinked-container", `refusing to create skills dir over non-dir: ${plan.skillsDir}`);
		mkdirSync(plan.skillsDir, { recursive: true });
		track(plan.skillsDir);
	}
	for (const name of plan.removeLinks) removeManagedSymlink(join(plan.skillsDir, name));
	for (const { name, target } of [...plan.refreshLinks, ...plan.createLinks]) {
		const link = join(plan.skillsDir, name);
		writeManagedSymlink(link, target);
		track(link);
	}
	if (plan.legacyAgents === "remove-canonical") rmSync(join(plan.home, ".agents"), { force: true });
	atomicWriteFile(plan.ompPath, `${Bun.YAML.stringify(plan.ompDocument)}\n`);
	if (!plan.ompExisted) track(plan.ompPath);
	atomicWriteFile(join(plan.home, "state", HOME_SKILLS_RECEIPT), `${JSON.stringify(plan.desiredReceipt, null, 2)}\n`);
	track(join(plan.home, "state", HOME_SKILLS_RECEIPT));
	return tracked;
}

function emit(lines: string[], quiet: boolean | undefined, line: string): void {
	lines.push(line);
	if (!quiet) process.stdout.write(`${line}\n`);
}

function bootstrapManifests(home: string, opts: HomeSkillsOptions): void {
	const sharedPath = join(home, "config", SHARED_SKILLS_MANIFEST);
	const localPath = join(home, "config", LOCAL_SKILLS_MANIFEST);
	if (!existsLstat(sharedPath)) {
		atomicWriteFile(sharedPath, "# Shared firstmate skills exposed into this home (one name per line).\n");
		if (opts.trackFile) appendFileSync(opts.trackFile, `${sharedPath}\n`);
	}
	if (!existsLstat(localPath)) {
		atomicWriteFile(localPath, "# Home-local extension skills (one name per line).\n");
		if (opts.trackFile) appendFileSync(opts.trackFile, `${localPath}\n`);
	}
}

export function reconcileHomeSkills(opts: HomeSkillsOptions): HomeSkillsResult {
	const lines: string[] = [];
	const mode = opts.mode;
	let home = "";
	try {
		const codeRoot = normalizeExistingDir(opts.codeRoot ?? envOr("FM_CODE_ROOT_OVERRIDE", envOr("FM_ROOT_OVERRIDE", REPO_ROOT)));
		if (!codeRoot) fail("missing-code-root", "firstmate code root is not a directory");
		const resolved = resolveHomeSkillsTarget(opts.target, { fmHome: opts.fmHome, dataDir: opts.dataDir });
		const homeNorm = normalizeExistingDir(resolved);
		if (!homeNorm) fail("missing-home", `home is not a directory: ${resolved}`);
		home = homeNorm;
		if (home === codeRoot) fail("invalid-home", "firstmate code root cannot be a skill-managed specialist home");

		emit(lines, opts.quiet, `home=${home}`);
		emit(lines, opts.quiet, `mode=${mode}`);

		if (opts.bootstrapManifests && mode === "sync") bootstrapManifests(home, opts);

		const plan = buildPlan(home, codeRoot, opts);
		emit(lines, opts.quiet, `effective=${plan.effectiveNames.join(",") || "-"}`);
		emit(lines, opts.quiet, `shared=${plan.sharedNames.join(",") || "-"}`);
		emit(lines, opts.quiet, `local_dir=${plan.localDirNames.join(",") || "-"}`);
		emit(lines, opts.quiet, `local_ext=${plan.localExtNames.join(",") || "-"}`);
		emit(lines, opts.quiet, `legacy.agents=${plan.legacyAgents}`);

		const drift = needsMutation(plan);
		if (mode === "check") {
			emit(lines, opts.quiet, drift ? "result=drift" : "result=ok");
			return { ok: !drift, home, mode, status: drift ? "drift" : "ok", effectiveNames: plan.effectiveNames, lines, trackedPaths: [] };
		}
		const trackedPaths = drift ? applyPlan(plan, opts) : [];
		emit(lines, opts.quiet, "result=ok");
		emit(lines, opts.quiet, `mutated=${drift}`);
		return { ok: true, home, mode, status: "ok", effectiveNames: plan.effectiveNames, lines, trackedPaths };
	} catch (err) {
		const code =
			err instanceof HomeSkillsError || err instanceof MateHomePathError || err instanceof HomeSkillsConfigError
				? err.code
				: "error";
		const message = err instanceof Error ? err.message : String(err);
		if (!lines.some(l => l.startsWith("home="))) emit(lines, opts.quiet, `home=${home || opts.target}`);
		if (!lines.some(l => l.startsWith("mode="))) emit(lines, opts.quiet, `mode=${mode}`);
		emit(lines, opts.quiet, `result=blocked:${code}`);
		if (!opts.quiet) process.stderr.write(`error: ${message}\n`);
		return { ok: false, home: home || opts.target, mode, status: `blocked:${code}`, effectiveNames: [], lines, trackedPaths: [] };
	}
}

export function syncHomeSkills(target: string, opts: Omit<HomeSkillsOptions, "mode" | "target"> = {}): HomeSkillsResult {
	return reconcileHomeSkills({ ...opts, mode: "sync", target });
}
