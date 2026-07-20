import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FM_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const HARNESS_NAME_RE = /^(claude|codex|opencode|pi|omp)$/;
const HARNESS_ARGS_RE = /(^|[\s/])(claude|codex|opencode|pi|omp)(\.ts)?(\s|$)/;
const CLAIM_STALE_MS = 30_000;

export interface SessionLockPaths {
	state: string;
	lockFile: string;
	claimDir: string;
}

export type LockSnapshot =
	| { state: "free" }
	| { state: "live"; pid: number; raw: string }
	| { state: "stale"; pid: number; raw: string };

export function envOrUndefined(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

export function resolveState(resolvedHome?: string): string {
	const rootOverride = envOrUndefined("FM_ROOT_OVERRIDE");
	const fmRoot = rootOverride ?? DEFAULT_FM_ROOT;
	const fmHome = resolvedHome ?? envOrUndefined("FM_HOME") ?? rootOverride ?? fmRoot;
	const stateOverride = envOrUndefined("FM_STATE_OVERRIDE");
	return stateOverride ?? join(fmHome, "state");
}

export function resolveLockPaths(resolvedHome?: string): SessionLockPaths {
	const state = resolveState(resolvedHome);
	return { state, lockFile: join(state, ".lock"), claimDir: join(state, ".lock.claim") };
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

export function harnessPid(): number | undefined {
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

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function holderAlive(pid: number): boolean {
	if (!processAlive(pid)) return false;
	const comm = psField("comm", pid);
	if (comm === undefined) return false;
	const args = psField("args", pid) ?? "";
	return looksLikeHarness(comm, args);
}

export function readLockRaw(paths: SessionLockPaths): string | undefined {
	if (!existsSync(paths.lockFile)) return undefined;
	return readFileSync(paths.lockFile, "utf8").trim();
}

export function lockSnapshot(paths: SessionLockPaths): LockSnapshot {
	const raw = readLockRaw(paths);
	if (raw === undefined) return { state: "free" };
	const pid = Number(raw);
	if (Number.isFinite(pid) && holderAlive(pid)) return { state: "live", pid, raw };
	return { state: "stale", pid, raw };
}

export function writeLockOwner(paths: SessionLockPaths, pid: number): void {
	mkdirSync(paths.state, { recursive: true });
	writeFileSync(paths.lockFile, `${pid}\n`);
}

export function removeLockIfOwner(paths: SessionLockPaths, pid: number): boolean {
	const raw = readLockRaw(paths);
	if (raw !== String(pid)) return false;
	unlinkSync(paths.lockFile);
	return true;
}

export function sleepMs(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function claimPid(paths: SessionLockPaths): number | undefined {
	try {
		const raw = readFileSync(join(paths.claimDir, "pid"), "utf8").trim();
		const pid = Number(raw);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function claimStale(paths: SessionLockPaths): boolean {
	const pid = claimPid(paths);
	if (pid !== undefined) return !processAlive(pid);
	try {
		return Date.now() - statSync(paths.claimDir).mtimeMs > CLAIM_STALE_MS;
	} catch {
		return true;
	}
}

export async function withLockClaim<T>(paths: SessionLockPaths, deadlineMs: number, body: () => T | Promise<T>): Promise<T> {
	mkdirSync(paths.state, { recursive: true });
	for (;;) {
		try {
			mkdirSync(paths.claimDir);
			writeFileSync(join(paths.claimDir, "pid"), `${process.pid}\n`);
			try {
				return await body();
			} finally {
				rmSync(paths.claimDir, { recursive: true, force: true });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (claimStale(paths)) {
				rmSync(paths.claimDir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadlineMs) throw new Error("timed out waiting for firstmate lock claim");
			await sleepMs(Math.min(50, Math.max(1, deadlineMs - Date.now())));
		}
	}
}
