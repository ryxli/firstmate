// fm verb: send - visible-pane steering and control only.
//
// Not mate-to-mate communication (use peer bus) and not bounded work dispatch
// (use OMP task subagents). Terminals:
//   text: delivered=0 | queued=76 | composer-blocked=75 | failed=1  (never consumed)
//   --key/--interrupt: delivered=0 | failed=1
//   --exit: consumed=0 after correlated session retirement | already-stopped | ...
//
// Usage: fm send <pane> [--steer] <text...>
//        fm send <pane> [--steer] --key <key>
//        fm send <pane> [--steer] --interrupt|--exit

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArtifact } from "../lib/artifact";
import { interruptPlan } from "../lib/harness-adapters";
import { observeComposer, readHerdrAgentStatus, resolveLivePane } from "../lib/herdr";
import { exitPaneSession } from "../lib/pane-exit";
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

function emitState(state: string, extra = ""): void {
	process.stdout.write(`state=${state}${extra ? ` ${extra}` : ""}\n`);
}

type SendMode =
	| { kind: "text"; text: string }
	| { kind: "key"; key: string }
	| { kind: "interrupt" }
	| { kind: "exit" };

function parseSendMode(rest: string[]): SendMode | { error: string } {
	if (rest[0] === "--interrupt") return { kind: "interrupt" };
	if (rest[0] === "--exit") return { kind: "exit" };
	if (rest[0] === "--key") {
		if (rest[1] === undefined) return { error: "usage: fm send <pane> [--steer] --key <key>" };
		return { kind: "key", key: rest[1] };
	}
	if (rest.length === 0) {
		return {
			error:
				"usage: fm send <pane> [--steer] <text...>\n       fm send <pane> [--steer] --key <key>\n       fm send <pane> [--steer] --interrupt|--exit",
		};
	}
	return { kind: "text", text: rest.join(" ") };
}

