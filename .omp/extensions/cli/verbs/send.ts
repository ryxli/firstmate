// fm verb: send - send one line of literal text to a crewmate pane, then Enter.
// Ported behavior-preserving from the former sbin/fm send.
//
// Artifact spine: allowed for WorkerLoop revise/steer only. Never use fm send
// on post-accept land paths. After accept, worker ownership is released;
// land via fm finish <id> (and fm revise only before accept).
//
// Usage: fm send <pane> [--steer] <text...>
//   <pane> may be a bare firstmate pane name (fm-xyz), resolved through this
//   home's state/<id>.meta, or an explicit herdr pane id (e.g. w8:p3).
// --steer marks the message as steering/correction; it bypasses the dispatch
//   gate (freeze and focus locks) while still verifying delivery.
// Special keys instead of text: fm send <pane> [--steer] --key Escape
// Adapter-aware: fm send <pane> [--steer] --interrupt | --exit
//   resolves harness= from state/<id>.meta and uses the internal harness
//   adapter registry (interrupt key sequence / exit slash command).
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
import { loadArtifact } from "../lib/artifact";
import { adapterAwareExitSupported, exitCommand, interruptPlan } from "../lib/harness-adapters";
import { paneInputPending, resolveLivePane } from "../lib/herdr";
import { homeFromCwd } from "../lib/root";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || homeFromCwd() || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || `${fmHome}/state`;
}

function firstLine(path: string): string {
	try {
		return readFileSync(path, "utf8").split("\n")[0] ?? "";
	} catch {
		return "";
	}
}

function metaHarness(state: string, paneTarget: string): string | undefined {
	if (!paneTarget.startsWith("fm-")) return undefined;
	const id = paneTarget.slice("fm-".length);
	try {
		const raw = readFileSync(join(state, `${id}.meta`), "utf8");
		const m = raw.match(/(?:^|\n|\s)harness=([^\s\n]+)/);
		return m?.[1];
	} catch {
		return undefined;
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const target = args[0];
	if (target === undefined) {
		process.stderr.write(
			"usage: fm send <pane> [--steer] <text...>\n       fm send <pane> [--steer] --key <key>\n       fm send <pane> [--steer] --interrupt|--exit\n",
		);
		return 1;
	}

	const state = resolveState();
	const pane = resolveLivePane(target, state);
	if (pane === null) return 1;

	let rest = args.slice(1);
	let steer = false;
	if (rest[0] === "--steer") {
		steer = true;
		rest = rest.slice(1);
	}
	const steerText = rest.join(" ");

	if (target.startsWith("fm-")) {
		const taskId = target.slice("fm-".length);
		const art = loadArtifact(taskId);
		if (art && (art.reviewState === "accepted" || art.reviewState === "abandoned" || art.reviewState === "superseded")) {
			process.stderr.write(
				`error: artifact ${taskId} reviewState=${art.reviewState}; fm send refused (revise is pre-accept only; land via fm finish ${taskId})\n`,
			);
			return 1;
		}
	}

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

	if (rest[0] === "--interrupt" || rest[0] === "--exit") {
		const harness = metaHarness(state, target);
		if (!harness) {
			process.stderr.write(`error: cannot resolve harness= from meta for ${target}; pass --key explicitly\n`);
			return 1;
		}
		if (rest[0] === "--interrupt") {
			const plan = interruptPlan(harness);
			if (!plan) {
				process.stderr.write(`error: no interrupt plan for harness '${harness}'\n`);
				return 1;
			}
			for (const key of plan.keys) {
				const res = spawnSync("herdr", ["pane", "send-keys", pane, key], { stdio: "inherit" });
				if (res.error || (res.status ?? 1) !== 0) return res.status ?? 1;
			}
			return 0;
		}
		const cmd = exitCommand(harness);
		if (!cmd) {
			process.stderr.write(`error: no exit command for harness '${harness}'\n`);
			return 1;
		}
		if (!adapterAwareExitSupported(harness)) {
			process.stderr.write(
				`error: fm send --exit is not supported for harness '${harness}' (exit delivery needs harness-specific timing); use fm send --key / explicit slash exit until encoded\n`,
			);
			return 1;
		}
		if (paneInputPending(pane)) {
			process.stderr.write(`blocked: ${pane} composer holds an unsent draft; text was not sent\n`);
			return 75;
		}
		const res = spawnSync("herdr", ["pane", "run", pane, cmd], { stdio: ["inherit", "inherit", "ignore"] });
		if (res.error || res.status !== 0) {
			process.stderr.write(`error: exit command not sent to ${pane}\n`);
			return 1;
		}
		return 0;
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
