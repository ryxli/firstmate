#!/usr/bin/env bun
// fm-milestone - one command, one reproducible longitudinal measurement row.
//
// Thin composition layer over instruments that already exist and are already proven:
//   - benchmarks/action-bench/bench.ts  gates | corpus   (pinned scenario corpus, deterministic)
//   - benchmarks/run.ts                 replay            (supervision old-vs-new replay bench)
//   - sbin/fm-context-weight                              (context token weight + per-file table)
//   - tests/*.test.sh                                      (behavior-suite pass/fail counts)
//   - benchmarks/action-bench/milestone-ledger.ts  macroFor  (per-model control/harness macro rows,
//     reused verbatim when --runs <runs.json...> are supplied, so this ledger's `models[]` section
//     is byte-identical in shape to a0e86b0's ledger - a straight superset, not a re-derivation)
//
// Nothing here re-implements a gate; it shells to the real one and folds the result into one row.
// See README.md in this directory for the row schema and the --compare contract.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { macroFor, type ModelMacro } from "../action-bench/milestone-ledger.ts";
import { loadScenarios } from "../action-bench/scenarios/index.ts";
import type { RunPayload } from "../action-bench/engine.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DEFAULT_OUT = join(REPO_ROOT, "benchmarks", "action-bench", "results");

// The tool's own acceptance test is excluded from the measured test corpus below: fm-milestone.sh
// runs `tests/*.test.sh` as one of its stages, and its own test file lives at that same path, so
// including it would make the tool invoke itself from inside its own measurement (unbounded
// recursion). Any file matching this pattern is treated as harness-of-the-harness, not a target.
const SELF_TEST_PATTERN = /^fm-milestone.*\.test\.sh$/;

interface Timed {
	secs: number;
}

interface GateActionBench extends Timed {
	ok: boolean;
	scenarios: number;
}

interface GateCorpus extends Timed {
	ok: boolean;
	total: number;
	synthetic: number;
	real_history: number;
	by_source_class: Record<string, number>;
	by_difficulty: Record<string, number>;
	sanitize_status: string;
}

interface GateSupervision extends Timed {
	ok: boolean;
	verdict: string;
	tokenizer: string;
	totals: {
		old_tokens: number;
		new_tokens: number;
		old_false: number;
		new_false: number;
		old_missed: number;
		new_missed: number;
	};
	reduction_pct: number;
}

interface GateTests extends Timed {
	ok: boolean;
	files: number;
	passed: number;
	failed: number;
	failures: string[];
	assertions: number;
}

interface GateContextWeight extends Timed {
	ok: boolean;
	total_tokens: number;
	tokenizer: string;
	table_hash: string;
}

// The row schema: a SUPERSET of a0e86b0's MilestoneRecord (captured/milestone/sha/corpus_scenarios/
// trials/note/models keep their exact names and meaning) plus new sections this tool adds. A row
// written under the old schema alone (no `gates`/`context_weight`/`schema` keys) is still a valid
// instance with those sections simply absent - historical seeding stays compatible either direction.
export interface MilestoneRow {
	schema: "fm-milestone/v1";
	captured: string;
	milestone: string;
	sha: string;
	corpus_scenarios: number | null;
	trials: number | null;
	note: string;
	models: ModelMacro[];
	gates: {
		action_bench: GateActionBench;
		corpus: GateCorpus;
		supervision: GateSupervision;
		tests: GateTests;
	};
	context_weight: GateContextWeight;
	elapsed_s: number;
}

interface MeasureOpts {
	label: string;
	sha: string;
	captured: string;
	note: string;
	jobs: number;
	runsPaths: string[];
}

async function runCmd(cmd: string[], cwd: string, timeoutMs = 180_000): Promise<{ code: number; stdout: string; stderr: string; secs: number }> {
	const t0 = Date.now();
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		return { code, stdout, stderr, secs: Math.round((Date.now() - t0) / 100) / 10 };
	} finally {
		clearTimeout(timer);
	}
}

