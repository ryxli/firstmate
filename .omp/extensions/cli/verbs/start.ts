// fm verb: start - launch a fresh interactive firstmate session with zero typing.
//
// Runs omp from the active firstmate home so home-local identity and instructions
// load for persistent supervisors. Without FM_HOME, falls back to the repo root
// so project-dir discovery picks up the ship extensions and .omp/config.yml.
// With no arguments it sends the standard kickoff message so AGENTS.md's
// session-start sequence begins immediately; any arguments are passed through
// to omp verbatim instead (e.g. `fm start -c` to continue the previous session).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { lockSnapshot, removeLockIfOwner, resolveLockPaths, sleepMs, withLockClaim, writeLockOwner } from "../lib/session-lock";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const KICKOFF = "Session start: run your session-start sequence, then report fleet status.";
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 300_000;
const LOCK_POLL_MS = 100;

interface ReservedLaunch {
	child: ReturnType<typeof spawn>;
	ownerPid: number;
	gate: string;
}

// Every-session skills injected into the cached system prefix, replacing two
// uncached tool-reads per boot. All other skills stay lazy.
const PRELOAD_SKILLS = ["firstmate-bootstrap", "firstmate-recovery"];

// Stable fleet registries: change rarely, read at every session start. Loading
// them at launch keeps them in the cached prefix and in a deterministic order,
// instead of N tool-reads scattered through the first turns.
const PRELOAD_REGISTRIES = ["data/projects.md", "data/secondmates.md", "data/cap.md"];

function preloadBlock(): string {
	const parts = ["# Preloaded skills", "The following mandatory session-start skills are already loaded in full - run them directly, never re-read them via a skill tool or file read."];
	for (const name of PRELOAD_SKILLS) {
		const path = join(REPO_ROOT, ".agents", "skills", name, "SKILL.md");
		parts.push(`## skill://${name}\n\n${readFileSync(path, "utf8").trim()}`);
	}
	const home = process.env.FM_HOME?.trim() || REPO_ROOT;
	const registries: string[] = [];
	for (const rel of PRELOAD_REGISTRIES) {
		try {
			registries.push(`## ${rel}\n\n${readFileSync(join(home, rel), "utf8").trim()}`);
		} catch {
			// Local-layer file absent (fresh clone): the skill flow handles it.
		}
	}
	if (registries.length > 0) {
		parts.push("# Preloaded fleet registries", "Current as of session launch - do not re-read these files unless you have changed them this session. Live state (panes, tasks, locks) is NOT here; get it from one `fm fleet --check` call.", ...registries);
	}
	return parts.join("\n\n");
}

function envMs(name: string, fallbackMs: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallbackMs;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
	return Math.floor(seconds * 1000);
}

function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
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

function startReservedChild(ompArgs: string[], cwd: string): ReservedLaunch {
	const paths = resolveLockPaths();
	const gate = join(paths.state, `.fm-start-gate-${process.pid}-${Date.now()}`);
	const child = spawn("/bin/sh", ["-c", "gate=$1; shift; while [ ! -e \"$gate\" ]; do sleep 0.01; done; exec omp \"$@\"", "fm-start-gate", gate, ...ompArgs], {
		cwd,
		stdio: "inherit",
		env: childEnv(),
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

async function waitAndLaunch(ompArgs: string[], cwd: string): Promise<number> {
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
				return startReservedChild(ompArgs, cwd);
			});
			if (launched !== undefined) return await waitForReservedChild(launched);
		} catch (error) {
			process.stderr.write(`fm start: ${(error as Error).message}; no omp process launched\n`);
			return 1;
		}
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const ompArgs = [`--append-system-prompt=${preloadBlock()}`, ...(args.length > 0 ? args : [KICKOFF])];
	return await waitAndLaunch(ompArgs, process.env.FM_HOME?.trim() || REPO_ROOT);
}

export default {
	name: "start",
	describe: "Wait for authority, then launch a fresh interactive firstmate OMP session.",
	run,
};
