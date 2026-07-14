import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
	assertCausalEvent,
	CAUSAL_SCHEMA_VERSION,
	CausalEvent,
	eventId,
	GENESIS_EVENT_SHA256,
	ProducerId,
	Sha256,
	StudyId,
} from "./schema";

export type ProducerWatermark = {
	readonly producer_id: ProducerId;
	readonly producer_seq: number;
	readonly event_sha256: Sha256;
};

export type LedgerRead = {
	readonly events: readonly CausalEvent[];
	readonly watermarks: readonly ProducerWatermark[];
};

export type AppendResult = {
	readonly disposition: "appended" | "idempotent";
	readonly ledger_path: string;
	readonly watermark: ProducerWatermark;
};

export class LedgerCorruptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerCorruptionError";
	}
}

export function studyLedgerPath(ledgerDirectory: string, studyId: StudyId): string {
	return join(ledgerDirectory, `${studyId}.ndjson`);
}

function watermarkPath(ledgerDirectory: string, studyId: StudyId): string {
	return join(ledgerDirectory, `${studyId}.watermarks.json`);
}

function compareWatermarks(left: ProducerWatermark, right: ProducerWatermark): number {
	return left.producer_id.localeCompare(right.producer_id);
}

export function validateLedgerEvents(events: readonly CausalEvent[]): LedgerRead {
	const seenEventHashes = new Map<string, Sha256>();
	const watermarks = new Map<ProducerId, ProducerWatermark>();
	const accepted: CausalEvent[] = [];
	for (const event of events) {
		assertCausalEvent(event);
		const existingHash = seenEventHashes.get(event.event_id);
		if (existingHash !== undefined) {
			if (existingHash !== event.event_sha256) throw new LedgerCorruptionError(`event ${event.event_id} has conflicting hashes`);
			continue;
		}
		seenEventHashes.set(event.event_id, event.event_sha256);
		const previous = watermarks.get(event.producer.producer_id);
		const expectedSequence = previous === undefined ? 1 : previous.producer_seq + 1;
		const expectedPreviousHash = previous === undefined ? GENESIS_EVENT_SHA256 : previous.event_sha256;
		if (event.producer.producer_seq !== expectedSequence) {
			throw new LedgerCorruptionError(`producer ${event.producer.producer_id} sequence expected ${expectedSequence}, got ${event.producer.producer_seq}`);
		}
		if (event.producer.previous_event_sha256 !== expectedPreviousHash) {
			throw new LedgerCorruptionError(`producer ${event.producer.producer_id} previous hash does not match sequence ${event.producer.producer_seq}`);
		}
		if (event.event_id !== eventId(event.producer.producer_id, event.producer.producer_seq)) {
			throw new LedgerCorruptionError(`event ${event.event_id} does not match producer sequence`);
		}
		const watermark = {
			producer_id: event.producer.producer_id,
			producer_seq: event.producer.producer_seq,
			event_sha256: event.event_sha256,
		};
		watermarks.set(event.producer.producer_id, watermark);
		accepted.push(event);
	}
	return Object.freeze({
		events: Object.freeze(accepted.slice()),
		watermarks: Object.freeze(Array.from(watermarks.values()).sort(compareWatermarks)),
	});
}

export function readStudyLedger(ledgerDirectory: string, studyId: StudyId): LedgerRead {
	const path = studyLedgerPath(ledgerDirectory, studyId);
	if (!existsSync(path)) return Object.freeze({ events: Object.freeze([]), watermarks: Object.freeze([]) });
	const events: CausalEvent[] = [];
	const lines = readFileSync(path, "utf8").split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.length === 0 && index === lines.length - 1) continue;
		if (line.length === 0) throw new LedgerCorruptionError(`ledger has an empty line at ${index + 1}`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown JSON parse failure";
			throw new LedgerCorruptionError(`ledger line ${index + 1} is invalid JSON: ${message}`);
		}
		try {
			assertCausalEvent(parsed);
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown schema failure";
			throw new LedgerCorruptionError(`ledger line ${index + 1} is invalid: ${message}`);
		}
		events.push(parsed);
	}
	return validateLedgerEvents(events);
}

function persistWatermarks(ledgerDirectory: string, studyId: StudyId, watermarks: readonly ProducerWatermark[]): void {
	const finalPath = watermarkPath(ledgerDirectory, studyId);
	const temporaryPath = `${finalPath}.tmp`;
	const contents = canonicalJson({ schema_version: CAUSAL_SCHEMA_VERSION, study_id: studyId, watermarks });
	writeFileSync(temporaryPath, `${contents}\n`, { encoding: "utf8", mode: 0o600 });
	const descriptor = openSync(temporaryPath, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporaryPath, finalPath);
}

export function appendCausalEvent(ledgerDirectory: string, event: CausalEvent): AppendResult {
	assertCausalEvent(event);
	mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
	const prior = readStudyLedger(ledgerDirectory, event.study_id);
	const matching = prior.events.find((existing) => existing.event_id === event.event_id);
	const watermark = {
		producer_id: event.producer.producer_id,
		producer_seq: event.producer.producer_seq,
		event_sha256: event.event_sha256,
	};
	const ledgerPath = studyLedgerPath(ledgerDirectory, event.study_id);
	if (matching !== undefined) {
		if (matching.event_sha256 !== event.event_sha256) throw new LedgerCorruptionError(`event ${event.event_id} has conflicting hashes`);
		return Object.freeze({ disposition: "idempotent", ledger_path: ledgerPath, watermark });
	}
	const producerWatermark = prior.watermarks.find((item) => item.producer_id === event.producer.producer_id);
	const expectedSequence = producerWatermark === undefined ? 1 : producerWatermark.producer_seq + 1;
	const expectedPreviousHash = producerWatermark === undefined ? GENESIS_EVENT_SHA256 : producerWatermark.event_sha256;
	if (event.producer.producer_seq !== expectedSequence || event.producer.previous_event_sha256 !== expectedPreviousHash) {
		throw new LedgerCorruptionError(`event ${event.event_id} does not continue its producer stream`);
	}
	const descriptor = openSync(ledgerPath, "a", 0o600);
	try {
		writeSync(descriptor, `${canonicalJson(event)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	const after = validateLedgerEvents([...prior.events, event]);
	persistWatermarks(ledgerDirectory, event.study_id, after.watermarks);
	return Object.freeze({ disposition: "appended", ledger_path: ledgerPath, watermark });
}
