// The live runner + judging + 3-axis aggregation + dual measurement.
//
// Design:
//   - A scenario gives a real agent (omp) a task on a CONTROLLED FIXTURE and a real
//     tool surface. We capture the tool-call TRACE, reasoning tokens, and turns from
//     omp's JSON stream, and judge the FINAL STATE + trace.
//   - Judging is multi-path: goal by end-state/goal-progress (never one gold tool
//     sequence) + a procedural check that guards corrupt success / reward-hacking.
//   - Attribution: vary ONLY the harness (the injected scaffold arm); hold model,
//     tools, corpus, tokenizer constant. Efficiency in tokens+turns, never wall-clock.
//   - Record/replay: raw runs are saved so aggregation replays deterministically.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFFICULTY_ORDER, type Scenario, type ToolCall, type Trace, toolCall, trace, traceNames } from "./types.ts";

// ---- per-run options (model + budget held constant across arms) ----------
export interface RunOpts {
	model: string;
	thinking: string;
	timeout: number; // per-session wall cap, seconds
	omp: string; // omp binary
	jobs: number; // live-run concurrency
}

// ---- one recorded run (the unit written to results/<stamp>.runs.json) -----
export interface RunRecord {
	scenario: string;
	difficulty: string;
	arm: string;
	trial: number;
	fixture: string;
	ranOk?: boolean;
	sessions?: number;
	reasoningTokens?: number;
	turns?: number;
	toolCalls?: string[];
	error?: string;
	goalCorrect?: boolean;
	goalProgress?: number;
	proceduralClean?: boolean;
	correct?: boolean;
	note?: string;
	// folded in by attachOmpStats (dual measurement)
	genTokens?: number | null;
	wallMs?: number | null;
	ttftMs?: number | null;
	throughputTps?: number | null;
	costUsd?: number | null;
	ompRequests?: number | null;
	statsError?: string;
}

// ---- the live runner -----------------------------------------------------
export function parseStream(stdout: string): Trace {
	let reasoning = 0;
	let turns = 0;
	let text = "";
	const calls: ToolCall[] = [];
	let sawAssistant = false;
	let apiError = "";
	const pending = new Map<string, ToolCall>();
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let ev: StreamEvent;
		try {
			ev = JSON.parse(line) as StreamEvent;
		} catch {
			continue;
		}
		const t = ev.type;
		if (t === "turn_end") {
			turns += 1;
		} else if (t === "tool_execution_start") {
			pending.set(
				String(ev.toolCallId),
				toolCall(ev.toolName ?? "", String(ev.args ?? ""), String(ev.intent ?? ""), false),
			);
		} else if (t === "tool_execution_end") {
			const tc = pending.get(String(ev.toolCallId));
			const isErr = String(ev.isError ?? "").toLowerCase() === "true";
			if (tc) {
				tc.isError = isErr;
				calls.push(tc);
			} else {
				calls.push(toolCall(ev.toolName ?? "", "", "", isErr));
			}
		} else if (t === "message_end") {
			const m = ev.message ?? {};
			if (m.role === "assistant") {
				// A real completed assistant turn vs an API error (e.g. Anthropic 400 with rc=0).
				if (m.stopReason === "error") {
					apiError = String(m.errorMessage ?? "api error").slice(0, 200);
				} else {
					sawAssistant = true;
				}
				const u = m.usage ?? {};
				if (typeof u.reasoningTokens === "number") {
					reasoning += Math.trunc(u.reasoningTokens); // optional: reasoning models only
				}
				for (const b of m.content ?? []) {
					if (b?.type === "text" && typeof b.text === "string") text += b.text;
				}
			}
		}
	}
	const ranOk = sawAssistant && !apiError;
	return trace(ranOk, reasoning, turns, calls, text, apiError);
}


interface StreamMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { reasoningTokens?: number };
	content?: Array<{ type?: string; text?: string }>;
}
interface StreamEvent {
	type?: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	intent?: unknown;
	isError?: unknown;
	message?: StreamMessage;
}

