// action-bench contract types: the small surface a corpus author implements and
// the engine/gates consume. This module is a LEAF (no intra-bench imports), so it
// carries no side effects and can be imported by every scenario, the engine, and
// the gates without a cycle.
//
// Objective function (firstmate/data/benchmark-principles.md), in order:
//   1. CORRECTNESS incl. procedural = primary. Right outcome via a valid, non-corrupt path.
//   2. COGNITION EFFICIENCY = secondary, on correct runs only: reasoning tokens + turns.
//   3. CAPABILITY = third: performance across the difficulty ladder.

export const DIFFICULTY_ORDER = ["easy", "medium", "hard", "aspirational"] as const;
export type Difficulty = (typeof DIFFICULTY_ORDER)[number];

// ---- captured trace from one live agent run ------------------------------
export interface ToolCall {
	name: string;
	args: string;
	intent: string;
	isError: boolean;
}

export function toolCall(name: string, args = "", intent = "", isError = false): ToolCall {
	return { name, args, intent, isError };
}

export interface Trace {
	ranOk: boolean; // a real assistant turn happened (reasoning tokens optional; model-agnostic)
	reasoningTokens: number;
	turns: number; // agent turns (turn_end events)
	toolCalls: ToolCall[];
	outputText: string;
	error: string;
}

export function trace(
	ranOk: boolean,
	reasoningTokens = 0,
	turns = 0,
	toolCalls: ToolCall[] = [],
	outputText = "",
	error = "",
): Trace {
	return { ranOk, reasoningTokens, turns, toolCalls, outputText, error };
}

// Tool-call names of a trace (a common convenience for graders).
export function traceNames(tr: Trace): string[] {
	return tr.toolCalls.map((t) => t.name);
}

// ---- grader results ------------------------------------------------------
export interface GoalResult {
	correct: boolean; // did it reach the intended outcome (any valid path)
	progress: number; // 0..1 goal progress (partial credit)
	note: string;
}

export function goalResult(correct: boolean, progress: number, note = ""): GoalResult {
	return { correct, progress, note };
}

export interface ProcResult {
	clean: boolean; // path was valid + non-corrupt (no reward-hack / unsafe shortcut)
	note: string;
}

export function procResult(clean: boolean, note = ""): ProcResult {
	return { clean, note };
}

// ---- long-horizon (multi-session) ---------------------------------------
// Evolve the fixture between sessions (new events/tasks); the agent's only memory
// is the fixture on disk.
export type Inject = (dir: string) => void;
// One long-horizon session: [step_task, inject | null].
export type Step = [string, Inject | null];

// goal/procedural receive a single Trace for a single-session scenario, or the
// per-session list of Traces when `steps` is set. Oracles mirror this shape.
export type TraceArg = Trace | Trace[];

// ---- real-history provenance --------------------------------------------
// A scenario is either SYNTHETIC (a hand-built puzzle) or REAL-HISTORY (derived
// from sanitized firstmate operational history). Real-history scenarios carry a
// `history` tag naming the source CLASS they were derived from; only sanitized,
// generic building blocks are ever committed - never raw operational data.
export const SOURCE_CLASSES = ["backlog-done", "state-status", "session-history"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

// ---- scenario contract (what a corpus author implements) -----------------
export interface Scenario {
	id: string;
	difficulty: Difficulty;
	// The prompt: states the OUTCOME, not the actions.
	task: string;
	// Populate the controlled fixture.
	setup: (dir: string) => void;
	// Judge the OUTCOME by end-state (multi-path, never a gold tool sequence).
	goal: (dir: string, tr: TraceArg) => GoalResult;
	// Guard corrupt success / reward-hacking.
	procedural: (dir: string, tr: TraceArg) => ProcResult;
	// Integrity-gate hook: apply the correct solution to dir AND return the Trace
	// (or per-session Traces) of a clean solving path; ground-truth-pinned asserts
	// it scores correct + clean + progress 1.0.
	oracle?: (dir: string) => TraceArg;
	// Solution/answer tokens that must NOT appear in any prompt (no-leak gate).
	leakMarkers: string[];
	// When set, the run is a SEQUENCE of fresh sessions in one persisting fixture.
	steps?: Step[];
	// Set on REAL-HISTORY scenarios: the sanitized operational-history source class
	// this scenario was derived from. Absent = SYNTHETIC. Real-history scenarios are
	// scanned by the sanitize gate (corpus.ts) before any live run.
	history?: { sourceClass: SourceClass };
}