async function stageActionBenchGates(root: string): Promise<GateActionBench> {
	const r = await runCmd(["bun", join(root, "benchmarks", "action-bench", "bench.ts"), "gates"], root, 180_000);
	const m = r.stdout.match(/\((\d+) scenarios x \d+ gates\)/);
	return { ok: r.code === 0, scenarios: m ? Number(m[1]) : 0, secs: r.secs };
}

async function stageCorpus(root: string): Promise<GateCorpus> {
	const r = await runCmd(["bun", join(root, "benchmarks", "action-bench", "bench.ts"), "corpus"], root, 60_000);
	let metrics: Record<string, unknown> = {};
	try {
		metrics = JSON.parse(r.stdout);
	} catch {
		// leave metrics empty; ok stays false below
	}
	const sanitization = (metrics.sanitization ?? {}) as { status?: string };
	return {
		ok: sanitization.status === "clean",
		total: Number(metrics.totalScenarios ?? 0),
		synthetic: Number(metrics.synthetic ?? 0),
		real_history: Number(metrics.realHistory ?? 0),
		by_source_class: (metrics.bySourceClass as Record<string, number>) ?? {},
		by_difficulty: (metrics.byDifficulty as Record<string, number>) ?? {},
		sanitize_status: sanitization.status ?? "unknown",
		secs: r.secs,
	};
}

async function stageSupervision(root: string): Promise<GateSupervision> {
	const r = await runCmd(["bun", join(root, "benchmarks", "run.ts"), "replay"], root, 60_000);
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(r.stdout);
	} catch {
		// leave data empty; ok stays false below
	}
	const totals = (data.totals ?? {}) as { old?: Record<string, number>; new?: Record<string, number> };
	const to = totals.old ?? {};
	const tn = totals.new ?? {};
	const oldTok = to.interface_tokens ?? 0;
	const newTok = tn.interface_tokens ?? 0;
	const reduction = oldTok ? Math.round(((oldTok - newTok) / oldTok) * 1000) / 10 : 0;
	return {
		ok: r.code === 0 && typeof data.verdict === "string",
		verdict: (data.verdict as string) ?? "?",
		tokenizer: (data.tokenizer as string) ?? "?",
		totals: {
			old_tokens: oldTok,
			new_tokens: newTok,
			old_false: to.false_wakes ?? 0,
			new_false: tn.false_wakes ?? 0,
			old_missed: to.missed_relevant ?? 0,
			new_missed: tn.missed_relevant ?? 0,
		},
		reduction_pct: reduction,
		secs: r.secs,
	};
}

async function stageContextWeight(root: string): Promise<GateContextWeight> {
	const r = await runCmd(["bun", join(root, "sbin", "fm-context-weight")], root, 60_000);
	const lines = r.stdout.split("\n");
	const totalLine = lines.find((l) => l.startsWith("estimated_total_tokens"));
	const tokLine = lines.find((l) => l.startsWith("tokenizer"));
	const startIdx = lines.indexOf("files");
	const blankAfter = startIdx >= 0 ? lines.indexOf("", startIdx + 1) : -1;
	const tableLines = startIdx >= 0 ? lines.slice(startIdx, blankAfter < 0 ? undefined : blankAfter) : [];
	const hash = createHash("sha256").update(tableLines.join("\n")).digest("hex").slice(0, 16);
	return {
		ok: r.code === 0,
		total_tokens: totalLine ? Number(totalLine.split("\t")[1]) : 0,
		tokenizer: tokLine ? tokLine.split("\t")[1] : "?",
		table_hash: hash,
		secs: r.secs,
	};
}

