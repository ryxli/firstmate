import { LedgerCorruptionError, readStudyLedger, validateLedgerEvents } from "./ledger";
import { CausalEvent, EpisodeId, EventId, EventType, MissingnessState, StudyId, Tagged } from "./schema";

const REQUIRED_EVENT_TYPES: readonly EventType[] = [
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

const REQUIRED_PARENT_TYPES: Readonly<Partial<Record<EventType, EventType>>> = {
	"episode.opened": "task.opened",
	"pre_state.snapshotted": "episode.opened",
	"intervention.decided": "pre_state.snapshotted",
	"prompt.prepared": "intervention.decided",
	"delivery.attempted": "prompt.prepared",
	"delivery.acknowledged": "delivery.attempted",
	"session.bound": "delivery.acknowledged",
	"lifecycle.transition": "session.bound",
	"artifact.registered": "lifecycle.transition",
	"evidence.recorded": "artifact.registered",
	"acceptance.decided": "evidence.recorded",
	"outcome.closed": "acceptance.decided",
	"next_action.selected": "outcome.closed",
};

export type ReplayEpisode = {
	readonly episode_id: EpisodeId;
	readonly status: "complete" | "not_estimable" | "unjoinable";
	readonly event_ids: readonly EventId[];
	readonly reasons: readonly string[];
	readonly effective_exposure_event_id?: EventId;
	readonly display_metadata: readonly Readonly<Record<string, string>>[];
};

export type ReplayResult = {
	readonly status: "accepted" | "rejected";
	readonly accepted_event_ids: readonly EventId[];
	readonly idempotent_event_ids: readonly EventId[];
	readonly episodes: readonly ReplayEpisode[];
	readonly corruptions: readonly string[];
};

function taggedValue<T>(value: Tagged<T>): T | undefined {
	return "value" in value ? value.value : undefined;
}

function taggedState<T>(value: Tagged<T>): MissingnessState | undefined {
	return "state" in value ? value.state : undefined;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

function findCoherentParentChain(byType: ReadonlyMap<EventType, readonly CausalEvent[]>): readonly CausalEvent[] | undefined {
	const byParent = new Map<EventId, CausalEvent[]>();
	for (const events of byType.values()) {
		for (const event of events) {
			const parentEventId = taggedValue(event.lineage.parent_event_id);
			if (parentEventId === undefined) continue;
			const children = byParent.get(parentEventId) ?? [];
			children.push(event);
			byParent.set(parentEventId, children);
		}
	}
	const walk = (current: CausalEvent, nextTypeIndex: number, rootTaskId: string, chain: readonly CausalEvent[]): readonly CausalEvent[] | undefined => {
		if (nextTypeIndex === REQUIRED_EVENT_TYPES.length) return chain;
		for (const candidate of byParent.get(current.event_id) ?? []) {
			if (candidate.event_type !== REQUIRED_EVENT_TYPES[nextTypeIndex]) continue;
			if (taggedValue(candidate.lineage.root_task_id) !== rootTaskId) continue;
			const result = walk(candidate, nextTypeIndex + 1, rootTaskId, [...chain, candidate]);
			if (result !== undefined) return result;
		}
		return undefined;
	};
	for (const root of byType.get("task.opened") ?? []) {
		if (taggedValue(root.lineage.parent_event_id) !== undefined) continue;
		const rootTaskId = taggedValue(root.lineage.root_task_id);
		if (rootTaskId === undefined) continue;
		const chain = walk(root, 1, rootTaskId, [root]);
		if (chain !== undefined) return chain;
	}
	return undefined;
}

function describeEpisode(events: readonly CausalEvent[], episodeId: EpisodeId): ReplayEpisode {
	const episodeEvents = events.filter((event) => taggedValue(event.lineage.episode_id) === episodeId);
	const byType = new Map<EventType, CausalEvent[]>();
	for (const event of episodeEvents) {
		const collected = byType.get(event.event_type) ?? [];
		collected.push(event);
		byType.set(event.event_type, collected);
	}
	const reasons: string[] = [];
	const displayMetadata: Readonly<Record<string, string>>[] = [];
	let hasUnjoinableIdentity = false;
	for (const event of episodeEvents) {
		if (event.lineage.display_metadata !== undefined) displayMetadata.push({ ...event.lineage.display_metadata });
		for (const value of Object.values(event.lineage)) {
			if (value !== null && typeof value === "object" && "state" in value && value.state === "unjoinable_identity") {
				hasUnjoinableIdentity = true;
			}
		}
		for (const field of [event.lineage.task_id, event.lineage.episode_id, event.lineage.root_task_id, event.lineage.supervisor_id, event.lineage.target_agent_id]) {
			const state = taggedState(field);
			if (state !== undefined) reasons.push(`${event.event_id} has required identity state ${state}`);
		}
	}
	if (hasUnjoinableIdentity) reasons.push("explicit unjoinable_identity blocks causal joins");
	for (const eventType of REQUIRED_EVENT_TYPES) {
		const candidates = byType.get(eventType) ?? [];
		if (candidates.length === 0) {
			reasons.push(`missing required ${eventType}`);
			continue;
		}
		const expectedParentType = REQUIRED_PARENT_TYPES[eventType];
		if (expectedParentType === undefined) continue;
		const parentIds = new Set((byType.get(expectedParentType) ?? []).map((event) => event.event_id));
		const linked = candidates.some((event) => {
			const parentEventId = taggedValue(event.lineage.parent_event_id);
			return parentEventId !== undefined && parentIds.has(parentEventId);
		});
		if (!linked) reasons.push(`${eventType} has no explicit parent link to ${expectedParentType}`);
	}
	const coherentChain = findCoherentParentChain(byType);
	if (coherentChain === undefined) reasons.push("events do not form one coherent root-to-outcome parent chain");
	const sessionBound = coherentChain?.filter((event) => event.event_type === "session.bound") ?? [];
	if (!sessionBound.some((event) => taggedValue(event.lineage.session_id) !== undefined)) {
		reasons.push("session.bound has no explicit session_id");
	}
	const acknowledgements = coherentChain?.filter((event) => event.event_type === "delivery.acknowledged") ?? [];
	if (acknowledgements.length === 0) reasons.push("delivery acknowledgement is absent, so exposure is ineffective");
	const status = hasUnjoinableIdentity ? "unjoinable" : coherentChain !== undefined && reasons.length === 0 ? "complete" : "not_estimable";
	return {
		episode_id: episodeId,
		status,
		event_ids: episodeEvents.map((event) => event.event_id),
		reasons,
		...(status === "complete" ? { effective_exposure_event_id: acknowledgements[0].event_id } : {}),
		display_metadata: displayMetadata,
	};
}

export function replayEvents(events: readonly CausalEvent[], requestedStudyId?: StudyId): ReplayResult {
	try {
		const validated = validateLedgerEvents(events, requestedStudyId);
		const seen = new Set<EventId>();
		const duplicates: EventId[] = [];
		for (const event of events) {
			if (seen.has(event.event_id)) duplicates.push(event.event_id);
			else seen.add(event.event_id);
		}
		const episodeIds = new Set<EpisodeId>();
		for (const event of validated.events) {
			const episodeId = taggedValue(event.lineage.episode_id);
			if (episodeId !== undefined) episodeIds.add(episodeId);
		}
		const episodes = Array.from(episodeIds)
			.sort()
			.map((episodeId) => describeEpisode(validated.events, episodeId));
		return deepFreeze({
			status: "accepted",
			accepted_event_ids: validated.events.map((event) => event.event_id),
			idempotent_event_ids: duplicates,
			episodes,
			corruptions: [],
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "unknown replay validation failure";
		return deepFreeze({ status: "rejected", accepted_event_ids: [], idempotent_event_ids: [], episodes: [], corruptions: [message] });
	}
}

export function replayStudyLedger(ledgerDirectory: string, studyId: StudyId): ReplayResult {
	try {
		return replayEvents(readStudyLedger(ledgerDirectory, studyId).events, studyId);
	} catch (error) {
		const message = error instanceof LedgerCorruptionError ? error.message : error instanceof Error ? error.message : "unknown replay read failure";
		return deepFreeze({ status: "rejected", accepted_event_ids: [], idempotent_event_ids: [], episodes: [], corruptions: [message] });
	}
}
