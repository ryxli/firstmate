// fm verb: home-link - check or repair the shared-code symlinks (AGENTS.md, sbin,
// .agents, .tasks.toml, .claude, .omp extensions, operational dirs) in a
// symlink-backed secondmate home.
// Ported behavior-preserving from the former sbin/fm home-link.
//
// Operational state (data/state/config/projects) remains local to the home;
// only executable/instruction surfaces are linked to the firstmate code root.
//
// This is the raw single-home path interface (used by other tooling that
// already resolved a home directory); the registry-driven `home` verb
// resolves a mate id to a home and shells out per-target.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	rmdirSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SUB_HOME_MARKER = ".fm-secondmate-home";

type Mode = "check" | "repair";

interface Ctx {
	homePath: string;
	mode: Mode;
	codeRoot: string;
	result: "ok" | "blocked";
	status: string;
}

function usage(): number {
	process.stderr.write("usage: fm home-link <home> --check\n");
	process.stderr.write("       fm home-link <home> --repair\n");
	return 1;
}

// -- path helpers, mirroring the bash script's `cd -P`-based normalization --

function cdPhysical(dir: string): string {
	const st = statSync(dir); // throws if missing; follows symlinks like `cd`
	if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);
	return realpathSync(dir);
}

function normalizeExistingDir(path: string): string | null {
	try {
		const st = statSync(path);
		if (!st.isDirectory()) return null;
		return realpathSync(path);
	} catch {
		return null;
	}
}

function normalizePath(path: string): string | null {
	try {
		const realParent = cdPhysical(dirname(path));
		return `${realParent}/${basename(path)}`;
	} catch {
		return null;
	}
}

function pathIsDescendant(root: string, path: string): boolean {
	if (root === path) return false;
	return path.startsWith(`${root}/`);
}

function resolveLinkTarget(link: string): string | null {
	let target: string;
	try {
		target = readlinkSync(link);
	} catch {
		return null;
	}
	if (target.startsWith("/")) return normalizePath(target);
	return normalizePath(`${dirname(link)}/${target}`);
}

function isSymlink(path: string): boolean {
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

function linkPointsTo(link: string, expected: string): boolean {
	if (!isSymlink(link)) return false;
	const actual = resolveLinkTarget(link);
	if (actual === null) return false;
	const expectedReal = normalizePath(expected);
	if (expectedReal === null) return false;
	return actual === expectedReal;
}

function emptyRegularFile(path: string): boolean {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return false;
	}
	return !st.isSymbolicLink() && st.isFile() && st.size === 0;
}

function emptyDirectory(path: string): boolean {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return false;
	}
	if (st.isSymbolicLink() || !st.isDirectory()) return false;
	return readdirSync(path).length === 0;
}

// -- state helpers, mirroring the bash script's shared RESULT/STATUS globals --

function setBlock(ctx: Ctx, reason: string): void {
	ctx.result = "blocked";
	ctx.status = `blocked:${reason}`;
}

function statusLine(ctx: Ctx, name: string): void {
	process.stdout.write(`${name}=${ctx.status}\n`);
}

function checkLegacyBinLink(ctx: Ctx): void {
	const link = join(ctx.homePath, "bin");
	const broken = isSymlink(link) && !existsFollow(link);
	if (broken) {
		if (ctx.mode === "check") {
			setBlock(ctx, "obsolete-link");
			return;
		}
		rmSync(link, { force: true });
		ctx.status = "repaired";
	} else {
		ctx.status = "ok";
	}
}

function checkClaudeLink(ctx: Ctx): void {
	const link = join(ctx.homePath, "CLAUDE.md");
	if (!existsFollow(link) && !isSymlink(link)) {
		ctx.status = "ok";
		return;
	}
	if (isSymlink(link)) {
		if (ctx.mode === "check") {
			setBlock(ctx, "obsolete-link");
			return;
		}
		rmSync(link, { force: true });
		ctx.status = "repaired";
		return;
	}
	ctx.status = "ok";
}

function clearForRelink(ctx: Ctx, link: string, conflictReason: string): "cleared" | "blocked" {
	if (isSymlink(link)) {
		rmSync(link, { force: true });
	} else if (!existsSync(link)) {
		// nothing to clear
	} else if (emptyRegularFile(link)) {
		rmSync(link, { force: true });
	} else if (emptyDirectory(link)) {
		rmdirSync(link);
	} else {
		setBlock(ctx, conflictReason);
		return "blocked";
	}
	return "cleared";
}

function repairLink(ctx: Ctx, name: string, target: string): void {
	const link = join(ctx.homePath, name);
	if (linkPointsTo(link, target)) {
		ctx.status = "ok";
		return;
	}
	if (ctx.mode === "check") {
		setBlock(ctx, "wrong-link");
		return;
	}
	const reason = isDirectoryFollow(link) ? "non-empty-directory" : "non-empty-file";
	if (clearForRelink(ctx, link, reason) === "blocked") return;
	if (!existsFollow(target)) {
		setBlock(ctx, "missing-target");
		return;
	}
	try {
		symlinkSync(target, link);
	} catch {
		setBlock(ctx, "repair-failed");
		return;
	}
	ctx.status = "repaired";
}

