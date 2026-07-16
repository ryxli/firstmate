// Deterministic integrity gates (firstmate/data/benchmark-principles.md ## Integrity gates).
//
// Automated hard-asserts that run BEFORE any live result is trusted; a failing gate
// aborts the run. No live model call is needed - every gate is a pure, deterministic
// check on the corpus, the arms, and the graders themselves. This is the benchmark
// policing its own fairness so a result cannot be quietly strawmanned, bench-maxxed,
// or leaked.
//
// Gates enforced:
//   - prompt-symmetry     control and harness get identical task text; the only delta
//                         is the generic harness scaffold, injected on a separate channel.
//   - scaffold-agnostic   the harness scaffold names no scenario id and carries no
//                         scenario-specific solution token (cannot be tuned to the corpus).
//   - no-leak             a scenario's solution tokens appear in NEITHER arm's prompt.
//   - real-difficulty     a no-op / empty agent FAILS the scenario and the grader can
//                         return < 1.0 (the task is not trivially passable).
//   - ground-truth-pinned applying the scenario's own oracle solution scores exactly
//                         correct + clean + progress 1.0, and grading is deterministic.
//   - real-history-safe   every real-history scenario's fixture/prompt/leak markers are
//                         free of operational data (abs paths, secrets, PII); the
//                         sanitizer self-tests against known poison so it cannot silently
//                         pass unsafe content (corpus.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Arms } from "./arms.ts";
import { poisonScenario, realHistoryScenarios, sanitize } from "./corpus.ts";
import { type Scenario, type Trace, type TraceArg, trace } from "./types.ts";

// An empty / no-op agent: it ran, but did nothing - no tools, no output.
function noopTrace(): Trace {
	return trace(true, 0, 1, [], "");
}

function fresh(scn: Scenario): string {
	const d = mkdtempSync(join(tmpdir(), `gate-${scn.id}-`));
	scn.setup(d);
	return d;
}

// The no-op trace argument shaped for the scenario: a per-session list for long-horizon.
function noopArg(scn: Scenario): TraceArg {
	return scn.steps ? scn.steps.map(() => noopTrace()) : noopTrace();
}

// Evolve the fixture through every long-horizon inject with NO agent action (what a no-op faces).
function applyInjects(scn: Scenario, d: string): void {
	if (scn.steps) {
		for (const [, inject] of scn.steps) {
			if (inject) inject(d);
		}
	}
}

// All prompt texts for a scenario: the top-level task plus every long-horizon step task.
function taskTexts(scn: Scenario): string[] {
	return scn.steps ? [scn.task, ...scn.steps.map(([t]) => t)] : [scn.task];
}

function isTrace(x: unknown): x is Trace {
	return typeof x === "object" && x != null && typeof (x as Trace).ranOk === "boolean";
}

// ---- individual gates: each returns list of failures (empty = pass) ------

function gatePromptSymmetry(scenarios: Scenario[], arms: Arms): string[] {
	const fails: string[] = [];
	if ((arms.control ?? "MISSING") !== "") {
		fails.push("control arm must be the empty scaffold (the floor); it carries text");
	}
	for (const scn of scenarios) {
		for (const txt of taskTexts(scn)) {
			for (const [an, at] of Object.entries(arms)) {
				if (at && txt.includes(at)) {
					fails.push(`${scn.id}: arm '${an}' scaffold text is baked into a task prompt (asymmetry)`);
				}
			}
		}
	}
	return fails;
}

function gateScaffoldAgnostic(scenarios: Scenario[], arms: Arms): string[] {
	const fails: string[] = [];
	const ids = scenarios.map((s) => s.id);
	for (const [an, at] of Object.entries(arms)) {
		if (!at) continue;
		for (const sid of ids) {
			if (at.includes(sid)) fails.push(`arm '${an}' names scenario id '${sid}' (corpus-tuned scaffold)`);
		}
		for (const scn of scenarios) {
			for (const mk of scn.leakMarkers) {
				if (mk && at.includes(mk)) fails.push(`arm '${an}' contains solution marker '${mk.slice(0, 40)}' of ${scn.id}`);
			}
		}
	}
	return fails;
}

function gateNoLeak(scenarios: Scenario[], arms: Arms): string[] {
	const fails: string[] = [];
	for (const scn of scenarios) {
		if (!scn.leakMarkers.length) {
			fails.push(`${scn.id}: declares no leakMarkers, so no-leak cannot be verified (REQUIRED)`);
			continue;
		}
		for (const mk of scn.leakMarkers) {
			for (const txt of taskTexts(scn)) {
				if (mk && txt.includes(mk)) fails.push(`${scn.id}: solution marker '${mk.slice(0, 40)}' appears in a task prompt (leak)`);
			}
			for (const [an, at] of Object.entries(arms)) {
				if (mk && at && at.includes(mk)) fails.push(`${scn.id}: solution marker '${mk.slice(0, 40)}' appears in arm '${an}' (leak)`);
			}
		}
	}
	return fails;
}

