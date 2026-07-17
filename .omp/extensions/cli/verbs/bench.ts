// fm verb: bench - thin wrapper over benchmarks/run.ts (deterministic OLD-vs-NEW
// supervision replay). Ported behavior-preserving from sbin/fm bench: exec bun
// on the real replay script, passing every argument through unchanged. It imports
// the production fm-supervisor.ts pure export and writes no result artifacts.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const RUN_TS = `${REPO_ROOT}/benchmarks/run.ts`;

function run(argv: string[]): number {
	const args = argv.slice(1);
	const child = spawnSync("bun", [RUN_TS, ...args], { stdio: "inherit" });
	if (child.error) throw child.error;
	return child.status ?? 1;
}

export default {
	name: "bench",
	describe: "Deterministic OLD-vs-NEW supervision replay over benchmarks/run.ts.",
	run,
};
