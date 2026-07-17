// fm verb: lavish-open - the standard way to open (or resume) a Lavish
// artifact.
//
// This is the render-delegation entry point. Instead of opening a session and
// then holding `lavish-axi poll` on your own thread, you call this: it opens
// the session in the browser, then launches a DETACHED steward worker
// (sbin/fm lavish-steward, still bash - not part of this port) that owns
// the long-poll and relays the cap's feedback back to YOUR pane. Control
// returns to you immediately, so firstmate's supervision thread (or a
// crewmate's work thread) is never tied up polling.
//
// Ported behavior-preserving from the former sbin/fm lavish-open. The
// session-key math (canonical path / sha256-16 key / steward liveness / orphan
// poll reaping) is imported from cli/lib/lavish.ts rather than re-derived here
// - it must stay bit-identical with lavish-axi's own client math. The detach
// mechanism changes shape (nohup + background + disown -> Bun.spawn with
// detached: true, stdio ignored, unref) since a Bun process has no shell
// job-control to disown from; the steward still owns and appends to its own
// `<key>.steward.log` internally regardless of how its stdio is wired. The
// steward itself is now the `lavish-steward` verb (cli/verbs/lavish-steward.ts),
// launched via `sbin/fm lavish-steward <args>` rather than the retired
// sbin/fm lavish-steward.
//
// Usage:
//   fm lavish-open <html-file> [--relay-pane <pane>] [--no-open]
//       Open/resume <html-file> and start its steward. The relay pane defaults
//       to the CURRENT herdr pane (the agent calling this), so feedback comes
//       back to you. Pass --relay-pane to target another pane, or "-" to
//       record feedback to disk without waking anyone. --no-open skips the
//       browser launch (resume the server/session only).
//   fm lavish-open --recover
//       Relaunch a steward for every still-open Lavish session this home owns
//       that has no live steward. Run at session start / recovery so a
//       firstmate restart never leaves an open artifact unattended. Recovery
//       only relaunches stewards whose state files this home already recorded.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonGet, metaValue } from "../lib/herdr";
import { lavishCanonical, lavishKey, lavishKillPolls, lavishStateDir, lavishStewardAlive } from "../lib/lavish";

// Repo root, resolved from this module's own physical location
// (verbs -> cli -> extensions -> .omp -> root), matching the depth other
// cli/verbs/*.ts and cli/lib/*.ts modules use.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const FM_CLI = join(REPO_ROOT, "sbin", "fm");

const USAGE = "usage: fm lavish-open <html-file> [--relay-pane <pane>] [--no-open]";

// shellQuote(value): wrap in single quotes, escaping any embedded single
// quotes the POSIX-shell way. Used to safely embed a file path into a `sh -c`
// string.
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// runShell(cmd): run cmd through `sh -c`, exactly like a bash command
// substitution would, so redirections such as `2>&1` or `2>/dev/null` behave
// identically to the original script.
function runShell(cmd: string): { stdout: string; status: number } {
	const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
	return { stdout: res.stdout ?? "", status: res.status ?? 1 };
}

