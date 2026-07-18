// fm verb: start - launch a fresh interactive firstmate session with zero typing.
//
// Runs OMP from the active home so home-local identity and instructions load.
// Main-firstmate startup executes deterministic checks before OMP, then opens
// idle with one visible static fleet message already in developer context.
// Secondmate homes preserve their existing startup prompt and cached context.
// Explicit arguments are passed through to OMP verbatim.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { lockSnapshot, removeLockIfOwner, resolveLockPaths, sleepMs, withLockClaim, writeLockOwner } from "../lib/session-lock";

import { FM_START_STATIC_CONTEXT_ENV, mainHomeStructurally, registryBlock, runStartupContext } from "../lib/startup-context";
import { activeHome, roleContractForHome } from "../lib/role-contract";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 300_000;
const LOCK_POLL_MS = 100;

interface ReservedLaunch {
	child: ReturnType<typeof spawn>;
	ownerPid: number;
	gate: string;
}

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

function secondmateContextBlock(home: string): string {
	const parts = [
		"# Secondmate startup context",
		"This is a model-driven secondmate startup. Stay inside your generated Runtime Role Contract, your charter routing scope, and your own home.",
		"Do not run main-fleet governance commands. Do not use `fm home`, `fm brief --secondmate`, or `fm spawn --secondmate` from this home.",
	];
	const charter = readOptional(join(home, "data", "charter.md"));
	if (charter) parts.push("## Local charter", charter);
	const cap = readOptional(join(home, "data", "cap.md"));
	if (cap) parts.push("## Local cap context", cap);
	const backlog = readOptional(join(home, "data", "backlog.md"));
	if (backlog) parts.push("## Local backlog", backlog);
	return parts.join("\n\n");
}

function mainPreloadBlock(home: string): string {
	const parts = [
		"# Startup preflight",
		"`fm start` already ran bootstrap, identity migration/check, home link check/repair when needed, Lavish recovery, and one fleet snapshot before launching this OMP process.",
		"Bootstrap and recovery procedure bodies are not preloaded in this default context.",
		"The static fleet representation is delivered as one visible `fm-start-static` session-start message. Treat it as static as of its embedded `static_as_of` timestamp, and refresh live state explicitly before acting on later changes.",
	];
	const registries = registryBlock(home, REPO_ROOT);
	if (registries.length > 0) {
		parts.push("# Preloaded fleet registries", "Stable desired context loaded at session launch. Live state is owned by the static fleet representation above until refreshed.", ...registries);
	}
	return parts.join("\n\n");
}

function secondmateKickoff(contract: string): string {
	const line = contract.split(/\r?\n/).find(entry => entry.startsWith("You are "));
	return `Session start: ${line ?? "You are a secondmate."} Run your local secondmate startup from the injected charter/cap context, then report local status to your supervisor channel when needed.`;
}

function envMs(name: string, fallbackMs: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallbackMs;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
	return Math.floor(seconds * 1000);
}

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra };
	delete env.FM_SUPERVISED_SUCCESSOR;
	return env;
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	child.on("exit", (code, signal) => {
		if (typeof code === "number") {
			resolve(code);
		} else if (signal) {
			resolve(1);
		} else {
			resolve(1);
		}
	});
	child.on("error", error => {
		process.stderr.write(`fm start: failed to launch omp: ${error.message}\n`);
		resolve(1);
	});
	return promise;
}

function terminateChild(child: ReturnType<typeof spawn>): void {
	try {
		child.kill("SIGTERM");
	} catch {
		// Already gone.
	}
}

function startReservedChild(ompArgs: string[], cwd: string, env: NodeJS.ProcessEnv): ReservedLaunch {
	const paths = resolveLockPaths();
	const gate = join(paths.state, `.fm-start-gate-${process.pid}-${Date.now()}`);
	const child = spawn("/bin/sh", ["-c", "gate=$1; shift; while [ ! -e \"$gate\" ]; do sleep 0.01; done; exec omp \"$@\"", "fm-start-gate", gate, ...ompArgs], {
		cwd,
		stdio: "inherit",
		env,
	});
	if (child.pid === undefined) {
		terminateChild(child);
		throw new Error("spawned omp owner pid was unavailable");
	}

	try {
		writeLockOwner(paths, child.pid);
		if (readFileSync(paths.lockFile, "utf8").trim() !== String(child.pid)) {
			terminateChild(child);
			throw new Error("spawned omp owner pid was not recorded");
		}
		writeFileSync(gate, "go\n");
	} catch (error) {
		terminateChild(child);
		try {
			removeLockIfOwner(paths, child.pid);
		} catch {
			// Best effort cleanup.
		}
		try {
			if (existsSync(gate)) unlinkSync(gate);
		} catch {
			// Best effort cleanup.
		}
		throw new Error(`failed to establish lock owner: ${(error as Error).message}`);
	}

	return { child, ownerPid: child.pid, gate };
}

