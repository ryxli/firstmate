// Observe OMP task-subagent activity for fleet resting honesty.
//
// There is no stable cross-session inventory of *active* OMP task subagents.
// Live status lives in per-process AgentRegistry / hub jobs; disk transcripts
// are history (parked), not liveness. Until OMP exposes a trustworthy
// cross-session inventory, this wrapper reports `unknown` so fleet clean/check
// fail closed rather than claiming a fresh fleet.
//
// Fleet stop never calls this for termination. OMP remains sole owner of
// subagent cancellation and completion.
//
// Production never trusts env overrides. Tests may inject results only through
// the test-only hook gated by FM_ALLOW_TEST_HOOKS=1.

import { existsSync, readFileSync } from "node:fs";

export type OmpSubagentInventoryState = "ok" | "active" | "unknown";

export interface OmpSubagentInventory {
	state: OmpSubagentInventoryState;
	trustworthy: boolean;
	reason: string;
	observedAt: string;
	activeCount?: number;
}

type InventoryObserver = (controllerHome?: string) => OmpSubagentInventory;

let testObserver: InventoryObserver | null = null;

function testHooksAllowed(): boolean {
	return process.env.FM_ALLOW_TEST_HOOKS === "1";
}

/**
 * Test-only injection. Requires FM_ALLOW_TEST_HOOKS=1.
 * Pass null to clear. Never available as a production trust path.
 */
export function __setOmpSubagentInventoryForTests(observer: InventoryObserver | null): void {
	if (!testHooksAllowed()) {
		throw new Error("__setOmpSubagentInventoryForTests requires FM_ALLOW_TEST_HOOKS=1");
	}
	testObserver = observer;
}

function inventoryFromTestFile(): OmpSubagentInventory | null {
	if (!testHooksAllowed()) return null;
	const file = process.env.FM_OMP_SUBAGENT_INVENTORY_FILE?.trim();
	if (!file || !existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OmpSubagentInventory>;
		if (parsed.state !== "ok" && parsed.state !== "active" && parsed.state !== "unknown") return null;
		return {
			state: parsed.state,
			trustworthy: parsed.trustworthy === true,
			reason: String(parsed.reason ?? "test inventory file"),
			observedAt: String(parsed.observedAt ?? new Date().toISOString()),
			activeCount: typeof parsed.activeCount === "number" ? parsed.activeCount : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Cross-session active subagent inventory for fleet resting gates.
 * Returns unknown when no stable API exists (current OMP reality).
 */
export function observeOmpSubagentInventory(controllerHome?: string): OmpSubagentInventory {
	const observedAt = new Date().toISOString();
	if (testHooksAllowed() && testObserver) {
		return testObserver(controllerHome);
	}
	const fromFile = inventoryFromTestFile();
	if (fromFile) return fromFile;

	return {
		state: "unknown",
		trustworthy: false,
		reason: "no stable cross-session OMP subagent inventory API; refuse false resting",
		observedAt,
	};
}
