#!/usr/bin/env bun
// Difficulty calibration analyzer.
//
// benchmark-principles.md: a difficulty tier must mean something. A scenario where BOTH arms
// score ~1.0 on EVERY tested model is not discriminating anywhere and should drop a tier. A
// scenario that saturates on a strong model but still discriminates on a weaker one keeps its
// tier (it is real difficulty for that model). This tool prints a per-scenario x per-model
// control/harness correctness matrix and the reclassify-down candidates. It RECOMMENDS only;
// the author applies the difficulty edits to the scenario sources.
//
// Usage: bun calibrate.ts results/<m1>.runs.json results/<m2>.runs.json [...]
import { readFileSync } from "node:fs";
import type { RunPayload } from "./engine.ts";
import { DIFFICULTY_ORDER } from "./types.ts";

const SAT = 0.999; // "~1.0"
const DOWN: Record<string, string> = { medium: "easy", hard: "medium", aspirational: "hard" };

// scenario -> arm -> [correct, total]
type ArmCounts = Map<string, [number, number]>;
type ScenCounts = Map<string, ArmCounts>;

export function perScenario(payload: RunPayload): { counts: ScenCounts; diff: Map<string, string> } {
	const counts: ScenCounts = new Map();
	const diff = new Map<string, string>();
	for (const r of payload.runs) {
		const s = r.scenario;
		diff.set(s, r.difficulty);
		let arms = counts.get(s);
		if (!arms) {
			arms = new Map();
			counts.set(s, arms);
		}
		let pair = arms.get(r.arm);
		if (!pair) {
			pair = [0, 0];
			arms.set(r.arm, pair);
		}
		pair[1] += 1;
		if (r.correct) pair[0] += 1;
	}
	return { counts, diff };
}

// mirror Python f"{x:.2f}" (nan -> "nan").
function fmt2(x: number): string {
	return Number.isNaN(x) ? "nan" : x.toFixed(2);
}

const ORDER = DIFFICULTY_ORDER as readonly string[];

function main(paths: string[]): void {
	if (paths.length === 0) {
		console.log("usage: calibrate.ts <runs.json> [<runs.json> ...]");
		process.exit(1);
	}
	const models: string[] = [];
	const data = new Map<string, ScenCounts>();
	const tier = new Map<string, string>();
	for (const p of paths) {
		const pl = JSON.parse(readFileSync(p, "utf8")) as RunPayload;
		const m = pl.model ?? "?";
		models.push(m);
		const { counts, diff } = perScenario(pl);
		data.set(m, counts);
		for (const [s, d] of diff) tier.set(s, d);
	}

	console.log(
		`${"scenario".padEnd(30)} ${"tier".padEnd(13)} ${models.map((m) => m.slice(0, 11).padStart(13)).join(" ")}   (control/harness)`,
	);

	const cands: Array<[string, string, string]> = [];
	const scenarios = [...tier.keys()].sort((a, b) => {
		const da = ORDER.indexOf(tier.get(a) as string);
		const db = ORDER.indexOf(tier.get(b) as string);
		if (da !== db) return da - db;
		return a < b ? -1 : a > b ? 1 : 0;
	});
	for (const s of scenarios) {
		const cells: string[] = [];
		let satAll = true;
		for (const m of models) {
			const arms = data.get(m)?.get(s);
			const cp = arms?.get("control") ?? [0, 0];
			const hp = arms?.get("harness") ?? [0, 0];
			const cr = cp[1] ? cp[0] / cp[1] : Number.NaN;
			const hr = hp[1] ? hp[0] / hp[1] : Number.NaN;
			cells.push(`${fmt2(cr)}/${fmt2(hr)}`);
			if (!(cr >= SAT && hr >= SAT)) satAll = false;
		}
		const t = tier.get(s) as string;
		let flag = "";
		if (satAll && t !== "easy") {
			flag = `  <= SATURATED -> ${DOWN[t]}`;
			cands.push([s, t, DOWN[t]]);
		}
		console.log(`${s.padEnd(30)} ${t.padEnd(13)} ${cells.map((c) => c.padStart(13)).join(" ")}${flag}`);
	}

	console.log(
		`\nReclassify-down candidates (both arms >= ${SAT.toFixed(3)} on ALL ${models.length} models, tier > easy):`,
	);
	if (cands.length === 0) console.log("  (none)");
	for (const [s, t, nt] of cands) console.log(`  ${s}: ${t} -> ${nt}`);
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
