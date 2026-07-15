#!/usr/bin/env bun
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "./canonical-json";
import { appendCausalEvent, readStudyLedger, type AppendResult } from "./ledger";
import {
	CAUSAL_SCHEMA_VERSION,
	createCausalEvent,
	eventId,
	GENESIS_EVENT_SHA256,
	missing,
	type CausalEvent,
	type EventType,
	type ProducerId,
	type Sha256,
	type StudyId,
} from "./schema";

const WITHHELD_POLICY_REASON = "shell_adapter_payload_withheld";
const ALLOWED_CLOCK_IDS = new Set(["firstmate.shell-causal-adapter/unix-utc-wall/v1"]);
const BODY_DIRECTORY = ".shell-adapter-bodies";
const LOCK_DIRECTORY = ".shell-adapter-locks";
const FORBIDDEN_KEYS = new Set(["directive", "queue", "normalized-summary", "normalized_summary", "normalized summary", "prompt", "prompt-text", "prompt_text", "prompt text"]);
const LOCK_WAIT_MS = 250;
const GENERIC_PAYLOAD_TYPES: Readonly<Record<string, string>> = {
	"task.opened": "task_shape", "episode.opened": "episode", "pre_state.snapshotted": "pre_state",
	"intervention.decided": "intervention", "prompt.prepared": "prompt", "delivery.attempted": "delivery_attempt",
	"delivery.acknowledged": "delivery_acknowledgement", "delivery.pending": "delivery_pending", "delivery.failed": "delivery_failure",
	"session.bound": "session_binding", "lifecycle.transition": "lifecycle", "artifact.registered": "artifact",
	"evidence.recorded": "evidence", "next_action.selected": "next_action", "checkpoint.created": "checkpoint",
	"replay.started": "replay", "replay.completed": "replay", "capture_gap.detected": "capture_gap",
};

export type ShellCausalInput = {
	readonly ledger_directory: string;
	readonly logical_delivery_key: string;
	readonly producer_id: ProducerId;
	readonly study_id: StudyId;
	readonly event_type: EventType;
	readonly emitted_at: { readonly utc_ms: number; readonly clock_id: string };
	readonly observed_at?: { readonly utc_ms: number; readonly clock_id: string };
};

export type ShellAdapterResult = AppendResult & { readonly event_id: string; readonly event_sha256: string };
export class ShellAdapterError extends Error {
	readonly code: string;
	constructor(code: string, message: string) { super(message); this.name = "ShellAdapterError"; this.code = code; }
}

