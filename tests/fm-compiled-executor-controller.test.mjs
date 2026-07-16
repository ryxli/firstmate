#!/usr/bin/env bun
// Deterministic tests for the compiled-executor deadline controller.
//
// These exercise the real controller class against a fake bus, a fake
// ExtensionAsyncJobControl that mirrors OMP's discriminated cancel semantics,
// and an injected clock + timer registry so every case is deterministic with no
// wall-clock waits and no polling.

import { test, expect } from "bun:test";
import {
	CompiledExecutorController,
	parseCompiledContract,
	COMPILED_EXECUTOR_AGENT,
	RECLAIM_MESSAGE_TYPE,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../.omp/extensions/fm-compiled-executor-controller.ts";

const CLOCK_START = 1_000_000;

function makeHarness() {
	let clock = CLOCK_START;
	const jobs = new Map();
	const sent = [];
	const timers = new Map();
	let timerSeq = 0;

	const asyncJobs = {
		inspect(jobId) {
			const job = jobs.get(jobId);
			return job ? { ...job } : null;
		},
		cancel(jobId) {
			const job = jobs.get(jobId);
			if (!job) return { cancelled: false, reason: "not-found" };
			if (job.status !== "running") return { cancelled: false, reason: "not-running", job: { ...job } };
			job.status = "cancelled";
			return { cancelled: true, job: { ...job } };
		},
	};

	const handlers = new Map();
	const bus = {
		on(channel, handler) {
			let set = handlers.get(channel);
			if (!set) {
				set = new Set();
				handlers.set(channel, set);
			}
			set.add(handler);
			return () => handlers.get(channel)?.delete(handler);
		},
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};

	const controller = new CompiledExecutorController({
		now: () => clock,
		setTimer: (callback, ms) => {
			const id = ++timerSeq;
			timers.set(id, { callback, ms, cleared: false });
			return id;
		},
		clearTimer: id => {
			const timer = timers.get(id);
			if (timer) timer.cleared = true;
		},
	});
	controller.bind({ asyncJobs, sendMessage: (message, options) => sent.push({ message, options }) });
	controller.subscribe(bus);

	return {
		controller,
		bus,
		jobs,
		sent,
		timers,
		setClock: value => {
			clock = value;
		},
		registerJob: (id, status = "running") =>
			jobs.set(id, { id, type: "task", status, label: id, startTime: clock }),
		liveTimers: () => [...timers.values()].filter(timer => !timer.cleared),
		fireTimer: id => {
			const timer = timers.get(id);
			if (timer && !timer.cleared) timer.callback();
		},
	};
}

function futureIso(offsetMs = 5_000) {
	return new Date(CLOCK_START + offsetMs).toISOString();
}

function assignment(actionId, deadline) {
	return `action_id: ${actionId}\ndeadline: ${deadline}\nordered operations:\n1. op-a read foo\n`;
}

function toolCall(input, toolCallId = "tc1") {
	return { type: "tool_call", toolCallId, toolName: "task", input };
}

function lifecycle(overrides) {
	return {
		id: "job-1",
		agent: COMPILED_EXECUTOR_AGENT,
		agentSource: "project",
		status: "started",
		parentToolCallId: "tc1",
		index: 0,
		detached: true,
		...overrides,
	};
}

function progress(overrides) {
	const { id = "job-1", parentToolCallId = "tc1", index = 0, detached = true, agent = COMPILED_EXECUTOR_AGENT } =
		overrides ?? {};
	return { index, agent, agentSource: "project", task: "t", parentToolCallId, detached, progress: { id } };
}

// --------------------------------------------------------------------------

test("parseCompiledContract: valid header parses id + absolute deadline", () => {
	const iso = futureIso(5_000);
	const parsed = parseCompiledContract("act-1", assignment("A-1", iso), CLOCK_START);
	expect(parsed.ok).toBe(true);
	expect(parsed.contract.actionId).toBe("A-1");
	expect(parsed.contract.deadlineRaw).toBe(iso);
	expect(parsed.contract.deadlineMs).toBe(Date.parse(iso));
});

test("parseCompiledContract: fail closed on unnamed / missing / malformed / expired", () => {
	const iso = futureIso(5_000);
	expect(parseCompiledContract("", assignment("A", iso), CLOCK_START)).toMatchObject({
		ok: false,
		failure: "unnamed-spawn",
	});
	expect(parseCompiledContract("n", `deadline: ${iso}\n`, CLOCK_START)).toMatchObject({
		ok: false,
		failure: "missing-action-id",
	});
	expect(parseCompiledContract("n", "action_id: A\n", CLOCK_START)).toMatchObject({
		ok: false,
		failure: "missing-deadline",
	});
	// Relative offset, local time, and zone offset are all malformed (one canonical UTC syntax).
	expect(parseCompiledContract("n", assignment("A", "+5m"), CLOCK_START)).toMatchObject({
		ok: false,
		failure: "malformed-deadline",
	});
	expect(parseCompiledContract("n", assignment("A", "2026-07-15T04:05:06"), CLOCK_START)).toMatchObject({
		ok: false,
		failure: "malformed-deadline",
	});
	expect(parseCompiledContract("n", assignment("A", "2026-07-15T04:05:06+00:00"), CLOCK_START)).toMatchObject({
		ok: false,
		failure: "malformed-deadline",
	});
	const past = new Date(CLOCK_START - 1).toISOString();
	expect(parseCompiledContract("n", assignment("A", past), CLOCK_START)).toMatchObject({
		ok: false,
		failure: "expired-deadline",
	});
	// Millisecond fraction is accepted.
	const withMs = "2099-01-02T03:04:05.250Z";
	expect(parseCompiledContract("n", assignment("A", withMs), CLOCK_START).ok).toBe(true);
});

test("registration: valid preflight caches contract; started arms one timer at the deadline delay", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	expect(h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }))).toBeUndefined();
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	const live = h.liveTimers();
	expect(live.length).toBe(1);
	expect(live[0].ms).toBe(5_000);
	expect(h.sent.length).toBe(0);
});

