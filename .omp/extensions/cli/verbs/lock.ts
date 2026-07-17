// fm verb: lock - acquire or report the per-home firstmate session lock.
// Ported verbatim (behavior-preserving) out of the former sbin/fm lock.
//
// Writes the harness (agent) process PID found by walking process ancestry,
// which lives as long as the firstmate session - unlike the transient PID of
// any one tool-call process, which is dead moments after it is written.
// Usage: fm lock           acquire; exit 1 if another live session holds it
//        FM_SUPERVISED_SUCCESSOR=1 fm lock
//                          acknowledge a live holder without taking authority
//        fm lock status    print holder and liveness; always exits 0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const DEFAULT_FM_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

// Known harness command names and script paths; extend when a new adapter is verified.
const HARNESS_NAME_RE = /^(claude|codex|opencode|pi|omp)$/;
const HARNESS_ARGS_RE = /(^|[\s/])(claude|codex|opencode|pi|omp)(\.ts)?(\s|$)/;
const SUPERVISED_SUCCESSOR_ENV = "FM_SUPERVISED_SUCCESSOR";

function envOrUndefined(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function resolveState(): string {
	const rootOverride = envOrUndefined("FM_ROOT_OVERRIDE");
	const fmRoot = rootOverride ?? DEFAULT_FM_ROOT;
	const fmHome = envOrUndefined("FM_HOME") ?? rootOverride ?? fmRoot;
	const stateOverride = envOrUndefined("FM_STATE_OVERRIDE");
	return stateOverride ?? join(fmHome, "state");
}

function psField(field: "comm" | "ppid" | "args", pid: number): string | undefined {
	const result = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return typeof result.stdout === "string" ? result.stdout.replace(/\r?\n+$/, "") : undefined;
}

function looksLikeHarness(comm: string, args: string): boolean {
	const name = basename(comm);
	if (HARNESS_NAME_RE.test(name)) return true;
	return HARNESS_ARGS_RE.test(args);
}

function harnessPid(): number | undefined {
	let pid = process.pid;
	for (let step = 0; step < 8; step += 1) {
		const comm = psField("comm", pid);
		if (comm === undefined) return undefined;
		const args = psField("args", pid) ?? "";
		if (looksLikeHarness(comm, args)) return pid;
		const ppidRaw = (psField("ppid", pid) ?? "").replace(/\s+/g, "");
		if (!ppidRaw) return undefined;
		const next = Number(ppidRaw);
		if (!Number.isFinite(next) || next <= 1) return undefined;
		pid = next;
	}
	return undefined;
}

function holderAlive(pid: number): boolean {
	// true if pid is a live process that looks like a harness
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const comm = psField("comm", pid);
	if (comm === undefined) return false;
	const args = psField("args", pid) ?? "";
	return looksLikeHarness(comm, args);
}

function supervisedSuccessorMode(): boolean {
	const marker = envOrUndefined(SUPERVISED_SUCCESSOR_ENV)?.toLowerCase();
	return marker === "1" || marker === "true";
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const state = resolveState();
	mkdirSync(state, { recursive: true });
	const lockFile = join(state, ".lock");

	if (args[0] === "status") {
		if (!existsSync(lockFile)) {
			process.stdout.write("lock: free\n");
			return 0;
		}
		const old = readFileSync(lockFile, "utf8").trim();
		if (holderAlive(Number(old))) {
			process.stdout.write(`lock: held by live harness pid ${old}\n`);
		} else {
			process.stdout.write(`lock: stale (pid ${old} dead or not a harness)\n`);
		}
		return 0;
	}

	const me = harnessPid();
	if (me === undefined) {
		process.stderr.write("error: cannot locate harness process in ancestry\n");
		return 1;
	}
	if (existsSync(lockFile)) {
		const old = readFileSync(lockFile, "utf8").trim();
		if (old !== String(me) && holderAlive(Number(old))) {
			if (supervisedSuccessorMode()) {
				process.stdout.write(`lock unchanged: authority remains with live holder pid ${old}; supervised successor is read-only until handoff\n`);
				return 0;
			}
			process.stderr.write(`error: another live firstmate session holds the lock (pid ${old}); operate read-only until resolved\n`);
			return 1;
		}
	}
	writeFileSync(lockFile, `${me}\n`);
	process.stdout.write(`lock acquired: harness pid ${me}\n`);
	return 0;
}

export default {
	name: "lock",
	describe: "Acquire or report the per-home firstmate session lock.",
	run,
};