function rejectContent(value: unknown): void {
	if (Array.isArray(value)) { for (const item of value) rejectContent(item); return; }
	if (value === null || typeof value !== "object") return;
	for (const [key, item] of Object.entries(value)) {
		if (FORBIDDEN_KEYS.has(key)) throw new ShellAdapterError("CONTENT_INPUT", "content-bearing input is not permitted");
		rejectContent(item);
	}
}
function requiredString(value: unknown, code: string): string {
	if (typeof value !== "string" || value.length === 0) throw new ShellAdapterError(code, "required string is invalid");
	return value;
}
function safeKey(key: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(key)) throw new ShellAdapterError("INVALID_INPUT", "logical delivery key is invalid");
}
function validateClock(timestamp: { readonly utc_ms: number; readonly clock_id: string }): void {
	if (!Number.isSafeInteger(timestamp.utc_ms) || timestamp.utc_ms < 0) throw new ShellAdapterError("INVALID_INPUT", "timestamp is invalid");
	if (!ALLOWED_CLOCK_IDS.has(timestamp.clock_id)) throw new ShellAdapterError("CONTENT_INPUT", "clock id is not permitted");
}
function acquireLock(path: string): number {
	const started = Date.now();
	for (;;) {
		try { return openSync(path, "wx", 0o600); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started >= LOCK_WAIT_MS) throw new ShellAdapterError("LOCK_TIMEOUT", "adapter lock is unavailable");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}
function durableWrite(path: string, contents: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
	const descriptor = openSync(temporary, "r");
	try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
	renameSync(temporary, path);
}
function buildEvent(input: ShellCausalInput, seq: number, previous: Sha256): CausalEvent {
	const eventType = input.event_type;
	if (!(eventType in GENERIC_PAYLOAD_TYPES)) throw new ShellAdapterError("INVALID_INPUT", "event type is not supported by shell adapter");
	const emitted = input.emitted_at;
	const observed = input.observed_at ?? emitted;
	return createCausalEvent({
		schema_version: CAUSAL_SCHEMA_VERSION,
		event_id: eventId(input.producer_id, seq),
		producer: { producer_id: input.producer_id, producer_seq: seq, previous_event_sha256: previous },
		event_type: eventType, study_id: input.study_id,
		time: { emitted_at: emitted, observed_at: observed, source_occurred_at: missing("source_did_not_supply") },
		source: { component: "firstmate.shell-causal-adapter", component_path: "causal/v1/shell-adapter.ts", component_revision: "foundation-v1", capture_mode: "derived", source_event_ref: missing("invalid_source") },
		lineage: {
			task_id: missing("not_yet_bound"), episode_id: missing("not_yet_bound"), root_task_id: missing("not_yet_bound"),
			parent_task_id: missing("not_applicable"), parent_episode_id: missing("not_applicable"), parent_event_id: missing("not_applicable"),
			supervisor_id: missing("not_yet_bound"), target_agent_id: missing("not_yet_bound"),
			session_id: missing("not_yet_bound"), pane_id: missing("not_yet_bound"), workspace_id: missing("not_yet_bound"), process_id: missing("not_yet_bound"),
		},
		payload: { type: GENERIC_PAYLOAD_TYPES[eventType] as never, payload_ref: { mode: "withheld", state: "privacy_withheld", policy_reason: WITHHELD_POLICY_REASON } },
	});
}


export function appendShellCausalEvent(input: ShellCausalInput): ShellAdapterResult {
	rejectContent(input);
	if (!input || typeof input !== "object") throw new ShellAdapterError("INVALID_INPUT", "input must be an object");
	const ledgerDirectory = requiredString(input.ledger_directory, "INVALID_INPUT");
	validateClock(input.emitted_at);
	if (input.observed_at !== undefined) validateClock(input.observed_at);
	const key = requiredString(input.logical_delivery_key, "INVALID_INPUT"); safeKey(key);
	mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
	const lockKey = sha256Hex(input.study_id);
	const lockPath = join(ledgerDirectory, LOCK_DIRECTORY, `${lockKey}.lock`);
	mkdirSync(join(ledgerDirectory, LOCK_DIRECTORY), { recursive: true, mode: 0o700 });
	const descriptor = acquireLock(lockPath);
	try {
		const bodyPath = join(ledgerDirectory, BODY_DIRECTORY, `${sha256Hex(`${input.study_id}\0${input.producer_id}\0${key}`)}.json`);
		mkdirSync(join(ledgerDirectory, BODY_DIRECTORY), { recursive: true, mode: 0o700 });
		let event: CausalEvent;
		let disposition: "appended" | "idempotent";
		if (existsSync(bodyPath)) {
			event = JSON.parse(readFileSync(bodyPath, "utf8")) as CausalEvent;
			const result = appendCausalEvent(ledgerDirectory, event);
			return Object.freeze({ ...result, event_id: event.event_id, event_sha256: event.event_sha256 });
		}
		const ledger = readStudyLedger(ledgerDirectory, input.study_id);
		const prior = ledger.watermarks.find((item) => item.producer_id === input.producer_id);
		event = buildEvent(input, (prior?.producer_seq ?? 0) + 1, prior?.event_sha256 ?? GENESIS_EVENT_SHA256 as Sha256);
		durableWrite(bodyPath, `${canonicalJson(event)}\n`);
		const result = appendCausalEvent(ledgerDirectory, event);
		disposition = result.disposition;
		return Object.freeze({ ...result, disposition, event_id: event.event_id, event_sha256: event.event_sha256 });
	} finally { closeSync(descriptor); unlinkSync(lockPath); }
}

async function main(): Promise<void> {
	let input = "";
	for await (const line of createInterface({ input: process.stdin })) input += line;
	try {
		const parsed = JSON.parse(input) as ShellCausalInput;
		process.stdout.write(`${JSON.stringify({ ok: true, result: appendShellCausalEvent(parsed) })}\n`);
	} catch (error) {
		const code = error instanceof ShellAdapterError ? error.code : "LEDGER_FAILURE";
		process.stderr.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
		process.exitCode = 1;
	}
}
if (import.meta.main) await main();
