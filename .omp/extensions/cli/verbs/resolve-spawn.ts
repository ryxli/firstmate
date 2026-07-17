// fm verb: resolve-spawn - validate spawn prerequisites before fm spawn
// creates a git worktree or herdr pane: the crew harness binary is resolvable
// and on PATH, the project registry has a matching entry (warn-only, not
// blocking), and the worktree base directory exists and is writable.
// Ported behavior-preserving from the former sbin/fm resolve-spawn, with
// the launch-command-word helper it sourced from sbin/fm-spawn-lib.sh inlined
// below.
// Usage: fm resolve-spawn <project> [harness-override]

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// firstmate root: verbs/ -> cli/ -> extensions/ -> .omp/ -> repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

function resolveRoot(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	return rootOverride || REPO_ROOT;
}

function resolveHome(fmRoot: string): string {
	const home = process.env.FM_HOME?.trim();
	if (home) return home;
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	return rootOverride || fmRoot;
}

function resolveData(fmHome: string): string {
	const dataOverride = process.env.FM_DATA_OVERRIDE?.trim();
	return dataOverride || join(fmHome, "data");
}

// Mirrors fm_first_command_word in the former sbin/fm-spawn-lib.sh: skip any
// leading VAR=value environment assignments in a raw launch command, then
// return the basename of the first real word. Returns null when the command
// is only assignments/empty (matches the shell helper's rc-1/no-output case).
function firstCommandWord(launch: string): string | null {
	for (const word of launch.split(/\s+/)) {
		if (!word) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		const parts = word.split("/");
		return parts[parts.length - 1];
	}
	return null;
}

// Mirrors `command -v <cmd>` closely enough for a spawn-time PATH check: an
// explicit path (containing "/") is checked directly, otherwise every PATH
// entry is searched for an executable file of that name.
function commandOnPath(cmd: string): boolean {
	if (cmd.includes("/")) {
		try {
			accessSync(cmd, fsConstants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		try {
			accessSync(join(dir, cmd), fsConstants.X_OK);
			return true;
		} catch {
			// keep looking
		}
	}
	return false;
}

// Mirrors the former script's call to `fm harness crew` (now the `harness`
// verb, invoked at the same fmRoot so a secondmate's own sbin symlink is used):
// resolve the configured crew harness by shelling out so the two never drift.
function crewHarness(fmRoot: string): string {
	const result = spawnSync(join(fmRoot, "sbin", "fm"), ["harness", "crew"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return "";
	return (result.stdout ?? "").replace(/\r?\n+$/, "");
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const project = args[0] ?? "";
	const harnessArg = args[1] ?? "";

	if (!project) {
		process.stderr.write("error: fm-resolve-spawn requires a project argument\n");
		return 2;
	}

	const fmRoot = resolveRoot();
	const fmHome = resolveHome(fmRoot);
	const data = resolveData(fmHome);

	let harness: string;
	if (!harnessArg) {
		harness = crewHarness(fmRoot);
	} else if (/\s/.test(harnessArg)) {
		harness = firstCommandWord(harnessArg) ?? "";
	} else {
		harness = harnessArg;
	}

	if (!harness) {
		process.stderr.write("error: could not resolve spawn harness; check config/crew-harness\n");
		return 1;
	}

	if (!commandOnPath(harness)) {
		process.stderr.write(
			`error: spawn harness binary '${harness}' was not found on PATH; check config/crew-harness or pass an available harness override\n`,
		);
		return 1;
	}

	let projectName = project.endsWith("/") ? project.slice(0, -1) : project;
	const slashIdx = projectName.lastIndexOf("/");
	if (slashIdx !== -1) projectName = projectName.slice(slashIdx + 1);

	const registry = join(data, "projects.md");
	if (existsSync(registry) && statSync(registry).isFile()) {
		const text = readFileSync(registry, "utf8");
		if (!text.includes(`- ${projectName} `)) {
			process.stderr.write(
				`warn: project '${projectName}' does not appear in ${registry}; continuing because direct paths are allowed\n`,
			);
		}
	} else {
		process.stderr.write(
			`warn: project registry ${registry} is missing; continuing because direct paths are allowed\n`,
		);
	}

	const wtbase = process.env.FM_WORKTREE_BASE?.trim() || join(fmHome, "worktrees");
	if (existsSync(wtbase)) {
		if (!statSync(wtbase).isDirectory()) {
			process.stderr.write(`error: worktree base '${wtbase}' exists but is not a directory\n`);
			return 1;
		}
		try {
			accessSync(wtbase, fsConstants.W_OK);
		} catch {
			process.stderr.write(`error: worktree base '${wtbase}' is not writable\n`);
			return 1;
		}
	} else {
		const parent = dirname(wtbase);
		if (!existsSync(parent) || !statSync(parent).isDirectory()) {
			process.stderr.write(`error: worktree base parent '${parent}' does not exist\n`);
			return 1;
		}
		try {
			accessSync(parent, fsConstants.W_OK);
		} catch {
			process.stderr.write(`error: worktree base parent '${parent}' is not writable\n`);
			return 1;
		}
	}

	return 0;
}

export default {
	name: "resolve-spawn",
	describe: "Validate spawn prerequisites (harness binary, project registry, worktree base) before fm-spawn creates a worktree or pane.",
	run,
};
