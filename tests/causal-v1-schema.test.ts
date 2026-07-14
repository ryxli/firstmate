import { describe, expect, it } from "bun:test";

import { canonicalJson, canonicalSha256 } from "../causal/v1/canonical-json";
import {
	assertCausalEvent,
	CAUSAL_SCHEMA_VERSION,
	createCausalEvent,
	eventId,
	GENESIS_EVENT_SHA256,
	missing,
	present,
	isUuidV4OpaqueId,
	mintAgentId,
	mintEpisodeId,
	mintPayloadId,
	mintProducerId,
	mintStudyId,
	mintSupervisorId,
	mintTaskId,
	ProducerId,
	StudyId,
	TaskId,
	EpisodeId,
	SupervisorId,
	AgentId,
	PayloadId,
} from "../causal/v1/schema";

const producerId = "producer_00000000-0000-4000-8000-000000000001" as ProducerId;
const studyId = "study_00000000-0000-4000-8000-000000000002" as StudyId;
const taskId = "task_00000000-0000-4000-8000-000000000003" as TaskId;
const episodeId = "episode_00000000-0000-4000-8000-000000000004" as EpisodeId;
const supervisorId = "supervisor_00000000-0000-4000-8000-000000000005" as SupervisorId;
const targetAgentId = "agent_00000000-0000-4000-8000-000000000006" as AgentId;

function fixtureEvent() {
	return createCausalEvent({
		schema_version: CAUSAL_SCHEMA_VERSION,
		event_id: eventId(producerId, 1),
		producer: { producer_id: producerId, producer_seq: 1, previous_event_sha256: GENESIS_EVENT_SHA256 as never },
		event_type: "task.opened",
		study_id: studyId,
		time: {
			emitted_at: { utc_ms: 1_784_022_300_123, clock_id: "producer_schema_fixture/unix-utc-wall/v1" },
			observed_at: { utc_ms: 1_784_022_300_123, clock_id: "producer_schema_fixture/unix-utc-wall/v1" },
			source_occurred_at: missing("source_did_not_supply"),
		},
		source: {
			component: "firstmate.fixture",
			component_path: "causal/v1/fixture.ts",
			component_revision: "fixture-revision",
			capture_mode: "manual",
			source_event_ref: missing("not_applicable"),
		},
		lineage: {
			task_id: present(taskId),
			episode_id: present(episodeId),
			root_task_id: present(taskId),
			parent_task_id: missing("not_applicable"),
			parent_episode_id: missing("not_applicable"),
			parent_event_id: missing("not_applicable"),
			supervisor_id: present(supervisorId),
			target_agent_id: present(targetAgentId),
			session_id: missing("not_yet_bound"),
			pane_id: missing("not_yet_bound"),
			workspace_id: missing("not_yet_bound"),
			process_id: missing("not_yet_bound"),
		},
		payload: {
			type: "task_shape",
			payload_ref: {
				mode: "metadata_only",
				reference: "payload_00000000-0000-4000-8000-000000000007" as PayloadId,
				fingerprint: "hmac-sha256:opaque-fixture",
				redaction_policy: "causal-payload-redaction/v1",
				byte_count: 0,
			},
		},
	});
}

describe("causal-event/v1 canonical JSON", () => {
	it("sorts object keys recursively and hashes canonical bytes", () => {
		expect(canonicalJson({ z: [3, { b: true, a: null }], a: "first" })).toBe('{"a":"first","z":[3,{"a":null,"b":true}]}');
		expect(canonicalSha256({ a: 1, b: 2 })).toBe(canonicalSha256({ b: 2, a: 1 }));
		expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("finite number");
	});
});

describe("causal-event/v1 schema", () => {
	it("mints a deterministic event id and hash over the body only", () => {
		const event = fixtureEvent();
		expect(event.event_id).toBe("ce1:producer_00000000-0000-4000-8000-000000000001:1");
		expect(event.event_sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(() => assertCausalEvent(event)).not.toThrow();
	});

	it("mints and recognizes UUIDv4-prefixed opaque identifiers", () => {
		const minted = [
			[mintProducerId(), "producer_"],
			[mintStudyId(), "study_"],
			[mintTaskId(), "task_"],
			[mintEpisodeId(), "episode_"],
			[mintSupervisorId(), "supervisor_"],
			[mintAgentId(), "agent_"],
			[mintPayloadId(), "payload_"],
		] as const;
		for (const [value, prefix] of minted) expect(isUuidV4OpaqueId(value, prefix)).toBe(true);
		expect(isUuidV4OpaqueId("task_not-a-uuid", "task_")).toBe(false);
	});

	it("rejects untagged missingness and absolute component paths", () => {
		const event = fixtureEvent();
		const invalidMissingness: unknown = {
			...event,
			lineage: { ...event.lineage, task_id: { value: taskId, state: "not_applicable" } },
		};
		expect(() => assertCausalEvent(invalidMissingness)).toThrow("exactly one");
		const absolutePath: unknown = {
			...event,
			source: { ...event.source, component_path: "/private/session.json" },
		};
		expect(() => assertCausalEvent(absolutePath)).toThrow("repository-relative");
	});

	it("runtime-validates tagged present field formats", () => {
		const event = fixtureEvent();
		const invalidSourceTime: unknown = {
			...event,
			time: { ...event.time, source_occurred_at: present("not-a-clock") },
		};
		expect(() => assertCausalEvent(invalidSourceTime)).toThrow("must be an object");
		const invalidTaskId: unknown = {
			...event,
			lineage: { ...event.lineage, task_id: present("task_not-a-uuid" as TaskId) },
		};
		expect(() => assertCausalEvent(invalidTaskId)).toThrow("UUIDv4 opaque id");
		const invalidParentEvent: unknown = {
			...event,
			lineage: { ...event.lineage, parent_event_id: present("ce1:producer_not-a-uuid:1" as never) },
		};
		expect(() => assertCausalEvent(invalidParentEvent)).toThrow("ce1 producer event id");
	});

	it("enforces metadata-only payloads without raw content fields", () => {
		const event = fixtureEvent();
		const rawPayload: unknown = {
			...event,
			payload: { ...event.payload, raw_text: "never write this" },
		};
		expect(() => assertCausalEvent(rawPayload)).toThrow("not permitted");
		const sealedPayload = createCausalEvent({
			...event,
			payload: {
				type: "task_shape",
				payload_ref: {
					mode: "sealed_local_ref",
					reference: "payload_00000000-0000-4000-8000-000000000008" as PayloadId,
					access_policy: "causal-reproduction/v1",
					expires_at: { utc_ms: 1_784_022_400_000, clock_id: "producer_schema_fixture/unix-utc-wall/v1" },
				},
			},
		});
		expect(sealedPayload.event_sha256).not.toBe(event.event_sha256);
		expect(sealedPayload.payload.payload_ref.mode).toBe("sealed_local_ref");
	});
});
