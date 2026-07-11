import { PEEK_40, RITUAL_TEXT, detectStaleWakes, epochFor, queueRecord } from "./model-lib.ts";
import { countTokens } from "./tokenizer.ts";
import type { FleetEvent, Metrics, Scenario } from "./types.ts";

const GRACE_MS = 30_000;
export type Components = Record<string, number>;
export type SystemResult = { metrics: Metrics; components: Components };

type Trigger =
	| { kind: "turnend"; t: number; pane: string }
	| { kind: "status"; t: number; task: string; pane: string; fileSnapshot: string[] };
type SignalGroup = { startT: number; members: Trigger[] };

function add(components: Components, key: string, text: string): void {
	components[key] = (components[key] ?? 0) + countTokens(text);
}

function total(components: Components): number {
	return Object.values(components).reduce((sum, value) => sum + value, 0);
}

function result(
	scenario: Scenario,
	components: Components,
	wakes: number,
	falseWakes: number,
	detected: number,
	missed: number,
): SystemResult {
	return {
		metrics: {
			system: "old",
			scenario: scenario.name,
			wakes,
			interface_tokens: total(components),
			false_wakes: falseWakes,
			detected_relevant: detected,
			missed_relevant: missed,
		},
		components,
	};
}

// Replay the replaced queue watcher.  It wakes on every working->idle turn end,
// never sees bare blocked/done herdr transitions, and makes the supervisor read
// queue records, full status files, and a re-arm ceremony on each turn.
export function modelOld(scenario: Scenario): SystemResult {
	const components: Components = {};
	const history = new Map<string, string[]>();
	const triggers: Trigger[] = [];
	const checks: FleetEvent[] = [];
	let missed = 0;

	for (const event of scenario.events) {
		if (event.kind === "status") {
			const lines = history.get(event.task) ?? [];
			if (event.status_line) lines.push(event.status_line);
			history.set(event.task, lines);
			if (event.relevant) triggers.push({ kind: "status", t: event.t, task: event.task, pane: event.pane, fileSnapshot: [...lines] });
			continue;
		}
		if (event.kind === "herdr" && event.herdr_from === "working" && event.herdr_to === "idle") {
			triggers.push({ kind: "turnend", t: event.t, pane: event.pane });
		} else if (event.kind === "herdr" && event.relevant) {
			missed++;
		} else if (event.kind === "check" && event.relevant) {
			checks.push(event);
		}
	}

	const groups: SignalGroup[] = [];
	for (const trigger of triggers) {
		const open = groups.at(-1);
		if (open && trigger.t - open.startT <= GRACE_MS) open.members.push(trigger);
		else groups.push({ startT: trigger.t, members: [trigger] });
	}
	if (scenario.afk) return modelOldAfk(scenario, groups, checks, components, missed);

	let sequence = 0;
	let wakes = 0;
	let falseWakes = 0;
	let detected = 0;
	for (const group of groups) {
		const statusMembers = group.members.filter((trigger): trigger is Extract<Trigger, { kind: "status" }> => trigger.kind === "status");
		const refs = [...new Set(group.members.map((trigger) => trigger.kind === "turnend" ? trigger.pane : `state/${trigger.task}.status`))];
		const reason = `signal: ${refs.join(" ")}`;
		add(components, "reason", reason);
		if (group.members.some((trigger) => trigger.kind === "turnend")) {
			add(components, "queue", queueRecord(epochFor(group.startT), ++sequence, "signal", "herdr-turn-end", reason));
		}
		const queuedStatusTasks = new Set<string>();
		for (const member of statusMembers) {
			if (queuedStatusTasks.has(member.task)) continue;
			queuedStatusTasks.add(member.task);
			add(components, "queue", queueRecord(epochFor(member.t), ++sequence, "signal", `${member.task}.status`, reason));
			add(components, "status_files", member.fileSnapshot.join("\n"));
		}
		add(components, "ritual", RITUAL_TEXT);
		wakes++;
		detected += new Set(statusMembers.map((member) => member.task)).size;
		if (statusMembers.length === 0) falseWakes++;
	}
	for (const check of checks) {
		const reason = `check: state/${check.task}.check.sh: ${check.check_out ?? ""}`;
		add(components, "reason", reason);
		add(components, "queue", queueRecord(epochFor(check.t), ++sequence, "check", `state/${check.task}.check.sh`, reason));
		add(components, "ritual", RITUAL_TEXT);
		wakes++;
		detected++;
	}
	for (const stale of detectStaleWakes(scenario.events, scenario.metas)) {
		const reason = `stale: ${stale.pane}`;
		add(components, "reason", reason);
		add(components, "queue", queueRecord(epochFor(0), ++sequence, "stale", stale.pane, reason));
		add(components, "peek", PEEK_40);
		add(components, "ritual", RITUAL_TEXT);
		wakes++;
		falseWakes++;
	}
	return result(scenario, components, wakes, falseWakes, detected, missed);
}

function modelOldAfk(
	scenario: Scenario,
	groups: readonly SignalGroup[],
	checks: readonly FleetEvent[],
	components: Components,
	missed: number,
): SystemResult {
	let sequence = 0;
	const items: { t: number; text: string }[] = [];
	for (const group of groups) {
		for (const member of group.members) {
			if (member.kind !== "status") continue;
			items.push({ t: member.t, text: `${member.task}.status: ${member.fileSnapshot.at(-1) ?? ""}` });
		}
	}
	for (const check of checks) items.push({ t: check.t, text: `check: state/${check.task}.check.sh: ${check.check_out ?? ""}` });
	items.sort((left, right) => left.t - right.t);

	for (const group of groups) {
		const refs = [...new Set(group.members.map((member) => member.kind === "turnend" ? member.pane : `state/${member.task}.status`))];
		const reason = `signal: ${refs.join(" ")}`;
		if (group.members.some((member) => member.kind === "turnend")) add(components, "queue", queueRecord(epochFor(group.startT), ++sequence, "signal", "herdr-turn-end", reason));
		const queuedStatusTasks = new Set<string>();
		for (const member of group.members) {
			if (member.kind !== "status" || queuedStatusTasks.has(member.task)) continue;
			queuedStatusTasks.add(member.task);
			add(components, "queue", queueRecord(epochFor(member.t), ++sequence, "signal", `${member.task}.status`, reason));
		}
	}
	for (const check of checks) {
		const reason = `check: state/${check.task}.check.sh: ${check.check_out ?? ""}`;
		add(components, "queue", queueRecord(epochFor(check.t), ++sequence, "check", `state/${check.task}.check.sh`, reason));
	}
	for (const stale of detectStaleWakes(scenario.events, scenario.metas)) add(components, "queue", queueRecord(epochFor(0), ++sequence, "stale", stale.pane, `stale: ${stale.pane}`));
	if (items.length > 0) add(components, "afk_flush", `Supervisor escalate (${items.length} event(s)): ${items.map((item) => item.text).join(" | ")} (pre-read; watcher daemon-managed)`);
	return result(scenario, components, items.length > 0 ? 1 : 0, 0, items.length, missed);
}
