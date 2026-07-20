// fm verb: harness - detect which agent harness this process (or a configured
// crewmate) runs under; inspect typed adapter facts from the internal registry.
// Ported detection from the former sbin/fm harness.
// Detection layers: verified environment markers first, then a process-ancestry walk.
// omp sets OMPCODE=1 AND CLAUDECODE=1 (Claude API compat), so it MUST be
// checked before the CLAUDECODE branch or omp misdetects as claude.
// Output is plain text (bare harness name), not TOON: fm resolve-spawn and
// fm spawn capture it directly via command substitution.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHarnessAdapter, listHarnessAdapters } from "../lib/harness-adapters";

const DEFAULT_FM_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

function envOrUndefined(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function psField(field: "comm" | "ppid" | "args", pid: number): string | undefined {
	const result = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return typeof result.stdout === "string" ? result.stdout.replace(/\r?\n+$/, "") : undefined;
}

function detectOwn(): string {
	if (process.env.OMPCODE === "1") return "omp";
	if (process.env.CLAUDECODE === "1") return "claude";
	if (process.env.PI_CODING_AGENT === "true") return "pi";

	let pid = process.pid;
	for (let step = 0; step < 8; step += 1) {
		const commRaw = psField("comm", pid);
		if (commRaw === undefined) break;
		const comm = basename(commRaw);
		if (comm.includes("omp")) return "omp";
		if (comm.includes("claude")) return "claude";
		if (comm.includes("codex")) return "codex";
		if (comm.includes("opencode")) return "opencode";
		if (comm === "pi") return "pi";
		if (/^(node|python|bun)/.test(comm)) {
			const args = psField("args", pid) ?? "";
			if (args.includes("omp")) return "omp";
			if (args.includes("claude")) return "claude";
			if (args.includes("codex")) return "codex";
			if (args.includes("opencode")) return "opencode";
			if (/\bpi\b/.test(args)) return "pi";
		}
		const ppidRaw = psField("ppid", pid);
		if (ppidRaw === undefined) break;
		const ppid = Number(ppidRaw.trim());
		if (!Number.isFinite(ppid) || ppid <= 0 || ppid === pid) break;
		pid = ppid;
	}
	return "unknown";
}

function resolveConfigDir(): string {
	const fmRoot = envOrUndefined("FM_ROOT_OVERRIDE") ?? DEFAULT_FM_ROOT;
	const fmHome = envOrUndefined("FM_HOME") ?? fmRoot;
	const configOverride = envOrUndefined("FM_CONFIG_OVERRIDE");
	return configOverride ?? join(fmHome, "config");
}

function crewHarness(): string {
	const configDir = resolveConfigDir();
	let crew = "";
	try {
		crew = readFileSync(join(configDir, "crew-harness"), "utf8").replace(/\s+/g, "");
	} catch {
		crew = "";
	}
	if (!crew || crew === "default") return detectOwn();
	return crew;
}

function printInspect(name?: string): number {
	if (name) {
		const adapter = getHarnessAdapter(name);
		if (!adapter) {
			process.stderr.write(`error: unknown harness '${name}'\n`);
			return 1;
		}
		process.stdout.write(`${JSON.stringify(adapter, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${JSON.stringify(listHarnessAdapters(), null, 2)}\n`);
	return 0;
}

async function run(argv: string[]): Promise<number> {
	const sub = argv[1];
	if (sub === "inspect") {
		return printInspect(argv[2]);
	}
	if (sub === "crew") {
		process.stdout.write(`${crewHarness()}\n`);
		return 0;
	}
	if (sub === "exit-command" && argv[2]) {
		const adapter = getHarnessAdapter(argv[2]);
		if (!adapter) {
			process.stderr.write(`error: unknown harness '${argv[2]}'\n`);
			return 1;
		}
		process.stdout.write(`${adapter.exitCommand}\n`);
		return 0;
	}
	if (sub === "interrupt-keys" && argv[2]) {
		const adapter = getHarnessAdapter(argv[2]);
		if (!adapter) {
			process.stderr.write(`error: unknown harness '${argv[2]}'\n`);
			return 1;
		}
		process.stdout.write(`${adapter.interruptKeys.join(" ")}\n`);
		return 0;
	}
	const result = detectOwn();
	process.stdout.write(`${result}\n`);
	return 0;
}

export default {
	name: "harness",
	describe: "Detect harness, inspect adapter registry, or resolve crew harness.",
	run,
};
