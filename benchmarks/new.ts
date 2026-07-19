import { classifyAttention } from "../.omp/extensions/fm-supervisor.ts";
import { detectStaleWakes } from "./model-lib.ts";
import { countTokens } from "./tokenizer.ts";
import type { Components, SystemResult } from "./old.ts";
import type { Scenario } from "./types.ts";

// This model deliberately calls the production pure export.  It must not copy
// classification into the benchmark: an import failure
// or semantic change is a failed replay, not a benchmark-local fallback.
export function modelNew(scenario: Scenario): SystemResult {
	const classifier = classifyAttention(scenario.events);
	const attentionNudge = "fleet-attention-changed: Read `fm fleet` once.";
	const stale = detectStaleWakes(scenario.events, scenario.metas);
	const wakes = scenario.afk ? 0 : Number(classifier.edges > 0 || stale.length > 0);
	const components: Components = {
		digest: wakes * countTokens(attentionNudge),
	};
	const expectedRelevant = scenario.events.reduce((count, event) => count + Number(event.relevant), 0);
	return {
		metrics: {
			system: "new",
			scenario: scenario.name,
			wakes,
			interface_tokens: Object.values(components).reduce((total, value) => total + value, 0),
			false_wakes: classifier.falseEdges,
			detected_relevant: classifier.detected,
			missed_relevant: expectedRelevant - classifier.detected,
		},
		components,
	};
}
