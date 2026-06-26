// Canonical relevance, shared by OLD and NEW so both replay one ground truth.
// The status regex matches bin/fm-classify-status.sh byte-for-byte:
//   grep -qiE 'done:|blocked:|failed:|needs-decision:|PR ready|checks green|ready in branch|merged'

import type { FleetEvent } from "./types.ts";

const CAPTAIN_RE =
	/done:|blocked:|failed:|needs-decision:|PR ready|checks green|ready in branch|merged/i;

// True iff a status line is captain-relevant (escalation-worthy).
export function statusIsCaptainRelevant(line: string | undefined): boolean {
	if (!line) return false;
	return CAPTAIN_RE.test(line);
}

// The contract's relevance rule applied to one event. This is the single source
// of ground truth; run.ts asserts every authored `relevant` field equals this,
// so a mis-tagged corpus event fails fast instead of skewing the numbers.
export function canonicalRelevant(e: FleetEvent): boolean {
	switch (e.kind) {
		case "status":
			return statusIsCaptainRelevant(e.status_line);
		case "check":
			return (e.check_out ?? "").length > 0;
		case "herdr":
			// working->idle is a turn-end (NOT a captain wake by itself);
			// idle->idle is a re-observation (NOT a wake). Only blocked/done are.
			return e.herdr_to === "blocked" || e.herdr_to === "done";
		default:
			return false;
	}
}
