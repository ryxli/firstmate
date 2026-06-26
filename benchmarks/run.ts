// Benchmark runner: replay every scenario through OLD and NEW, validate the
// ground truth, write a markdown evidence table + raw JSON under results/.
//
//   bun benchmarks/run.ts
//
// Deterministic: all metric numbers are identical on re-run (only the results
// filename/header timestamp varies, by design).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalRelevant } from "./relevance.ts";
import { modelOld } from "./old.ts";
import { modelNew } from "./new.ts";
import { SCENARIOS } from "./scenarios.ts";
import { tokenizerBackend } from "./tokenizer.ts";
import type { Components, SystemResult } from "./old.ts";
import type { Metrics, Scenario } from "./types.ts";

// Fail fast if any authored `relevant` field disagrees with the contract rule:
// the corpus must be self-consistent or the numbers are meaningless.
function assertGroundTruth(scenarios: readonly Scenario[]): void {
	for (const s of scenarios) {
		for (let i = 0; i < s.events.length; i += 1) {
			const e = s.events[i];
			const expected = canonicalRelevant(e);
			if (e.relevant !== expected) {
				throw new Error(
					`ground-truth mismatch in ${s.name}[${i}] (${e.kind}): authored relevant=${e.relevant}, contract rule=${expected}`,
				);
			}
		}
	}
}

type Row = { scenario: string; feature: string; old: Metrics; new: Metrics; oldC: Components; newC: Components };

// Per-scenario NEW verdict under the decision rule (fewer tokens, no more false
// wakes, zero misses). Applied corpus-wide too for the authoritative call.
function verdict(o: Metrics, n: Metrics): string {
	if (n.missed_relevant > 0) return "REGRESSION (missed)";
	// NEW catches a relevant event OLD drops on the floor (e.g. herdr-native
	// blocked with no status line): a recall win regardless of token delta.
	if (o.missed_relevant > n.missed_relevant) return "NEW win (recall)";
	if (n.false_wakes > o.false_wakes) return "REGRESSION (false)";
	if (n.interface_tokens < o.interface_tokens) return "NEW win";
	if (n.interface_tokens === o.interface_tokens) return "tie";
	return "OLD win";
}

function pct(oldV: number, newV: number): string {
	// OLD spending 0 means it acted on nothing (a miss): a reduction figure is
	// meaningless, so flag it rather than printing +inf.
	if (oldV === 0) return newV === 0 ? "0%" : "n/a";
	return `${Math.round(((oldV - newV) / oldV) * 1000) / 10}%`;
}

function sumComponents(rows: readonly Components[]): Components {
	const out: Components = {};
	for (const c of rows) {
		for (const [k, v] of Object.entries(c)) out[k] = (out[k] ?? 0) + v;
	}
	return out;
}

