import { expect, test } from "bun:test";
import { dependencyDeliveries, parseDependencyEdge, prioritizeDependencyEdges, validateBlockedReport } from "../.omp/extensions/dependency-handoff";

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