function applyTextDispatchGuards(target: string, state: string, steer: boolean): number | null {
	if (target.startsWith("fm-")) {
		const taskId = target.slice("fm-".length);
		const art = loadArtifact(taskId);
		if (art && (art.reviewState === "accepted" || art.reviewState === "abandoned" || art.reviewState === "superseded")) {
			process.stderr.write(
				`error: artifact ${taskId} reviewState=${art.reviewState}; fm send refused (revise is pre-accept only; land via fm finish ${taskId})\n`,
			);
			emitState("failed", "reason=artifact-terminal");
			return 1;
		}
	}

	if (process.env.FM_DISPATCH_OVERRIDE !== "1" && !steer) {
		const freezePath = join(state, ".dispatch-freeze");
		if (existsSync(freezePath)) {
			process.stderr.write(`error: dispatch frozen (use FM_DISPATCH_OVERRIDE=1 or --steer to bypass): ${freezePath}\n`);
			emitState("failed", "reason=dispatch-freeze");
			return 1;
		}
		if (target.startsWith("fm-")) {
			const lockPath = join(state, `.focus-${target.slice("fm-".length)}`);
			if (existsSync(lockPath)) {
				const reason = firstLine(lockPath);
				process.stderr.write(
					`error: ${target} is focus-locked${reason ? `: ${reason}` : ""} (use FM_DISPATCH_OVERRIDE=1 or --steer to bypass)\n`,
				);
				emitState("failed", "reason=focus-lock");
				return 1;
			}
		}
	}
	return null;
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
	if (pane === null) {
		emitState("failed", "reason=resolve");
		return 1;
	}

	let rest = args.slice(1);
	let steer = false;
	if (rest[0] === "--steer") {
		steer = true;
		rest = rest.slice(1);
	}

	const mode = parseSendMode(rest);
	if ("error" in mode) {
		process.stderr.write(`${mode.error}\n`);
		emitState("failed", "reason=usage");
		return 1;
	}

	// Artifact-terminal / focus-lock / dispatch-freeze apply only to ordinary text.
	if (mode.kind === "text") {
		const blocked = applyTextDispatchGuards(target, state, steer);
		if (blocked !== null) return blocked;
	}

	if (mode.kind === "interrupt" || mode.kind === "exit") {
		const harness = metaHarness(state, target);
		if (!harness) {
			process.stderr.write(`error: cannot resolve harness= from meta for ${target}; pass --key explicitly\n`);
			emitState("failed", "reason=missing-harness");
			return 1;
		}
		if (mode.kind === "interrupt") {
			const plan = interruptPlan(harness);
			if (!plan) {
				process.stderr.write(`error: no interrupt plan for harness '${harness}'\n`);
				emitState("failed", "reason=no-interrupt-plan");
				return 1;
			}
			for (const key of plan.keys) {
				const res = spawnSync("herdr", ["pane", "send-keys", pane, key], { stdio: "inherit" });
				if (res.error || (res.status ?? 1) !== 0) {
					emitState("failed", `pane=${pane} reason=send-keys`);
					return res.status ?? 1;
				}
			}
			emitState("delivered", `pane=${pane} mode=interrupt`);
			return 0;
		}
		const exit = await exitPaneSession({ target, stateDir: state, harness, pane });
		if (exit.state === "composer-blocked") {
			process.stderr.write(`blocked: ${pane} composer holds an unsent draft; text was not sent\n`);
			emitState("composer-blocked", `pane=${pane}`);
			return 75;
		}
		if (exit.state === "already-stopped") {
			emitState("already-stopped", `pane=${pane}${exit.reason ? ` reason=${exit.reason}` : ""}`);
			return 0;
		}
		if (exit.state === "consumed") {
			emitState("consumed", `pane=${pane}${exit.sessionId ? ` session=${exit.sessionId}` : ""}`);
			return 0;
		}
		process.stderr.write(`error: exit ${exit.reason || "failed"} for ${pane}\n`);
		emitState("failed", `pane=${pane} reason=${(exit.reason || "failed").replace(/\s+/g, "-")}`);
		return 1;
	}

	if (mode.kind === "key") {
		const res = spawnSync("herdr", ["pane", "send-keys", pane, mode.key], { stdio: "inherit" });
		if (res.error || (res.status ?? 1) !== 0) {
			emitState("failed", `pane=${pane} reason=send-keys`);
			return res.status ?? 1;
		}
		emitState("delivered", `pane=${pane} mode=key`);
		return 0;
	}

	const composer = observeComposer(pane);
	if (composer.state === "error") {
		process.stderr.write(`error: composer observation failed for ${pane}: ${composer.reason}\n`);
		emitState("failed", `pane=${pane} reason=composer-observation`);
		return 1;
	}
	if (composer.state === "pending") {
		process.stderr.write(`blocked: ${pane} composer holds an unsent draft; text was not sent\n`);
		emitState("composer-blocked", `pane=${pane}`);
		return 75;
	}

	const status = readHerdrAgentStatus(pane);
	if (status.presence === "absent") {
		process.stderr.write(`error: agent status absent for ${pane}; refusing text send\n`);
		emitState("failed", `pane=${pane} reason=agent-status-absent`);
		return 1;
	}
	if (status.presence === "error") {
		process.stderr.write(`error: agent status read failed for ${pane}: ${status.reason}\n`);
		emitState("failed", `pane=${pane} reason=agent-status-error`);
		return 1;
	}
	const agentStatus = status.status.trim().toLowerCase();
	if (agentStatus !== "idle" && agentStatus !== "working") {
		process.stderr.write(
			`error: agent status '${status.status || "<empty>"}' for ${pane}; only idle/working may receive text\n`,
		);
		emitState("failed", `pane=${pane} reason=agent-status-${agentStatus || "empty"}`);
		return 1;
	}

	const res = spawnSync("herdr", ["pane", "run", pane, mode.text], { stdio: ["inherit", "inherit", "ignore"] });
	if (res.error || res.status !== 0) {
		process.stderr.write(`error: text not sent to ${pane} (herdr pane run failed)\n`);
		emitState("failed", `pane=${pane} reason=pane-run`);
		return 1;
	}

	if (steer && mode.text.length > 0) {
		spawnSync(join(REPO_ROOT, "sbin", "fm"), ["capture", "steer", target, mode.text, ""], {
			stdio: ["ignore", "inherit", "ignore"],
		});
	}

	if (agentStatus === "working") {
		emitState("queued", `pane=${pane}`);
		return 76;
	}
	emitState("delivered", `pane=${pane}`);
	return 0;
}

export default {
	name: "send",
	describe: "Steer or control a visible pane (not mate-to-mate communication).",
	run,
};