function buildMarkdown(rows: readonly Row[], stamp: string): string {
	const totOld = { wakes: 0, tokens: 0, false: 0, missed: 0, detected: 0 };
	const totNew = { wakes: 0, tokens: 0, false: 0, missed: 0, detected: 0 };
	for (const r of rows) {
		totOld.wakes += r.old.wakes;
		totOld.tokens += r.old.interface_tokens;
		totOld.false += r.old.false_wakes;
		totOld.missed += r.old.missed_relevant;
		totOld.detected += r.old.detected_relevant;
		totNew.wakes += r.new.wakes;
		totNew.tokens += r.new.interface_tokens;
		totNew.false += r.new.false_wakes;
		totNew.missed += r.new.missed_relevant;
		totNew.detected += r.new.detected_relevant;
	}

	const L: string[] = [];
	L.push("# Supervision interface-efficiency benchmark: OLD vs NEW");
	L.push("");
	L.push(`Run: ${stamp}`);
	L.push(`Tokenizer: ${tokenizerBackend} (identical for both systems)`);
	L.push(`Scenarios: ${rows.length} (constant corpus). Deterministic: numbers identical on re-run.`);
	L.push("");
	L.push("`interface_tokens` = the LLM-facing cost the supervisor must INGEST to act on each wake.");
	L.push("OLD = reason line + drained wake-queue records + FULL status files + (stale) 40-line peek + drain/re-arm ceremony;");
	L.push("afk OLD = daemon batched flush + the still-mandatory queue-drain backstop (no re-arm).");
	L.push("NEW = the injected self-contained digest(s) only; a STALE digest additionally pays the same 40-line peek (it directs a peek).");
	L.push("");

	L.push("## Per-scenario evidence");
	L.push("");
	L.push("| scenario | feature | wakes O/N | interface_tokens O/N | reduction | false_wakes O/N | missed O/N | verdict |");
	L.push("|---|---|---|---|---|---|---|---|");
	for (const r of rows) {
		L.push(
			`| ${r.scenario} | ${r.feature} | ${r.old.wakes}/${r.new.wakes} | ${r.old.interface_tokens}/${r.new.interface_tokens} | ${pct(r.old.interface_tokens, r.new.interface_tokens)} | ${r.old.false_wakes}/${r.new.false_wakes} | ${r.old.missed_relevant}/${r.new.missed_relevant} | ${verdict(r.old, r.new)} |`,
		);
	}
	L.push(
		`| **TOTAL** | all | **${totOld.wakes}/${totNew.wakes}** | **${totOld.tokens}/${totNew.tokens}** | **${pct(totOld.tokens, totNew.tokens)}** | **${totOld.false}/${totNew.false}** | **${totOld.missed}/${totNew.missed}** | ${verdict({ system: "old", scenario: "total", wakes: totOld.wakes, interface_tokens: totOld.tokens, false_wakes: totOld.false, detected_relevant: totOld.detected, missed_relevant: totOld.missed }, { system: "new", scenario: "total", wakes: totNew.wakes, interface_tokens: totNew.tokens, false_wakes: totNew.false, detected_relevant: totNew.detected, missed_relevant: totNew.missed })} |`,
	);
	L.push("");

	L.push("## Decision rule (corpus-wide, authoritative)");
	L.push("");
	L.push("Adopt NEW iff: interface_tokens(new) < interface_tokens(old) AND false_wakes(new) <= false_wakes(old) AND missed_relevant(new) == 0.");
	L.push("");
	const ruleTokens = totNew.tokens < totOld.tokens;
	const ruleFalse = totNew.false <= totOld.false;
	const ruleMissed = totNew.missed === 0;
	const adopt = ruleTokens && ruleFalse && ruleMissed;
	L.push(`- interface_tokens(new) < interface_tokens(old): ${totNew.tokens} < ${totOld.tokens} -> ${ruleTokens ? "PASS" : "FAIL"}`);
	L.push(`- false_wakes(new) <= false_wakes(old): ${totNew.false} <= ${totOld.false} -> ${ruleFalse ? "PASS" : "FAIL"}`);
	L.push(`- missed_relevant(new) == 0: ${totNew.missed} -> ${ruleMissed ? "PASS" : "FAIL"}`);
	L.push("");
	L.push(`### VERDICT: ${adopt ? "ADOPT NEW" : "DO NOT ADOPT"} (token reduction ${pct(totOld.tokens, totNew.tokens)})`);
	L.push("");

	L.push("## Per-feature verdict");
	L.push("");
	L.push("| feature | scenario | reduction | false O/N | missed O/N | verdict |");
	L.push("|---|---|---|---|---|---|");
	for (const r of rows) {
		L.push(
			`| ${r.feature} | ${r.scenario} | ${pct(r.old.interface_tokens, r.new.interface_tokens)} | ${r.old.false_wakes}/${r.new.false_wakes} | ${r.old.missed_relevant}/${r.new.missed_relevant} | ${verdict(r.old, r.new)} |`,
		);
	}
	L.push("");

	L.push("## Token component breakdown (corpus totals, auditable)");
	L.push("");
	const oldComp = sumComponents(rows.map((r) => r.oldC));
	const newComp = sumComponents(rows.map((r) => r.newC));
	L.push("OLD components:");
	for (const [k, v] of Object.entries(oldComp)) L.push(`- ${k}: ${v}`);
	L.push("");
	L.push("NEW components:");
	for (const [k, v] of Object.entries(newComp)) L.push(`- ${k}: ${v}`);
	L.push("");

	L.push("## Modeling notes");
	L.push("");
	L.push("- Relevance uses the exact bin/fm-classify-status.sh regex; run.ts asserts every authored ground-truth `relevant` equals the contract rule.");
	L.push("- OLD wakes UNCONDITIONALLY on every herdr working->idle (turn-end), even with no captain-relevant status (false wake); NEW does not.");
	L.push("- OLD's herdr scan never wakes on a bare ->blocked/->done transition, so a crewmate frozen on an input dialog (no status line) is MISSED by OLD; NEW's native herdr-blocked detection catches it.");
	L.push("- Stale wakes charge the 40-line peek to BOTH systems (a stale signal is not self-contained); the delta is the drain/re-arm ceremony only.");
	L.push("- Parked-on-green-PR and kind=secondmate panes skip stale in BOTH systems (fm-watch.sh awaiting_merge / secondmate skip), modeled identically - no strawman.");
	L.push("- afk sensitivity: the OLD daemon's batched flush is ALREADY as dense as the NEW digest; the entire afk NEW win is eliminating the AGENTS.md-mandated queue-drain backstop that still runs every escalated turn. If that drain is deemed negligible, afk is a wash. See the afk_flush vs queue components.");
	L.push("- The re-arm ceremony constant is conservative (drain + arm + one confirmation line); it omits guard banners and protocol reminders, so the NEW win is a lower bound.");
	L.push("");

	return L.join("\n");
}

function main(): void {
	assertGroundTruth(SCENARIOS);

	const rows: Row[] = [];
	const rawOld: SystemResult[] = [];
	const rawNew: SystemResult[] = [];
	for (const s of SCENARIOS) {
		const o = modelOld(s);
		const n = modelNew(s);
		rawOld.push(o);
		rawNew.push(n);
		rows.push({ scenario: s.name, feature: s.feature, old: o.metrics, new: n.metrics, oldC: o.components, newC: n.components });
	}

	const stamp = new Date().toISOString();
	const safeStamp = stamp.replace(/[:.]/g, "-");
	const resultsDir = join(import.meta.dir, "results");
	mkdirSync(resultsDir, { recursive: true });

	const md = buildMarkdown(rows, stamp);
	const mdPath = join(resultsDir, `${safeStamp}.md`);
	const jsonPath = join(resultsDir, `${safeStamp}.json`);
	writeFileSync(mdPath, `${md}\n`);
	writeFileSync(
		jsonPath,
		`${JSON.stringify(
			{
				run: stamp,
				tokenizer: tokenizerBackend,
				scenarios: rows.map((r) => ({ scenario: r.scenario, feature: r.feature, old: r.old, new: r.new, oldComponents: r.oldC, newComponents: r.newC })),
			},
			null,
			2,
		)}\n`,
	);

	// Console summary (so a bare `bun benchmarks/run.ts` is informative).
	process.stdout.write(`${md}\n\n`);
	process.stdout.write(`Wrote ${mdPath}\nWrote ${jsonPath}\n`);
}

main();
