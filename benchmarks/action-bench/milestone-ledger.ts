#!/usr/bin/env bun
// Append one macro datapoint per MILESTONE to a durable progress ledger.
//
// action-bench is run at milestone cadence (not continuously) to track, at a macro level, how the
// harness-vs-control effect evolves as firstmate changes over time. This tool turns a set of
// per-model runs.json artifacts (one per model, control+harness) into a single comparable milestone
// row: it re-aggregates each run under the CURRENT calibrated difficulty tiers, extracts the headline
// metrics (per-model control / harness overall correctness, the harness lift, and corrupt-success),
// appends the record to <out>/milestones.jsonl, and appends the matching row block to <out>/milestones.md.
//
// Usage: bun milestone-ledger.ts [--out <dir>] <label> <sha> <runs.json> [<runs.json> ...]
//   --out <dir>   write milestones.jsonl / milestones.md under <dir> (default: results/). Point at a
//                 temp dir to test without touching the committed ledger.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Aggregate, type RunPayload, type RunRecord, aggregate } from "./engine.ts";
import { loadScenarios } from "./scenarios/index.ts";

const HERE = import.meta.dir;
const DEFAULT_RESULTS = join(HERE, "results");

// one model at one milestone (the shape stored under milestone.models[]).
interface ModelMacro {
	model: string;
	thinking: string;
	trials: number | null;
	scenarios: number;
	control: number | null;
	harness: number | null;
	lift: number | null;
	corrupt: number;
}

// one milestone row (the shape stored per line in milestones.jsonl). Keys and order match the
// committed ledger exactly; corpus_scenarios stays snake_case to match existing rows.
interface MilestoneRecord {
	captured: string;
	milestone: string;
	sha: string;
	corpus_scenarios: number;
	trials: number | null;
	note: string;
	models: ModelMacro[];
}

// Re-aggregate a run under current tiers; return the per-model macro summary.
function macroFor(payload: RunPayload, id2tier: Map<string, string>): ModelMacro {
	const runs: RunRecord[] = payload.runs;
	for (const r of runs) {
		const t = id2tier.get(r.scenario);
		if (t !== undefined) r.difficulty = t;
	}
	const agg: Aggregate = aggregate(runs);
	const arms = agg.arms;
	const scenIds = new Set(runs.map((r) => r.scenario));
	const corrupt = (arm: string): number => {
		const a = arms[arm];
		if (!a) return 0;
		return Object.values(a.byDifficulty).reduce((sum, b) => sum + (b?.corruptSuccess ?? 0), 0);
	};
	const c = arms.control?.overallCorrectness ?? null;
	const h = arms.harness?.overallCorrectness ?? null;
	return {
		model: payload.model ?? "?",
		thinking: payload.thinking ?? "?",
		trials: payload.trials ?? null,
		scenarios: scenIds.size,
		control: c,
		harness: h,
		lift: c !== null && h !== null ? Math.round((h - c) * 1000) / 1000 : null,
		corrupt: corrupt("control") + corrupt("harness"),
	};
}

// mirror Python json.dumps for an int-or-null field ("null" when absent).
function jint(x: number | null): string {
	return x === null ? "null" : String(x);
}

// mirror Python json.dumps for a float-or-null field (whole values keep a trailing ".0").
function jfloat(x: number | null): string {
	if (x === null) return "null";
	return Number.isInteger(x) ? `${x}.0` : String(x);
}

// Serialize one record exactly as Python's json.dumps(rec) would (spaced separators, float ".0",
// insertion-ordered keys) so an appended line is byte-consistent with the committed jsonl rows.
function recordToJsonl(rec: MilestoneRecord): string {
	const models = rec.models
		.map(
			(m) =>
				`{"model": ${JSON.stringify(m.model)}, "thinking": ${JSON.stringify(m.thinking)}, "trials": ${jint(m.trials)}, ` +
				`"scenarios": ${jint(m.scenarios)}, "control": ${jfloat(m.control)}, "harness": ${jfloat(m.harness)}, ` +
				`"lift": ${jfloat(m.lift)}, "corrupt": ${jint(m.corrupt)}}`,
		)
		.join(", ");
	return (
		`{"captured": ${JSON.stringify(rec.captured)}, "milestone": ${JSON.stringify(rec.milestone)}, ` +
		`"sha": ${JSON.stringify(rec.sha)}, "corpus_scenarios": ${jint(rec.corpus_scenarios)}, ` +
		`"trials": ${jint(rec.trials)}, "note": ${JSON.stringify(rec.note)}, "models": [${models}]}`
	);
}

