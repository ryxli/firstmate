// fm verb: afk - atomic away-mode enter/exit/status.
// Owns state/.afk and idle-digest resume/cleanup so callers cannot leave
// half-entered or half-exited state. Judgment (when/authority) stays in
// skill://fm-away-mode.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

function envOrDefault(name: string, fallback: string): string {
	const value = process.env[name];
	return value !== undefined && value !== "" ? value : fallback;
}

function resolvePaths(): { home: string; state: string; afk: string; digest: string; fmBin: string } {
	const home = envOrDefault("FM_HOME", envOrDefault("FM_ROOT_OVERRIDE", REPO_ROOT));
	const state = envOrDefault("FM_STATE_OVERRIDE", join(home, "state"));
	return {
		home,
		state,
		afk: join(state, ".afk"),
		digest: join(state, ".idle-digest.md"),
		fmBin: join(REPO_ROOT, "sbin", "fm"),
	};
}

function runIdleDigest(fmBin: string, sub: string): { status: number; stdout: string; stderr: string } {
	const res = spawnSync(fmBin, ["idle-digest", sub], { encoding: "utf8" });
	return {
		status: res.status ?? 1,
		stdout: typeof res.stdout === "string" ? res.stdout : "",
		stderr: typeof res.stderr === "string" ? res.stderr : "",
	};
}

function statusLine(paths: ReturnType<typeof resolvePaths>): string {
	const active = existsSync(paths.afk);
	let since = "";
	if (active) {
		try {
			since = readFileSync(paths.afk, "utf8").trim();
		} catch {
			since = "";
		}
	}
	const digest = existsSync(paths.digest) ? "yes" : "no";
	return `afk: ${active ? "active" : "inactive"}${since ? ` since=${since}` : ""} idle-digest=${digest}\n`;
}

async function run(argv: string[]): Promise<number> {
	const sub = argv[1] ?? "";
	const paths = resolvePaths();
	mkdirSync(paths.state, { recursive: true });

	if (sub === "status" || sub === "") {
		process.stdout.write(statusLine(paths));
		return 0;
	}

	if (sub === "enter") {
		// Resume digest before committing the flag so a begin failure cannot leave
		// away-mode half-entered.
		if (existsSync(paths.digest)) {
			const began = runIdleDigest(paths.fmBin, "begin");
			if (began.status !== 0) {
				process.stderr.write(`error: afk enter: idle-digest begin failed; flag not set\n${began.stderr}`);
				return 1;
			}
		}
		writeFileSync(paths.afk, `${Math.floor(Date.now() / 1000)}\n`);
		process.stdout.write(statusLine(paths));
		return 0;
	}

	if (sub === "exit") {
		if (existsSync(paths.digest)) {
			const screened = runIdleDigest(paths.fmBin, "screen");
			if (screened.stdout) process.stdout.write(screened.stdout);
			const cleared = runIdleDigest(paths.fmBin, "clear");
			if (cleared.status !== 0) {
				process.stderr.write(`error: afk exit could not clear idle-digest\n${cleared.stderr}`);
				return 1;
			}
		}
		try {
			if (existsSync(paths.afk)) unlinkSync(paths.afk);
		} catch (error) {
			process.stderr.write(`error: afk exit could not clear flag: ${(error as Error).message}\n`);
			return 1;
		}
		process.stdout.write(statusLine(paths));
		return 0;
	}

	process.stderr.write("usage: fm afk enter|exit|status\n");
	return 2;
}

export default {
	name: "afk",
	describe: "Enter, exit, or report away-mode (owns .afk flag and idle-digest cleanup).",
	run,
};
