#!/usr/bin/env bun
// action-bench CLI: the reframed firstmate eval substrate.
//
// A live agentic-coding A/B that isolates the effect of the HARNESS: `control`
// (no scaffold, the floor) vs `harness` (the firstmate discipline scaffold,
// arms/harness.txt). Everything else is held constant, so a metric delta is the
// isolated causal effect of the harness. See README.md and the objective function
// in firstmate/data/benchmark-principles.md.
//
// Subcommands:
//   gates  [--only a,b]                     run the integrity gates and exit (pure; no tokens)
//   replay <runs.json>                      re-aggregate a recorded run and print (pure)
//   run    --live [flags]                   the LIVE A/B against the real harness (costs tokens)
//
// Only `run` touches an LLM, and it refuses without --live or FM_ACTION_BENCH_LIVE=1,
// so gates + replay are safe to drive from CI.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Arms, loadArms } from "./arms.ts";
import { type Aggregate, type RunOpts, type RunPayload, type RunRecord, aggregate, attachOmpStats, renderMd, runOnce } from "./engine.ts";
import { assertIntegrity, runGates } from "./gates.ts";
import { loadScenarios } from "./scenarios/index.ts";
import type { Scenario } from "./types.ts";

const HERE = import.meta.dir;
const SCEN_DIR = join(HERE, "scenarios");
const RESULTS_DIR = join(HERE, "results");
const DEFAULT_ARM = join(HERE, "arms", "harness.txt");

export interface ParsedArgs {
	positionals: string[];
	flags: Record<string, string | true>;
}

// Parse `--flag value` / `--flag` (boolean) plus bare positionals.
function parseArgs(argv: readonly string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positionals.push(a);
		}
	}
	return { positionals, flags };
}

function armsFor(flags: Record<string, string | true>): Arms {
	const armFile = typeof flags["arm-file"] === "string" ? flags["arm-file"] : DEFAULT_ARM;
	const all = loadArms(armFile);
	const want = (typeof flags.arms === "string" ? flags.arms : "control,harness").split(",").filter(Boolean);
	const out: Arms = {};
	for (const k of want) out[k] = all[k] ?? "";
	return out;
}

function onlyFrom(flags: Record<string, string | true>): string[] | undefined {
	const raw = typeof flags.only === "string" ? flags.only.split(",").filter(Boolean) : [];
	return raw.length ? raw : undefined;
}

function cmdGates(flags: Record<string, string | true>): never {
	const scns = loadScenarios(onlyFrom(flags));
	const { ok } = runGates(scns, armsFor(flags), true);
	process.exit(ok ? 0 : 2);
}

function cmdReplay(file: string): void {
	const payload = JSON.parse(readFileSync(file, "utf8")) as { runs: RunRecord[] };
	console.log(JSON.stringify(aggregate(payload.runs), null, 2));
}

// A single live job: (scenario, arm, trial).
interface Job {
	scn: Scenario;
	armName: string;
	armPrefix: string;
	trial: number;
}

async function runPool(jobs: Job[], opts: RunOpts, onDone: (r: RunRecord, done: number) => void): Promise<RunRecord[]> {
	const results: RunRecord[] = new Array(jobs.length);
	let next = 0;
	let done = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const i = next++;
			if (i >= jobs.length) break;
			const j = jobs[i];
			results[i] = await runOnce(j.scn, j.armName, j.armPrefix, j.trial, opts);
			done++;
			onDone(results[i], done);
		}
	};
	const width = Math.min(opts.jobs, jobs.length) || 1;
	await Promise.all(Array.from({ length: width }, () => worker()));
	return results;
}

async function cmdRun(flags: Record<string, string | true>): Promise<void> {
	const live = flags.live === true || process.env.FM_ACTION_BENCH_LIVE === "1";
	if (!live) {
		console.error("run: refusing the live path without --live (or FM_ACTION_BENCH_LIVE=1). It spends tokens.");
		process.exit(1);
	}
	const str = (k: string, d: string): string => (typeof flags[k] === "string" ? (flags[k] as string) : d);
	const int = (k: string, d: number): number => (typeof flags[k] === "string" ? Number.parseInt(flags[k] as string, 10) : d);

	const opts: RunOpts = {
		model: str("model", "gpt-5.4-mini"),
		thinking: str("thinking", "low"),
		timeout: int("timeout", 240),
		omp: str("omp", "omp"),
		jobs: int("jobs", 4),
	};
	const trials = int("trials", 2);
	const sha = str("sha", "");
	const outDir = str("out", RESULTS_DIR);
	mkdirSync(outDir, { recursive: true });

	const scns = loadScenarios(onlyFrom(flags));
	const arms = armsFor(flags);

	// Integrity gates: deterministic hard-asserts that abort before any tokens are spent.
	if (flags["skip-gates"] !== true) assertIntegrity(scns, arms);

	const jobs: Job[] = [];
	for (const scn of scns) {
		for (const [armName, armPrefix] of Object.entries(arms)) {
			for (let t = 0; t < trials; t++) jobs.push({ scn, armName, armPrefix, trial: t });
		}
	}
	console.log(
		`action-bench: ${scns.length} scenarios x ${Object.keys(arms).length} arms x ${trials} trials = ${jobs.length} runs (model=${opts.model}, thinking=${opts.thinking})`,
	);

	const t0 = Date.now();
	const runs = await runPool(jobs, opts, (r, done) => {
		const tok = r.reasoningTokens ?? "?";
		const turns = r.turns ?? "?";
		const err = r.error ? ` (${r.error.slice(0, 40)})` : "";
		console.log(`  [${done}/${jobs.length}] ${r.scenario.padEnd(22)} ${r.arm.padEnd(8)} t${r.trial} -> ${r.correct ? "OK" : "x "} tok=${tok} turns=${turns}${err}`);
	});
	const elapsedS = Math.round((Date.now() - t0) / 100) / 10;

	// Measurement: fold wall-clock + generation + throughput + cost from omp stats.
	attachOmpStats(runs, opts.omp);

	const agg: Aggregate = aggregate(runs);
	const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..*/, "");
	const stem = join(outDir, `actionbench-${(sha || "run").slice(0, 8)}-${ts}`);
	const payload: RunPayload = {
		capturedUtc: new Date().toISOString(),
		sha,
		model: opts.model,
		thinking: opts.thinking,
		trials,
		elapsedS,
		runs,
		aggregate: agg,
	};
	writeFileSync(`${stem}.runs.json`, JSON.stringify(payload, null, 2));
	writeFileSync(`${stem}.md`, renderMd(payload));
	console.log(`\nwrote ${stem}.runs.json + .md  (${elapsedS}s)`);
	console.log(JSON.stringify(agg, null, 2));
}

async function main(): Promise<void> {
	const [cmd, ...rest] = Bun.argv.slice(2);
	const { positionals, flags } = parseArgs(rest);
	switch (cmd) {
		case "gates":
			cmdGates(flags);
			break;
		case "replay": {
			const file = positionals[0];
			if (!file) {
				console.error("replay <runs.json>: missing file");
				process.exit(1);
			}
			cmdReplay(file);
			break;
		}
		case "run":
			await cmdRun(flags);
			break;
		default:
			console.error("usage: bench.ts <gates|replay|run> [flags]  (see README.md)");
			process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}

export { SCEN_DIR, RESULTS_DIR };