// mirror Python f"{x:+.3f}" (forced sign, 3 decimals).
function fmtLift(x: number): string {
	return `${x < 0 ? "-" : "+"}${Math.abs(x).toFixed(3)}`;
}

// mirror Python str(x) for a correctness cell (whole -> "N.0", None -> "None").
function fmtNum(x: number | null): string {
	if (x === null) return "None";
	return Number.isInteger(x) ? `${x}.0` : String(x);
}

const MD_HEADER = [
	"# action-bench milestone ledger",
	"",
	"Macro progress across milestones (run at milestone cadence, not continuously). Each row is " +
		"one model at one milestone: control -> harness overall correctness, the harness lift, and " +
		"total corrupt-success. Correctness is calibrated-tier-weighted; a rising lift or a widening " +
		"gap on the hard tiers is the signal to watch.",
	"",
];

// The markdown block for a single milestone. Concatenated onto a file that already ends in the
// prior block's trailing blank line, this reproduces Python's full re-render byte-for-byte while
// leaving every existing row untouched.
function renderSection(rec: MilestoneRecord): string {
	const seg = [
		`## ${rec.milestone}  (\`${rec.sha}\`, ${rec.captured.slice(0, 10)}, ${rec.corpus_scenarios} scenarios, trials ${rec.trials})`,
		"",
		"| model | control | harness | lift | corrupt |",
		"|---|---|---|---|---|",
	];
	for (const m of rec.models) {
		const lift = m.lift !== null ? fmtLift(m.lift) : "-";
		seg.push(`| \`${m.model}\` | ${fmtNum(m.control)} | ${fmtNum(m.harness)} | ${lift} | ${m.corrupt} |`);
	}
	if (rec.note) seg.push("", `_${rec.note}_`);
	seg.push("");
	return `${seg.join("\n")}\n`;
}

function main(argv: string[]): void {
	let outDir = DEFAULT_RESULTS;
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") {
			outDir = argv[++i] ?? outDir;
		} else {
			positionals.push(argv[i]);
		}
	}
	if (positionals.length < 3) {
		console.log("usage: milestone-ledger.ts [--out <dir>] <label> <sha> <runs.json> [<runs.json> ...]");
		process.exit(1);
	}
	const [label, sha, ...paths] = positionals;
	const note = process.env.FM_MILESTONE_NOTE ?? "";
	const id2tier = new Map(loadScenarios().map((s) => [s.id, s.difficulty] as const));

	const models = paths.map((p) => macroFor(JSON.parse(readFileSync(p, "utf8")) as RunPayload, id2tier));
	const trials = models.find((m) => m.trials !== null)?.trials ?? null;
	const corpus = models.length ? Math.max(...models.map((m) => m.scenarios)) : 0;
	const rec: MilestoneRecord = {
		// mirror Python datetime.now(timezone.utc).isoformat(): microseconds + "+00:00" offset.
		captured: new Date().toISOString().replace("Z", "000+00:00"),
		milestone: label,
		sha,
		corpus_scenarios: corpus,
		trials,
		note,
		models,
	};

	const jsonlPath = join(outDir, "milestones.jsonl");
	const mdPath = join(outDir, "milestones.md");
	mkdirSync(dirname(jsonlPath), { recursive: true });
	appendFileSync(jsonlPath, `${recordToJsonl(rec)}\n`);

	const section = renderSection(rec);
	if (existsSync(mdPath) && readFileSync(mdPath, "utf8").length > 0) {
		appendFileSync(mdPath, section);
	} else {
		writeFileSync(mdPath, `${MD_HEADER.join("\n")}\n${section}`);
	}

	console.log(`milestone '${label}' appended: ${models.length} models, corpus ${corpus}, trials ${trials}`);
	for (const m of models) {
		if (m.lift !== null) {
			console.log(
				`  ${m.model.padEnd(22)} control ${fmtNum(m.control)} -> harness ${fmtNum(m.harness)} (lift ${fmtLift(m.lift)}) corrupt ${m.corrupt}`,
			);
		} else {
			console.log(`  ${m.model}: incomplete`);
		}
	}
	console.log(`wrote ${mdPath}`);
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
