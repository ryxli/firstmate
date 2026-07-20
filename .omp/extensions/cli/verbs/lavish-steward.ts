// fm verb: lavish-steward - the dedicated Lavish poll worker.
// Ported behavior-preserving from sbin/fm lavish-steward.
//
// ONE steward process owns the long-poll for ONE Lavish session. It holds
// `bunx lavish-axi poll <file>` (the official, stable long-poll), and every time
// the cap sends feedback it:
//   1. appends the feedback to state/lavish/<key>.feedback.md (durable record),
//   2. wakes the ORIGINATING agent's pane via the `send` verb with a one-line
//      pointer to that file plus the reply command,
// then loops back into the poll. It exits when the session ends (the cap
// closes it) or when it is told to stop. Because the steward is a separate
// process from the agent that opened the artifact, the agent's own thread is
// NEVER tied up polling Lavish - it just gets woken when there is feedback.
//
// This verb is meant to run detached and long-lived (normally launched by
// `fm lavish-open`, not by hand): run() itself IS the poll loop, blocking
// until the session ends or the steward gives up after repeated failures.
//
// Usage:
//   fm lavish-steward <canonical-file> <session-key> <relay-pane> [<session-url>]
//     <canonical-file> realpath of the artifact (the lavish session key source)
//     <session-key>    16-hex key (fm_lavish_key); names the state files
//     <relay-pane>     herdr pane id of the agent that opened the artifact, OR
//                      "-" to relay nowhere (feedback still recorded to disk)
//     <session-url>    optional browser URL, recorded for context

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lavishStateDir } from "../lib/lavish";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const SBIN_DIR = join(REPO_ROOT, "sbin");
const FM_CLI = join(SBIN_DIR, "fm");

const USAGE = "usage: fm lavish-steward <canonical-file> <session-key> <relay-pane> [<session-url>]";

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// interruptibleSleep(seconds, isRunning): like `sleep`, but wakes early once
// isRunning() goes false, so a TERM/INT during backoff stops the loop
// promptly instead of riding out the full backoff window.
async function interruptibleSleep(seconds: number, isRunning: () => boolean): Promise<void> {
	const stepMs = 100;
	const totalMs = Math.max(0, seconds * 1000);
	let elapsed = 0;
	while (elapsed < totalMs && isRunning()) {
		await new Promise(resolve => setTimeout(resolve, Math.min(stepMs, totalMs - elapsed)));
		elapsed += stepMs;
	}
}

// extractPromptCount(toon): read the N from a `prompts[N]{...}:` header line.
function extractPromptCount(text: string): string {
	const m = text.match(/^prompts\[(\d*)\]/m);
	return m ? m[1] : "";
}

