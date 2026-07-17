// fm verb: think-bench - thin wrapper over benchmarks/thinking/run.ts (the
// thinking-efficiency BASELINE-vs-NEW A/B bench). Ported behavior-preserving
// from sbin/fm think-bench: exec bun on the real run script, passing every
// argument through unchanged. See benchmarks/thinking/README.md.
//
//   sbin/fm think-bench check-corpus
//   sbin/fm think-bench grade <oracle.json> <output-file>
//   sbin/fm think-bench replay <runs.json> --out DIR
//   sbin/fm think-bench record --live      # live; costs tokens

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const RUN_TS = `${REPO_ROOT}/benchmarks/thinking/run.ts`;

function run(argv: string[]): number {
	const args = argv.slice(1);
	const child = spawnSync("bun", [RUN_TS, ...args], { stdio: "inherit" });
	if (child.error) throw child.error;
	return child.status ?? 1;
}

export default {
	name: "think-bench",
	describe: "Thinking-efficiency BASELINE-vs-NEW A/B bench over benchmarks/thinking/run.ts.",
	run,
};
