// fm verb: home-skills - reconcile or check per-home OMP skill isolation.
//
// Usage:
//   fm home-skills sync <secondmate-id|home-path>
//   fm home-skills check <secondmate-id|home-path>
//
// sync performs one atomic, ownership-safe reconciliation.
// check performs the same complete validation without mutation and exits
// nonzero on drift or validation failure.

import { reconcileHomeSkills, type HomeSkillsMode } from "../lib/home-skills";

const USAGE = `usage: fm home-skills sync <secondmate-id|home-path>
       fm home-skills check <secondmate-id|home-path>
`;

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length !== 2) {
		process.stderr.write(USAGE);
		return 2;
	}
	const modeArg = args[0];
	if (modeArg !== "sync" && modeArg !== "check") {
		process.stderr.write(USAGE);
		return 2;
	}
	const mode = modeArg as HomeSkillsMode;
	const result = reconcileHomeSkills({ mode, target: args[1] });
	return result.ok ? 0 : 1;
}

export default {
	name: "home-skills",
	describe: "Reconcile or check isolated OMP skills for a persistent specialist home.",
	run,
};
