// wbl - whiteboard loop command for any omp pane.
//
// `/wbl` injects the shared whiteboard protocol into the current agent turn.
// It is intentionally tiny: the whiteboard itself is the durable state, while
// this command only reminds the running agent how to use it.
// @ts-nocheck

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const WB_LOOP_MESSAGE = [
	"WB loop requested by the captain.",
	"Read the pane's reserved `/wb` whiteboard FIRST and treat it as the current local lane map and shared truths.",
	"Write detailed findings to the durable artifacts listed on that board; cite digested audits by id and never re-derive them.",
	"Append only NEW durable cross-lane facts back to the reserved `/wb` board, respecting one-writer-per-lane and never touching the captain's uncommitted changes.",
	"Report back in no more than 5 delta lines.",
].join("\n");

const HELP = "Usage: /wbl - run the local reserved `/wb` whiteboard loop in this pane.";

export default function wbl(pi: ExtensionAPI) {
	pi.setLabel?.("wbl");

	pi.registerCommand("wbl", {
		description: "Whiteboard loop: read local /wb truths, update durable facts, report <=5 deltas",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			return [
				{ value: "loop", label: "loop", description: "run the local reserved /wb loop" },
			].filter(v => v.value.startsWith(p));
		},
		handler: async (_args: string, ctx) => {
			const c = ctx as { hasUI?: boolean; ui?: { notify?: (m: string, l?: string) => void } } | undefined;

			try {
				pi.sendMessage?.(
					{ customType: "wb-loop", content: WB_LOOP_MESSAGE, display: true },
					{ deliverAs: "nextTurn", triggerTurn: true },
				);
				if (c?.hasUI !== false) c?.ui?.notify?.("wbl: loop queued", "info");
			} catch (err) {
				if (c?.hasUI !== false) c?.ui?.notify?.(`wbl: failed to queue loop - ${String(err)}`, "error");
			}
		},
	});
}
