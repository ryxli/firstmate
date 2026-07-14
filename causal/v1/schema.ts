import { randomUUID } from "node:crypto";
import { canonicalSha256 } from "./canonical-json";

export const CAUSAL_SCHEMA_VERSION = "causal-event/v1" as const;
export const GENESIS_EVENT_SHA256 = "0".repeat(64);

export type OpaqueId<Prefix extends string> = string & { readonly __opaquePrefix: Prefix };
export type StudyId = OpaqueId<"study_">;
export type ProducerId = OpaqueId<"producer_">;
export type TaskId = OpaqueId<"task_">;
export type EpisodeId = OpaqueId<"episode_">;
export type SupervisorId = OpaqueId<"supervisor_">;
export type AgentId = OpaqueId<"agent_">;
export type EventId = OpaqueId<"ce1:">;
export type PayloadId = OpaqueId<"payload_">;
export type Sha256 = string & { readonly __sha256: true };

export const MISSINGNESS_STATES = [
	"not_applicable",
	"not_yet_bound",
	"source_did_not_supply",
	"source_unavailable",
	"not_emitted",
	"privacy_withheld",
	"invalid_source",
	"unjoinable_identity",
	"legacy_unknown",
	"conflicting_sources",
] as const;
export type MissingnessState = (typeof MISSINGNESS_STATES)[number];
export type Tagged<T> = { readonly value: T } | { readonly state: MissingnessState };

export const EVENT_TYPES = [
	"task.opened",
	"episode.opened",
	"pre_state.snapshotted",
	"intervention.decided",
	"prompt.prepared",
	"delivery.attempted",
	"delivery.acknowledged",
	"delivery.pending",
	"delivery.failed",
	"session.bound",
	"lifecycle.transition",
	"artifact.registered",
	"evidence.recorded",
	"acceptance.decided",
	"outcome.closed",
	"next_action.selected",
	"checkpoint.created",
	"replay.started",
	"replay.completed",
	"capture_gap.detected",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const CAPTURE_MODES = ["native", "derived", "manual", "reconciled", "imported", "replay"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type ClockTimestamp = {
	readonly utc_ms: number;
	readonly clock_id: string;
};

export type PayloadReference =
	| {
			readonly mode: "metadata_only";
			readonly reference: PayloadId;
			readonly fingerprint: `hmac-sha256:${string}`;
			readonly redaction_policy: string;
			readonly byte_count?: number;
		}
	| {
			readonly mode: "sealed_local_ref";
			readonly reference: PayloadId;
			readonly access_policy: string;
			readonly expires_at: ClockTimestamp;
		}
	| {
			readonly mode: "withheld";
			readonly state: "privacy_withheld";
			readonly policy_reason: string;
		};

export type CausalPayload = {
	readonly type: string;
	readonly payload_ref: PayloadReference;
};

export type CausalEventBody = {
	readonly schema_version: typeof CAUSAL_SCHEMA_VERSION;
	readonly event_id: EventId;
	readonly producer: {
		readonly producer_id: ProducerId;
		readonly producer_seq: number;
		readonly previous_event_sha256: Sha256;
	};
	readonly event_type: EventType;
	readonly study_id: StudyId;
	readonly time: {
		readonly emitted_at: ClockTimestamp;
		readonly observed_at: ClockTimestamp;
		readonly source_occurred_at: Tagged<ClockTimestamp>;
	};
	readonly source: {
		readonly component: string;
		readonly component_path: string;
		readonly component_revision: string;
		readonly capture_mode: CaptureMode;
		readonly source_event_ref: Tagged<string>;
	};
	readonly lineage: {
		readonly task_id: Tagged<TaskId>;
		readonly episode_id: Tagged<EpisodeId>;
		readonly root_task_id: Tagged<TaskId>;
		readonly parent_task_id: Tagged<TaskId>;
		readonly parent_episode_id: Tagged<EpisodeId>;
		readonly parent_event_id: Tagged<EventId>;
		readonly supervisor_id: Tagged<SupervisorId>;
		readonly target_agent_id: Tagged<AgentId>;
		readonly session_id: Tagged<OpaqueId<"session_">>;
		readonly pane_id: Tagged<OpaqueId<"pane_">>;
		readonly workspace_id: Tagged<OpaqueId<"workspace_">>;
		readonly process_id: Tagged<OpaqueId<"process_">>;
		readonly display_metadata?: Readonly<Record<string, string>>;
	};
	readonly payload: CausalPayload;
};

export type CausalEvent = CausalEventBody & { readonly event_sha256: Sha256 };
export type UnsignedCausalEvent = CausalEventBody;

export class CausalSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CausalSchemaError";
	}
}

