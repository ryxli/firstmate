// bridge - an always-fresh, read-only fleet snapshot reachable from ANY omp pane.
//
// The captain runs many parallel sessions and loses the thread between panes.
// `/bridge` is the single place his fleet context lives: on each invocation it
// reads the live on-disk fleet state (the constantly-mutating source of truth)
// across ALL firstmate homes and renders a compact board. Two lenses, by argument:
// `/bridge` = NEEDS YOU + the crew roster; `/bridge tasks` = the task board; `/bridge all` = both.
//
// DESIGN (locked): on-demand LIVE read, no maintained store and no hooks. The
// fleet files ARE the persistent mutating state; reading them live each time is
// always-fresh and robust to crashes/restarts. The command writes NOTHING - it
// only reads fleet files and runs read-only `gh`/`herdr`.
//
// Sources (all best-effort, degrade to notes): per home data/backlog.md,
// state/*.meta, latest state/*.status; live `gh pr view` PR/CI state; live
// `herdr agent list` agent status. Homes enumerated from data/secondmates.md.
//
// Layout follows the textguard / agent-effectiveness convention: only this
// index.ts is auto-discovered as an extension; fleet.ts (pure) + collect.ts (IO)
// load via imports. To disable: add `extension-module:bridge` to
// `disabledExtensions` in ~/.omp/agent/config.yml.
// @ts-nocheck

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { collectAndRender } from "./collect";

export default function bridge(pi: ExtensionAPI) {
	pi.setLabel?.("bridge");

	// Subviews, surfaced as argument autocompletions (type `/bridge ` to discover).
	const VIEWS = [
		{ value: "roster", label: "roster", description: "default - the crew you reach out to + what needs you" },
		{ value: "tasks", label: "tasks", description: "the full task board, grouped by state" },
		{ value: "all", label: "all", description: "roster + every task" },
	];

	pi.registerCommand("bridge", {
		description: "Fleet bridge: crew roster + what needs you (also /bridge tasks, /bridge all)",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			return VIEWS.filter(v => v.value.startsWith(p));
		},
		handler: async (args: string, ctx) => {
			const c = ctx as { cwd?: string; hasUI?: boolean; ui?: { notify?: (m: string, l?: string) => void } } | undefined;
			const word = (args.trim().toLowerCase().split(/\s+/)[0] ?? "");
			const view = word === "tasks" || word === "board" ? "tasks" : word === "all" ? "all" : "roster";
			let board: string;
			try {
				board = await collectAndRender(undefined, c?.cwd, view);
			} catch (err) {
				board = `bridge: failed to read fleet - ${String(err)}`;
			}
			if (c?.hasUI === false) return;
			c?.ui?.notify?.(board, "info");
		},
	});
}
