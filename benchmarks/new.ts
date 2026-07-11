import { classifyAndDigest } from "../.omp/extensions/fm-supervisor.ts";
import { PEEK_40, detectStaleWakes } from "./model-lib.ts";
import { countTokens } from "./tokenizer.ts";
import type { Components, SystemResult } from "./old.ts";
import type { Scenario } from "./types.ts";

// This model deliberately calls the production pure export.  It must not copy
// classification or digest construction into the benchmark: an import failure
// or semantic change is a failed replay, not a benchmark-local fallback.
export function modelNew(scenario: Scenario): SystemResult {
	const classifier = classifyAndDigest(scenario.events, { afk: scenario.afk });
	const components: Components = {
		digest: classifier.digests.reduce((total, digest) => total + countTokens(digest), 0),
	};
	let wakes = classifier.wakes;
	let falseWakes = classifier.falseWakes;
	for (const stale of detectStaleWakes(scenario.events, scenario.metas)) {
		const digest = `[wake] ${stale.task} ${stale.pane} - STALE idle, no status \u00b7 action: peek pane`;
		components.stale_digest = (components.stale_digest ?? 0) + countTokens(digest);
		components.peek = (components.peek ?? 0) + countTokens(PEEK_40);
		wakes++;
		falseWakes++;
	}
	const expectedRelevant = scenario.events.reduce((count, event) => count + Number(event.relevant), 0);
	return {
		metrics: {
			system: "new",
			scenario: scenario.name,
			wakes,
			interface_tokens: Object.values(components).reduce((total, value) => total + value, 0),
			false_wakes: falseWakes,
			detected_relevant: classifier.detected,
			missed_relevant: expectedRelevant - classifier.detected,
		},
		components,
	};
}
