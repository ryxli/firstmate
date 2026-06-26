// OLD system model: replay a scenario through the current bash supervision
// stack (fm-watch.sh + fm-wake-lib.sh + fm-supervise-daemon.sh) and compute the
// per-wake LLM-facing ingestion cost the protocol mandates.
//
// Faithfulness notes (all keyed to bin/):
// - relevance uses the SAME regex as bin/fm-classify-status.sh (relevance.ts).
// - a herdr working->idle is an UNCONDITIONAL turn-end wake (fm-watch.sh always
//   `wake "signal:..."` on the transition), even with no captain-relevant status
//   -> a false wake.
// - relevant status writes coalesce with a turn-end inside the signal grace
//   window into ONE wake; the agent then reads the FULL status file(s) listed.
// - herdr ->blocked/->done are NOT woken on by fm-watch.sh's herdr scan (only
//   working->idle and idle-staleness are handled), so a bare herdr block/done
//   with no status line is MISSED by OLD (missed_relevant).
// - stale wakes cost a 40-line pane peek; secondmate + parked-on-green-PR panes
//   are skipped (fm-watch.sh awaiting_merge / kind=secondmate).
// - every wake-handling turn pays the drain -> re-arm ceremony (RITUAL_TEXT);
//   afk turns instead pay the daemon's batched flush + the still-mandatory
//   queue-drain backstop, and skip re-arm (daemon-managed).

import { canonicalRelevant, statusIsCaptainRelevant } from "./relevance.ts";
import {
	PEEK_40,
	RITUAL_TEXT,
	detectStaleWakes,
	epochFor,
	queueRecord,
} from "./model-lib.ts";
import { countTokens } from "./tokenizer.ts";
import type { FleetEvent, Metrics, Scenario } from "./types.ts";

const GRACE_MS = 30000;

export type Components = Record<string, number>;

export type SystemResult = { metrics: Metrics; components: Components };

type StatusTrigger = { t: number; task: string; pane: string; fileSnapshot: string[] };
type SignalTrigger =
	| { kind: "turnend"; t: number; pane: string }
	| { kind: "status"; t: number; task: string; pane: string; fileSnapshot: string[] };

// A coalesced signal-class wake group (turn-ends + relevant status writes).
type SignalGroup = { startT: number; members: SignalTrigger[] };

function add(components: Components, key: string, tokens: number): void {
	components[key] = (components[key] ?? 0) + tokens;
}

