// NEW system model: the omp supervisor extension's LLM-facing cost.
//
// Event relevance + event digests come from the shared pure export
// `classifyAndDigest` (the single source of truth). interface_tokens for those
// wakes = the injected, self-contained digest strings ONLY (no follow-up read).
//
// STALE wakes are the live loop's time-based concern, NOT classifyAndDigest, so
// they are derived here (detectStaleWakes, identical to OLD) and DO charge the
// shared 40-line peek: a STALE digest directs the supervisor to peek the pane to
// diagnose, so it is not self-contained. The peek cost is identical to OLD, so
// the stale comparison isolates the ceremony the NEW model removes.
//
// Event relevance + digests come from SupervisorExt's pure export. Verified to
// load under Bun and to match the spec stub's wakes/detected/falseWakes across
// the whole corpus; the local supervisor-stub.ts remains as the offline spec
// reference and parity oracle (used by the import-parity check), not in this path.
import { classifyAndDigest } from "../.omp/extensions/fm-supervisor.ts";
import { canonicalRelevant } from "./relevance.ts";
import { PEEK_40, detectStaleWakes } from "./model-lib.ts";
import { countTokens } from "./tokenizer.ts";
import type { Scenario } from "./types.ts";
import type { Components, SystemResult } from "./old.ts";

export function modelNew(scenario: Scenario): SystemResult {
	const components: Components = {};
	let wakes = 0;
	let falseWakes = 0;

	// --- event-driven wakes from the shared pure classifier ------------------
	const result = classifyAndDigest(scenario.events, { afk: scenario.afk });
	let digestTokens = 0;
	for (const d of result.digests) digestTokens += countTokens(d);
	components.digest = digestTokens;
	wakes += result.wakes;
	falseWakes += result.falseWakes;
	const detected = result.detected;

	// --- stale wakes (live-loop behavior; pay the shared peek) ---------------
	const staleWakes = detectStaleWakes(scenario.events, scenario.metas);
	let staleDigestTokens = 0;
	let peekTokens = 0;
	for (const s of staleWakes) {
		const digest = `[wake] ${s.task} ${s.pane} - STALE idle, no status \u00b7 action: peek pane`;
		staleDigestTokens += countTokens(digest);
		peekTokens += countTokens(PEEK_40);
		wakes += 1;
		falseWakes += 1; // triggered by a non-relevant idle->idle (mechanical false)
	}
	if (staleWakes.length > 0) {
		components.stale_digest = staleDigestTokens;
		components.peek = peekTokens;
	}

	// recall is computed against ground truth, not trusted blindly: if the real
	// classifier under-detects, missed_relevant goes positive and the table shows it.
	const totalRelevant = scenario.events.filter(canonicalRelevant).length;
	const missed = totalRelevant - detected;

	const interface_tokens = Object.values(components).reduce((a, b) => a + b, 0);
	return {
		metrics: {
			system: "new",
			scenario: scenario.name,
			wakes,
			interface_tokens,
			false_wakes: falseWakes,
			detected_relevant: detected,
			missed_relevant: missed,
		},
		components,
	};
}
