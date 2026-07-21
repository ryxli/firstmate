// Typed harness exit for visible panes.
//
// Proof:
//   1. Capture a non-empty agent_session.value before delivering exit.
//   2. `herdr wait agent-status <pane> --status unknown --timeout <ms>`
//      (event-backed; wait success alone is not proof).
//   3. Correlated pane get must show the original session absent or changed;
//      if stale, process-info must report the exact shell fallback.
// Rebind checks only inspect.slot (authoritative resolved name), never a
// simultaneous fm-<id> alias.

import { spawnSync } from "node:child_process";
import { adapterAwareExitSupported, exitCommand } from "./harness-adapters";
import {
	herdrPaneAgentProcessVerdict,
	inspectLivePane,
	observeComposer,
	readAgentSlot,
	readPaneSnapshot,
	refreshPaneBinding,
	type InspectLivePaneResult,
} from "./herdr";

export type PaneExitState =
	| "already-stopped"
	| "composer-blocked"
	| "delivered"
	| "consumed"
	| "failed";

export interface PaneExitResult {
	state: PaneExitState;
	pane?: string;
	sessionId?: string;
	reason?: string;
	inspect?: InspectLivePaneResult;
}

export interface PaneExitOptions {
	target: string;
	stateDir: string;
	harness: string;
	/** When set, skip inspect and use this pane id (must already be validated). */
	pane?: string;
	timeoutMs?: number;
	/** Refresh meta pane= after live slot validation (fleet stop). */
	refreshBinding?: boolean;
}

/**
 * Correlated session-value proof after an event-backed wait.
 * Requires a non-empty original agent_session.value that later disappears or
 * changes. Empty↔empty is not a transition. If the session value is stale,
 * an exact shell process verdict is the only fallback proof; agent and err
 * verdicts fail closed.
 */
export function sessionValueRetired(preSession: string, pane: string): boolean {
	if (!preSession) return false;
	const snap = readPaneSnapshot(pane);
	if (snap.presence === "error") return false;
	if (snap.presence === "absent") return true;
	if (snap.paneId !== pane) return false;
	return !snap.sessionId || snap.sessionId !== preSession;
}

/**
 * Rebind check against the authoritative resolved slot only.
 * After agent.rename("fran"), fm-fran may be absent while fran remains bound.
 */
function assertResolvedSlotStillBound(slot: string, pane: string): string | null {
	if (!slot || slot.includes(":")) return null;
	const bound = readAgentSlot(slot);
	if (bound.presence === "absent") return "slot absent before exit delivery";
	if (bound.presence === "error") return `slot rebind check error: ${bound.reason}`;
	if (bound.paneId !== pane) return "pane mismatch: slot rebound before exit delivery";
	return null;
}

/**
 * Correlated verification surrounds an event-backed wait. A shell that already
 * exists avoids the wait entirely. When Herdr already reports unknown before
 * exit, bounded process rechecks let a still-closing harness reach its restored
 * shell. Agent and err verdicts remain fail-closed until the deadline.
 */
function proveSessionRetirement(preSession: string, pane: string, timeoutMs: number): boolean {
	const timeout = Math.max(250, timeoutMs);
	const deadline = Date.now() + timeout;
	if (sessionValueRetired(preSession, pane)) return true;
	const initialVerdict = herdrPaneAgentProcessVerdict(pane);
	if (initialVerdict === "shell") return true;
	const wait = spawnSync(
		"herdr",
		["wait", "agent-status", pane, "--status", "unknown", "--timeout", String(timeout)],
		{ encoding: "utf8" },
	);
	if (wait.error && (wait.error as NodeJS.ErrnoException).code === "ENOENT") {
		return false;
	}
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (true) {
		if (sessionValueRetired(preSession, pane)) return true;
		const verdict = herdrPaneAgentProcessVerdict(pane);
		if (verdict === "shell") return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		Atomics.wait(sleeper, 0, 0, Math.min(100, remaining));
	}
}

/**
 * Deliver adapter exit and prove correlated session retirement when possible.
 * Does not close panes or tear down homes.
 */
export async function exitPaneSession(opts: PaneExitOptions): Promise<PaneExitResult> {
	const harness = opts.harness.trim();
	if (!harness) return { state: "failed", reason: "missing harness" };
	const cmd = exitCommand(harness);
	if (!cmd) return { state: "failed", reason: `no exit command for harness '${harness}'` };
	if (!adapterAwareExitSupported(harness)) {
		return { state: "failed", reason: `exit not supported for harness '${harness}'` };
	}

	const inspect = inspectLivePane(opts.target, opts.stateDir);
	if (inspect.class === "absent" || inspect.class === "shell") {
		return { state: "already-stopped", inspect, pane: inspect.livePane || inspect.recordedPane, reason: inspect.class };
	}
	if (inspect.class === "stale-binding") {
		return { state: "failed", inspect, reason: "stale-binding: recorded pane is not the mate agent slot" };
	}
	if (inspect.class === "error" || inspect.class === "unknown") {
		return { state: "failed", inspect, reason: inspect.reason || inspect.class };
	}

	const pane = opts.pane || inspect.livePane;
	const slot = inspect.slot;
	if (!pane) return { state: "failed", inspect, reason: "no live pane" };
	if (opts.refreshBinding) refreshPaneBinding(opts.target, opts.stateDir, pane);

	const pre = readPaneSnapshot(pane);
	if (pre.presence === "error") {
		return { state: "failed", pane, inspect, reason: pre.errorMessage || "pane get error before exit" };
	}
	if (pre.presence === "absent") {
		return { state: "already-stopped", pane, inspect, reason: "pane-absent-before-exit" };
	}
	const preSession = pre.sessionId.trim();
	if (!preSession) {
		return {
			state: "failed",
			pane,
			inspect,
			reason: "missing agent_session.value; cannot correlate retirement",
		};
	}

	const rebindErr = assertResolvedSlotStillBound(slot, pane);
	if (rebindErr) {
		return { state: "failed", pane, sessionId: preSession, inspect, reason: rebindErr };
	}
	if (herdrPaneAgentProcessVerdict(pane) === "shell") {
		return { state: "already-stopped", pane, sessionId: preSession, inspect, reason: "shell" };
	}

	const composer = observeComposer(pane);
	if (composer.state === "error") {
		return { state: "failed", pane, inspect, reason: `composer observation error: ${composer.reason}` };
	}
	if (composer.state === "pending") {
		return { state: "composer-blocked", pane, inspect, reason: "composer-draft" };
	}

	const delivery = readPaneSnapshot(pane);
	if (
		delivery.presence !== "present" ||
		delivery.paneId !== pane ||
		!delivery.sessionId ||
		delivery.sessionId !== preSession
	) {
		return {
			state: "failed",
			pane,
			sessionId: preSession,
			inspect,
			reason: "pane/session changed before exit delivery",
		};
	}
	const res = spawnSync("herdr", ["pane", "run", pane, cmd], { encoding: "utf8" });
	if (res.error || res.status !== 0) {
		return { state: "failed", pane, sessionId: preSession, inspect, reason: "exit command not delivered" };
	}

	const timeoutMs = opts.timeoutMs ?? Number(process.env.FM_EXIT_RETIRE_TIMEOUT_MS ?? "60000");
	if (proveSessionRetirement(preSession, pane, timeoutMs)) {
		return { state: "consumed", pane, sessionId: preSession, inspect };
	}
	return {
		state: "failed",
		pane,
		sessionId: preSession,
		inspect,
		reason: "session retirement not correlated after agent-status wait",
	};
}
