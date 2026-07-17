// fm verb: send - send one line of literal text to a crewmate pane, then Enter.
// Ported behavior-preserving from the former sbin/fm send.
//
// Usage: fm send <pane> [--steer] <text...>
//   <pane> may be a bare firstmate pane name (fm-xyz), resolved through this
//   home's state/<id>.meta, or an explicit herdr pane id (e.g. w8:p3).
// --steer marks the message as steering/correction; it bypasses the dispatch
//   gate (freeze and focus locks) while still verifying delivery.
// Special keys instead of text: fm send <pane> [--steer] --key Escape
//
// Dispatch gate: new work is refused when state/.dispatch-freeze exists or
// state/.focus-<id> exists for the target mate. Bypass with --steer or
// FM_DISPATCH_OVERRIDE=1.
//
// Text submission is fail-closed. A human's unsent draft causes exit 75.
// Otherwise one "herdr pane run" call atomically sends the text and Enter.
// The command is never retried or queued: retrying can duplicate one logical
// instruction in the harness steering queue.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { paneInputPending, resolveLivePane } from "../lib/herdr";
import { homeFromCwd } from "../lib/root";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || homeFromCwd() || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || `${fmHome}/state`;
}

// firstLine(path): the first line of a file (no trailing newline), or "" when
// the file is missing or unreadable. Mirrors `head -n1 "$path" 2>/dev/null`.
function firstLine(path: string): string {
	try {
		return readFileSync(path, "utf8").split("\n")[0] ?? "";
	} catch {
		return "";
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const target = args[0];
	if (target === undefined) {
		process.stderr.write("usage: fm send <pane> [--steer] <text...>\n       fm send <pane> [--steer] --key <key>\n");
		return 1;
	}

	const state = resolveState();
	const pane = resolveLivePane(target, state);
	if (pane === null) return 1;

	// Parse --steer: steering messages bypass the dispatch gate.
	let rest = args.slice(1);
	let steer = false;
	if (rest[0] === "--steer") {
		steer = true;
		rest = rest.slice(1);
	}
	const steerText = rest.join(" ");

	// Dispatch gate: block new work during a freeze or focus lock.
	// Bypass with FM_DISPATCH_OVERRIDE=1 or --steer.
	if (process.env.FM_DISPATCH_OVERRIDE !== "1" && !steer) {
		const freezePath = join(state, ".dispatch-freeze");
		if (existsSync(freezePath)) {
			process.stderr.write(`error: dispatch frozen (use FM_DISPATCH_OVERRIDE=1 or --steer to bypass): ${freezePath}\n`);
			return 1;
		}
		if (target.startsWith("fm-")) {
			const lockPath = join(state, `.focus-${target.slice("fm-".length)}`);
			if (existsSync(lockPath)) {
				const reason = firstLine(lockPath);
				process.stderr.write(
					`error: ${target} is focus-locked${reason ? `: ${reason}` : ""} (use FM_DISPATCH_OVERRIDE=1 or --steer to bypass)\n`,
				);
				return 1;
			}
		}
	}

	if (rest[0] === "--key") {
		const key = rest[1];
		if (key === undefined) {
			process.stderr.write("usage: fm send <pane> [--steer] --key <key>\n");
			return 1;
		}
		const res = spawnSync("herdr", ["pane", "send-keys", pane, key], { stdio: "inherit" });
		if (res.error || (res.status ?? 1) !== 0) return res.status ?? 1;
	} else {
		if (paneInputPending(pane)) {
			process.stderr.write(`blocked: ${pane} composer holds an unsent draft; text was not sent\n`);
			return 75;
		}
		const text = rest.join(" ");
		const res = spawnSync("herdr", ["pane", "run", pane, text], { stdio: ["inherit", "inherit", "ignore"] });
		if (res.error || res.status !== 0) {
			process.stderr.write(`error: text not sent to ${pane} (herdr pane run failed)\n`);
			return 1;
		}
	}

	// Capture steer events: log to the events journal when a steering message was sent.
	if (steer && rest[0] !== "--key" && steerText.length > 0) {
		spawnSync(join(REPO_ROOT, "sbin", "fm"), ["capture", "steer", target, steerText, ""], {
			stdio: ["ignore", "inherit", "ignore"],
		});
	}

	return 0;
}

export default {
	name: "send",
	describe: "Send one line of literal text to a crewmate pane, then Enter.",
	run,
};