async function stageTests(root: string, jobs: number, only?: RegExp): Promise<GateTests> {
	const dir = join(root, "tests");
	const files = existsSync(dir)
		? readdirSync(dir)
				.filter((f) => f.endsWith(".test.sh"))
				.filter((f) => !SELF_TEST_PATTERN.test(f))
				.filter((f) => (only ? only.test(f) : true))
				.sort()
		: [];
	const per: Record<string, { code: number; assertions: number }> = {};
	const t0 = Date.now();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const i = next++;
			if (i >= files.length) break;
			const f = files[i];
			const r = await runCmd([join(dir, f)], root, 240_000);
			const assertions = (r.stdout.match(/^\s*(?:ok|pass)\b/gim) ?? []).length;
			per[f] = { code: r.code, assertions };
		}
	};
	const width = Math.min(jobs, files.length) || 1;
	await Promise.all(Array.from({ length: width }, worker));
	const failures = Object.entries(per)
		.filter(([, v]) => v.code !== 0)
		.map(([k]) => k)
		.sort();
	return {
		ok: failures.length === 0,
		files: files.length,
		passed: files.length - failures.length,
		failed: failures.length,
		failures,
		assertions: Object.values(per).reduce((s, v) => s + v.assertions, 0),
		secs: Math.round((Date.now() - t0) / 100) / 10,
	};
}

async function modelsFromRuns(runsPaths: string[]): Promise<ModelMacro[]> {
	if (runsPaths.length === 0) return [];
	const id2tier = new Map(loadScenarios().map((s) => [s.id, s.difficulty] as const));
	return runsPaths.map((p) => macroFor(JSON.parse(readFileSync(p, "utf8")) as RunPayload, id2tier));
}

// Run every stage against `root` (the current worktree for a live milestone, or an isolated
// git-archive snapshot for --compare) and compose one row. Nothing here writes to `root`.
export async function measure(root: string, opts: MeasureOpts): Promise<MilestoneRow> {
	const t0 = Date.now();
	const [actionBench, corpus, supervision, tests, contextWeight, models] = await Promise.all([
		stageActionBenchGates(root),
		stageCorpus(root),
		stageSupervision(root),
		stageTests(root, opts.jobs, process.env.FM_MILESTONE_TESTS_ONLY ? new RegExp(process.env.FM_MILESTONE_TESTS_ONLY) : undefined),
		stageContextWeight(root),
		modelsFromRuns(opts.runsPaths),
	]);
	const trials = models.find((m) => m.trials !== null)?.trials ?? null;
	return {
		schema: "fm-milestone/v1",
		captured: opts.captured,
		milestone: opts.label,
		sha: opts.sha,
		corpus_scenarios: corpus.total || null,
		trials,
		note: opts.note,
		models,
		gates: { action_bench: actionBench, corpus, supervision, tests },
		context_weight: contextWeight,
		elapsed_s: Math.round((Date.now() - t0) / 100) / 10,
	};
}

function nowCaptured(): string {
	// mirror milestone-ledger.ts's captured format: microseconds + "+00:00" offset.
	return new Date().toISOString().replace("Z", "000+00:00");
}

const MD_HEADER = [
	"# firstmate milestone ledger",
	"",
	"Longitudinal composition row: one entry per milestone, quantifying the harness across every " +
		"deterministic instrument at once (action-bench integrity + corpus, supervision replay, " +
		"context weight, behavior-suite pass counts). Superset of the a0e86b0 action-bench ledger " +
		"schema (`captured`/`milestone`/`sha`/`corpus_scenarios`/`trials`/`note`/`models` keep their " +
		"exact meaning); `models[]` is populated only when live action-bench runs.json artifacts are " +
		"passed via `--runs`.",
	"",
];

function fmtGate(ok: boolean): string {
	return ok ? "PASS" : "FAIL";
}

