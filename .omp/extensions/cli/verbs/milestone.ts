// fm verb: milestone - thin wrapper over benchmarks/milestone/run.ts.
// Ported behavior-preserving from sbin/fm milestone: exec bun on the real
// composition layer, passing every argument through unchanged. All real logic
// lives in benchmarks/milestone/run.ts (see its header for the row schema and
// the --compare contract); this verb adds no behavior of its own.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const RUN_TS = `${REPO_ROOT}/benchmarks/milestone/run.ts`;

function run(argv: string[]): number {
	const args = argv.slice(1);
	const child = spawnSync("bun", [RUN_TS, ...args], { stdio: "inherit" });
	if (child.error) throw child.error;
	return child.status ?? 1;
}

export default {
	name: "milestone",
	describe: "One reproducible longitudinal measurement row: gates, corpus, replay, context-weight, tests.",
	run,
};
