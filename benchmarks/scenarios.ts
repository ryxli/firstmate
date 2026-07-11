import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetEvent, Scenario, TaskMeta } from "./types.ts";

const STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);

type Spec = {
	name: string;
	file: string;
	feature: string;
	afk: boolean;
	metas: Record<string, TaskMeta>;
};

const SPECS: readonly Spec[] = [
	{ name: "normal-lifecycle", file: "normal-lifecycle.json", feature: "turn-end + done/PR signal wake", afk: false, metas: { "fix-login-k3": { pane: "w8:p3", kind: "ship" } } },
	{ name: "stale", file: "stale.json", feature: "stale-pane diagnosis (peek)", afk: false, metas: { "build-api-q2": { pane: "w9:p2", kind: "ship" } } },
	{ name: "noisy-fleet", file: "noisy-fleet.json", feature: "noise suppression + needs-decision", afk: false, metas: { "refactor-db-z7": { pane: "w7:p1", kind: "ship" }, "fix-login-k3": { pane: "w8:p3", kind: "ship" }, "build-api-q2": { pane: "w9:p2", kind: "ship" } } },
	{ name: "pr-merge", file: "pr-merge.json", feature: "parked-PR skip + merge check", afk: false, metas: { "ship-checkout-m4": { pane: "w8:p4", kind: "ship", pr: "https://github.com/acme/app/pull/77" } } },
	{ name: "blocked", file: "blocked.json", feature: "herdr-native blocked detection", afk: false, metas: { "wire-oauth-r5": { pane: "w8:p3", kind: "ship" } } },
	{ name: "afk-batch", file: "afk-batch.json", feature: "away-mode batched escalation", afk: true, metas: { "refactor-db-z7": { pane: "w7:p1", kind: "ship" }, "fix-login-k3": { pane: "w8:p3", kind: "ship" }, "build-api-q2": { pane: "w9:p2", kind: "ship" } } },
	{ name: "busy-turns", file: "busy-turns.json", feature: "per-turn-end over-waking", afk: false, metas: { "fix-login-k3": { pane: "w8:p3", kind: "ship" } } },
];

function loadEvents(file: string): FleetEvent[] {
	const raw: unknown = JSON.parse(readFileSync(join(import.meta.dir, "scenarios", file), "utf8"));
	if (!Array.isArray(raw)) throw new Error(`${file}: top level must be an array`);
	const events = raw.map((value, index) => {
		if (typeof value !== "object" || value === null) throw new Error(`${file}[${index}]: event must be an object`);
		const event = value as Record<string, unknown>;
		if (typeof event.t !== "number" || typeof event.task !== "string" || typeof event.pane !== "string" || typeof event.relevant !== "boolean") throw new Error(`${file}[${index}]: invalid required event fields`);
		if (event.kind !== "status" && event.kind !== "herdr" && event.kind !== "check") throw new Error(`${file}[${index}]: invalid event kind`);
		if (event.herdr_from !== undefined && (typeof event.herdr_from !== "string" || !STATES.has(event.herdr_from))) throw new Error(`${file}[${index}]: invalid herdr_from`);
		if (event.herdr_to !== undefined && (typeof event.herdr_to !== "string" || !STATES.has(event.herdr_to))) throw new Error(`${file}[${index}]: invalid herdr_to`);
		if (event.status_line !== undefined && typeof event.status_line !== "string") throw new Error(`${file}[${index}]: invalid status_line`);
		if (event.check_out !== undefined && typeof event.check_out !== "string") throw new Error(`${file}[${index}]: invalid check_out`);
		return event as FleetEvent;
	});
	for (let index = 1; index < events.length; index++) {
		if (events[index].t < events[index - 1].t) throw new Error(`${file}: events out of order at index ${index}`);
	}
	return events;
}

export const SCENARIOS: readonly Scenario[] = SPECS.map((spec) => ({ ...spec, events: loadEvents(spec.file) }));
