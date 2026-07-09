// wb - whiteboard loop command for any omp pane.
//
// `/wb loop` injects the shared whiteboard protocol into the current agent turn.
// It is intentionally tiny: the whiteboard itself is the durable state, while
// this command only reminds the running agent how to use it.
// @ts-nocheck

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const WB_LOOP_MESSAGE = [
	"WB loop requested by the captain.",
	"Read the shared whiteboard FIRST and treat it as the current lane map and shared truths.",
	"Write detailed findings to the durable artifacts listed on the board; cite digested audits by id and never re-derive them.",
	"Append only NEW durable cross-lane facts back to the whiteboard, respecting one-writer-per-lane and never touching the captain's uncommitted changes.",
	"Report back in no more than 5 delta lines.",
].join("\n");

const HELP = "Usage: /wb loop - run the shared whiteboard loop in this pane.";

export default function wb(pi: ExtensionAPI) {
	pi.setLabel?.("wb");

	pi.registerCommand("wb", {
		description: "Whiteboard loop: read shared truths, update durable facts, report <=5 deltas",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			return [
				{ value: "loop", label: "loop", description: "run the shared whiteboard loop" },
			].filter(v => v.value.startsWith(p));
		},
		handler: async (args: string, ctx) => {
			const c = ctx as { hasUI?: boolean; ui?: { notify?: (m: string, l?: string) => void } } | undefined;
			const word = (args.trim().toLowerCase().split(/\s+/)[0] ?? "");
			if (word !== "loop") {
				if (c?.hasUI !== false) c?.ui?.notify?.(HELP, "info");
				return;
			}

			try {
				pi.sendMessage?.(
					{ customType: "wb-loop", content: WB_LOOP_MESSAGE, display: true },
					{ deliverAs: "nextTurn", triggerTurn: true },
				);
				if (c?.hasUI !== false) c?.ui?.notify?.("wb: loop queued", "info");
			} catch (err) {
				if (c?.hasUI !== false) c?.ui?.notify?.(`wb: failed to queue loop - ${String(err)}`, "error");
			}
		},
	});
}
