import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyDeliveries, parseDependencyEdge, prioritizeDependencyEdges, validateBlockedReport } from "../.omp/extensions/cli/lib/dependency-handoff";
import { writeDependencyReceiptFileForTest } from "../.omp/extensions/fm-supervisor";

test("producer completion with an existing artifact wakes parent and every sibling consumer", () => {
	const edge = parseDependencyEdge([
		"dependency.producer=producer",
		"dependency.consumers=consumer-a,consumer-b",
		"dependency.artifact=/tmp/result.json",
		"dependency.sha=abc123",
		"dependency.wake=consume artifact",
		"dependency.priority=critical",
	].join("\n"));
	expect(edge).toBeDefined();
	expect(dependencyDeliveries(edge!, true, true)).toEqual([
		{ target: "parent", action: "consume artifact" },
		{ target: "consumer", consumer: "consumer-a", action: "consume artifact" },
		{ target: "consumer", consumer: "consumer-b", action: "consume artifact" },
	]);
	expect(dependencyDeliveries(edge!, false, true)).toEqual([]);
});

test("critical dependency handoffs outrank ordinary backfill", () => {
	const make = (priority: string) => parseDependencyEdge(`dependency.producer=p\ndependency.consumers=c\ndependency.artifact=a\ndependency.sha=s\ndependency.wake=w\ndependency.priority=${priority}`)!;
	expect(prioritizeDependencyEdges([make("ordinary"), make("critical")])[0]?.criticalPath).toBe(true);
});

test("malformed blocked reports are rejected until all callback fields exist", () => {
	expect(validateBlockedReport("blocked: waiting_on=producer").valid).toBe(false);
	expect(validateBlockedReport("blocked: waiting_on=producer artifact=/tmp/a owner=producer callback=fm-send").valid).toBe(true);
});

test("dependency receipt writes use unique temporaries and report persistence failures", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fm-dependency-receipts-"));
	try {
		const receipt = join(dir, ".dependency-handoffs.json");
		const writes = await Promise.all([
			writeDependencyReceiptFileForTest(receipt, [{ key: "a", producer: "producer-a" }]),
			writeDependencyReceiptFileForTest(receipt, [{ key: "b", producer: "producer-b" }]),
		]);
		expect(writes).toEqual([true, true]);
		const records = JSON.parse(readFileSync(receipt, "utf8"));
		expect(records.length).toBe(1);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
		mkdirSync(join(dir, "receipt-dir"));
		const failed = await writeDependencyReceiptFileForTest(join(dir, "receipt-dir"), [{ key: "c", producer: "producer-c" }]);
		expect(failed).toBe(false);
		expect(existsSync(join(dir, "receipt-dir"))).toBe(true);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