function repairExtensionLink(ctx: Ctx, name: string): void {
	const source = join(ctx.codeRoot, ".omp", "extensions", name);
	const link = join(ctx.homePath, ".omp", "extensions", name);
	if (isFileFollow(link) && !isSymlink(link)) {
		ctx.status = "ok";
		return;
	}
	if (linkPointsTo(link, source)) {
		ctx.status = "ok";
		return;
	}
	if (ctx.mode === "check") {
		setBlock(ctx, "wrong-link");
		return;
	}
	if (clearForRelink(ctx, link, "extension-conflict") === "blocked") return;
	if (!existsFollow(source)) {
		setBlock(ctx, "missing-target");
		return;
	}
	try {
		symlinkSync(source, link);
	} catch {
		setBlock(ctx, "repair-failed");
		return;
	}
	ctx.status = "repaired";
}

function checkCurrentOmp(ctx: Ctx): void {
	const extSrc = join(ctx.codeRoot, ".omp", "extensions");
	const extDst = join(ctx.homePath, ".omp", "extensions");
	if (!isDirectoryFollow(extDst) || isSymlink(extDst)) {
		const homeOmp = join(ctx.homePath, ".omp");
		if (ctx.mode === "repair" && isDirectoryFollow(homeOmp) && !isSymlink(homeOmp)) {
			try {
				mkdirSync(extDst, { recursive: true });
			} catch {
				setBlock(ctx, "repair-failed");
				return;
			}
		} else {
			setBlock(ctx, "missing");
			return;
		}
	}
	if (!isDirectoryFollow(extSrc)) {
		ctx.status = "ok";
		return;
	}
	let entries: string[] = [];
	try {
		entries = readdirSync(extSrc);
	} catch {
		entries = [];
	}
	for (const name of entries) {
		if (!existsSync(join(extSrc, name))) continue;
		repairExtensionLink(ctx, name);
		statusLine(ctx, `link..omp.extensions.${name}`);
	}
}

function checkOperationalDir(ctx: Ctx, name: string): void {
	const dir = join(ctx.homePath, name);
	if (!existsSync(dir)) {
		setBlock(ctx, "missing");
		return;
	}
	if (!isDirectoryFollow(dir)) {
		setBlock(ctx, "not-directory");
		return;
	}
	const absDir = normalizeExistingDir(dir);
	if (absDir === null) {
		setBlock(ctx, "unresolved");
		return;
	}
	if (pathIsDescendant(ctx.homePath, absDir)) {
		ctx.status = "ok";
	} else {
		setBlock(ctx, "escapes-home");
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length !== 2) return usage();
	const homeArg = args[0];
	let mode: Mode;
	if (args[1] === "--check") mode = "check";
	else if (args[1] === "--repair") mode = "repair";
	else return usage();

	const fmRoot = process.env.FM_CODE_ROOT_OVERRIDE?.trim() || process.env.FM_ROOT_OVERRIDE?.trim() || REPO_ROOT;

	const homePath = normalizeExistingDir(homeArg);
	if (homePath === null) {
		process.stdout.write(`home=${homeArg}\nmode=${mode}\nhome.status=blocked:missing\nresult=blocked\n`);
		return 1;
	}
	const codeRoot = normalizeExistingDir(fmRoot);
	if (codeRoot === null) {
		process.stderr.write(`error: firstmate code root is not a directory: ${fmRoot}\n`);
		return 1;
	}

	const ompDir = join(homePath, ".omp");
	const currentOmp = isDirectoryFollow(ompDir) && !isSymlink(ompDir);

	const ctx: Ctx = { homePath, mode, codeRoot, result: "ok", status: "ok" };

	try {
		process.stdout.write(`home=${homePath}\nmode=${mode}\n`);

		const markerPath = join(homePath, SUB_HOME_MARKER);
		if (isSymlink(markerPath)) {
			setBlock(ctx, "symlink");
		} else if (isFileFollow(markerPath) && !isSymlink(markerPath)) {
			ctx.status = "ok";
		} else {
			setBlock(ctx, "missing");
		}
		checkLegacyBinLink(ctx);
		statusLine(ctx, "legacy.bin");
		statusLine(ctx, "marker");

		for (const op of ["data", "state", "config", "projects"]) {
			checkOperationalDir(ctx, op);
			statusLine(ctx, `operational.${op}`);
		}

		repairLink(ctx, "AGENTS.md", join(codeRoot, "AGENTS.md"));
		statusLine(ctx, "link.AGENTS.md");
		checkClaudeLink(ctx);
		statusLine(ctx, "link.CLAUDE.md");
		repairLink(ctx, "sbin", join(codeRoot, "sbin"));
		statusLine(ctx, "link.sbin");
		repairLink(ctx, ".agents", join(codeRoot, ".agents"));
		statusLine(ctx, "link..agents");
		repairLink(ctx, ".tasks.toml", join(codeRoot, ".tasks.toml"));
		statusLine(ctx, "link..tasks.toml");

		if (currentOmp) {
			checkCurrentOmp(ctx);
		} else {
			repairLink(ctx, ".claude", join(codeRoot, ".claude"));
			statusLine(ctx, "link..claude");
			repairLink(ctx, ".omp", join(codeRoot, ".omp"));
			statusLine(ctx, "link..omp");
		}

		if (ctx.result !== "ok") ctx.status = ctx.result;
		statusLine(ctx, "result");
	} catch {
		// mirrors the bash script's `set -e`: an unguarded repair step (an rm/rmdir
		// outside the explicit `|| set_block ...` fallbacks) aborts the whole run.
		return 1;
	}

	return ctx.result === "ok" ? 0 : 1;
}

export default {
	name: "home-link",
	describe: "Check or repair the shared-code symlinks in a symlink-backed secondmate home.",
	run,
};
