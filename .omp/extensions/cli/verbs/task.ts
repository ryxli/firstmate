// fm verb: task - explicit zero-ambiguity singular alias for `fm tasks`.
//
// This is the ONLY alias in the fm CLI: near-miss verbs get a structured
// did-you-mean and run nothing (see sbin/fm's unknown-command handling), but
// `task` === `tasks` is an intentional, documented exception because the
// distinction is a typo, not a different command. See tasks.ts for the
// canonical implementation, help text, and subcommand dispatch.

import tasks from "./tasks";

async function run(argv: string[]): Promise<number> {
	return tasks.run(["tasks", ...argv.slice(1)]);
}

export default {
	name: "task",
	describe: "Alias for `tasks` (add/list/show/start/done/reopen/update/block/unblock/hold/unhold/ready/mv/prune/render/fleet/next).",
	run,
};