export function renderSection(row: MilestoneRow): string {
	const g = row.gates;
	const seg = [
		`## ${row.milestone}  (\`${row.sha.slice(0, 12)}\`, ${row.captured.slice(0, 10)}, elapsed ${row.elapsed_s}s)`,
		"",
		"| gate | result |",
		"|---|---|",
		`| action-bench gates | ${fmtGate(g.action_bench.ok)} (${g.action_bench.scenarios} scenarios, ${g.action_bench.secs}s) |`,
		`| corpus | ${g.corpus.sanitize_status} (${g.corpus.total} total: ${g.corpus.synthetic} synthetic / ${g.corpus.real_history} real-history, ${g.corpus.secs}s) |`,
		`| supervision | ${g.supervision.verdict} tokens ${g.supervision.totals.old_tokens}->${g.supervision.totals.new_tokens} (${g.supervision.reduction_pct >= 0 ? "-" : "+"}${Math.abs(g.supervision.reduction_pct)}%, ${g.supervision.secs}s) |`,
		`| tests | ${fmtGate(g.tests.ok)} ${g.tests.passed}/${g.tests.files} files, ${g.tests.assertions} assertions (${g.tests.secs}s) |`,
		`| context-weight | ${row.context_weight.total_tokens} tokens (hash \`${row.context_weight.table_hash}\`, ${row.context_weight.secs}s) |`,
	];
	if (row.models.length > 0) {
		seg.push("", "| model | control | harness | lift | corrupt |", "|---|---|---|---|---|");
		for (const m of row.models) {
			const lift = m.lift !== null ? `${m.lift >= 0 ? "+" : ""}${m.lift.toFixed(3)}` : "-";
			seg.push(`| \`${m.model}\` | ${m.control ?? "None"} | ${m.harness ?? "None"} | ${lift} | ${m.corrupt} |`);
		}
	}
	if (row.note) seg.push("", `_${row.note}_`);
	seg.push("");
	return `${seg.join("\n")}\n`;
}

function appendRow(row: MilestoneRow, outDir: string): { jsonlPath: string; mdPath: string } {
	const jsonlPath = join(outDir, "milestones.jsonl");
	const mdPath = join(outDir, "milestones.md");
	mkdirSync(outDir, { recursive: true });
	appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);
	const section = renderSection(row);
	if (existsSync(mdPath) && readFileSync(mdPath, "utf8").length > 0) {
		appendFileSync(mdPath, section);
	} else {
		writeFileSync(mdPath, `${MD_HEADER.join("\n")}\n${section}`);
	}
	return { jsonlPath, mdPath };
}

