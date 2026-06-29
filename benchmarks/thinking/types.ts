// Shared types for the thinking-efficiency bench: a BASELINE-vs-NEW A/B that
// proves a thinking-discipline change cuts reasoning-token cost and latency
// WITHOUT regressing output quality, under a strict adopt-iff rule.
//
// The split that makes this honest: every type here is consumed by PURE,
// deterministic, CI-tested code (corpus loader, oracle, aggregation, decision,
// render). The non-deterministic LLM call lives only in harness.ts/run.ts and
// is flag-gated out of CI; its output is recorded to JSON so the verdict can be
// replayed deterministically offline.

// A deterministic, machine-gradeable quality oracle. Each kind maps produced
// agent output to a score in [0,1]; "pass" is score >= passThreshold (default
// 0.5, so the binary 0/1 kinds below separate cleanly). Quality is NEVER
// subjective: no kind here consults a model or a human.
export type Oracle =
	// Normalized exact match of the model's final answer against `expected`.
	| { kind: "equals"; expected: string; ci?: boolean }
	// Output must contain every needle (normalized). Score = fraction present,
	// so partial credit is possible; pass needs all by default (threshold 1.0
	// when authored as such) - here threshold stays 0.5 unless overridden.
	| { kind: "contains"; needles: string[]; ci?: boolean }
	// Output must match the regex.
	| { kind: "regex"; pattern: string; flags?: string }
	// The first number found in the output must equal `expected` within `tol`.
	| { kind: "numeric"; expected: number; tol?: number };

// One corpus task: a prompt + fixed inline context + an objective oracle. With
// the live runner in --no-tools mode the context is read by the model inline,
// so a task is fully reproducible from this record alone.
export type Task = {
	id: string; // unique within the corpus; also the results key
	title: string; // short human label
	prompt: string; // the instruction (should demand a terse, gradeable answer)
	context?: string; // fixed supporting context, concatenated before the prompt
	oracle: Oracle; // deterministic quality checker
};

// A named A/B variant. The discipline is injected as a system-prompt prefix, so
// a new discipline is a new prefix file with ZERO code change. Baseline carries
// an empty prefix (no added discipline).
export type Variant = {
	name: string; // "baseline" | "new" | any label
	prefix: string; // system-prompt prefix; "" = no injection
};

// One recorded trial: the REAL per-run metrics captured from the harness usage
// report (thinking/output tokens are reported, not estimated) plus the oracle
// result. This is the unit written to results/<stamp>.runs.json and replayed.
export type RunMetric = {
	task: string; // Task.id
	variant: string; // Variant.name
	trial: number; // 0-based trial index
	thinking_tokens: number; // reasoning tokens from the usage report
	output_tokens: number; // visible output tokens from the usage report
	latency_ms: number; // wall time of the model call
	quality: number; // oracle score in [0,1]
	ok: boolean; // the call itself succeeded (false => excluded from quality)
	cost_usd?: number; // optional, for the auditable raw record
	text?: string; // optional truncated produced output, for the raw record
};

// A summary statistic over a sample.
export type Stat = {
	median: number;
	mean: number;
	stddev: number; // population standard deviation (spread)
	n: number;
};

// Per-variant aggregate across corpus x trials.
export type Aggregate = {
	variant: string;
	trials: number; // successful trials counted
	thinking: Stat;
	output: Stat;
	latency_ms: Stat;
	quality_pass_rate: number; // fraction of successful trials with quality >= threshold
	quality_mean: number; // mean oracle score
};

// The adopt-iff decision and its evidence. failingSignals is empty iff adopt.
export type Decision = {
	adopt: boolean;
	baseline: string; // baseline variant name
	candidate: string; // candidate (NEW) variant name
	thinkingTokenDelta: number; // baseline.median - candidate.median (>0 = win)
	thinkingTokenDeltaPct: number; // reduction percent vs baseline
	qualityDelta: number; // candidate.pass_rate - baseline.pass_rate (>=0 required)
	latencyDelta: number; // baseline.median - candidate.median (informational)
	latencyDeltaPct: number;
	failingSignals: string[]; // named on REJECT
};
