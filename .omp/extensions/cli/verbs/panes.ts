// fm verb: panes - list herdr panes with detected agent name, agent_status, pane_id.
// Ported verbatim (behavior-preserving) out of the former sbin/fm panes.
// name = display_agent (preferred) falling back to agent.
// Optional args: [--all] [name-filter]
//   --all: also list panes with NO detected agent as -<TAB>unknown<TAB><pane_id><TAB><cwd>
// Exit 0 with empty output when nothing matches; exit non-zero with stderr if herdr output is unparseable.
// Output is plain tab-separated text, not TOON: consumers pipe this directly.

import { spawnSync } from "node:child_process";

interface HerdrPane {
	agent?: string;
	display_agent?: string;
	agent_status?: string;
	pane_id?: string;
	cwd?: string;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	let filter = "";
	let all = false;
	for (const arg of args) {
		if (arg === "--all") all = true;
		else filter = arg;
	}

	const result = spawnSync("herdr", ["pane", "list"], { encoding: "utf8" });
	const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;

	let data: { result?: { panes?: HerdrPane[] } };
	try {
		data = JSON.parse(combined);
	} catch (error) {
		process.stderr.write(`error: invalid JSON from herdr pane list: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	const panes = data?.result?.panes ?? [];
	const lines: string[] = [];
	for (const pane of panes) {
		const agent = pane.agent ?? "";
		const displayAgent = pane.display_agent ?? "";
		const paneId = pane.pane_id ?? "";
		const cwd = pane.cwd ?? "";

		if (!agent && !displayAgent) {
			// Agentless pane: only included with --all
			if (!all) continue;
			// Filter applies to pane_id for agentless panes (no name to filter on)
			if (filter) continue;
			lines.push(`-\tunknown\t${paneId}\t${cwd}`);
			continue;
		}

		const name = displayAgent || agent;
		const status = pane.agent_status ?? "";

		if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;

		lines.push(`${name}\t${status}\t${paneId}`);
	}

	if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

export default {
	name: "panes",
	describe: "List herdr panes with detected agent name, agent_status, pane_id.",
	run,
};