function gitRevParse(rev: string, cwd: string): string {
	const r = spawnSync("git", ["-C", cwd, "rev-parse", rev], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git rev-parse ${rev} failed: ${r.stderr}`);
	return r.stdout.trim();
}

// Isolated, ephemeral snapshot of `sha` (no .git, no worktree metadata - a plain source tree via
// `git archive`) so --compare can measure a historical SHA without touching the live checkout or
// registering a worktree. Self-cleans; the caller runs the same `measure()` used for a live row.
function archiveSnapshot(sha: string): string {
	const resolved = gitRevParse(sha, REPO_ROOT);
	const dir = mkdtempSync(join(tmpdir(), "fm-milestone-compare-"));
	const arch = spawnSync("git", ["-C", REPO_ROOT, "archive", resolved], { maxBuffer: 1024 * 1024 * 256 });
	if (arch.status !== 0) throw new Error(`git archive ${resolved} failed: ${arch.stderr}`);
	const tar = spawnSync("tar", ["-x", "-C", dir], { input: arch.stdout, maxBuffer: 1024 * 1024 * 256 });
	if (tar.status !== 0) throw new Error(`tar extract for ${resolved} failed: ${tar.stderr}`);
	return dir;
}

function fmtDelta(a: number, b: number): string {
	const d = b - a;
	return `${a} -> ${b} (${d >= 0 ? "+" : ""}${d})`;
}

// --compare <shaA> <shaB>: the auto-A/B hook. Measures baseline and candidate through the IDENTICAL
// gate pipeline (same measure() used for a live milestone row), appends both to the same durable
// ledger under `<label>-baseline` / `<label>-candidate`, and prints a delta table. This is the same
// shape any future harness-change PR uses to prove itself: run twice, diff the deterministic gates.
async function cmdCompare(shaA: string, shaB: string, label: string, outDir: string, jobs: number): Promise<void> {
	console.log(`fm-milestone --compare: baseline ${shaA} vs candidate ${shaB}`);
	const dirs = [archiveSnapshot(shaA), archiveSnapshot(shaB)];
	try {
		const [rowA, rowB] = await Promise.all([
			measure(dirs[0], { label: `${label}-baseline`, sha: gitRevParse(shaA, REPO_ROOT), captured: nowCaptured(), note: "", jobs, runsPaths: [] }),
			measure(dirs[1], { label: `${label}-candidate`, sha: gitRevParse(shaB, REPO_ROOT), captured: nowCaptured(), note: "", jobs, runsPaths: [] }),
		]);
		appendRow(rowA, outDir);
		const { jsonlPath, mdPath } = appendRow(rowB, outDir);
		console.log("");
		console.log(`| metric | baseline (${rowA.sha.slice(0, 8)}) -> candidate (${rowB.sha.slice(0, 8)}) |`);
		console.log("|---|---|");
		console.log(`| action-bench gates | ${fmtGate(rowA.gates.action_bench.ok)} -> ${fmtGate(rowB.gates.action_bench.ok)} |`);
		console.log(`| corpus scenarios | ${fmtDelta(rowA.gates.corpus.total, rowB.gates.corpus.total)} |`);
		console.log(`| supervision tokens | ${fmtDelta(rowA.gates.supervision.totals.new_tokens, rowB.gates.supervision.totals.new_tokens)} |`);
		console.log(`| tests passed | ${fmtDelta(rowA.gates.tests.passed, rowB.gates.tests.passed)}/${rowB.gates.tests.files} |`);
		console.log(`| context-weight tokens | ${fmtDelta(rowA.context_weight.total_tokens, rowB.context_weight.total_tokens)} |`);
		console.log("");
		console.log(`wrote ${jsonlPath} + ${mdPath}`);
	} finally {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	}
}

async function cmdRun(argv: string[]): Promise<void> {
	const positionals: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			flags[a.slice(2)] = argv[++i] ?? "";
		} else {
			positionals.push(a);
		}
	}
	const [label, ...rest] = positionals;
	if (!label) {
		console.error("usage: fm-milestone.sh <label> [sha] [runs.json ...] [--note text] [--out dir] [--captured iso8601] [--jobs n]");
		process.exit(1);
	}
	const maybeSha = rest[0] && !existsSync(rest[0]) ? rest[0] : undefined;
	const runsPaths = (maybeSha ? rest.slice(1) : rest).filter((p) => existsSync(p));
	const sha = maybeSha ?? gitRevParse("HEAD", REPO_ROOT);
	const outDir = flags.out ?? DEFAULT_OUT;
	const jobs = flags.jobs ? Number(flags.jobs) : 4;
	const note = flags.note ?? process.env.FM_MILESTONE_NOTE ?? "";
	const captured = flags.captured ?? nowCaptured();

	const row = await measure(REPO_ROOT, { label, sha, captured, note, jobs, runsPaths });
	const { jsonlPath, mdPath } = appendRow(row, outDir);
	console.log(`milestone '${label}' appended (sha ${sha.slice(0, 12)}, elapsed ${row.elapsed_s}s):`);
	console.log(`  action-bench gates ${fmtGate(row.gates.action_bench.ok)} (${row.gates.action_bench.scenarios} scenarios)`);
	console.log(`  corpus ${row.gates.corpus.sanitize_status} (${row.gates.corpus.total} total)`);
	console.log(`  supervision ${row.gates.supervision.verdict} tokens ${row.gates.supervision.totals.old_tokens}->${row.gates.supervision.totals.new_tokens}`);
	console.log(`  tests ${fmtGate(row.gates.tests.ok)} ${row.gates.tests.passed}/${row.gates.tests.files} files`);
	console.log(`  context-weight ${row.context_weight.total_tokens} tokens (hash ${row.context_weight.table_hash})`);
	console.log(`wrote ${jsonlPath} + ${mdPath}`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "--compare") {
		const [shaA, shaB, label] = argv.slice(1);
		if (!shaA || !shaB) {
			console.error("usage: fm-milestone.sh --compare <shaA> <shaB> [label]");
			process.exit(1);
		}
		await cmdCompare(shaA, shaB, label ?? "compare", DEFAULT_OUT, 4);
		return;
	}
	await cmdRun(argv);
}

if (import.meta.main) {
	await main();
}
