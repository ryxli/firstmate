// fm verb: promote - flip a scout task's meta kind= to ship in place.
// Ported behavior-preserving from the former sbin/fm promote.
//
// Promotes a scout task to a ship task in place: the crewmate keeps its
// window, worktree, and loaded context; only the contract changes. Flips
// kind= to ship in state/<task-id>.meta so fm teardown applies the full
// unpushed-work protection again. After promoting, send the crewmate its
// ship instructions via fm send (inventory scratch state, reset to a
// clean default-branch base, carry over only intended fix changes, create
// branch fm/<task-id>, implement, then report done according to the
// project's delivery mode).
// Usage: fm promote <task-id>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || join(fmHome, "state");
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const id = args[0];
	if (!id) {
		process.stderr.write("Usage: fm promote <task-id>\n");
		return 1;
	}

	const state = resolveState();
	const metaPath = join(state, `${id}.meta`);

	if (!existsSync(metaPath)) {
		process.stderr.write(`error: no meta for task ${id} at ${metaPath}\n`);
		return 1;
	}

	const content = readFileSync(metaPath, "utf8");
	const lines = content.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (!lines.includes("kind=scout")) {
		process.stderr.write(`error: task ${id} is not a scout task (kind=scout not in meta)\n`);
		return 1;
	}

	const kept = lines.filter(line => !line.startsWith("kind="));
	kept.push("kind=ship");
	writeFileSync(metaPath, `${kept.join("\n")}\n`);

	process.stdout.write(`promoted ${id} to ship (teardown protection restored)\n`);
	process.stdout.write(
		`next: sbin/fm send fm-${id} '<ship instructions: review scratch state with git status and git log; reset to a clean default-branch base; carry over only intended fix changes; create branch fm/${id}; implement; report done>'\n`,
	);
	return 0;
}

export default {
	name: "promote",
	describe: "Promote a scout task to ship.",
	surface: "captain",
	run,
};
