import { classifyAttention } from "../.omp/extensions/fm-supervisor.ts";
import { modelNew } from "./new.ts";
import { modelOld } from "./old.ts";
import { SCENARIOS } from "./scenarios.ts";
import { tokenizerBackend } from "./tokenizer.ts";
import type { Components } from "./old.ts";
import type { Metrics, Scenario } from "./types.ts";

type Row = { scenario: string; feature: string; old: Metrics; new: Metrics; oldComponents: Components; newComponents: Components };

type Report = {
	contract: "direct fm-supervisor.ts classifyAttention export";
	tokenizer: string;
	scenarios: Row[];
	totals: { old: Totals; new: Totals };
	verdict: "ADOPT NEW" | "DO NOT ADOPT";
};

type Totals = {
	wakes: number;
	interface_tokens: number;
	false_wakes: number;
	detected_relevant: number;
	missed_relevant: number;
};

function assertSupervisorExportContract(): void {
	const timestampedDone = {
		t: 0,
		kind: "status" as const,
		pane: "w1:p1",
		task: "export-sentinel",
		status_line: "2026-07-11T00:00:00Z done: PR https://example.test/1 checks green",
		relevant: true,
	};
	const blocked = {
		t: 1,
		kind: "herdr" as const,
		pane: "w2:p1",
		task: "export-sentinel-blocked",
		herdr_from: "working" as const,
		herdr_to: "blocked" as const,
		relevant: true,
	};
	const single = classifyAttention([timestampedDone]);
	if (single.edges !== 1 || single.detected !== 1 || single.falseEdges !== 0) {
		throw new Error("fm-supervisor.ts classifyAttention export did not produce one silent edge");
	}
	const burst = classifyAttention([timestampedDone, blocked]);
	if (burst.edges !== 1 || burst.detected !== 2 || burst.falseEdges !== 0) {
		throw new Error("fm-supervisor.ts reducer did not coalesce a relevant burst");
	}
}

function assertScenarioIntegrity(scenarios: readonly Scenario[]): void {
	assertSupervisorExportContract();
	for (const scenario of scenarios) {
		for (const [index, event] of scenario.events.entries()) {
			const actual = classifyAttention([event]).detected === 1;
			if (actual !== event.relevant) throw new Error(`${scenario.name}[${index}]: recorded relevant=${event.relevant}, live supervisor=${actual}`);
		}
		const expectedRelevant = scenario.events.reduce((count, event) => count + Number(event.relevant), 0);
		const classified = classifyAttention(scenario.events);
		if (classified.detected !== expectedRelevant || classified.falseEdges !== 0) throw new Error(`${scenario.name}: live supervisor failed corpus integrity`);
		const replay = modelNew(scenario).metrics;
		if (replay.missed_relevant !== 0) throw new Error(`${scenario.name}: live supervisor replay missed a relevant event`);
	}
}

function addMetrics(total: Totals, metrics: Metrics): void {
	total.wakes += metrics.wakes;
	total.interface_tokens += metrics.interface_tokens;
	total.false_wakes += metrics.false_wakes;
	total.detected_relevant += metrics.detected_relevant;
	total.missed_relevant += metrics.missed_relevant;
}

function buildReport(): Report {
	assertScenarioIntegrity(SCENARIOS);
	const rows = SCENARIOS.map((scenario) => {
		const old = modelOld(scenario);
		const current = modelNew(scenario);
		return { scenario: scenario.name, feature: scenario.feature, old: old.metrics, new: current.metrics, oldComponents: old.components, newComponents: current.components };
	});
	const totals = {
		old: { wakes: 0, interface_tokens: 0, false_wakes: 0, detected_relevant: 0, missed_relevant: 0 },
		new: { wakes: 0, interface_tokens: 0, false_wakes: 0, detected_relevant: 0, missed_relevant: 0 },
	};
	for (const row of rows) {
		addMetrics(totals.old, row.old);
		addMetrics(totals.new, row.new);
	}
	const adopt = totals.new.interface_tokens < totals.old.interface_tokens && totals.new.false_wakes <= totals.old.false_wakes && totals.new.missed_relevant === 0;
	return { contract: "direct fm-supervisor.ts classifyAttention export", tokenizer: tokenizerBackend, scenarios: rows, totals, verdict: adopt ? "ADOPT NEW" : "DO NOT ADOPT" };
}

const command = process.argv[2] ?? "replay";
if (command === "check") {
	assertScenarioIntegrity(SCENARIOS);
	process.stdout.write(`integrity: ${SCENARIOS.length} deterministic scenarios validated against direct fm-supervisor.ts classifyAttention export\n`);
} else if (command === "replay") {
	process.stdout.write(`${JSON.stringify(buildReport(), null, 2)}\n`);
} else {
	process.stderr.write("usage: bun benchmarks/run.ts <check|replay>\n");
	process.exitCode = 2;
}
