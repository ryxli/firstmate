import type { FleetEvent as SupervisorFleetEvent } from "../.omp/extensions/fm-supervisor.ts";

// The replay consumes the supervisor's own event contract.  Keeping this alias
// structural prevents a benchmark-only event shape from drifting from herdr's
// live classifier input.
export type FleetEvent = SupervisorFleetEvent;
export type System = "old" | "new";

export type Metrics = {
	system: System;
	scenario: string;
	wakes: number;
	interface_tokens: number;
	false_wakes: number;
	detected_relevant: number;
	missed_relevant: number;
};

export type TaskMeta = {
	pane: string;
	kind?: "ship" | "scout" | "secondmate";
	pr?: string;
};

export type Scenario = {
	name: string;
	file: string;
	feature: string;
	afk: boolean;
	metas: Record<string, TaskMeta>;
	events: FleetEvent[];
};