const payloadTypes: Readonly<Record<EventType, string>> = {
	"task.opened": "task_shape",
	"episode.opened": "episode",
	"pre_state.snapshotted": "pre_state",
	"intervention.decided": "intervention",
	"prompt.prepared": "prompt",
	"delivery.attempted": "delivery_attempt",
	"delivery.acknowledged": "delivery_acknowledgement",
	"delivery.pending": "delivery_pending",
	"delivery.failed": "delivery_failure",
	"session.bound": "session_binding",
	"lifecycle.transition": "lifecycle",
	"artifact.registered": "artifact",
	"evidence.recorded": "evidence",
	"acceptance.decided": "acceptance",
	"outcome.closed": "outcome",
	"next_action.selected": "next_action",
	"checkpoint.created": "checkpoint",
	"replay.started": "replay",
	"replay.completed": "replay",
	"capture_gap.detected": "capture_gap",
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4OpaqueId<Prefix extends string>(value: unknown, prefix: Prefix): value is OpaqueId<Prefix> {
	return typeof value === "string" && value.startsWith(prefix) && UUID_V4.test(value.slice(prefix.length));
}

function assertUuidV4OpaqueId<Prefix extends string>(value: unknown, prefix: Prefix, path: string): asserts value is OpaqueId<Prefix> {
	if (!isUuidV4OpaqueId(value, prefix)) throw new CausalSchemaError(`${path} must be a ${prefix} UUIDv4 opaque id`);
}

function assertEventIdentifier(value: unknown, path: string): void {
	assertNonEmptyString(value, path);
	const match = /^ce1:(producer_[0-9a-f-]+):([1-9]\d*)$/.exec(value);
	if (match === null) throw new CausalSchemaError(`${path} must be a ce1 producer event id`);
	assertUuidV4OpaqueId(match[1], "producer_", `${path}.producer_id`);
	const sequence = Number(match[2]);
	if (!Number.isSafeInteger(sequence) || sequence < 1) {
		throw new CausalSchemaError(`${path}.sequence must be a positive safe integer`);
	}
}

function mintUuidV4OpaqueId<Prefix extends string>(prefix: Prefix): OpaqueId<Prefix> {
	return `${prefix}${randomUUID()}` as OpaqueId<Prefix>;
}

export function mintStudyId(): StudyId {
	return mintUuidV4OpaqueId("study_");
}

export function mintProducerId(): ProducerId {
	return mintUuidV4OpaqueId("producer_");
}

export function mintTaskId(): TaskId {
	return mintUuidV4OpaqueId("task_");
}

export function mintEpisodeId(): EpisodeId {
	return mintUuidV4OpaqueId("episode_");
}

export function mintSupervisorId(): SupervisorId {
	return mintUuidV4OpaqueId("supervisor_");
}

export function mintAgentId(): AgentId {
	return mintUuidV4OpaqueId("agent_");
}

export function mintPayloadId(): PayloadId {
	return mintUuidV4OpaqueId("payload_");
}

export function present<T>(value: T): Tagged<T> {
	return { value };
}

export function missing<T>(state: MissingnessState): Tagged<T> {
	return { state };
}

export function eventId(producerId: ProducerId, producerSeq: number): EventId {
	assertUuidV4OpaqueId(producerId, "producer_", "producer_id");
	if (!Number.isSafeInteger(producerSeq) || producerSeq < 1) {
		throw new CausalSchemaError("producer_seq must be a positive safe integer");
	}
	return `ce1:${producerId}:${producerSeq}` as EventId;
}

export type CausalEventDraft = UnsignedCausalEvent & { readonly event_sha256?: Sha256 };

export function causalEventHash(event: UnsignedCausalEvent): Sha256 {
	return canonicalSha256(event) as Sha256;
}

export function createCausalEvent(event: CausalEventDraft): CausalEvent {
	const { event_sha256: discardedHash, ...body } = event;
	const completed = { ...body, event_sha256: causalEventHash(body) } as CausalEvent;
	assertCausalEvent(completed);
	void discardedHash;
	return completed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new CausalSchemaError(`${path}.${key} is not permitted`);
	}
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new CausalSchemaError(`${path} must be a non-empty string`);
}

type PresentValueValidator = (value: unknown, path: string) => void;

