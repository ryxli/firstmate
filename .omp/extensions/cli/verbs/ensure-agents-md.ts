// fm verb: ensure-agents-md - establish the AGENTS.md-is-real / CLAUDE.md-is-symlink
// convention in a project worktree.
// Ported verbatim (behavior-preserving) from the former sbin/fm ensure-agents-md.
//
// AGENTS.md is the real project-intrinsic knowledge file; CLAUDE.md is a
// relative symlink to it for compatibility. Creates a minimal AGENTS.md skeleton
// when neither file exists, promotes a real CLAUDE.md file when it is the only
// file present, and refuses to clobber distinct real files or wrong symlinks.
// This is a worktree utility for crewmates, not a supervision script.
//
// This verb preserves the original script's plain stdout/stderr text and exit
// codes exactly (it is a direct end-user/crewmate utility, not a structured
// TOON data source), so it intentionally does not route through the shared
// output()/validationError() helpers used by other verbs.

import { existsSync, lstatSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";

const USAGE = "usage: fm ensure-agents-md [repo-or-worktree-dir]";

const SKELETON = [
	"# Project agent memory",
	"",
	"This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.",
	"",
	"- Add durable project-specific notes here as they are discovered through real work.",
	"",
].join("\n");

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function isCorrectClaudeSymlink(claudePath: string, agentsPath: string): boolean {
	let target: string;
	try {
		target = readlinkSync(claudePath);
	} catch {
		return false;
	}
	if (target === "AGENTS.md" || target === "./AGENTS.md") return true;
	if (!existsSync(agentsPath)) return false;
	try {
		return realpathSync(claudePath) === realpathSync(agentsPath);
	} catch {
		return false;
	}
}

function ensureAgentsMd(argv: string[]): number {
	const args = argv.slice(1);

	if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
		console.error(USAGE);
		return 0;
	}
	if (args.length > 1) {
		console.error(USAGE);
		return 1;
	}

	const inputDir = args[0] ?? ".";
	if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
		console.error(`error: not a directory: ${inputDir}`);
		return 1;
	}
	const dir = realpathSync(inputDir);
	const agentsPath = `${dir}/AGENTS.md`;
	const claudePath = `${dir}/CLAUDE.md`;

	function writeSkeleton(): void {
		writeFileSync(agentsPath, SKELETON);
	}

	const agentsLstat = lstatOrNull(agentsPath);
	if (agentsLstat && agentsLstat.isSymbolicLink()) {
		console.error(`conflict: AGENTS.md is a symlink in ${dir}; expected AGENTS.md to be the real file`);
		return 1;
	}
	if (agentsLstat && !agentsLstat.isFile()) {
		console.error(`conflict: AGENTS.md exists in ${dir} but is not a regular file`);
		return 1;
	}
	const agentsExists = agentsLstat !== null;
	const claudeLstat = lstatOrNull(claudePath);

	if (agentsExists) {
		if (claudeLstat && claudeLstat.isSymbolicLink()) {
			if (isCorrectClaudeSymlink(claudePath, agentsPath)) {
				console.log(`unchanged: AGENTS.md with CLAUDE.md -> AGENTS.md in ${dir}`);
				return 0;
			}
			console.error(`conflict: CLAUDE.md is a symlink in ${dir} but does not point to AGENTS.md`);
			return 1;
		}
		if (!claudeLstat) {
			symlinkSync("AGENTS.md", claudePath);
			console.log(`symlinked: CLAUDE.md -> AGENTS.md in ${dir}`);
			return 0;
		}
		if (claudeLstat.isFile()) {
			console.error(`conflict: both AGENTS.md and CLAUDE.md are real files in ${dir}; reconcile them manually`);
			return 1;
		}
		console.error(`conflict: CLAUDE.md exists in ${dir} but is not a regular file or symlink`);
		return 1;
	}

	if (claudeLstat && claudeLstat.isSymbolicLink()) {
		if (isCorrectClaudeSymlink(claudePath, agentsPath)) {
			writeSkeleton();
			console.log(`created: AGENTS.md and kept CLAUDE.md -> AGENTS.md in ${dir}`);
			return 0;
		}
		console.error(`conflict: CLAUDE.md is a symlink in ${dir} but AGENTS.md is missing and the link does not point to AGENTS.md`);
		return 1;
	}

	if (claudeLstat) {
		if (claudeLstat.isFile()) {
			renameSync(claudePath, agentsPath);
			symlinkSync("AGENTS.md", claudePath);
			console.log(`promoted: moved CLAUDE.md to AGENTS.md and symlinked CLAUDE.md -> AGENTS.md in ${dir}`);
			return 0;
		}
		console.error(`conflict: CLAUDE.md exists in ${dir} but is not a regular file or symlink`);
		return 1;
	}

	writeSkeleton();
	symlinkSync("AGENTS.md", claudePath);
	console.log(`created: AGENTS.md and CLAUDE.md -> AGENTS.md in ${dir}`);
	return 0;
}

function run(argv: string[]): number {
	return ensureAgentsMd(argv);
}

export default {
	name: "ensure-agents-md",
	describe: "Establish the AGENTS.md-is-real / CLAUDE.md-is-symlink convention in a project worktree.",
	run,
};