test("completion before deadline: terminal lifecycle clears the timer and emits nothing", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	const [timer] = [...h.timers.entries()][0];
	// Completion wins: mark the job done and deliver the terminal lifecycle.
	h.jobs.get("job-1").status = "completed";
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "completed" }));
	expect(h.liveTimers().length).toBe(0);
	// Even a stray timer fire after cleanup must not emit.
	h.fireTimer(timer);
	expect(h.sent.length).toBe(0);
});

test("deadline cancellation: running job is canceled and exactly one reclaim event is delivered", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	const [timer] = [...h.timers.entries()][0];
	h.setClock(CLOCK_START + 5_000);
	h.fireTimer(timer);

	expect(h.sent.length).toBe(1);
	const { message, options } = h.sent[0];
	expect(message.customType).toBe(RECLAIM_MESSAGE_TYPE);
	expect(message.details).toMatchObject({
		kind: RECLAIM_MESSAGE_TYPE,
		jobId: "job-1",
		actionId: "A-1",
		deadline: iso,
		reason: "deadline-exceeded",
		cancellation: { cancelled: true, jobStatus: "cancelled" },
	});
	expect(options).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
	expect(h.jobs.get("job-1").status).toBe("cancelled");
});

test("exactly-once: a second timer fire and a late terminal lifecycle do not double-deliver", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	const [timer] = [...h.timers.entries()][0];
	h.fireTimer(timer);
	h.fireTimer(timer); // second fire: entry already claimed
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "aborted" })); // late terminal
	expect(h.sent.length).toBe(1);
});

test("race: completion wins at the deadline (job no longer running) -> no reclaim", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1", "completed"); // already terminal when the timer fires
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	const [timer] = [...h.timers.entries()][0];
	h.fireTimer(timer);
	expect(h.sent.length).toBe(0);
});

test("malformed deadline fail-closed: preflight blocks the whole task call", () => {
	const h = makeHarness();
	const blocked = h.controller.reviewToolCall(
		toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", "+5m") }),
	);
	expect(blocked).toMatchObject({ block: true });
	expect(blocked.reason).toContain("ISO-8601 UTC");
	// Nothing cached: a subsequent started for this coordinate fails closed (no timer, immediate reclaim).
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	expect(h.liveTimers().length).toBe(0);
	expect(h.sent.length).toBe(1);
	expect(h.sent[0].message.details.reason).toBe("uncompiled-contract");
	expect(h.jobs.get("job-1").status).toBe("cancelled");
});

test("fail-closed: unnamed and missing-action-id and expired are each rejected at preflight", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	expect(h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, assignment: assignment("A", iso) }))).toMatchObject({ block: true });
	expect(h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "n", assignment: `deadline: ${iso}\n` }))).toMatchObject({ block: true });
	const past = new Date(CLOCK_START - 1).toISOString();
	expect(h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "n", assignment: assignment("A", past) }))).toMatchObject({ block: true });
});

test("unrelated-agent exclusion: other agents are ignored at preflight and on the bus", () => {
	const h = makeHarness();
	// A task-tool call for a different agent is not gated.
	expect(h.controller.reviewToolCall(toolCall({ agent: "task", id: "x", assignment: "do work" }))).toBeUndefined();
	// Lifecycle/progress for a non-compiled-executor agent are ignored.
	h.registerJob("job-9");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "job-9", agent: "task", status: "started" }));
	h.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress({ id: "job-9", agent: "task" }));
	expect(h.liveTimers().length).toBe(0);
	expect(h.sent.length).toBe(0);
	// A non-detached compiled-executor (sync spawn) is ignored too.
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "job-9", detached: false, status: "started" }));
	expect(h.liveTimers().length).toBe(0);
});

