// Static scenario registry. Every scenario module exports `SCENARIOS: Scenario[]`;
// this file imports them all and flattens them into the corpus. Adding a scenario
// file means adding one import + one spread here (static, so the graph stays reviewable).
import type { Scenario } from "../types.ts";
import { SCENARIOS as aspirational } from "./aspirational.ts";
import { SCENARIOS as computation } from "./computation.ts";
import { SCENARIOS as firstmate } from "./firstmate.ts";
import { SCENARIOS as hard } from "./hard.ts";
import { SCENARIOS as hardBugs } from "./hard_bugs.ts";
import { SCENARIOS as harder } from "./harder.ts";
import { SCENARIOS as longhorizon } from "./longhorizon.ts";
import { SCENARIOS as longhorizonHard } from "./longhorizon_hard.ts";
import { SCENARIOS as procedural } from "./procedural.ts";
import { SCENARIOS as reallog } from "./reallog.ts";
import { SCENARIOS as reallogHistory } from "./reallog_history.ts";
import { SCENARIOS as reference } from "./reference.ts";
import { SCENARIOS as supervision } from "./supervision.ts";
import { SCENARIOS as variety } from "./variety.ts";

export const ALL_SCENARIOS: Scenario[] = [
	...reference,
	...variety,
	...hard,
	...procedural,
	...aspirational,
	...firstmate,
	...supervision,
	...reallog,
	...reallogHistory,
	...harder,
	...computation,
	...hardBugs,
	...longhorizon,
	...longhorizonHard,
];

export function loadScenarios(only?: string[]): Scenario[] {
	if (only && only.length) return ALL_SCENARIOS.filter((s) => only.includes(s.id));
	return ALL_SCENARIOS;
}