// stripNextStep(out): drop the upstream `next_step:` block (and everything
// after it): it instructs the reader to run `lavish-axi poll --agent-reply`
// itself and "never kill it" - exactly the self-poll this steward exists to
// avoid. Mirrors `sed '/^next_step:/,$d'` (line-anchored, first match wins).
function stripNextStep(out: string): string {
	const lines = out.split("\n");
	const idx = lines.findIndex(line => line.startsWith("next_step:"));
	return (idx === -1 ? lines : lines.slice(0, idx)).join("\n");
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const file = args[0] ?? "";
	const key = args[1] ?? "";
	const relay = args[2] ?? "";
	const url = args[3] ?? "";
	if (!file || !key || !relay) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}

	const stateDir = lavishStateDir();
	mkdirSync(stateDir, { recursive: true });
	const meta = join(stateDir, `${key}.steward`);
	const feedback = join(stateDir, `${key}.feedback.md`);
	const log = join(stateDir, `${key}.steward.log`);

	// log(line): append a timestamped diagnostic line, mirroring the bash
	// script's `log()` helper. Best-effort: a logging failure is never fatal.
	function log_(line: string): void {
		try {
			appendFileSync(log, `${timestamp()} ${line}\n`);
		} catch {
			// best-effort
		}
	}
	function logRaw(text: string): void {
		if (!text) return;
		try {
			appendFileSync(log, text);
		} catch {
			// best-effort
		}
	}

	// Record steward metadata (pid, file, relay target) so open can be
	// idempotent and recovery can detect a dead steward.
	writeFileSync(
		meta,
		[`pid=${process.pid}`, `file=${file}`, `key=${key}`, `relay=${relay}`, `url=${url}`, `started=${timestamp()}`]
			.map(line => `${line}\n`)
			.join(""),
	);

	let running = true;
	let pollChild: ReturnType<typeof spawn> | null = null;

	// cleanup: mirrors the bash EXIT trap - kill any in-flight poll child so it
	// cannot consume (and then drop) a feedback event after we decided to exit,
	// then remove the steward's meta file.
	const cleanup = () => {
		if (pollChild) {
			try {
				pollChild.kill();
			} catch {
				// already gone
			}
		}
		log_(`steward stopping (pid ${process.pid})`);
		rmSync(meta, { force: true });
	};
	const onSignal = () => {
		running = false;
		if (pollChild) {
			try {
				pollChild.kill();
			} catch {
				// already gone
			}
		}
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	log_(`steward started pid=${process.pid} file=${file} relay=${relay} url=${url}`);

	// wakeAgent(n): nudge the originating agent's pane with a one-line pointer
	// to the recorded feedback and the reply command. Best-effort: feedback is
	// already on disk, so a failed send is logged but never fatal. Wakes via
	// the `send` verb (sbin/fm send) - the same pane-send path every other
	// mate wake uses.
	function wakeAgent(n: string): void {
		if (relay === "-") {
			log_("relay disabled; feedback recorded only");
			return;
		}
		const msg =
			`Lavish feedback (${n} item(s)) on ${file} - read ${feedback}, apply the changes, then acknowledge in-browser with: ` +
			`${SBIN_DIR}/fm lavish-reply "${file}" "<message>" (do NOT run 'lavish-axi poll' yourself - the steward owns it)`;
		const res = spawnSync(FM_CLI, ["send", relay, "--steer", msg], { encoding: "utf8" });
		logRaw(`${res.stdout ?? ""}${res.stderr ?? ""}`);
		const rc = res.status ?? 1;
		// queued=76: Herdr accepted steering while the pane was already working.
		// Log honestly and never auto-retry (retry can duplicate instructions).
		if (!res.error && rc === 0) {
			log_(`relayed feedback to pane ${relay} (${n} items)`);
		} else if (!res.error && rc === 76) {
			log_(`relayed feedback to pane ${relay} queued=76 (accepted, not yet consumed; not retrying; ${n} items)`);
		} else if (!res.error && rc === 75) {
			log_(`WARN relay to pane ${relay} composer-blocked=75 (feedback is recorded at ${feedback})`);
		} else {
			log_(`WARN relay to pane ${relay} failed rc=${rc} (feedback is recorded at ${feedback})`);
		}
	}

	// runPoll: hold one `bunx lavish-axi poll <file>` child as a tracked
	// background process (so onSignal can kill it), resolving with its exit
	// code and accumulated stdout once it exits.
	function runPoll(fileArg: string): Promise<{ rc: number; out: string }> {
		return new Promise(resolve => {
			const child = spawn("bunx", ["lavish-axi", "poll", fileArg], { stdio: ["ignore", "pipe", "pipe"] });
			pollChild = child;
			let out = "";
			child.stdout.on("data", chunk => {
				out += chunk.toString();
			});
			child.stderr.on("data", chunk => logRaw(chunk.toString()));
			child.on("error", () => {
				pollChild = null;
				resolve({ rc: 1, out: "" });
			});
			child.on("close", code => {
				pollChild = null;
				resolve({ rc: code ?? 1, out });
			});
		});
	}

	// revive: headlessly resume the server/session; returns stdout only (the
	// caller checks it for "status: ended"). Stderr is appended raw to the log.
	function revive(fileArg: string): string {
		const res = spawnSync("bunx", ["lavish-axi", fileArg, "--no-open"], { encoding: "utf8" });
		logRaw(res.stderr ?? "");
		return res.stdout ?? "";
	}

	// FM_LAVISH_FAIL_MAX: give up after this many consecutive poll failures so a
	// permanently dead server never leaves a steward spinning. FM_LAVISH_BACKOFF_CAP
	// caps the exponential backoff. Both are env-tunable (and let tests run fast).
	const backoffStart = () => Number(process.env.FM_LAVISH_BACKOFF_START ?? "2");
	let backoff = backoffStart();
	let fails = 0;
	const failMax = Number(process.env.FM_LAVISH_FAIL_MAX ?? "8");
	const backoffCap = Number(process.env.FM_LAVISH_BACKOFF_CAP ?? "30");

	while (running) {
		const { rc, out } = await runPoll(file);
		if (!running) break;

		if (rc !== 0 || !out) {
			// A non-zero/empty return is an error (e.g. server down), not feedback.
			// Revive the server/session headlessly; if the revive reports the
			// session is ended (or gone), stop - the cap closed it. Otherwise
			// back off and retry, giving up after FAIL_MAX consecutive failures
			// so a permanently dead server never leaves a steward spinning
			// forever.
			fails += 1;
			const revived = revive(file);
			if (revived.includes("status: ended")) {
				log_("revive reports session ended; steward exiting");
				break;
			}
			if (fails >= failMax) {
				log_(`poll failed ${fails} times consecutively (server unreachable); steward giving up`);
				break;
			}
			log_(`poll rc=${rc} empty=${out ? "no" : "yes"}; revive+backoff ${backoff}s (fail ${fails}/${failMax})`);
			await interruptibleSleep(backoff, () => running);
			if (backoff < backoffCap) backoff *= 2;
			continue;
		}
		backoff = backoffStart();
		fails = 0;

		if (out.includes("status: ended")) {
			log_("session ended; steward exiting");
			break;
		}
		if (out.includes("status: feedback")) {
			let n = extractPromptCount(out);
			if (!n) n = "?";
			// Drop the upstream `next_step:` block: it instructs the reader to run
			// `lavish-axi poll --agent-reply` itself and "never kill it" - exactly the
			// self-poll this steward exists to avoid. We replace it with the reply path
			// that routes through the write-only endpoint and never blocks the agent.
			const body = stripNextStep(out);
			const fence = "```";
			const block =
				`\n## Feedback ${timestamp()} (${n} item(s))\n\n` +
				`${fence}\n${body}\n${fence}\n` +
				`\nApply the requested changes to ${file}, then acknowledge in-browser:\n` +
				`    ${SBIN_DIR}/fm lavish-reply "${file}" "<message for the cap>"\n` +
				"Do NOT run 'lavish-axi poll' yourself - the steward owns the poll and will relay the next round here.\n";
			appendFileSync(feedback, block);
			log_(`feedback received (${n} items); appended to ${feedback}`);
			wakeAgent(n);
		} else {
			// status: waiting or an unrecognized shape (we never pass --timeout-ms, so
			// waiting should not occur). Treat as a transient and re-poll without spin.
			log_("unrecognized poll result; re-polling");
			await interruptibleSleep(1, () => running);
		}
	}

	cleanup();
	process.removeListener("SIGTERM", onSignal);
	process.removeListener("SIGINT", onSignal);
	return 0;
}

export default {
	name: "lavish-steward",
	describe: "Hold one Lavish session's long-poll and relay feedback to the originating pane.",
	run,
};
