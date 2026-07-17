// fm verb: start - launch a fresh interactive firstmate session with zero typing.
//
// Runs omp from the repo root so project-dir discovery picks up the ship
// extensions and .omp/config.yml (which preloads the bootstrap and recovery
// skills into the cached prefix). With no arguments it sends the standard
// kickoff message so AGENTS.md's session-start sequence begins immediately;
// any arguments are passed through to omp verbatim instead (e.g. `fm start -c`
// to continue the previous session).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const KICKOFF = "Session start: run your session-start sequence, then report fleet status.";

// Every-session skills injected into the cached system prefix, replacing two
// uncached tool-reads per boot. All other skills stay lazy.
const PRELOAD_SKILLS = ["firstmate-bootstrap", "firstmate-recovery"];

function preloadBlock(): string {
	const parts = ["# Preloaded skills", "The following mandatory session-start skills are already loaded in full - run them directly, never re-read them via a skill tool or file read."];
	for (const name of PRELOAD_SKILLS) {
		const path = join(REPO_ROOT, ".agents", "skills", name, "SKILL.md");
		parts.push(`## skill://${name}\n\n${readFileSync(path, "utf8").trim()}`);
	}
	return parts.join("\n\n");
}

function run(argv: string[]): number {
	const args = argv.slice(1);
	const ompArgs = [`--append-system-prompt=${preloadBlock()}`, ...(args.length > 0 ? args : [KICKOFF])];
	const result = spawnSync("omp", ompArgs, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		process.stderr.write(`fm start: failed to launch omp: ${result.error.message}\n`);
		return 1;
	}
	return result.status ?? 1;
}

export default {
	name: "start",
	describe: "Launch a fresh interactive firstmate omp session (args pass through to omp).",
	run,
};
