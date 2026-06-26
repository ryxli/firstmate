// Spec-faithful local stub of the NEW supervisor's pure export. Used by new.ts
// until SupervisorExt's ../.omp/extensions/fm-supervisor.ts loads under Bun;
// new.ts then swaps the import to the real module and re-verifies parity.
//
// Mirrors the agreed contract EXACTLY:
//   classifyAndDigest(events, opts?) => { wakes; digests; falseWakes; detected }
// - relevance = the canonical contract rule (relevance.ts)
// - same-pane relevant events within a 30s grace coalesce into ONE wake / ONE
//   digest, but each still increments `detected` (so missed_relevant nets 0)
// - afk:true batches ALL relevant events into ONE combined digest (wakes=1)
// - falseWakes is always 0 (the NEW model never wakes on a non-relevant event)
// - digest line: `[wake] <task> <pane> - <state> · action: <act>` (middot U+00B7)
//
// STALE wakes are NOT produced here: staleness is the live loop's time-based
// concern (modeled in new.ts), not event relevance. This pure function is the
// single source of truth for event relevance + event digests only.

import { canonicalRelevant } from "./relevance.ts";
import type { FleetEvent } from "./types.ts";

export type { FleetEvent } from "./types.ts";

export type ClassifyResult = {
	wakes: number;
	digests: string[];
	falseWakes: number;
	detected: number;
};

const GRACE_MS = 30000;

// Dense, self-contained digest line for one relevant event: state phrase plus a
// recommended action so the supervisor needs no follow-up read.
function digestLine(e: FleetEvent): string {
	let state: string;
	let action: string;
	if (e.kind === "herdr") {
		if (e.herdr_to === "blocked") {
			state = "BLOCKED (no status, herdr)";
			action = "peek+unblock";
		} else {
			state = "done (herdr)";
			action = "review";
		}
	} else if (e.kind === "check") {
		state = (e.check_out ?? "").trim();
		action = /merged/i.test(state) ? "confirm merge+teardown" : "act";
	} else {
		state = (e.status_line ?? "").trim();
		if (/needs-decision:/i.test(state)) action = "decide";
		else if (/blocked:/i.test(state)) action = "unblock";
		else if (/failed:/i.test(state)) action = "triage";
		else if (/merged/i.test(state)) action = "confirm merge+teardown";
		else if (/PR ready|ready in branch|done:.* PR |checks green/i.test(state)) action = "review+merge";
		else action = "review";
	}
	return `[wake] ${e.task} ${e.pane} - ${state} \u00b7 action: ${action}`;
}

export function classifyAndDigest(
	events: FleetEvent[],
	opts?: { afk?: boolean },
): ClassifyResult {
	const relevant = events.filter(canonicalRelevant);
	const detected = relevant.length;

	// Coalesce same-pane relevant events within the grace window into one group.
	const groups: FleetEvent[][] = [];
	const openByPane = new Map<string, FleetEvent[]>();
	for (const e of relevant) {
		const open = openByPane.get(e.pane);
		if (open && e.t - open[0].t <= GRACE_MS) {
			open.push(e);
			continue;
		}
		const fresh = [e];
		openByPane.set(e.pane, fresh);
		groups.push(fresh);
	}

	// One digest per group, built from the group's most-recent event.
	const groupDigests = groups.map((g) => digestLine(g[g.length - 1]));

	if (opts?.afk) {
		// Away mode: batch every relevant event into ONE combined digest.
		if (groupDigests.length === 0) return { wakes: 0, digests: [], falseWakes: 0, detected: 0 };
		return { wakes: 1, digests: [groupDigests.join("\n")], falseWakes: 0, detected };
	}

	return { wakes: groupDigests.length, digests: groupDigests, falseWakes: 0, detected };
}
