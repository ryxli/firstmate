// fm verb: action-bench - thin wrapper over benchmarks/action-bench/bench.ts, a
// live agentic-coding A/B that isolates the effect of the HARNESS (control vs
// the firstmate discipline scaffold) across a difficulty ladder, on three axes -
// correctness incl. procedural, cost-of-pass efficiency, and capability - with
// deterministic integrity gates that abort an unfair run.
//
// All real logic lives in benchmarks/action-bench/bench.ts (deterministic gates +
// replay core, flag-gated live path). See benchmarks/action-bench/README.md.
//
//   sbin/fm action-bench gates                       # integrity gates only (pure; no tokens)
//   sbin/fm action-bench corpus                      # corpus metrics + sanitize verdict (pure; no tokens)
//   sbin/fm action-bench replay <runs.json>          # re-aggregate a recording (pure)
//   sbin/fm action-bench run --live [flags]          # live A/B; costs tokens
//
// Ported behavior-preserving from sbin/fm action-bench: exec bun on the real
// bench script, passing every argument through unchanged.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const BENCH_TS = `${REPO_ROOT}/benchmarks/action-bench/bench.ts`;

function run(argv: string[]): number {
	const args = argv.slice(1);
	const child = spawnSync("bun", [BENCH_TS, ...args], { stdio: "inherit" });
	if (child.error) throw child.error;
	return child.status ?? 1;
}

export default {
	name: "action-bench",
	describe: "Live agentic-coding harness A/B over benchmarks/action-bench/bench.ts.",
	run,
};
