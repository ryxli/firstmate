// fm verb: start - launch a fresh interactive firstmate session with zero typing.
//
// Runs omp from the active firstmate home so home-local identity and instructions
// load for persistent supervisors. Without FM_HOME, falls back to the repo root
// so project-dir discovery picks up the ship extensions and .omp/config.yml.
// With no arguments it sends the standard kickoff message so AGENTS.md's
// session-start sequence begins immediately; any arguments are passed through
// to omp verbatim instead (e.g. `fm start -c` to continue the previous session).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const SUPERVISED_SUCCESSOR_ENV = "FM_SUPERVISED_SUCCESSOR";
const SUPERVISED_SUCCESSOR_VALUE = "1";

const SUPERVISED_SUCCESSOR_CONTRACT = `# Supervised successor startup
This session is launched with ${SUPERVISED_SUCCESSOR_ENV}=${SUPERVISED_SUCCESSOR_VALUE}.
It is a supervised successor to any live firstmate that already holds the per-home lock.
Your first startup action is to run \`fm lock\` before any repair, bootstrap, patch, reload, update, file write, registry change, pane mutation, or other mutation.
If \`fm lock\` prints \`lock acquired\`, this session has authority: proceed with the normal full startup sequence.
If \`fm lock\` prints \`lock unchanged\`, another live firstmate retains authority: remain read-only, skip bootstrap, repair, reload, update, and every other mutation, do not claim shared write authority, do not steal the lock automatically, and report ready for handoff with any blockers.
If \`fm lock\` exits nonzero, report the refusal and remain read-only.`;

const KICKOFF = "Session start: run `fm lock` first. If it prints `lock acquired`, proceed with the normal full startup sequence. If it prints `lock unchanged`, remain read-only, skip bootstrap, repair, reload, update, and every other mutation, then report ready for handoff with any blockers.";

// Every-session skills injected into the cached system prefix, replacing two
// uncached tool-reads per boot. All other skills stay lazy.
const PRELOAD_SKILLS = ["firstmate-bootstrap", "firstmate-recovery"];

// Stable fleet registries: change rarely, read at every session start. Loading
// them at launch keeps them in the cached prefix and in a deterministic order,
// instead of N tool-reads scattered through the first turns.
const PRELOAD_REGISTRIES = ["data/projects.md", "data/secondmates.md", "data/cap.md"];

function preloadBlock(): string {
	const parts = [SUPERVISED_SUCCESSOR_CONTRACT, "# Preloaded skills", "The following mandatory session-start skills are already loaded in full - run them directly, never re-read them via a skill tool or file read."];
	for (const name of PRELOAD_SKILLS) {
		const path = join(REPO_ROOT, ".agents", "skills", name, "SKILL.md");
		parts.push(`## skill://${name}\n\n${readFileSync(path, "utf8").trim()}`);
	}
	const home = process.env.FM_HOME?.trim() || REPO_ROOT;
	const registries: string[] = [];
	for (const rel of PRELOAD_REGISTRIES) {
		try {
			registries.push(`## ${rel}\n\n${readFileSync(join(home, rel), "utf8").trim()}`);
		} catch {
			// Local-layer file absent (fresh clone): the skill flow handles it.
		}
	}
	if (registries.length > 0) {
		parts.push("# Preloaded fleet registries", "Current as of session launch - do not re-read these files unless you have changed them this session. Live state (panes, tasks, locks) is NOT here; get it from one `fm fleet --check` call.", ...registries);
	}
	return parts.join("\n\n");
}

function run(argv: string[]): number {
	const args = argv.slice(1);
	const ompArgs = [`--append-system-prompt=${preloadBlock()}`, ...(args.length > 0 ? args : [KICKOFF])];
	const result = spawnSync("omp", ompArgs, {
		cwd: process.env.FM_HOME?.trim() || REPO_ROOT,
		stdio: "inherit",
		env: { ...process.env, [SUPERVISED_SUCCESSOR_ENV]: SUPERVISED_SUCCESSOR_VALUE },
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