// extractField(output, name): the value of the first `<name>: ...` line
// (leading/trailing space around the colon stripped), or "" if none match.
// Mirrors `sed -n 's/^[[:space:]]*<name>:[[:space:]]*//p' | head -1`.
function extractField(output: string, name: string): string {
	const re = new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`);
	for (const line of output.split(/\r?\n/)) {
		const m = line.match(re);
		if (m) return m[1];
	}
	return "";
}

// currentPane(): the herdr pane id of the caller, or "-" if it cannot be
// resolved (herdr unavailable / not in a pane).
function currentPane(): string {
	const res = spawnSync("herdr", ["pane", "current"], { encoding: "utf8" });
	const pane = jsonGet(res.stdout ?? "", "result", "pane", "pane_id");
	return pane || "-";
}

// launchSteward(file, key, relay, url): start a detached steward worker that
// survives this process, the calling agent's turn, and the firstmate session.
function launchSteward(file: string, key: string, relay: string, url: string): void {
	const proc = Bun.spawn([FM_CLI, "lavish-steward", file, key, relay, url], {
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
	proc.unref();
}

function recover(stateDir: string): number {
	let entries: string[] = [];
	try {
		entries = readdirSync(stateDir).filter(name => name.endsWith(".steward")).sort();
	} catch {
		entries = [];
	}

	let recovered = 0;
	for (const name of entries) {
		const metaPath = join(stateDir, name);
		const key = metaValue(metaPath, "key");
		const file = metaValue(metaPath, "file");
		const relay = metaValue(metaPath, "relay");
		const url = metaValue(metaPath, "url");
		if (!key || !file) continue;
		if (lavishStewardAlive(key)) continue; // already attended

		// Stale meta (dead steward). Relaunch only if the session is still open.
		const { stdout } = runShell(`bunx lavish-axi ${shellQuote(file)} --no-open 2>/dev/null`);
		const status = extractField(stdout, "status");
		if (status === "ended") {
			try {
				unlinkSync(metaPath); // session gone; drop the stale record
			} catch {
				// already gone
			}
			continue;
		}
		// Empty status (unexpected output or server error) is treated the same as
		// a live non-ended status: relaunch the steward and let its bounded-revive
		// determine whether the session is truly dead, rather than silently
		// abandoning a possibly-live session.
		lavishKillPolls(file); // reap any orphan poll from the crashed steward
		launchSteward(file, key, relay || "-", url);
		recovered += 1;
	}

	process.stdout.write(`recovered: ${recovered} steward(s)\n`);
	return 0;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);

	const stateDir = lavishStateDir();
	mkdirSync(stateDir, { recursive: true });

	if (args[0] === "--recover") {
		return recover(stateDir);
	}

	// Parse open args.
	let file = "";
	let relay = "";
	let noOpen = false;
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--relay-pane") {
			relay = args[i + 1] ?? "";
			i += 2;
		} else if (arg === "--no-open") {
			noOpen = true;
			i += 1;
		} else if (arg.startsWith("-")) {
			process.stderr.write(`unknown flag: ${arg}\n`);
			return 2;
		} else {
			file = arg;
			i += 1;
		}
	}
	if (!file) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	if (!existsSync(file)) {
		process.stderr.write(`error: no such file: ${file}\n`);
		return 1;
	}

	const canon = lavishCanonical(file);
	const key = lavishKey(canon);
	if (!relay) relay = currentPane();

	// Open/resume the session via the official CLI (also guarantees the server is up).
	const openCmd = noOpen
		? `bunx lavish-axi ${shellQuote(canon)} --no-open 2>&1`
		: `bunx lavish-axi ${shellQuote(canon)} 2>&1`;
	const { stdout: openOut, status: openRc } = runShell(openCmd);
	if (openRc !== 0) {
		process.stderr.write("error: lavish-axi failed to open the session\n");
		process.stderr.write(`${openOut}\n`);
		return 1;
	}
	const url = extractField(openOut, "url").replace(/"/g, "");

	// Idempotent: only one steward per session.
	if (lavishStewardAlive(key)) {
		process.stdout.write(`steward already running for this session (key=${key})\n`);
	} else {
		lavishKillPolls(canon); // reap any orphan poll from a prior crashed steward
		launchSteward(canon, key, relay, url);
		process.stdout.write(`steward launched (key=${key}, relay=${relay})\n`);
	}

	process.stdout.write(`opened: ${url}\n`);
	process.stdout.write(`Feedback will be relayed to pane ${relay}; this thread is free. Do NOT run 'lavish-axi poll' yourself.\n`);
	return 0;
}

export default {
	name: "lavish-open",
	describe: "Open/resume a Lavish session and launch its detached feedback steward.",
	run,
};