function assertTagged(value: unknown, path: string, assertPresentValue: PresentValueValidator): void {
	if (!isRecord(value)) throw new CausalSchemaError(`${path} must be a tagged value`);
	assertExactKeys(value, ["value", "state"], path);
	const hasValue = Object.hasOwn(value, "value");
	const hasState = Object.hasOwn(value, "state");
	if (hasValue === hasState) throw new CausalSchemaError(`${path} must contain exactly one of value or state`);
	if (hasState && (typeof value.state !== "string" || !MISSINGNESS_STATES.includes(value.state as MissingnessState))) {
		throw new CausalSchemaError(`${path}.state is not an allowed missingness state`);
	}
	if (hasValue) assertPresentValue(value.value, `${path}.value`);
}

function assertClockTimestamp(value: unknown, path: string): void {
	if (!isRecord(value)) throw new CausalSchemaError(`${path} must be an object`);
	assertExactKeys(value, ["utc_ms", "clock_id"], path);
	if (!Number.isSafeInteger(value.utc_ms)) throw new CausalSchemaError(`${path}.utc_ms must be a safe integer`);
	assertNonEmptyString(value.clock_id, `${path}.clock_id`);
}

function assertPrefixedBindingId(value: unknown, prefix: string, path: string): void {
	assertNonEmptyString(value, path);
	if (!value.startsWith(prefix)) throw new CausalSchemaError(`${path} must start with ${prefix}`);
	if (value.length === prefix.length) throw new CausalSchemaError(`${path} must have a non-empty suffix after ${prefix}`);
}

const LINEAGE_VALUE_VALIDATORS: Readonly<Record<string, PresentValueValidator>> = {
	task_id: (value, path) => assertUuidV4OpaqueId(value, "task_", path),
	episode_id: (value, path) => assertUuidV4OpaqueId(value, "episode_", path),
	root_task_id: (value, path) => assertUuidV4OpaqueId(value, "task_", path),
	parent_task_id: (value, path) => assertUuidV4OpaqueId(value, "task_", path),
	parent_episode_id: (value, path) => assertUuidV4OpaqueId(value, "episode_", path),
	parent_event_id: (value, path) => assertEventIdentifier(value, path),
	supervisor_id: (value, path) => assertUuidV4OpaqueId(value, "supervisor_", path),
	target_agent_id: (value, path) => assertUuidV4OpaqueId(value, "agent_", path),
	session_id: (value, path) => assertPrefixedBindingId(value, "session_", path),
	pane_id: (value, path) => assertPrefixedBindingId(value, "pane_", path),
	workspace_id: (value, path) => assertPrefixedBindingId(value, "workspace_", path),
	process_id: (value, path) => assertPrefixedBindingId(value, "process_", path),
};

function assertPayload(payload: unknown, eventType: EventType): void {
	if (!isRecord(payload)) throw new CausalSchemaError("payload must be an object");
	assertExactKeys(payload, ["type", "payload_ref"], "payload");
	if (payload.type !== payloadTypes[eventType]) throw new CausalSchemaError(`payload.type must be ${payloadTypes[eventType]} for ${eventType}`);
	if (!isRecord(payload.payload_ref)) throw new CausalSchemaError("payload.payload_ref must be an object");
	const ref = payload.payload_ref;
	if (ref.mode === "metadata_only") {
		assertExactKeys(ref, ["mode", "reference", "fingerprint", "redaction_policy", "byte_count"], "payload.payload_ref");
		assertUuidV4OpaqueId(ref.reference, "payload_", "payload.payload_ref.reference");
		if (typeof ref.fingerprint !== "string" || !ref.fingerprint.startsWith("hmac-sha256:")) throw new CausalSchemaError("payload fingerprint must be HMAC-SHA-256");
		assertNonEmptyString(ref.redaction_policy, "payload.payload_ref.redaction_policy");
		if (ref.byte_count !== undefined && (!Number.isSafeInteger(ref.byte_count) || ref.byte_count < 0)) throw new CausalSchemaError("payload byte_count must be a non-negative safe integer");
		return;
	}
	if (ref.mode === "sealed_local_ref") {
		assertExactKeys(ref, ["mode", "reference", "access_policy", "expires_at"], "payload.payload_ref");
		assertUuidV4OpaqueId(ref.reference, "payload_", "payload.payload_ref.reference");
		assertNonEmptyString(ref.access_policy, "payload.payload_ref.access_policy");
		assertClockTimestamp(ref.expires_at, "payload.payload_ref.expires_at");
		return;
	}
	if (ref.mode === "withheld") {
		assertExactKeys(ref, ["mode", "state", "policy_reason"], "payload.payload_ref");
		if (ref.state !== "privacy_withheld") throw new CausalSchemaError("withheld payloads must state privacy_withheld");
		assertNonEmptyString(ref.policy_reason, "payload.payload_ref.policy_reason");
		return;
	}
	throw new CausalSchemaError("payload_ref.mode is not permitted");
}

