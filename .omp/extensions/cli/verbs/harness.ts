// fm verb: harness - detect which agent harness this process (or a configured
// crewmate) runs under.
// Ported verbatim (behavior-preserving) out of the former sbin/fm harness.
// Detection layers: verified environment markers first, then a process-ancestry walk.
// omp sets OMPCODE=1 AND CLAUDECODE=1 (Claude API compat), so it MUST be
// checked before the CLAUDECODE branch or omp misdetects as claude.
// Output is plain text (bare harness name), not TOON: fm resolve-spawn and
// fm-spawn.sh capture it directly via command substitution.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
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
	// Layer 1: environment markers for verified harnesses.
	if (process.env.OMPCODE === "1") return "omp";
	if (process.env.CLAUDECODE === "1") return "claude";
	if (process.env.PI_CODING_AGENT === "true") return "pi";

	// Layer 2: walk the parent chain and match the command name.
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
			// Bare interpreter: match the harness name in its script path.
			const args = psField("args", pid) ?? "";
			if (args.includes("omp")) return "omp";
			if (args.includes("claude")) return "claude";
			if (args.includes("codex")) return "codex";
			if (args.includes("opencode")) return "opencode";
			if (/ pi /.test(args) || args.endsWith("/pi")) return "pi";
		}
		const ppidRaw = (psField("ppid", pid) ?? "").replace(/\s+/g, "");
		if (!ppidRaw) break;
		const nextPid = Number(ppidRaw);
		if (!Number.isFinite(nextPid) || nextPid <= 1) break;
		pid = nextPid;
	}
	return "unknown";
}

function resolveConfigDir(): string {
	const fmRootOverride = envOrUndefined("FM_ROOT_OVERRIDE");
	const fmRoot = fmRootOverride ?? DEFAULT_FM_ROOT;
	const fmHome = envOrUndefined("FM_HOME") ?? fmRootOverride ?? fmRoot;
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

async function run(argv: string[]): Promise<number> {
	const result = argv[1] === "crew" ? crewHarness() : detectOwn();
	process.stdout.write(`${result}\n`);
	return 0;
}

export default {
	name: "harness",
	describe: "Detect which agent harness this process or a configured crewmate runs under.",
	run,
};