export function modelOld(scenario: Scenario): SystemResult {
	const components: Components = {};
	let wakes = 0;
	let falseWakes = 0;
	let detected = 0;
	let missed = 0;

	// --- single pass: build status-file history + collect triggers -----------
	const history = new Map<string, string[]>();
	const signalTriggers: SignalTrigger[] = [];
	const checkTriggers: FleetEvent[] = [];
	for (const e of scenario.events) {
		if (e.kind === "status") {
			const lines = history.get(e.task) ?? [];
			if (e.status_line) lines.push(e.status_line);
			history.set(e.task, lines);
			if (statusIsCaptainRelevant(e.status_line)) {
				signalTriggers.push({
					kind: "status",
					t: e.t,
					task: e.task,
					pane: e.pane,
					fileSnapshot: [...lines],
				});
			}
		} else if (e.kind === "herdr" && e.herdr_from === "working" && e.herdr_to === "idle") {
			signalTriggers.push({ kind: "turnend", t: e.t, pane: e.pane });
		} else if (e.kind === "herdr" && (e.herdr_to === "blocked" || e.herdr_to === "done")) {
			// fm-watch.sh's herdr scan never wakes on a bare block/done transition.
			missed += 1;
		} else if (e.kind === "check" && (e.check_out ?? "").length > 0) {
			checkTriggers.push(e);
		}
	}

	// --- coalesce signal-class triggers within the grace window --------------
	const groups: SignalGroup[] = [];
	let open: SignalGroup | undefined;
	for (const tr of signalTriggers) {
		if (!open || tr.t - open.startT > GRACE_MS) {
			open = { startT: tr.t, members: [tr] };
			groups.push(open);
		} else {
			open.members.push(tr);
		}
	}

	// AFK path: the daemon self-handles routine wakes and escalates ONE batched
	// flush; the supervisor turn still drains the durable queue (lossless
	// backstop) and skips re-arm. Model that single escalation.
	if (scenario.afk) {
		return modelOldAfk(scenario, groups, checkTriggers, components, missed);
	}

	let seq = 0;
	const nextSeq = (): number => (seq += 1);

	// --- signal-class wakes (one supervisor turn per group) ------------------
	for (const g of groups) {
		const statusMembers = g.members.filter(
			(m): m is Extract<SignalTrigger, { kind: "status" }> => m.kind === "status",
		);
		const hasTurnEnd = g.members.some((m) => m.kind === "turnend");

		// reason line: `signal: <panes/files in t order, de-duped>`
		const seenRef = new Set<string>();
		const refs: string[] = [];
		for (const m of g.members) {
			const ref = m.kind === "turnend" ? m.pane : `state/${m.task}.status`;
			if (seenRef.has(ref)) continue;
			seenRef.add(ref);
			refs.push(ref);
		}
		const reason = `signal: ${refs.join(" ")}`;
		add(components, "reason", countTokens(reason));

		// drained queue records: one per distinct (kind,key), payload = reason.
		if (hasTurnEnd) {
			add(components, "queue", countTokens(queueRecord(epochFor(g.startT), nextSeq(), "signal", "herdr-turn-end", reason)));
		}
		const seenTask = new Set<string>();
		for (const m of statusMembers) {
			if (seenTask.has(m.task)) continue;
			seenTask.add(m.task);
			add(components, "queue", countTokens(queueRecord(epochFor(m.t), nextSeq(), "signal", `${m.task}.status`, reason)));
		}

		// FULL status file content for each distinct listed status file.
		const filesSeen = new Set<string>();
		for (const m of statusMembers) {
			if (filesSeen.has(m.task)) continue;
			filesSeen.add(m.task);
			add(components, "status_files", countTokens(m.fileSnapshot.join("\n")));
		}

		// re-arm ceremony, once per wake.
		add(components, "ritual", countTokens(RITUAL_TEXT));

		wakes += 1;
		detected += seenTask.size; // distinct relevant status events surfaced
		if (statusMembers.length === 0) falseWakes += 1; // pure turn-end => false
	}

	// --- check wakes (standalone; output rides in the reason line) -----------
	for (const c of checkTriggers) {
		const reason = `check: state/${c.task}.check.sh: ${c.check_out ?? ""}`;
		add(components, "reason", countTokens(reason));
		add(components, "queue", countTokens(queueRecord(epochFor(c.t), nextSeq(), "check", `state/${c.task}.check.sh`, reason)));
		add(components, "ritual", countTokens(RITUAL_TEXT));
		wakes += 1;
		detected += 1;
	}

	// --- stale wakes (standalone; pay the 40-line peek) ----------------------
	const staleWakes = detectStaleWakes(scenario.events, scenario.metas);
	for (const s of staleWakes) {
		const reason = `stale: ${s.pane}`;
		add(components, "reason", countTokens(reason));
		add(components, "queue", countTokens(queueRecord(epochFor(0), nextSeq(), "stale", s.pane, reason)));
		add(components, "peek", countTokens(PEEK_40));
		add(components, "ritual", countTokens(RITUAL_TEXT));
		wakes += 1;
		falseWakes += 1; // triggered by a non-relevant idle->idle (mechanical false)
	}

	const interface_tokens = Object.values(components).reduce((a, b) => a + b, 0);
	return {
		metrics: {
			system: "old",
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

// AFK daemon model: single batched escalation + the mandated queue-drain
// backstop, no re-arm. Escalated events = relevant status writes + checks (the
// daemon never sees bare herdr block/done, so those stay missed).
function modelOldAfk(
	scenario: Scenario,
	groups: SignalGroup[],
	checkTriggers: FleetEvent[],
	components: Components,
	missed: number,
): SystemResult {
	let seq = 0;
	const nextSeq = (): number => (seq += 1);

	// Distilled escalation items (one per relevant event), in t order.
	const items: { t: number; text: string }[] = [];
	let detected = 0;
	for (const g of groups) {
		for (const m of g.members) {
			if (m.kind !== "status") continue;
			const last = m.fileSnapshot[m.fileSnapshot.length - 1] ?? "";
			items.push({ t: m.t, text: `${m.task}.status: ${last}` });
			detected += 1;
		}
	}
	for (const c of checkTriggers) {
		items.push({ t: c.t, text: `check: state/${c.task}.check.sh: ${c.check_out ?? ""}` });
		detected += 1;
	}
	items.sort((a, b) => a.t - b.t);

	// drained queue records still accrue for EVERY watcher wake (turn-ends,
	// relevant signals, checks, stale) - the daemon's child watcher appended them.
	const staleWakes = detectStaleWakes(scenario.events, scenario.metas);
	for (const g of groups) {
		const reason = `signal: ${g.members
			.map((m) => (m.kind === "turnend" ? m.pane : `state/${m.task}.status`))
			.filter((v, i, arr) => arr.indexOf(v) === i)
			.join(" ")}`;
		if (g.members.some((m) => m.kind === "turnend")) {
			add(components, "queue", countTokens(queueRecord(epochFor(g.startT), nextSeq(), "signal", "herdr-turn-end", reason)));
		}
		const seenTask = new Set<string>();
		for (const m of g.members) {
			if (m.kind !== "status" || seenTask.has(m.task)) continue;
			seenTask.add(m.task);
			add(components, "queue", countTokens(queueRecord(epochFor(m.t), nextSeq(), "signal", `${m.task}.status`, reason)));
		}
	}
	for (const c of checkTriggers) {
		const reason = `check: state/${c.task}.check.sh: ${c.check_out ?? ""}`;
		add(components, "queue", countTokens(queueRecord(epochFor(c.t), nextSeq(), "check", `state/${c.task}.check.sh`, reason)));
	}
	for (const s of staleWakes) {
		add(components, "queue", countTokens(queueRecord(epochFor(0), nextSeq(), "stale", s.pane, `stale: ${s.pane}`)));
	}

	let wakes = 0;
	if (items.length > 0) {
		const flush = `Supervisor escalate (${items.length} event(s)): ${items
			.map((i) => i.text)
			.join(" | ")} (pre-read; re-arm not needed - watcher daemon-managed)`;
		add(components, "afk_flush", countTokens(flush));
		wakes = 1;
	}

	const interface_tokens = Object.values(components).reduce((a, b) => a + b, 0);
	return {
		metrics: {
			system: "old",
			scenario: scenario.name,
			wakes,
			interface_tokens,
			false_wakes: 0, // the daemon escalates only relevant content
			detected_relevant: detected,
			missed_relevant: missed,
		},
		components,
	};
}
