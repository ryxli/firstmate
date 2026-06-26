// The CONSTANT benchmark corpus: scenario files paired with the fleet metadata
// (afk flag, per-task pane/kind/pr) the OLD watcher's stale-skip rules consult.
// Scenario JSON is EXTERNAL input, so it is validated into FleetEvent[] through a
// type guard - never cast to any.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetEvent, HerdrStatus, Scenario, TaskMeta } from "./types.ts";

const HERDR_STATES: Record<HerdrStatus, true> = {
	idle: true,
	working: true,
	blocked: true,
	done: true,
	unknown: true,
};

function isHerdrStatus(v: unknown): v is HerdrStatus {
	return typeof v === "string" && Object.prototype.hasOwnProperty.call(HERDR_STATES, v);
}

function toEvent(raw: unknown, idx: number, file: string): FleetEvent {
	if (typeof raw !== "object" || raw === null) {
		throw new Error(`${file}[${idx}]: event is not an object`);
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.t !== "number") throw new Error(`${file}[${idx}]: t must be a number`);
	if (r.kind !== "status" && r.kind !== "herdr" && r.kind !== "check") {
		throw new Error(`${file}[${idx}]: kind must be status|herdr|check`);
	}
	if (typeof r.pane !== "string") throw new Error(`${file}[${idx}]: pane must be a string`);
	if (typeof r.task !== "string") throw new Error(`${file}[${idx}]: task must be a string`);
	if (typeof r.relevant !== "boolean") throw new Error(`${file}[${idx}]: relevant must be a boolean`);
	const ev: FleetEvent = { t: r.t, kind: r.kind, pane: r.pane, task: r.task, relevant: r.relevant };
	if (typeof r.status_line === "string") ev.status_line = r.status_line;
	if (isHerdrStatus(r.herdr_from)) ev.herdr_from = r.herdr_from;
	if (isHerdrStatus(r.herdr_to)) ev.herdr_to = r.herdr_to;
	if (typeof r.check_out === "string") ev.check_out = r.check_out;
	return ev;
}

function loadEvents(file: string): FleetEvent[] {
	const text = readFileSync(join(import.meta.dir, "scenarios", file), "utf8");
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error(`${file}: top level must be a JSON array`);
	const events = parsed.map((raw, i) => toEvent(raw, i, file));
	// Events must be t-ordered for the coalescing replay to be correct.
	for (let i = 1; i < events.length; i += 1) {
		if (events[i].t < events[i - 1].t) throw new Error(`${file}: events are not t-ordered at index ${i}`);
	}
	return events;
}

type ScenarioSpec = {
	name: string;
	file: string;
	feature: string;
	afk: boolean;
	metas: Record<string, TaskMeta>;
};

// Each scenario names the replaced machinery it exercises (the per-feature
// verdict groups by this) and supplies the per-task meta OLD consults.
const SPECS: ScenarioSpec[] = [
	{
		name: "normal-lifecycle",
		file: "normal-lifecycle.json",
		feature: "turn-end + done/PR signal wake",
		afk: false,
		metas: { "fix-login-k3": { pane: "w8:p3", kind: "ship" } },
	},
	{
		name: "stale",
		file: "stale.json",
		feature: "stale-pane diagnosis (peek)",
		afk: false,
		metas: { "build-api-q2": { pane: "w9:p2", kind: "ship" } },
	},
	{
		name: "noisy-fleet",
		file: "noisy-fleet.json",
		feature: "noise suppression + needs-decision",
		afk: false,
		metas: {
			"refactor-db-z7": { pane: "w7:p1", kind: "ship" },
			"fix-login-k3": { pane: "w8:p3", kind: "ship" },
			"build-api-q2": { pane: "w9:p2", kind: "ship" },
		},
	},
	{
		name: "pr-merge",
		file: "pr-merge.json",
		feature: "parked-PR skip + merge check",
		afk: false,
		metas: {
			"ship-checkout-m4": {
				pane: "w8:p4",
				kind: "ship",
				pr: "https://github.com/acme/app/pull/77",
			},
		},
	},
	{
		name: "blocked",
		file: "blocked.json",
		feature: "herdr-native blocked detection",
		afk: false,
		metas: { "wire-oauth-r5": { pane: "w8:p3", kind: "ship" } },
	},
	{
		name: "afk-batch",
		file: "afk-batch.json",
		feature: "away-mode batched escalation",
		afk: true,
		metas: {
			"refactor-db-z7": { pane: "w7:p1", kind: "ship" },
			"fix-login-k3": { pane: "w8:p3", kind: "ship" },
			"build-api-q2": { pane: "w9:p2", kind: "ship" },
		},
	},
	{
		name: "busy-turns",
		file: "busy-turns.json",
		feature: "per-turn-end over-waking",
		afk: false,
		metas: { "fix-login-k3": { pane: "w8:p3", kind: "ship" } },
	},
];

export const SCENARIOS: Scenario[] = SPECS.map((s) => ({
	name: s.name,
	file: s.file,
	feature: s.feature,
	afk: s.afk,
	metas: s.metas,
	events: loadEvents(s.file),
}));
