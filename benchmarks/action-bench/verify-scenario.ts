#!/usr/bin/env bun
// Dev helper: verify ONE scenario file's exported SCENARIOS against all 5 integrity
// gates in isolation, without registering it in scenarios/index.ts. Used while
// authoring or porting a scenario file; not part of the CI path.
//
//   bun verify-scenario.ts scenarios/<file>.ts
import { join, resolve } from "node:path";
import { loadArms } from "./arms.ts";
import { runGates } from "./gates.ts";
import type { Scenario } from "./types.ts";

const rel = Bun.argv[2];
if (!rel) {
	console.error("usage: verify-scenario.ts <scenarios/file.ts>");
	process.exit(1);
}
// Runtime-selected module path (the file under verification): a static import
// cannot name it, so this is the sanctioned plugin-style dynamic-import exception.
const mod = (await import(resolve(rel))) as { SCENARIOS?: Scenario[] };
const scns = mod.SCENARIOS ?? [];
if (!scns.length) {
	console.error(`no SCENARIOS exported by ${rel}`);
	process.exit(1);
}
const arms = loadArms(join(import.meta.dir, "arms", "harness.txt"));
const { ok } = runGates(scns, arms, true);
process.exit(ok ? 0 : 2);
