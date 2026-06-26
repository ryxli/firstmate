// Shared benchmark types. FleetEvent mirrors the redesign contract exactly
// (local://supervisor-redesign.md) so OLD and NEW replay the identical corpus.

export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

// The unit replayed by the benchmark, consumed by both systems.
export type FleetEvent = {
	t: number; // ms offset within the scenario (ordered)
	kind: "status" | "herdr" | "check";
	pane: string; // e.g. "w8:p3"
	task: string; // e.g. "fix-login-k3"
	status_line?: string; // kind=status: the appended status line
	herdr_from?: HerdrStatus; // kind=herdr
	herdr_to?: HerdrStatus;
	check_out?: string; // kind=check: stdout of a *.check.sh (empty = no wake)
	relevant: boolean; // GROUND TRUTH: should this wake the supervisor?
};

export type System = "old" | "new";

// One row per scenario per system.
export type Metrics = {
	system: System;
	scenario: string;
	wakes: number; // supervisor wake events generated
	interface_tokens: number; // tokens the supervisor must INGEST to act
	false_wakes: number; // wakes whose triggering events were all non-relevant
	detected_relevant: number; // distinct relevant events that produced a wake
	missed_relevant: number; // relevant events that produced NO wake
};

// Per-task fleet metadata the OLD watcher consults for its stale-skip rules.
// (kind=secondmate panes and ship tasks parked on a green PR skip stale wakes.)
export type TaskMeta = {
	pane: string;
	kind?: "ship" | "scout" | "secondmate";
	pr?: string; // recorded PR url; presence + terminal done-PR line => parked
};

export type Scenario = {
	name: string; // logical scenario name (also the feature exercised)
	file: string; // path to the JSON corpus file
	feature: string; // the replaced machinery this scenario exercises
	afk: boolean; // state/.afk present for this scenario
	metas: Record<string, TaskMeta>; // task -> meta
	events: FleetEvent[];
};