async function waitForReservedChild(launch: ReservedLaunch): Promise<number> {
	const paths = resolveLockPaths();
	const status = await waitForChild(launch.child);
	try {
		removeLockIfOwner(paths, launch.ownerPid);
	} catch {
		// Best effort cleanup only; a later status/acquire treats a dead owner as stale.
	}
	try {
		if (existsSync(launch.gate)) unlinkSync(launch.gate);
	} catch {
		// Best effort cleanup.
	}
	return status;
}

async function waitAndLaunch(ompArgs: string[], cwd: string, beforeLaunch?: () => Promise<boolean>, launchEnv?: () => NodeJS.ProcessEnv): Promise<number> {
	const paths = resolveLockPaths();
	const deadlineMs = Date.now() + envMs("FM_START_LOCK_WAIT_TIMEOUT_SECS", DEFAULT_LOCK_WAIT_TIMEOUT_MS);
	let announced = false;
	for (;;) {
		const snapshot = lockSnapshot(paths);
		if (snapshot.state === "live") {
			if (!announced) {
				process.stdout.write(`fm start: waiting for live firstmate lock holder pid ${snapshot.raw} to release before launching omp\n`);
				announced = true;
			}
			if (Date.now() >= deadlineMs) {
				process.stderr.write(`fm start: timed out waiting for live firstmate lock holder pid ${snapshot.raw} to release; no omp process launched\n`);
				return 1;
			}
			await sleepMs(Math.min(LOCK_POLL_MS, Math.max(1, deadlineMs - Date.now())));
			continue;
		}

		try {
			const launched = await withLockClaim(paths, deadlineMs, async () => {
				const claimedSnapshot = lockSnapshot(paths);
				if (claimedSnapshot.state === "live") return undefined;
				if (beforeLaunch && !await beforeLaunch()) return false;
				return startReservedChild(ompArgs, cwd, launchEnv ? launchEnv() : childEnv());
			});
			if (launched === false) return 1;
			if (launched !== undefined) return await waitForReservedChild(launched);
		} catch (error) {
			process.stderr.write(`fm start: ${(error as Error).message}; no omp process launched\n`);
			return 1;
		}
	}
}

async function legacyRun(argv: string[], home: string): Promise<number> {
	const args = argv.slice(1);
	const contract = roleContractForHome(home);
	const context = secondmateContextBlock(home);
	const ompArgs = [`--append-system-prompt=${contract}`, `--append-system-prompt=${context}`, ...(args.length > 0 ? args : [secondmateKickoff(contract)])];
	return await waitAndLaunch(ompArgs, home);
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const home = activeHome(REPO_ROOT);
	if (!mainHomeStructurally(home)) return legacyRun(argv, home);

	let staticFleet = "";
	let preflightDone = false;
	const beforeLaunch = async (): Promise<boolean> => {
		if (preflightDone) return true;
		const outcome = await runStartupContext({
			fmBin: process.env.FM_START_FM_BIN?.trim() || join(REPO_ROOT, "sbin", "fm"),
			home,
			cwd: home,
			env: childEnv(),
		});
		if (!outcome.ok) {
			process.stderr.write(`fm start preflight failed: ${JSON.stringify(outcome.failure)}\n`);
			return false;
		}
		staticFleet = outcome.context.staticFleet;
		preflightDone = true;
		return true;
	};
	const ompArgs = [`--append-system-prompt=${roleContractForHome(home)}`, `--append-system-prompt=${mainPreloadBlock(home)}`, ...args];
	return await waitAndLaunch(ompArgs, home, async () => {
		const ok = await beforeLaunch();
		if (!ok) return false;
		return true;
	}, () => childEnv({ [FM_START_STATIC_CONTEXT_ENV]: staticFleet }));
}

export default {
	name: "start",
	describe: "Wait for authority, then launch a fresh interactive firstmate OMP session.",
	run,
};