function gateRealDifficulty(scenarios: Scenario[], _arms: Arms): string[] {
	const fails: string[] = [];
	for (const scn of scenarios) {
		const d = fresh(scn);
		try {
			applyInjects(scn, d); // a no-op agent still faces every injected event
			const noop = noopArg(scn);
			const g = scn.goal(d, noop);
			const p = scn.procedural(d, noop);
			if (g.correct && p.clean) {
				fails.push(`${scn.id}: a no-op agent PASSES it (not real difficulty) [goal=${g.correct} proc_clean=${p.clean}]`);
			}
			if (g.progress >= 1.0) {
				fails.push(`${scn.id}: no-op goal progress is ${g.progress} (grader cannot drop below 1.0)`);
			}
		} catch (e) {
			fails.push(`${scn.id}: grader raised on the no-op trace: ${String(e)}`);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	}
	return fails;
}

function gateGroundTruthPinned(scenarios: Scenario[], _arms: Arms): string[] {
	const fails: string[] = [];
	for (const scn of scenarios) {
		if (!scn.oracle) {
			fails.push(`${scn.id}: declares no oracle, so ground truth cannot be pinned (REQUIRED)`);
			continue;
		}
		const d = fresh(scn);
		try {
			const tr = scn.oracle(d);
			const goodType = scn.steps ? Array.isArray(tr) && tr.length > 0 && tr.every(isTrace) : isTrace(tr);
			if (!goodType) {
				fails.push(`${scn.id}: oracle must return ${scn.steps ? "a list of Traces" : "a Trace"} of the clean solving path`);
				continue;
			}
			const g1 = scn.goal(d, tr);
			const p1 = scn.procedural(d, tr);
			if (!(g1.correct && Math.abs(g1.progress - 1.0) < 1e-9)) {
				fails.push(`${scn.id}: oracle solution does not score 1.0 [goal=${g1.correct} progress=${g1.progress}] :: ${g1.note}`);
			}
			if (!p1.clean) {
				fails.push(`${scn.id}: oracle solution flagged procedurally dirty :: ${p1.note}`);
			}
			// determinism: an identical oracle input must grade identically.
			const d2 = fresh(scn);
			const tr2 = scn.oracle(d2);
			const g2 = scn.goal(d2, tr2);
			const p2 = scn.procedural(d2, tr2);
			rmSync(d2, { recursive: true, force: true });
			const key1 = `${g1.correct}|${round6(g1.progress)}|${p1.clean}`;
			const key2 = `${g2.correct}|${round6(g2.progress)}|${p2.clean}`;
			if (key1 !== key2) fails.push(`${scn.id}: grader is non-deterministic across identical oracle inputs`);
		} catch (e) {
			fails.push(`${scn.id}: oracle/grader raised: ${String(e)}`);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	}
	return fails;
}

// real-history-safe: every REAL-HISTORY scenario's fixture, prompt, and leak markers
// are free of operational data that must never be committed (absolute home paths,
// emails, IPs, private-key headers, credential/secret-like tokens). The sanitizer
// self-tests against known poison first, so a broken matcher fails here rather than
// waving unsafe content through. Honors FM_ACTION_BENCH_POISON=abspath|secret, which
// injects a deliberately-leaking real-history scenario into the scan as a negative
// control (the gate MUST then fail), exercising the same path that guards the corpus.
function gateRealHistorySafe(scenarios: Scenario[], _arms: Arms): string[] {
	const fails: string[] = [];
	const poison = process.env.FM_ACTION_BENCH_POISON;
	const scan = poison === "abspath" || poison === "secret" ? [...scenarios, poisonScenario(poison)] : scenarios;
	const rep = sanitize(scan);
	for (const label of rep.selfTest.missed) fails.push(`sanitizer self-test: poison sample '${label}' went UNFLAGGED (matcher broken)`);
	for (const f of rep.findings) fails.push(`${f.scenario}: unsafe real-history content in ${f.where} [${f.labels.join(", ")}]`);
	if (!realHistoryScenarios(scenarios).length) fails.push("no real-history scenarios present to sanitize (REQUIRED)");
	return fails;
}

function round6(x: number): number {
	return Math.round(x * 1e6) / 1e6;
}

type GateFn = (scenarios: Scenario[], arms: Arms) => string[];

const GATES: Array<[string, GateFn]> = [
	["prompt-symmetry", gatePromptSymmetry],
	["scaffold-agnostic", gateScaffoldAgnostic],
	["no-leak", gateNoLeak],
	["real-difficulty", gateRealDifficulty],
	["ground-truth-pinned", gateGroundTruthPinned],
	["real-history-safe", gateRealHistorySafe],
];

export interface GateReport {
	ok: boolean;
	lines: string[];
}

// Run every gate. Never throws for a gate failure - callers decide whether to abort.
export function runGates(scenarios: Scenario[], arms: Arms, verbose = true): GateReport {
	const lines: string[] = [];
	let allFail: string[] = [];
	for (const [name, fn] of GATES) {
		const fails = fn(scenarios, arms);
		lines.push(`[${fails.length ? `FAIL ${fails.length}` : "PASS"}] ${name}`);
		for (const f of fails) lines.push(`    - ${f}`);
		allFail = allFail.concat(fails);
	}
	const ok = allFail.length === 0;
	lines.push("");
	lines.push(
		`integrity gates: ${ok ? "ALL PASS" : `${allFail.length} FAILURE(S) - result NOT trusted`} (${scenarios.length} scenarios x ${GATES.length} gates)`,
	);
	if (verbose) console.log(lines.join("\n"));
	return { ok, lines };
}

// Hard-assert the whole suite; abort (exit 2) if any gate fails.
export function assertIntegrity(scenarios: Scenario[], arms: Arms): void {
	const { ok } = runGates(scenarios, arms, true);
	if (!ok) process.exit(2);
}
