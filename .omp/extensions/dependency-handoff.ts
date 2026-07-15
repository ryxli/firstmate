export type DependencyEdge = Readonly<{
	producer: string;
	consumers: readonly string[];
	artifactPath: string;
	artifactSha?: string;
	wakeAction: string;
	criticalPath: boolean;
}>;

export type DependencyDelivery = Readonly<{
	target: "parent" | "consumer";
	consumer?: string;
	action: string;
}>;

const REQUIRED = ["dependency.producer", "dependency.consumers", "dependency.artifact", "dependency.sha", "dependency.wake"] as const;

export function parseDependencyEdge(meta: string): DependencyEdge | undefined {
	const values = new Map<string, string>();
	for (const line of meta.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	if (REQUIRED.some((key) => !values.get(key))) return undefined;
	const consumers = values.get("dependency.consumers")!.split(",").map((value) => value.trim()).filter(Boolean);
	if (consumers.length === 0) return undefined;
	return Object.freeze({
		consumers: Object.freeze([...new Set(consumers)]),
		artifactPath: values.get("dependency.artifact")!,
		artifactSha: values.get("dependency.sha")!,
		wakeAction: values.get("dependency.wake")!,
		producer: values.get("dependency.producer")!,
		criticalPath: values.get("dependency.priority") === "critical",
	});
}

export function validateBlockedReport(line: string): { valid: true } | { valid: false; missing: string[] } {
	if (!/^blocked:/i.test(line.trim())) return { valid: true };
	const required = ["waiting_on", "artifact", "owner", "callback"];
	const missing = required.filter((key) => !new RegExp(`(?:^|\\s)${key}=[^\\s]+`, "i").test(line));
	return missing.length === 0 ? { valid: true } : { valid: false, missing };
}

export function dependencyDeliveries(edge: DependencyEdge, artifactExists: boolean, artifactShaMatches = true): DependencyDelivery[] {
	if (!artifactExists || !artifactShaMatches) return [];
	const targets: DependencyDelivery[] = [{ target: "parent", action: edge.wakeAction }];
	for (const consumer of edge.consumers) targets.push({ target: "consumer", consumer, action: edge.wakeAction });
	return targets;
}

export function prioritizeDependencyEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
	return [...edges].sort((left, right) => Number(right.criticalPath) - Number(left.criticalPath));
}
