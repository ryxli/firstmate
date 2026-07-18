// fm verb: crew-metrics - thin wrapper over benchmarks/eval-runner/crew-metrics.py
// (the passive crew-metrics harvester: zero-cost, runs no agents, and only reads
// harness side-effect signals - omp stats byFolder, state/*.meta, state/*.status,
// state/.status-internal.log, data/backlog.md). Ported behavior-preserving from
// sbin/fm crew-metrics: exec python3 on the real script, passing every argument
// through unchanged. All real logic, including the omp-stats capture-to-file
// workaround (byFolder is unbounded; a pipe capture truncates at 64KB), lives in
// the python module - see its docstring for the full metric set and caveats.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const CREW_METRICS_PY = `${REPO_ROOT}/benchmarks/eval-runner/crew-metrics.py`;

function run(argv: string[]): number {
	const args = argv.slice(1);
	// PYTHONDONTWRITEBYTECODE keeps this a clean read-only no-op: without it,
	// Apple's system python3 caches .pyc bytecode into $HOME/Library/Caches
	// on import, which leaks writes into the caller's HOME. Same guard the
	// spawn verb applies to python tooling a mate runs.
	const child = spawnSync("python3", [CREW_METRICS_PY, ...args], {
		stdio: "inherit",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
	if (child.error) throw child.error;
	return child.status ?? 1;
}

export default {
	name: "crew-metrics",
	describe: "Passive crew-metrics harvester over benchmarks/eval-runner/crew-metrics.py.",
	run,
};