async function runAgentOnce(task: string, fixture: string, armPrefix: string, opts: RunOpts): Promise<Trace> {
	const args = [opts.omp, "-p", "--mode", "json", "--model", opts.model, "--thinking", opts.thinking, "--auto-approve"];
	if (armPrefix) args.push("--append-system-prompt", armPrefix);
	args.push(task);
	const proc = Bun.spawn(args, { cwd: fixture, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, opts.timeout * 1000);
	let stdout = "";
	let stderr = "";
	try {
		stdout = await new Response(proc.stdout).text();
		stderr = await new Response(proc.stderr).text();
		await proc.exited;
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) return trace(false, 0, 0, [], "", `timeout ${opts.timeout}s`);
	const rc = proc.exitCode ?? -1;
	if (rc !== 0) return trace(false, 0, 0, [], "", `exit ${rc}: ${stderr.slice(-160)}`);
	const tr = parseStream(stdout);
	if (!tr.ranOk && !tr.error) tr.error = `model ${opts.model}: no successful assistant turn`;
	return tr;
}

// transient provider errors worth retrying: usage/rate caps, overload, 5xx. A cap
// error means the call did NO work (0 turns), so reusing the same fixture is safe.
const TRANSIENT = ["usage_limit", "usage limit", "rate limit", "rate_limit", "429", "overloaded", "503", "server error"];

function isTransient(err: string): boolean {
	const e = (err || "").toLowerCase();
	return TRANSIENT.some((k) => e.includes(k));
}

export async function runAgent(
	task: string,
	fixture: string,
	armPrefix: string,
	opts: RunOpts,
	retries = 3,
	backoff = 20,
): Promise<Trace> {
	let tr = await runAgentOnce(task, fixture, armPrefix, opts);
	let attempt = 0;
	while (!tr.ranOk && isTransient(tr.error) && attempt < retries) {
		attempt += 1;
		await Bun.sleep(backoff * attempt * 1000);
		tr = await runAgentOnce(task, fixture, armPrefix, opts);
	}
	return tr;
}

// ---- one run: fixture -> agent -> judge ----------------------------------
export async function runOnce(scn: Scenario, armName: string, armPrefix: string, trial: number, opts: RunOpts): Promise<RunRecord> {
	const fixture = mkdtempSync(join(tmpdir(), `actbench-${scn.id}-${armName}-`));
	const rec: RunRecord = {
		scenario: scn.id,
		difficulty: scn.difficulty,
		arm: armName,
		trial,
		fixture: fixture.split("/").pop() ?? fixture,
	};
	try {
		scn.setup(fixture);
		if (scn.steps) {
			// long-horizon: sequential fresh sessions in the same fixture; state carries on disk.
			const traces: Trace[] = [];
			for (const [stepTask, inject] of scn.steps) {
				if (inject) inject(fixture);
				const tr = await runAgent(stepTask, fixture, armPrefix, opts);
				traces.push(tr);
				if (!tr.ranOk) break;
			}
			const ranOk = traces.length === scn.steps.length && traces.every((t) => t.ranOk);
			rec.ranOk = ranOk;
			rec.sessions = traces.length;
			rec.reasoningTokens = traces.reduce((s, t) => s + t.reasoningTokens, 0);
			rec.turns = traces.reduce((s, t) => s + t.turns, 0);
			rec.toolCalls = traces.flatMap((t) => traceNames(t));
			rec.error = traces.find((t) => t.error)?.error ?? "";
			if (!ranOk) {
				rec.correct = false;
				rec.goalProgress = 0;
				rec.proceduralClean = false;
				rec.note = rec.error || "incomplete session chain";
				return rec;
			}
			const g = scn.goal(fixture, traces);
			const p = scn.procedural(fixture, traces);
			return finishRecord(rec, g, p);
		}
		const tr = await runAgent(scn.task, fixture, armPrefix, opts);
		rec.ranOk = tr.ranOk;
		rec.reasoningTokens = tr.reasoningTokens;
		rec.turns = tr.turns;
		rec.toolCalls = traceNames(tr);
		rec.error = tr.error;
		if (!tr.ranOk) {
			rec.correct = false;
			rec.goalProgress = 0;
			rec.proceduralClean = false;
			rec.note = tr.error;
			return rec;
		}
		const g = scn.goal(fixture, tr);
		const p = scn.procedural(fixture, tr);
		return finishRecord(rec, g, p);
	} catch (e) {
		rec.ranOk = false;
		rec.correct = false;
		rec.goalProgress = 0;
		rec.proceduralClean = false;
		rec.error = `harness error: ${String(e)}`;
		return rec;
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

// CORRECTNESS incl. procedural: correct iff goal AND procedurally clean.
function finishRecord(rec: RunRecord, g: { correct: boolean; progress: number; note: string }, p: { clean: boolean; note: string }): RunRecord {
	rec.goalCorrect = g.correct;
	rec.goalProgress = round(g.progress, 3);
	rec.proceduralClean = p.clean;
	rec.correct = Boolean(g.correct && p.clean);
	rec.note = `goal: ${g.note} | proc: ${p.note}`.replace(/^[ |]+|[ |]+$/g, "");
	return rec;
}

// ---- 3-axis aggregation (difficulty-adaptive Pareto) ---------------------
export interface Stat {
	median: number;
	mean: number;
	n: number;
}

export interface DiffAggregate {
	runs: number;
	correctnessRate: number;
	goalRate: number;
	corruptSuccess: number;
	meanGoalProgress: number;
	genTokensToPass: Stat | null;
	reasoningTokensToPass: Stat | null;
	turnsToPass: Stat | null;
	wallMsToPass: Stat | null;
	ttftMsToPass: Stat | null;
	throughputTps: Stat | null;
	costUsdToPass: Stat | null;
}

export interface ArmAggregate {
	byDifficulty: Partial<Record<string, DiffAggregate>>;
	capabilityFrontier: string;
	overallCorrectness: number;
}

export interface Aggregate {
	arms: Record<string, ArmAggregate>;
}

function round(x: number, digits = 1): number {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	const mid = Math.floor(n / 2);
	return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function statOf(xs: Array<number | null | undefined>): Stat | null {
	const v = xs.filter((x): x is number => x != null);
	if (v.length === 0) return null;
	return { median: round(median(v)), mean: round(mean(v)), n: v.length };
}

export function aggregate(runs: RunRecord[]): Aggregate {
	const armNames = [...new Set(runs.map((r) => r.arm))].sort();
	const out: Aggregate = { arms: {} };
	for (const arm of armNames) {
		const a = runs.filter((r) => r.arm === arm);
		const byDifficulty: Partial<Record<string, DiffAggregate>> = {};
		for (const d of DIFFICULTY_ORDER) {
			const dr = a.filter((r) => r.difficulty === d);
			if (dr.length === 0) continue;
			const correct = dr.filter((r) => r.correct);
			const goalOnly = dr.filter((r) => r.goalCorrect);
			// corrupt success = goal reached but procedurally dirty (reward-hack caught)
			const corrupt = dr.filter((r) => r.goalCorrect && !r.proceduralClean);
			byDifficulty[d] = {
				runs: dr.length,
				correctnessRate: round(correct.length / dr.length, 3),
				goalRate: round(goalOnly.length / dr.length, 3),
				corruptSuccess: corrupt.length,
				meanGoalProgress: round(mean(dr.map((r) => r.goalProgress ?? 0)), 3),
				genTokensToPass: statOf(correct.map((r) => r.genTokens)),
				reasoningTokensToPass: statOf(correct.map((r) => r.reasoningTokens)),
				turnsToPass: statOf(correct.map((r) => r.turns)),
				wallMsToPass: statOf(correct.map((r) => r.wallMs)),
				ttftMsToPass: statOf(correct.map((r) => r.ttftMs)),
				throughputTps: statOf(correct.map((r) => r.throughputTps)),
				costUsdToPass: statOf(correct.map((r) => r.costUsd)),
			};
		}
		// AXIS 3 capability: how far up the difficulty ladder it stays correct
		const cap = DIFFICULTY_ORDER.filter((d) => (byDifficulty[d]?.correctnessRate ?? 0) >= 0.5);
		out.arms[arm] = {
			byDifficulty,
			capabilityFrontier: cap.length ? cap[cap.length - 1] : "none",
			overallCorrectness: a.length ? round(a.filter((r) => r.correct).length / a.length, 3) : 0,
		};
	}
	return out;
}

// ---- measurement: fold omp stats into each run (dual: wall-clock + gen) ---
interface OmpFolderStat {
	folder?: string;
	totalOutputTokens?: number;
	avgDuration?: number;
	avgTtft?: number;
	avgTokensPerSecond?: number;
	totalCost?: number;
	totalRequests?: number;
}

// Per principles.md ## Measurement: record BOTH wall-clock and token generation.
// Source is `omp stats --json` (byFolder). Folder labels are dash-mangled (single-
// dash path bug), so match by the unique temp-folder suffix. Best-effort; leaves
// fields absent on miss so the run still reports tokens+turns.
export function attachOmpStats(runs: RunRecord[], ompBin = "omp"): void {
	let folders: OmpFolderStat[] = [];
	try {
		const r = spawnSync(ompBin, ["stats", "--json"], { encoding: "utf8", timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
		const raw = r.stdout ?? "";
		const data = JSON.parse(raw.slice(raw.indexOf("{"))) as { byFolder?: OmpFolderStat[] }; // strip "Syncing..." preamble
		folders = data.byFolder ?? [];
	} catch (e) {
		for (const r of runs) r.statsError = `omp stats unavailable: ${String(e)}`;
		return;
	}
	const num = (x: unknown): number | null => (typeof x === "number" ? round(x) : null);
	for (const r of runs) {
		const fb = r.fixture;
		const m = fb ? folders.find((f) => String(f.folder ?? "").endsWith(fb)) : undefined;
		if (!m) continue;
		r.genTokens = m.totalOutputTokens ?? null; // generation (reproducible primary)
		r.wallMs = num(m.avgDuration); // wall-clock per request (noisy secondary)
		r.ttftMs = num(m.avgTtft);
		r.throughputTps = num(m.avgTokensPerSecond); // reconciles wall <-> tokens
		r.costUsd = m.totalCost ?? null;
		r.ompRequests = m.totalRequests ?? null;
	}
}

// ---- markdown render -----------------------------------------------------
export interface RunPayload {
	capturedUtc: string;
	sha: string;
	model: string;
	thinking: string;
	trials: number;
	elapsedS: number;
	runs: RunRecord[];
	aggregate: Aggregate;
}

export function renderMd(p: RunPayload): string {
	const L: string[] = [
		"# action-bench result",
		"",
		`- SHA under test: \`${p.sha || "n/a"}\` | model \`${p.model}\` thinking \`${p.thinking}\` | trials ${p.trials} | ${p.elapsedS}s`,
		"- Axes: (1) correctness incl. procedural [primary] (2) cost-of-pass efficiency on correct runs - " +
			"token-generation [reproducible primary] + wall-clock [noisy secondary] + throughput [reconciler], plus reasoning tokens & turns (3) capability across difficulty",
		"",
	];
	for (const [arm, a] of Object.entries(p.aggregate.arms)) {
		L.push(
			`## arm: ${arm}`,
			`overall correctness ${a.overallCorrectness} | capability frontier: **${a.capabilityFrontier}**`,
			"",
			"| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput t/s |",
			"|---|---|---|---|---|---|---|---|---|---|",
		);
		for (const d of DIFFICULTY_ORDER) {
			const b = a.byDifficulty[d];
			if (!b) continue;
			const m = (s: Stat | null): string => (s ? String(s.median) : "-");
			L.push(
				`| ${d} | ${b.correctnessRate} | ${b.goalRate} | ${b.corruptSuccess} | ${b.meanGoalProgress} | ` +
					`${m(b.genTokensToPass)} | ${m(b.reasoningTokensToPass)} | ${m(b.turnsToPass)} | ${m(b.wallMsToPass)} | ${m(b.throughputTps)} |`,
			);
		}
		L.push("");
	}
	return `${L.join("\n")}\n`;
}
