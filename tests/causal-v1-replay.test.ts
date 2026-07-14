import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCausalEvent, readStudyLedger, studyLedgerPath } from "../causal/v1/ledger";
import { replayEvents, replayStudyLedger } from "../causal/v1/replay";
import {
	CAUSAL_SCHEMA_VERSION,
	createCausalEvent,
	eventId,
	EventType,
	GENESIS_EVENT_SHA256,
	missing,
	present,
	ProducerId,
	StudyId,
	TaskId,
	EpisodeId,
	SupervisorId,
	AgentId,
	CausalEvent,
	Sha256,
	PayloadId,
	CausalPayload,
} from "../causal/v1/schema";

const producerId = "producer_00000000-0000-4000-8000-000000000101" as ProducerId;
const studyId = "study_00000000-0000-4000-8000-000000000102" as StudyId;
const otherStudyId = "study_00000000-0000-4000-8000-000000000107" as StudyId;
const taskId = "task_00000000-0000-4000-8000-000000000103" as TaskId;
const episodeId = "episode_00000000-0000-4000-8000-000000000104" as EpisodeId;
const supervisorId = "supervisor_00000000-0000-4000-8000-000000000105" as SupervisorId;
const targetAgentId = "agent_00000000-0000-4000-8000-000000000106" as AgentId;
const sessionId = "session_replay_fixture" as never;
const paneId = "pane_replay_fixture" as never;
const workspaceId = "workspace_replay_fixture" as never;
const processId = "process_replay_fixture" as never;
const payloadType: Readonly<Record<EventType, string>> = {
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
const chain: readonly EventType[] = [
	"task.opened",
	"episode.opened",
	"pre_state.snapshotted",
	"intervention.decided",
	"prompt.prepared",
	"delivery.attempted",
	"delivery.acknowledged",
	"session.bound",
	"lifecycle.transition",
	"artifact.registered",
	"evidence.recorded",
	"acceptance.decided",
	"outcome.closed",
	"next_action.selected",
];

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureEvent(eventType: EventType, sequence: number, previousEvent: CausalEvent | undefined): CausalEvent {
	const parentEventId = previousEvent === undefined ? missing("not_applicable") : present(previousEvent.event_id);
	return createCausalEvent({
		schema_version: CAUSAL_SCHEMA_VERSION,
		event_id: eventId(producerId, sequence),
		producer: {
			producer_id: producerId,
			producer_seq: sequence,
			previous_event_sha256: (previousEvent?.event_sha256 ?? GENESIS_EVENT_SHA256) as Sha256,
		},
		event_type: eventType,
		study_id: studyId,
		time: {
			emitted_at: { utc_ms: 1_784_022_300_000 + sequence, clock_id: "producer_replay_fixture/unix-utc-wall/v1" },
			observed_at: { utc_ms: 1_784_022_300_000 + sequence, clock_id: "producer_replay_fixture/unix-utc-wall/v1" },
			source_occurred_at: missing("source_did_not_supply"),
		},
		source: {
			component: "causal.fixture",
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
			parent_event_id: parentEventId,
			supervisor_id: present(supervisorId),
			target_agent_id: present(targetAgentId),
			session_id: eventType === "session.bound" ? present(sessionId) : missing("not_yet_bound"),
			pane_id: eventType === "session.bound" ? present(paneId) : missing("not_yet_bound"),
			workspace_id: eventType === "session.bound" ? present(workspaceId) : missing("not_yet_bound"),
			process_id: eventType === "session.bound" ? present(processId) : missing("not_yet_bound"),
		},
		payload: fixturePayload(eventType, sequence),
	});
}

function fixturePayload(eventType: EventType, sequence: number): CausalPayload {
	const payloadRef = {
		mode: "metadata_only" as const,
		reference: `payload_00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}` as PayloadId,
		fingerprint: `hmac-sha256:fixture-${sequence}` as const,
		redaction_policy: "causal-payload-redaction/v1",
	};
	if (eventType === "acceptance.decided") {
		return {
			type: "acceptance",
			payload_ref: payloadRef,
			acceptance: {
				decision: "accepted",
				evaluator: { supervisor: { supervisor_id: supervisorId } },
				decision_basis: "evidence_review",
				evidence_event_ids: [eventId(producerId, sequence - 1)],
			},
		};
	}
	if (eventType === "outcome.closed") {
		return {
			type: "outcome",
			payload_ref: payloadRef,
			outcome: {
				valid_completion: "valid",
				milestone_result: "achieved",
				blocker_disposition: "no_blocker",
				safety_disposition: "safe",
				close_reason: "completed",
			},
		};
	}
	return {
		type: payloadType[eventType] as Exclude<CausalPayload["type"], "acceptance" | "outcome">,
		payload_ref: payloadRef,
	};
}

function completeFixture(): CausalEvent[] {
	const events: CausalEvent[] = [];
	for (const eventType of chain) events.push(fixtureEvent(eventType, events.length + 1, events.at(-1)));
	return events;
}

describe("causal-event/v1 deterministic replay fixtures", () => {
	it("accepts the complete task-to-next-action join chain as a read-only result", () => {
		const result = replayEvents(completeFixture());
		expect(result.status).toBe("accepted");
		expect(result.episodes).toHaveLength(1);
		expect(result.episodes[0].status).toBe("complete");
		expect(result.episodes[0].effective_exposure_event_id).toBe("ce1:producer_00000000-0000-4000-8000-000000000101:7");
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.episodes)).toBe(true);
	});

	it("marks a tagged missing required identity not estimable", () => {
		const events = completeFixture();
		const acknowledgement = events[6];
		const { event_sha256: discardedHash, ...acknowledgementBody } = acknowledgement;
		events[6] = createCausalEvent({
			...acknowledgementBody,
			lineage: { ...acknowledgement.lineage, target_agent_id: missing("source_unavailable") },
		});
		for (let index = 7; index < events.length; index += 1) {
			const { event_sha256: discarded, ...body } = events[index];
			events[index] = fixtureEvent(events[index].event_type, index + 1, events[index - 1]);
			void discarded;
			void body;
		}
		const result = replayEvents(events);
		expect(result.episodes[0].status).toBe("not_estimable");
		expect(result.episodes[0].reasons.join(" ")).toContain("source_unavailable");
	});

	it("keeps delayed delivery ineffective until a later acknowledgement", () => {
		const beforeAcknowledgement = completeFixture().slice(0, 6);
		beforeAcknowledgement.push(fixtureEvent("delivery.pending", 7, beforeAcknowledgement.at(-1)));
		const pending = replayEvents(beforeAcknowledgement);
		expect(pending.episodes[0].status).toBe("not_estimable");
		expect(pending.episodes[0].reasons.join(" ")).toContain("delivery acknowledgement is absent");
		const resumed = beforeAcknowledgement.slice(0, 6);
		resumed.push(fixtureEvent("delivery.acknowledged", 7, resumed.at(-1)));
		for (const eventType of chain.slice(7)) resumed.push(fixtureEvent(eventType, resumed.length + 1, resumed.at(-1)));
		expect(replayEvents(resumed).episodes[0].status).toBe("complete");
	});

	it("requires evidence_event_ids to resolve to same-episode evidence.recorded events and valid closures to reference accepted acceptance", () => {
		const missingEvidence = completeFixture();
		const acceptance = missingEvidence[11];
		const { event_sha256: discardedAcceptanceHash, ...acceptanceBody } = acceptance;
		missingEvidence[11] = createCausalEvent({
			...acceptanceBody,
			payload: {
				type: "acceptance",
				payload_ref: acceptance.payload.payload_ref,
				acceptance: {
					decision: "accepted",
					evaluator: { supervisor: { supervisor_id: supervisorId } },
					decision_basis: "evidence_review",
					evidence_event_ids: [missingEvidence[9].event_id],
				},
			},
		});
		for (let index = 12; index < missingEvidence.length; index += 1) {
			missingEvidence[index] = fixtureEvent(missingEvidence[index].event_type, index + 1, missingEvidence[index - 1]);
		}
		void discardedAcceptanceHash;
		const missingEvidenceResult = replayEvents(missingEvidence).episodes[0];
		expect(missingEvidenceResult.status).toBe("not_estimable");
		expect(missingEvidenceResult.reasons.join(" ")).toContain("references missing evidence event");

		const rejectedAcceptance = completeFixture();
		const rejected = rejectedAcceptance[11];
		const { event_sha256: discardedRejectedHash, ...rejectedBody } = rejected;
		rejectedAcceptance[11] = createCausalEvent({
			...rejectedBody,
			payload: {
				type: "acceptance",
				payload_ref: rejected.payload.payload_ref,
				acceptance: {
					decision: "rejected",
					evaluator: { agent: { agent_id: targetAgentId } },
					decision_basis: "policy_review",
					evidence_event_ids: [rejectedAcceptance[10].event_id],
				},
			},
		});
		for (let index = 12; index < rejectedAcceptance.length; index += 1) {
			rejectedAcceptance[index] = fixtureEvent(rejectedAcceptance[index].event_type, index + 1, rejectedAcceptance[index - 1]);
		}
		void discardedRejectedHash;
		const rejectedAcceptanceResult = replayEvents(rejectedAcceptance).episodes[0];
		expect(rejectedAcceptanceResult.status).toBe("not_estimable");
		expect(rejectedAcceptanceResult.reasons).toContain("no accepted acceptance.decided event");

		const invalidClosure = completeFixture();
		const outcome = invalidClosure[12];
		const { event_sha256: discardedOutcomeHash, ...outcomeBody } = outcome;
		invalidClosure[12] = createCausalEvent({
			...outcomeBody,
			lineage: { ...outcome.lineage, parent_event_id: present(invalidClosure[10].event_id) },
			payload: outcome.payload,
		});
		invalidClosure[13] = fixtureEvent(invalidClosure[13].event_type, 14, invalidClosure[12]);
		void discardedOutcomeHash;
		const invalidClosureResult = replayEvents(invalidClosure).episodes[0];
		expect(invalidClosureResult.status).toBe("not_estimable");
		expect(invalidClosureResult.reasons.join(" ")).toContain("valid outcome must directly reference an accepted acceptance.decided event");
	});

	it("deduplicates same-id same-hash retries and rejects same-id different-hash corruption", () => {
		const events = completeFixture();
		const duplicate = replayEvents([...events, events[5]]);
		expect(duplicate.status).toBe("accepted");
		expect(duplicate.idempotent_event_ids).toEqual([events[5].event_id]);
		const attempted = events[5];
		const { event_sha256: discardedHash, ...attemptedBody } = attempted;
		const conflict = createCausalEvent({
			...attemptedBody,
			payload: {
				...attempted.payload,
				payload_ref: { ...attempted.payload.payload_ref, reference: "payload_00000000-0000-4000-8000-000000000199" as PayloadId },
			},
		});
		const corrupted = replayEvents([...events, conflict]);
		expect(corrupted.status).toBe("rejected");
		expect(corrupted.corruptions.join(" ")).toContain("conflicting hashes");
	});

	it("rejects cross-study ledger files and replay joins", () => {
		const directory = mkdtempSync(join(tmpdir(), "causal-v1-study-binding-"));
		temporaryDirectories.push(directory);
		const source = fixtureEvent("task.opened", 1, undefined);
		const { event_sha256: discardedHash, ...sourceBody } = source;
		const foreign = createCausalEvent({ ...sourceBody, study_id: otherStudyId });
		writeFileSync(studyLedgerPath(directory, studyId), `${JSON.stringify(foreign)}\n`);
		expect(() => readStudyLedger(directory, studyId)).toThrow("expected");
		expect(replayStudyLedger(directory, studyId).status).toBe("rejected");
		expect(replayEvents([foreign], studyId).status).toBe("rejected");
		const sidecarDirectory = mkdtempSync(join(tmpdir(), "causal-v1-sidecar-binding-"));
		temporaryDirectories.push(sidecarDirectory);
		writeFileSync(
			join(sidecarDirectory, `${studyId}.watermarks.json`),
			JSON.stringify({ schema_version: CAUSAL_SCHEMA_VERSION, study_id: otherStudyId, watermarks: [] }),
		);
		expect(() => readStudyLedger(sidecarDirectory, studyId)).toThrow("watermark sidecar is bound");

		const continuation = fixtureEvent("episode.opened", 2, source);
		const { event_sha256: discardedContinuationHash, ...continuationBody } = continuation;
		const foreignContinuation = createCausalEvent({ ...continuationBody, study_id: otherStudyId });
		expect(replayEvents([source, foreignContinuation]).status).toBe("rejected");
		expect(replayEvents([source, foreignContinuation]).corruptions.join(" ")).toContain("study");
		void discardedHash;
		void discardedContinuationHash;
	});

	it("rejects producer sequence and previous-hash gaps", () => {
		const first = fixtureEvent("task.opened", 1, undefined);
		const sequenceGap = fixtureEvent("episode.opened", 3, first);
		expect(replayEvents([first, sequenceGap]).status).toBe("rejected");
		const second = fixtureEvent("episode.opened", 2, first);
		const { event_sha256: discardedHash, ...secondBody } = second;
		const hashGap = createCausalEvent({
			...secondBody,
			producer: { ...second.producer, previous_event_sha256: GENESIS_EVENT_SHA256 as Sha256 },
		});
		void discardedHash;
		const rejected = replayEvents([first, hashGap]);
		expect(rejected.status).toBe("rejected");
		expect(rejected.corruptions.join(" ")).toContain("previous hash");
	});

	it("resumes a producer from its fsynced watermark without repeating source events", () => {
		const directory = mkdtempSync(join(tmpdir(), "causal-v1-replay-"));
		temporaryDirectories.push(directory);
		const events = completeFixture();
		for (const event of events.slice(0, 6)) expect(appendCausalEvent(directory, event).disposition).toBe("appended");
		for (const event of events.slice(6)) expect(appendCausalEvent(directory, event).disposition).toBe("appended");
		expect(appendCausalEvent(directory, events[5]).disposition).toBe("idempotent");
		const ledger = readStudyLedger(directory, studyId);
		expect(ledger.watermarks).toEqual([{ producer_id: producerId, producer_seq: 14, event_sha256: events[13].event_sha256 }]);
		expect(replayStudyLedger(directory, studyId).episodes[0].status).toBe("complete");
	});

	it("repairs a missing watermark sidecar on an idempotent retry", () => {
		const directory = mkdtempSync(join(tmpdir(), "causal-v1-watermark-retry-"));
		temporaryDirectories.push(directory);
		const event = fixtureEvent("task.opened", 1, undefined);
		expect(appendCausalEvent(directory, event).disposition).toBe("appended");
		const sidecar = join(directory, `${studyId}.watermarks.json`);
		rmSync(sidecar);
		writeFileSync(`${sidecar}.tmp`, "interrupted sidecar write");
		const retry = appendCausalEvent(directory, event);
		expect(retry.disposition).toBe("idempotent");
		expect(retry.watermark).toEqual({ producer_id: producerId, producer_seq: 1, event_sha256: event.event_sha256 });
		expect(JSON.parse(readFileSync(sidecar, "utf8")).watermarks).toEqual([retry.watermark]);
	});

	it("rejects a branching parent graph without one coherent root-to-outcome chain", () => {
		const base = completeFixture();
		const rebuilt: CausalEvent[] = [base[0]];
		const branchTaskEventId = eventId(producerId, 15);
		const { event_sha256: discardedEpisodeHash, ...episodeBody } = base[1];
		rebuilt.push(
			createCausalEvent({
				...episodeBody,
				lineage: { ...base[1].lineage, parent_event_id: present(branchTaskEventId) },
			}),
		);
		for (let index = 2; index < base.length; index += 1) {
			const { event_sha256: discardedHash, ...body } = base[index];
			rebuilt.push(
				createCausalEvent({
					...body,
					producer: { ...body.producer, previous_event_sha256: rebuilt.at(-1)!.event_sha256 },
				}),
			);
			void discardedHash;
		}
		const { event_sha256: discardedTaskHash, ...taskBody } = base[0];
		rebuilt.push(
			createCausalEvent({
				...taskBody,
				event_id: branchTaskEventId,
				producer: {
					...taskBody.producer,
					producer_seq: 15,
					previous_event_sha256: rebuilt.at(-1)!.event_sha256,
				},
				lineage: {
					...taskBody.lineage,
					parent_event_id: present(eventId(producerId, 999)),
				},
			}),
		);
		void discardedEpisodeHash;
		void discardedTaskHash;
		const result = replayEvents(rebuilt);
		expect(result.status).toBe("accepted");
		expect(result.episodes[0].status).toBe("not_estimable");
		expect(result.episodes[0].reasons.join(" ")).toContain("coherent root-to-outcome");
	});

	it("uses the acknowledgement from the accepted coherent branch", () => {
		const base = completeFixture();
		const coherentAcknowledgementId = eventId(producerId, 15);
		const rebuilt: CausalEvent[] = [base[0]];
		for (let index = 1; index < base.length; index += 1) {
			const { event_sha256: discardedHash, ...body } = base[index];
			rebuilt.push(
				createCausalEvent({
					...body,
					producer: { ...body.producer, previous_event_sha256: rebuilt.at(-1)!.event_sha256 },
					...(index === 7 ? { lineage: { ...body.lineage, parent_event_id: present(coherentAcknowledgementId) } } : {}),
				}),
			);
			void discardedHash;
		}
		const { event_sha256: discardedAcknowledgementHash, ...acknowledgementBody } = base[6];
		const coherentAcknowledgement = createCausalEvent({
			...acknowledgementBody,
			event_id: coherentAcknowledgementId,
			producer: {
				...acknowledgementBody.producer,
				producer_seq: 15,
				previous_event_sha256: rebuilt.at(-1)!.event_sha256,
			},
		});
		rebuilt.push(coherentAcknowledgement);
		void discardedAcknowledgementHash;
		const result = replayEvents(rebuilt);
		expect(result.status).toBe("accepted");
		expect(result.episodes[0].status).toBe("complete");
		expect(result.episodes[0].effective_exposure_event_id).toBe(coherentAcknowledgementId);
	});

	it("preserves candidate display metadata while refusing heuristic joins", () => {
		const event = fixtureEvent("task.opened", 1, undefined);
		const { event_sha256: discardedHash, ...body } = event;
		const unjoinable = createCausalEvent({
			...body,
			lineage: {
				...event.lineage,
				task_id: missing("unjoinable_identity"),
				display_metadata: { candidate_pane_label: "friendly-worker-label" },
			},
		});
		const result = replayEvents([unjoinable]);
		expect(result.episodes[0].status).toBe("unjoinable");
		expect(result.episodes[0].display_metadata).toEqual([{ candidate_pane_label: "friendly-worker-label" }]);
	});
});
