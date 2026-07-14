#!/usr/bin/env bun
// Internal JSON adapter for visual consumers. Agent-facing output is fm-axi TOON.
import { collectSnapshot } from "../.omp/extensions/bridge/collect";

const args = process.argv.slice(2);
let includeMetrics = false;
let statsFile: string | undefined;
let home: string | undefined;
function requiredValue(flag: string, index: number): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		process.stderr.write(`fm-fleet-snapshot: ${flag} requires a value\n`);
		process.exit(2);
	}
	return value;
}
for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	if (arg === "--metrics") includeMetrics = true;
	else if (arg === "--home") {
		home = requiredValue(arg, index);
		index += 1;
	} else if (arg === "--stats-file") {
		statsFile = requiredValue(arg, index);
		index += 1;
	} else if (arg === "--help" || arg === "-h") {
		process.stdout.write("usage: fm-fleet-snapshot.ts [--metrics] [--home <path>] [--stats-file <path>]\n");
		process.exit(0);
	} else {
		process.stderr.write(`fm-fleet-snapshot: unknown argument ${arg}\n`);
		process.exit(2);
	}
}

const snapshot = await collectSnapshot(new Date().toISOString(), home, { includeMetrics, statsFile });
process.stdout.write(`${JSON.stringify(snapshot)}\n`);
