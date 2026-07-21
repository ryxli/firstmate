// fm verb: home-link - check or repair the shared-code symlinks (AGENTS.md, sbin,
// .agents, .claude, .omp extensions, operational dirs) in a
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
	rmSync,
	rmdirSync,
	symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMateMiseToml } from "../lib/mise-home";
import { checkMateHomeLayout, repairMateHomeLayout } from "../lib/mate-home-layout";
import { isTrackedPreHooks } from "../lib/ship-ext";
import {
	existsFollow,
	isDirectoryFollow,
	isFileFollow,
	isSymlink,
	linkPointsTo,
	normalizeExistingDir,
	rawLinkTarget,
} from "../lib/path-links";

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
function hasLifecycleGuard(path: string): boolean {
	try {
		return lstatSync(join(path, "fm-lifecycle-guard.ts")).isFile();
	} catch {
		return false;
	}
}

function checkPreHooks(ctx: Ctx): void {
	const ompDir = join(ctx.homePath, ".omp");
	const source = join(ctx.codeRoot, ".omp", "hooks", "pre");
	const hooksDir = join(ompDir, "hooks");
	const link = join(hooksDir, "pre");
	if (!isDirectoryFollow(source) || !hasLifecycleGuard(source)) {
		setBlock(ctx, "missing-target");
		return;
	}

	const canonicalOmp = join(ctx.codeRoot, ".omp");
	const legacyOmpLink = isSymlink(ompDir) && linkPointsTo(ompDir, canonicalOmp);
	if (isSymlink(ompDir)) {
		if (!linkPointsTo(ompDir, canonicalOmp)) {
			setBlock(ctx, "wrong-link");
			return;
		}
	} else if (!isDirectoryFollow(ompDir)) {
		setBlock(ctx, existsSync(ompDir) ? "hook-conflict" : "wrong-link");
		return;
	}
	if (!legacyOmpLink && (isSymlink(hooksDir) || (existsSync(hooksDir) && !isDirectoryFollow(hooksDir)))) {
		setBlock(ctx, "hook-conflict");
		return;
	}
	if (linkPointsTo(link, source) || (isDirectoryFollow(link) && !isSymlink(link) && hasLifecycleGuard(link))) {
		if (isSymlink(link) || legacyOmpLink || isTrackedPreHooks(ctx.homePath)) {
			ctx.status = "ok";
			return;
		}
		setBlock(ctx, "hook-conflict");
		return;
	}

	let linkExists = false;
	try {
		lstatSync(link);
		linkExists = true;
	} catch {
		// missing link
	}
	if (linkExists && !isSymlink(link) && isDirectoryFollow(link)) {
		let entries: string[] = [];
		try {
			entries = readdirSync(link);
		} catch {
			setBlock(ctx, "hook-conflict");
			return;
		}
		if (entries.length > 0) {
			setBlock(ctx, "hook-conflict");
			return;
		}
	}
	if (linkExists && !isSymlink(link) && !isDirectoryFollow(link)) {
		setBlock(ctx, "hook-conflict");
		return;
	}
	if (ctx.mode === "check") {
		setBlock(ctx, "wrong-link");
		return;
	}

	if (isSymlink(link)) {
		try {
			rmSync(link, { force: true });
		} catch {
			setBlock(ctx, "repair-failed");
			return;
		}
	} else if (linkExists) {
		try {
			rmdirSync(link);
		} catch {
			setBlock(ctx, "repair-failed");
			return;
		}
	}
	try {
		mkdirSync(hooksDir, { recursive: true });
		symlinkSync(source, link);
	} catch {
		setBlock(ctx, "repair-failed");
		return;
	}
	ctx.status = "repaired";
}


function checkCurrentOmp(ctx: Ctx): void {
	checkPreHooks(ctx);
	statusLine(ctx, "link..omp.hooks.pre");
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
		setBlock(ctx, "missing-target");
		return;
	}
	let entries: string[];
	try {
		entries = readdirSync(extSrc);
	} catch {
		setBlock(ctx, "missing-target");
		return;
	}
	const canonicalEntries = new Set(entries);
	let currentEntries: string[] = [];
	try {
		currentEntries = readdirSync(extDst);
	} catch {
		currentEntries = [];
	}
	for (const name of currentEntries) {
		if (canonicalEntries.has(name)) continue;
		const link = join(extDst, name);
		if (!isSymlink(link)) continue;
		const target = rawLinkTarget(link);
		if (target === null || dirname(target) !== extSrc) continue;
		if (ctx.mode === "check") {
			setBlock(ctx, "obsolete-link");
		} else {
			rmSync(link, { force: true });
			ctx.status = "repaired";
		}
		statusLine(ctx, `link..omp.extensions.${name}`);
	}
	for (const name of entries) {
		if (!existsSync(join(extSrc, name))) continue;
		repairExtensionLink(ctx, name);
		statusLine(ctx, `link..omp.extensions.${name}`);
	}
}

function checkMiseToml(ctx: Ctx): void {
	const result = ensureMateMiseToml(ctx.homePath, ctx.mode === "repair");
	if (result.status.startsWith("blocked:")) setBlock(ctx, result.status.slice("blocked:".length));
	else ctx.status = result.status;
}

function checkMateLayout(ctx: Ctx): void {
	const layoutKey = (rel: string) => `layout.${rel.replace(/\//g, ".")}`;
	if (ctx.mode === "repair") {
		const repaired = repairMateHomeLayout(ctx.homePath);
		for (const rel of repaired.created) {
			process.stdout.write(`${layoutKey(rel)}=repaired\n`);
		}
		for (const issue of repaired.issues) {
			setBlock(ctx, issue.code);
			process.stdout.write(`${layoutKey(issue.rel)}=blocked:${issue.code}\n`);
		}
		ctx.status = repaired.ok ? (repaired.created.length > 0 ? "repaired" : "ok") : ctx.status;
		statusLine(ctx, "layout");
		return;
	}

	const checked = checkMateHomeLayout(ctx.homePath);
	for (const issue of checked.issues) {
		setBlock(ctx, issue.code);
		process.stdout.write(`${layoutKey(issue.rel)}=blocked:${issue.code}\n`);
	}
	if (checked.ok) ctx.status = "ok";
	statusLine(ctx, "layout");
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
	if (homePath === codeRoot) {
		process.stderr.write("error: firstmate code root cannot be a link-managed home\n");
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

		checkMateLayout(ctx);

		repairLink(ctx, "AGENTS.md", join(codeRoot, "AGENTS.md"));
		statusLine(ctx, "link.AGENTS.md");
		checkClaudeLink(ctx);
		statusLine(ctx, "link.CLAUDE.md");
		repairLink(ctx, "sbin", join(codeRoot, "sbin"));
		statusLine(ctx, "link.sbin");
		// Intentionally no .agents whole-catalog link. Legacy canonical .agents
		// removal and per-skill exposure are owned by `fm home skills`.
		ctx.status = "skipped";
		statusLine(ctx, "link..agents");
		checkMiseToml(ctx);
		statusLine(ctx, "mise.toml");

		if (currentOmp) {
			checkCurrentOmp(ctx);
		} else {
			repairLink(ctx, ".claude", join(codeRoot, ".claude"));
			statusLine(ctx, "link..claude");
			repairLink(ctx, ".omp", join(codeRoot, ".omp"));
			statusLine(ctx, "link..omp");
			checkPreHooks(ctx);
			statusLine(ctx, "link..omp.hooks.pre");
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