test("duplicate progress: repeated progress arms exactly one timer", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress({}));
	h.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress({}));
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" })); // corroboration, still one
	expect(h.timers.size).toBe(1);
	expect(h.liveTimers().length).toBe(1);
});

test("progress fallback: progress alone arms when lifecycle started is missed", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress({}));
	expect(h.liveTimers().length).toBe(1);
});

test("batch form: each item's contract is correlated by ${toolCallId}:${index}", () => {
	const h = makeHarness();
	const isoA = futureIso(3_000);
	const isoB = futureIso(9_000);
	const blocked = h.controller.reviewToolCall(
		toolCall({
			agent: COMPILED_EXECUTOR_AGENT,
			context: "shared context",
			tasks: [
				{ id: "a", assignment: assignment("A-a", isoA) },
				{ id: "b", assignment: assignment("A-b", isoB) },
			],
		}),
	);
	expect(blocked).toBeUndefined();
	h.registerJob("job-b");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "job-b", parentToolCallId: "tc1", index: 1, status: "started" }));
	const live = h.liveTimers();
	expect(live.length).toBe(1);
	expect(live[0].ms).toBe(9_000);
	const [timer] = [...h.timers.entries()][0];
	h.fireTimer(timer);
	expect(h.sent[0].message.details.actionId).toBe("A-b");
});

test("cleanup: terminal lifecycle clears the entry+timer; reset clears everything", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-1", assignment: assignment("A-1", iso) }));
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	expect(h.liveTimers().length).toBe(1);
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "failed" }));
	expect(h.liveTimers().length).toBe(0);

	// A fresh armed action, then reset(), leaves no live timers.
	h.controller.reviewToolCall(toolCall({ agent: COMPILED_EXECUTOR_AGENT, id: "act-2", assignment: assignment("A-2", iso) }, "tc2"));
	h.registerJob("job-2");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ id: "job-2", parentToolCallId: "tc2", status: "started" }));
	expect(h.liveTimers().length).toBe(1);
	h.controller.reset();
	expect(h.liveTimers().length).toBe(0);
});

// Regression: the installed OMP task schema is per-item `{ name, agent, task }`
// (batch items carry their OWN agent; no top-level agent), distinct from the
// `{ id, assignment }` + top-level-agent shape. The controller must gate + arm
// compiled-executor spawns under the installed shape too. These fail on a
// controller that only reads top-level `input.agent` and `item.id`/`assignment`.
test("installed batch shape {name, agent, task} per item is gated and armed", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	const blocked = h.controller.reviewToolCall({
		type: "tool_call",
		toolCallId: "tc1",
		toolName: "task",
		input: {
			context: "shared context",
			tasks: [{ name: "act-1", agent: COMPILED_EXECUTOR_AGENT, task: assignment("A-1", iso) }],
		},
	});
	expect(blocked).toBeUndefined();
	h.registerJob("job-1");
	h.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle({ status: "started" }));
	// Armed with the real deadline (not the fail-closed immediate reclaim the old
	// code produced because it never saw the compiled-executor item).
	expect(h.liveTimers().length).toBe(1);
	expect(h.liveTimers()[0].ms).toBe(5_000);
	expect(h.sent.length).toBe(0);
});

test("installed flat shape {name, agent, task} is gated (valid passes, malformed blocks)", () => {
	const h = makeHarness();
	const iso = futureIso(5_000);
	expect(
		h.controller.reviewToolCall({
			type: "tool_call",
			toolCallId: "tcF",
			toolName: "task",
			input: { agent: COMPILED_EXECUTOR_AGENT, name: "act-1", task: assignment("A-1", iso) },
		}),
	).toBeUndefined();
	expect(
		h.controller.reviewToolCall({
			type: "tool_call",
			toolCallId: "tcG",
			toolName: "task",
			input: { agent: COMPILED_EXECUTOR_AGENT, name: "act-2", task: assignment("A-2", "+5m") },
		}),
	).toMatchObject({ block: true });
});

test("installed batch shape: a malformed item still fails closed (blocks the call)", () => {
	const h = makeHarness();
	const blocked = h.controller.reviewToolCall({
		type: "tool_call",
		toolCallId: "tcH",
		toolName: "task",
		input: { context: "c", tasks: [{ name: "a", agent: COMPILED_EXECUTOR_AGENT, task: "action_id: A\n" }] },
	});
	expect(blocked).toMatchObject({ block: true });
});