export function assertCausalEvent(value: unknown): asserts value is CausalEvent {
	if (!isRecord(value)) throw new CausalSchemaError("event must be an object");
	assertExactKeys(value, ["schema_version", "event_id", "producer", "event_type", "study_id", "time", "source", "lineage", "payload", "event_sha256"], "event");
	if (value.schema_version !== CAUSAL_SCHEMA_VERSION) throw new CausalSchemaError("event has an unsupported schema_version");
	assertEventIdentifier(value.event_id, "event.event_id");
	assertUuidV4OpaqueId(value.study_id, "study_", "event.study_id");
	if (!isRecord(value.producer)) throw new CausalSchemaError("event.producer must be an object");
	assertExactKeys(value.producer, ["producer_id", "producer_seq", "previous_event_sha256"], "event.producer");
	assertUuidV4OpaqueId(value.producer.producer_id, "producer_", "event.producer.producer_id");
	if (!Number.isSafeInteger(value.producer.producer_seq) || value.producer.producer_seq < 1) throw new CausalSchemaError("event.producer.producer_seq must be positive");
	if (value.event_id !== eventId(value.producer.producer_id, value.producer.producer_seq)) throw new CausalSchemaError("event_id must match producer_id and producer_seq");
	if (typeof value.producer.previous_event_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.producer.previous_event_sha256)) throw new CausalSchemaError("previous_event_sha256 must be SHA-256 hex");
	if (typeof value.event_type !== "string" || !EVENT_TYPES.includes(value.event_type as EventType)) throw new CausalSchemaError("event_type is not supported");
	if (!isRecord(value.time)) throw new CausalSchemaError("event.time must be an object");
	assertExactKeys(value.time, ["emitted_at", "observed_at", "source_occurred_at"], "event.time");
	assertClockTimestamp(value.time.emitted_at, "event.time.emitted_at");
	assertClockTimestamp(value.time.observed_at, "event.time.observed_at");
	assertTagged(value.time.source_occurred_at, "event.time.source_occurred_at", assertClockTimestamp);
	if (!isRecord(value.source)) throw new CausalSchemaError("event.source must be an object");
	assertExactKeys(value.source, ["component", "component_path", "component_revision", "capture_mode", "source_event_ref"], "event.source");
	assertNonEmptyString(value.source.component, "event.source.component");
	assertNonEmptyString(value.source.component_path, "event.source.component_path");
	if (value.source.component_path.startsWith("/")) throw new CausalSchemaError("component_path must be repository-relative");
	assertNonEmptyString(value.source.component_revision, "event.source.component_revision");
	if (typeof value.source.capture_mode !== "string" || !CAPTURE_MODES.includes(value.source.capture_mode as CaptureMode)) throw new CausalSchemaError("source.capture_mode is not supported");
	assertTagged(value.source.source_event_ref, "event.source.source_event_ref", assertNonEmptyString);
	if (!isRecord(value.lineage)) throw new CausalSchemaError("event.lineage must be an object");
	assertExactKeys(value.lineage, ["task_id", "episode_id", "root_task_id", "parent_task_id", "parent_episode_id", "parent_event_id", "supervisor_id", "target_agent_id", "session_id", "pane_id", "workspace_id", "process_id", "display_metadata"], "event.lineage");
	for (const field of ["task_id", "episode_id", "root_task_id", "parent_task_id", "parent_episode_id", "parent_event_id", "supervisor_id", "target_agent_id", "session_id", "pane_id", "workspace_id", "process_id"]) {
		assertTagged(value.lineage[field], `event.lineage.${field}`, LINEAGE_VALUE_VALIDATORS[field]);
	}
	if (value.lineage.display_metadata !== undefined) {
		if (!isRecord(value.lineage.display_metadata)) throw new CausalSchemaError("display_metadata must be an object");
		for (const [key, item] of Object.entries(value.lineage.display_metadata)) {
			if (/raw|prompt|steer|transcript|secret|content|path/i.test(key) || typeof item !== "string") throw new CausalSchemaError("display_metadata must contain only non-sensitive labels");
		}
	}
	assertPayload(value.payload, value.event_type as EventType);
	if (typeof value.event_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.event_sha256)) throw new CausalSchemaError("event_sha256 must be SHA-256 hex");
	const { event_sha256: suppliedHash, ...body } = value;
	if (causalEventHash(body as UnsignedCausalEvent) !== suppliedHash) throw new CausalSchemaError("event_sha256 does not match canonical event body");
}
