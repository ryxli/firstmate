// Thinking-efficiency bench CLI. Subcommands:
//
//   check-corpus [dir]              validate the corpus, print task count (pure)
//   grade <oracle.json> <out-file> score one output with an oracle (pure)
//   replay <runs.json> [--out DIR] rebuild the verdict from a recording (pure)
//   record [--live] [flags]        LIVE A/B against the real harness (gated)
//
// Only `record` touches an LLM, and it refuses to run without --live or
// FM_THINK_BENCH_LIVE=1, so this file is safe to drive from CI for everything
// except record. See README.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadCorpus, validateOracle } from "./corpus.ts";
import { gradeOutput } from "./oracle.ts";
import { loadVariantPrefix, runTrial, type HarnessOpts } from "./harness.ts";
import { buildReportData, renderJson, renderMarkdown, type ReportMeta } from "./render.ts";
import type { RunMetric, Variant } from "./types.ts";

const HERE = import.meta.dir;
const DEFAULT_CORPUS = join(HERE, "corpus");
const DEFAULT_RESULTS = join(HERE, "results");
const VARIANTS = join(HERE, "variants");

// Parse `--flag value` / `--flag` (boolean) plus bare positionals.
function parseArgs(argv: readonly string[]): { positionals: string[]; flags: Record<string, string | true> } {
	const positionals: string[] = [];
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i += 1;
			} else {
				flags[key] = true;
			}
		} else {
			positionals.push(a);
		}
	}
	return { positionals, flags };
}

function cmdCheckCorpus(dir: string): void {
	const tasks = loadCorpus(dir);
	process.stdout.write(`ok: ${tasks.length} tasks\n`);
	for (const t of tasks) process.stdout.write(`- ${t.id} (${t.oracle.kind}): ${t.title}\n`);
}

function cmdGrade(oracleFile: string, outputFile: string): void {
	const oracle = validateOracle(JSON.parse(readFileSync(oracleFile, "utf8")), oracleFile);
	const output = readFileSync(outputFile, "utf8");
	process.stdout.write(`${gradeOutput(output, oracle)}\n`);
}

// Build report data from a recorded runs file and emit md+json. Used by replay
// and (after recording) by record - the deterministic tail shared by both.
function emitReport(metrics: readonly RunMetric[], meta: ReportMeta, outDir: string, base: string): void {
	const data = buildReportData(metrics, meta);
	const md = renderMarkdown(data);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, `${base}.md`), `${md}\n`);
	writeFileSync(join(outDir, `${base}.json`), `${JSON.stringify(renderJson(data), null, 2)}\n`);
	process.stdout.write(`${md}\n`);
}

function cmdReplay(runsFile: string, flags: Record<string, string | true>): void {
	const parsed = JSON.parse(readFileSync(runsFile, "utf8")) as { meta: ReportMeta; metrics: RunMetric[] };
	if (!parsed.meta || !Array.isArray(parsed.metrics)) throw new Error(`${runsFile}: expected { meta, metrics }`);
	const data = buildReportData(parsed.metrics, parsed.meta);
	process.stdout.write(`${renderMarkdown(data)}\n`);
	const out = typeof flags.out === "string" ? flags.out : undefined;
	if (out) {
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "verdict.md"), `${renderMarkdown(data)}\n`);
		writeFileSync(join(out, "verdict.json"), `${JSON.stringify(renderJson(data), null, 2)}\n`);
	}
}

function cmdRecord(flags: Record<string, string | true>): void {
	if (!flags.live && process.env.FM_THINK_BENCH_LIVE !== "1")
		throw new Error("record is the LIVE path (calls a real model). Pass --live or set FM_THINK_BENCH_LIVE=1.");

	const model = typeof flags.model === "string" ? flags.model : "gpt-5.4-mini";
	const thinking = typeof flags.thinking === "string" ? flags.thinking : "medium";
	const trials = typeof flags.trials === "string" ? Number(flags.trials) : 3;
	if (!Number.isInteger(trials) || trials < 1) throw new Error(`--trials must be a positive integer, got ${flags.trials}`);
	const corpusDir = typeof flags.corpus === "string" ? flags.corpus : DEFAULT_CORPUS;
	const outDir = typeof flags.out === "string" ? flags.out : DEFAULT_RESULTS;
	const baselineFile = typeof flags.baseline === "string" ? flags.baseline : join(VARIANTS, "baseline.txt");
	const newFile = typeof flags.new === "string" ? flags.new : join(VARIANTS, "decide-once.txt");

	const variants: Variant[] = [
		{ name: basename(baselineFile).replace(/\.txt$/, ""), prefix: loadVariantPrefix(baselineFile) },
		{ name: basename(newFile).replace(/\.txt$/, ""), prefix: loadVariantPrefix(newFile) },
	];

	let tasks = loadCorpus(corpusDir);
	if (typeof flags.tasks === "string") {
		const want = new Set(flags.tasks.split(","));
		tasks = tasks.filter((t) => want.has(t.id));
		if (tasks.length === 0) throw new Error(`--tasks matched no corpus task: ${flags.tasks}`);
	}

	const opts: HarnessOpts = { model, thinking, timeoutMs: 180000, ompBin: typeof flags.omp === "string" ? flags.omp : "omp" };
	const metrics: RunMetric[] = [];
	const total = tasks.length * variants.length * trials;
	let done = 0;
	for (const task of tasks) {
		for (const variant of variants) {
			for (let trial = 0; trial < trials; trial += 1) {
				const m = runTrial(task, variant, trial, opts);
				metrics.push(m);
				done += 1;
				process.stderr.write(
					`[${done}/${total}] ${task.id} ${variant.name} #${trial}: ${m.ok ? `think=${m.thinking_tokens} out=${m.output_tokens} q=${m.quality} ${m.latency_ms}ms` : `FAILED ${m.text ?? ""}`}\n`,
				);
			}
		}
	}

	const stamp = new Date().toISOString();
	const meta: ReportMeta = {
		stamp,
		model,
		thinking,
		baseline: variants[0].name,
		candidate: variants[1].name,
		corpusSize: tasks.length,
		trialsPerCell: trials,
	};
	const base = stamp.replace(/[:.]/g, "-");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, `${base}.runs.json`), `${JSON.stringify({ meta, metrics }, null, 2)}\n`);
	emitReport(metrics, meta, outDir, base);
	process.stderr.write(`\nWrote ${join(outDir, `${base}.runs.json`)} (+ .md/.json)\n`);
}

function main(): void {
	const [cmd, ...rest] = process.argv.slice(2);
	const { positionals, flags } = parseArgs(rest);
	switch (cmd) {
		case "check-corpus":
			cmdCheckCorpus(positionals[0] ?? DEFAULT_CORPUS);
			return;
		case "grade":
			if (positionals.length < 2) throw new Error("usage: grade <oracle.json> <output-file>");
			cmdGrade(positionals[0], positionals[1]);
			return;
		case "replay":
			if (positionals.length < 1) throw new Error("usage: replay <runs.json> [--out DIR]");
			cmdReplay(positionals[0], flags);
			return;
		case "record":
			cmdRecord(flags);
			return;
		default:
			process.stderr.write("usage: run.ts <check-corpus|grade|replay|record> [args]\n");
			process.exit(2);
	}
}

try {
	main();
} catch (e) {
	process.stderr.write(`error: ${(e as Error).message}\n`);
	process.exit(1);
}
