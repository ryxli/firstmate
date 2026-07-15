import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../causal/v1/canonical-json";
import { readStudyLedger, studyLedgerPath } from "../causal/v1/ledger";
import { appendShellCausalEvent, type ShellCausalInput } from "../causal/v1/shell-adapter";
import { CAUSAL_SCHEMA_VERSION, type ProducerId, type StudyId } from "../causal/v1/schema";

const producerId = "producer_00000000-0000-4000-8000-000000000301" as ProducerId;
const studyId = "study_00000000-0000-4000-8000-000000000302" as StudyId;
const otherProducerId = "producer_00000000-0000-4000-8000-000000000303" as ProducerId;
const otherStudyId = "study_00000000-0000-4000-8000-000000000304" as StudyId;
const dirs: string[] = [];
const GOLDEN_EVENT_LINE = '{"event_id":"ce1:producer_00000000-0000-4000-8000-000000000301:1","event_sha256":"6d54d9929df895be6a241e34e13a018f25a184b457c9fc83912c5ea3e55fa65b","event_type":"delivery.attempted","lineage":{"episode_id":{"state":"not_yet_bound"},"pane_id":{"state":"not_yet_bound"},"parent_episode_id":{"state":"not_applicable"},"parent_event_id":{"state":"not_applicable"},"parent_task_id":{"state":"not_applicable"},"process_id":{"state":"not_yet_bound"},"root_task_id":{"state":"not_yet_bound"},"session_id":{"state":"not_yet_bound"},"supervisor_id":{"state":"not_yet_bound"},"target_agent_id":{"state":"not_yet_bound"},"task_id":{"state":"not_yet_bound"},"workspace_id":{"state":"not_yet_bound"}},"payload":{"payload_ref":{"mode":"withheld","policy_reason":"shell_adapter_payload_withheld","state":"privacy_withheld"},"type":"delivery_attempt"},"producer":{"previous_event_sha256":"0000000000000000000000000000000000000000000000000000000000000000","producer_id":"producer_00000000-0000-4000-8000-000000000301","producer_seq":1},"schema_version":"causal-event/v1","source":{"capture_mode":"derived","component":"firstmate.shell-causal-adapter","component_path":"causal/v1/shell-adapter.ts","component_revision":"foundation-v1","source_event_ref":{"state":"invalid_source"}},"study_id":"study_00000000-0000-4000-8000-000000000302","time":{"emitted_at":{"clock_id":"firstmate.shell-causal-adapter/unix-utc-wall/v1","utc_ms":1784022301001},"observed_at":{"clock_id":"firstmate.shell-causal-adapter/unix-utc-wall/v1","utc_ms":1784022301002},"source_occurred_at":{"state":"source_did_not_supply"}}}\n';
const GOLDEN_WATERMARK_BYTES = '{"schema_version":"causal-event/v1","study_id":"study_00000000-0000-4000-8000-000000000302","watermarks":[{"event_sha256":"6d54d9929df895be6a241e34e13a018f25a184b457c9fc83912c5ea3e55fa65b","producer_id":"producer_00000000-0000-4000-8000-000000000301","producer_seq":1}]}\n';
const adapter = join(import.meta.dir, "../causal/v1/shell-adapter.ts");
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function input(directory: string, key: string): ShellCausalInput {
	return {
		ledger_directory: directory, logical_delivery_key: key, producer_id: producerId, study_id: studyId,
		event_type: "delivery.attempted",
		emitted_at: { utc_ms: 1_784_022_301_001, clock_id: "firstmate.shell-causal-adapter/unix-utc-wall/v1" },
		observed_at: { utc_ms: 1_784_022_301_002, clock_id: "firstmate.shell-causal-adapter/unix-utc-wall/v1" },
	};
}
async function invoke(value: ShellCausalInput): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["bun", adapter], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(`${JSON.stringify(value)}\n`); child.stdin.end();
	return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe("shell causal adapter foundation", () => {
	it("appends one canonical event and matching watermark", () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-")); dirs.push(directory);
		const result = appendShellCausalEvent(input(directory, "delivery-a"));
		const ledgerBytes = readFileSync(studyLedgerPath(directory, studyId), "utf8");
		const watermarkBytes = readFileSync(join(directory, `${studyId}.watermarks.json`), "utf8");
		const event = readStudyLedger(directory, studyId).events[0];
		expect(result.disposition).toBe("appended");
		expect(ledgerBytes).toBe(GOLDEN_EVENT_LINE);
		expect(watermarkBytes).toBe(GOLDEN_WATERMARK_BYTES);
		expect(ledgerBytes).toBe(`${canonicalJson(event)}\n`);
		expect(watermarkBytes).toBe(`${canonicalJson({ schema_version: CAUSAL_SCHEMA_VERSION, study_id: studyId, watermarks: [{ producer_id: producerId, producer_seq: 1, event_sha256: event.event_sha256 }] })}\n`);
		expect(event.payload.payload_ref).toEqual({ mode: "withheld", state: "privacy_withheld", policy_reason: "shell_adapter_payload_withheld" });
		expect(event.source.source_event_ref).toEqual({ state: "invalid_source" });
		expect(event.lineage.display_metadata).toBeUndefined();
	});

	it("retries byte-identically from a separate process", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-")); dirs.push(directory);
		const first = await invoke(input(directory, "delivery-retry"));
		const beforeLedger = readFileSync(studyLedgerPath(directory, studyId), "utf8");
		const beforeWatermark = readFileSync(join(directory, `${studyId}.watermarks.json`), "utf8");
		const second = await invoke(input(directory, "delivery-retry"));
		expect(first.code).toBe(0); expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout).result.disposition).toBe("idempotent");
		expect(readFileSync(studyLedgerPath(directory, studyId), "utf8")).toBe(beforeLedger);
		expect(readFileSync(join(directory, `${studyId}.watermarks.json`), "utf8")).toBe(beforeWatermark);
		expect(JSON.parse(second.stdout).result.event_sha256).toBe(JSON.parse(first.stdout).result.event_sha256);
	});

	it("recovers an interrupted append from a durable body sidecar", () => {
		const source = mkdtempSync(join(tmpdir(), "shell-adapter-"));
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-"));
		dirs.push(source, directory);
		const delivery = input(source, "interrupted");
		appendShellCausalEvent(delivery);
		const bodyName = `${sha256Hex(`${studyId}\0${producerId}\0interrupted`)}.json`;
		mkdirSync(join(directory, ".shell-adapter-bodies"), { recursive: true });
		writeFileSync(join(directory, ".shell-adapter-bodies", bodyName), readFileSync(join(source, ".shell-adapter-bodies", bodyName)));
		const recovered = appendShellCausalEvent({ ...delivery, ledger_directory: directory });
		expect(recovered.disposition).toBe("appended");
		expect(readStudyLedger(directory, studyId).events).toHaveLength(1);
	});

	it("serializes concurrent duplicate and distinct delivery calls", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-")); dirs.push(directory);
		const duplicate = await Promise.all([invoke(input(directory, "same")), invoke(input(directory, "same"))]);
		expect(duplicate.every((item) => item.code === 0)).toBe(true);
		expect(readStudyLedger(directory, studyId).events).toHaveLength(1);
		const distinct = await Promise.all([invoke(input(directory, "one")), invoke(input(directory, "two"))]);
		const otherProducer = await Promise.all([
			invoke(input(directory, "producer-a")),
			invoke({ ...input(directory, "producer-b"), producer_id: otherProducerId }),
		]);
		expect(otherProducer.every((item) => item.code === 0)).toBe(true);
		const twoProducerLedger = readStudyLedger(directory, studyId);
		expect(twoProducerLedger.events).toHaveLength(5);
		expect(twoProducerLedger.watermarks).toHaveLength(2);
		expect(distinct.every((item) => item.code === 0)).toBe(true);
		const ledger = readStudyLedger(directory, studyId);
		expect(ledger.events).toHaveLength(5);
		expect(ledger.events.filter((event) => event.producer.producer_id === producerId).map((event) => event.producer.producer_seq)).toEqual([1, 2, 3, 4]);
		expect(ledger.events.filter((event) => event.producer.producer_id === otherProducerId).map((event) => event.producer.producer_seq)).toEqual([1]);
	});

	it("isolates the same logical key across producer and study streams", () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-")); dirs.push(directory);
		const first = appendShellCausalEvent(input(directory, "same-key"));
		const second = appendShellCausalEvent({ ...input(directory, "same-key"), producer_id: otherProducerId });
		const third = appendShellCausalEvent({ ...input(directory, "same-key"), study_id: otherStudyId });
		expect(first.event_id).not.toBe(second.event_id);
		expect(second.event_id).not.toBe(third.event_id);
		expect(readStudyLedger(directory, studyId).events).toHaveLength(2);
		expect(readStudyLedger(directory, otherStudyId).events).toHaveLength(1);
	});

	it("fails deterministically on an orphaned lock", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-")); dirs.push(directory);
		const lockDirectory = join(directory, ".shell-adapter-locks");
		mkdirSync(lockDirectory);
		const lockPath = join(lockDirectory, `${sha256Hex(studyId)}.lock`);
		writeFileSync(lockPath, "orphan");
		const result = await invoke(input(directory, "locked"));
		expect(result.code).not.toBe(0);
		expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: { code: "LOCK_TIMEOUT" } });
	});

	it("rejects invalid and content-bearing input before persistence", () => {
		const directory = join(mkdtempSync(join(tmpdir(), "shell-adapter-")), "ledger"); dirs.push(directory.slice(0, directory.lastIndexOf("/")));
		expect(() => appendShellCausalEvent({ ...input(directory, "bad key"), directive: "do this" } as never)).toThrow("content-bearing");
		expect(existsSync(directory)).toBe(false);
		expect(() => appendShellCausalEvent({ ...input(directory, "valid"), normalized_summary: "secret" } as never)).toThrow("content-bearing");
		expect(existsSync(directory)).toBe(false);
		expect(() => appendShellCausalEvent({ ...input(directory, "invalid"), event_type: "acceptance.decided" } as never)).toThrow("not supported");
	});

	it("rejects content in clock ids before creating ledger state", () => {
		const directory = join(mkdtempSync(join(tmpdir(), "shell-adapter-")), "ledger"); dirs.push(directory.slice(0, directory.lastIndexOf("/")));
		const contentClock = { ...input(directory, "clock-content"), emitted_at: { utc_ms: 1, clock_id: "directive: prompt text" } };
		expect(() => appendShellCausalEvent(contentClock)).toThrow("clock id");
		expect(existsSync(directory)).toBe(false);
	});

	it("returns machine-readable failure on storage errors without false success", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-adapter-")); dirs.push(directory);
		const ledgerPath = join(directory, "not-a-directory"); writeFileSync(ledgerPath, "fixed");
		const result = await invoke(input(ledgerPath, "storage-failure"));
		expect(result.code).not.toBe(0);
		expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: { code: "LEDGER_FAILURE" } });
		expect(readFileSync(ledgerPath, "utf8")).toBe("fixed");
	});
});
