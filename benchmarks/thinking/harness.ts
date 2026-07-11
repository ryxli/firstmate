// The LIVE path: drive the real harness once per (task, variant, trial) and
// capture the REAL usage report. This module is the ONLY non-deterministic part
// of the bench; it is flag-gated by run.ts and never runs in CI. Its output is
// recorded to JSON so the verdict can be replayed deterministically offline.
//
// Mechanism: `omp -p --mode json` emits a JSONL event stream whose assistant
// `message_end` events carry a usage object with `reasoningTokens` (the real
// thinking-token count), `output` (visible output tokens), and `cost`. We sum
// those across assistant messages, concatenate the produced text, time the wall
// latency around the call, and grade the text with the task oracle.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gradeOutput } from "./oracle.ts";
import type { RunMetric, Task, Variant } from "./types.ts";

// Read a variant prefix file, dropping `#` comment lines and trimming. An
// empty result (e.g. baseline.txt) means "inject no discipline".
export function loadVariantPrefix(file: string): string {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n")
		.trim();
}

export type HarnessOpts = {
	model: string; // e.g. "gpt-5.4-mini"
	thinking: string; // off|minimal|low|medium|high|xhigh|auto
	timeoutMs: number; // per-call wall cap
	ompBin: string; // omp binary (default "omp")
};

// Parsed signal from one omp JSONL stream.
type ParsedRun = { thinkingTokens: number; outputTokens: number; costUsd: number; text: string; sawReasoning: boolean };

// Sum reasoning/output tokens and concatenate text across all assistant
// `message_end` events in the JSONL stream. Only final (`message_end`) events
// are counted, so partial `message_update` usage is never double-added.
function parseOmpStream(stdout: string): ParsedRun {
	let thinkingTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	let text = "";
	let sawReasoning = false;
	for (const line of stdout.split("\n")) {
		if (line.length === 0) continue;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line);
		} catch {
			continue; // non-JSON noise (rare); ignore
		}
		if (ev.type !== "message_end") continue;
		const msg = ev.message as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const usage = msg.usage as Record<string, unknown> | undefined;
		if (usage) {
			if (typeof usage.reasoningTokens === "number") {
				thinkingTokens += usage.reasoningTokens;
				sawReasoning = true;
			}
			if (typeof usage.output === "number") outputTokens += usage.output;
			const cost = usage.cost as Record<string, unknown> | undefined;
			if (cost && typeof cost.total === "number") costUsd += cost.total;
		}
		for (const block of (msg.content as Array<Record<string, unknown>>) ?? []) {
			if (block.type === "text" && typeof block.text === "string") text += block.text;
		}
	}
	return { thinkingTokens, outputTokens, costUsd, text, sawReasoning };
}

// Run one trial: build the full prompt (context then prompt), invoke omp, parse
// the usage, grade the output. A non-zero exit, a timeout, or no parsed
// assistant message yields ok=false (excluded from the aggregates).
export function runTrial(task: Task, variant: Variant, trial: number, opts: HarnessOpts): RunMetric {
	const fullPrompt = [task.context ?? "", task.prompt].filter((p) => p.length > 0).join("\n\n");
	const args = ["-p", "--mode", "json", "--model", opts.model, "--no-tools", "--thinking", opts.thinking];
	if (variant.prefix.length > 0) args.push("--append-system-prompt", variant.prefix);
	args.push(fullPrompt);

	const started = Date.now();
	const res = spawnSync(opts.ompBin, args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: opts.timeoutMs,
	});
	const latency_ms = Date.now() - started;

	const base: RunMetric = {
		task: task.id,
		variant: variant.name,
		trial,
		thinking_tokens: 0,
		output_tokens: 0,
		latency_ms,
		quality: 0,
		ok: false,
	};

	if (res.status !== 0 || res.error) {
		return { ...base, text: `ERROR: ${res.error ? res.error.message : `exit ${res.status}`}` };
	}
	const parsed = parseOmpStream(res.stdout ?? "");
	if (!parsed.sawReasoning) {
		// No reasoning-token signal: a wrong-model misconfiguration would silently
		// record 0 thinking tokens and corrupt the verdict. Fail this trial loud.
		return { ...base, text: `ERROR: model ${opts.model} reported no reasoningTokens; choose a reasoning model` };
	}
	return {
		task: task.id,
		variant: variant.name,
		trial,
		thinking_tokens: parsed.thinkingTokens,
		output_tokens: parsed.outputTokens,
		latency_ms,
		quality: gradeOutput(parsed.text, task.oracle),
		ok: true,
		cost_usd: parsed.costUsd,
		text: parsed.text.slice(0, 200),
	};
}
