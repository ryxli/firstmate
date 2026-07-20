// Controller-home authorization for mutating fleet commands.
// Read-only fleet discovers the controller without treating a specialist
// FM_HOME as the whole fleet.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveMainHome } from "../../bridge/collect";
import { identityValue } from "./identity";
import { homeFromCwd } from "./root";
import { isSecondmateHome, roleKindForHome } from "./role-contract";

export type FleetAuthResult =
	| { ok: true; controllerHome: string }
	| { ok: false; reason: string };

function kindLabel(home: string): string {
	try {
		return roleKindForHome(home);
	} catch {
		return "unreadable";
	}
}

/**
 * Positive firstmate identity/marker evidence.
 * An arbitrary unmarked directory must not default to controller authority.
 */
export function hasPositiveFirstmateEvidence(home: string): boolean {
	if (!home || !existsSync(home)) return false;
	if (isSecondmateHome(home)) return false;
	const configDir = join(home, "config");
	const role = identityValue(configDir, "role")?.trim().toLowerCase();
	const parent = identityValue(configDir, "parent")?.trim().toLowerCase();
	const parentIsCap = parent === "cap" || parent === "captain";
	if (role === "firstmate") return true;
	if (parentIsCap) return true;
	const hasSbin = existsSync(join(home, "sbin", "fm")) || existsSync(join(home, "sbin", "fm-spawn.sh"));
	const hasAgents = existsSync(join(home, "AGENTS.md"));
	return hasSbin && hasAgents;
}

function assertControllerHome(home: string): FleetAuthResult {
	const normalized = home.replace(/\/+$/, "");
	const kind = kindLabel(normalized);
	if (kind !== "firstmate") {
		return { ok: false, reason: `home is ${kind}, not controller/firstmate: ${normalized}` };
	}
	if (!hasPositiveFirstmateEvidence(normalized)) {
		return {
			ok: false,
			reason: `home lacks positive firstmate identity/marker evidence: ${normalized}`,
		};
	}
	return { ok: true, controllerHome: normalized };
}

/** Mutation authority: stop/clean/update. Fail closed on invalid/unverified FM_HOME. */
export function requireControllerMutationAuthority(): FleetAuthResult {
	const pinned = process.env.FM_HOME?.trim();
	if (pinned) {
		if (!existsSync(pinned)) {
			return { ok: false, reason: `FM_HOME does not exist: ${pinned}` };
		}
		return assertControllerHome(pinned);
	}

	const nearest = homeFromCwd();
	if (nearest) {
		const asserted = assertControllerHome(nearest);
		if (!asserted.ok) {
			return {
				ok: false,
				reason: `mutating fleet commands require controller home; ${asserted.reason}`,
			};
		}
		return asserted;
	}

	const main = resolveMainHome(process.cwd());
	if (!main || !existsSync(main)) {
		return { ok: false, reason: "could not locate controller/firstmate home" };
	}
	return assertControllerHome(main);
}

/**
 * Controller root for read-only fleet commands.
 * Never treats a specialist FM_HOME as the fleet root; discovers the main home instead.
 * Explicit invalid FM_HOME (missing path) still fails closed.
 */
export function resolveFleetControllerHome(): FleetAuthResult {
	const pinned = process.env.FM_HOME?.trim();
	if (pinned) {
		if (!existsSync(pinned)) {
			return { ok: false, reason: `FM_HOME does not exist: ${pinned}` };
		}
		const asserted = assertControllerHome(pinned);
		if (asserted.ok) return asserted;
		// Specialist / unmarked pin: discover controller without using that home as fleet root.
		const kind = kindLabel(pinned);
		const saved = process.env.FM_HOME;
		const savedFirst = process.env.FIRSTMATE_HOME;
		try {
			delete process.env.FM_HOME;
			if (savedFirst && existsSync(savedFirst) && assertControllerHome(savedFirst).ok) {
				process.env.FM_HOME = savedFirst;
			} else {
				delete process.env.FIRSTMATE_HOME;
			}
			const main = resolveMainHome(process.cwd());
			if (!main || !existsSync(main)) {
				return {
					ok: false,
					reason: `FM_HOME is ${kind}; could not discover controller home for read-only fleet`,
				};
			}
			return assertControllerHome(main);
		} finally {
			if (saved !== undefined) process.env.FM_HOME = saved;
			else delete process.env.FM_HOME;
			if (savedFirst !== undefined) process.env.FIRSTMATE_HOME = savedFirst;
			else delete process.env.FIRSTMATE_HOME;
		}
	}

	const main = resolveMainHome(process.cwd());
	if (!main || !existsSync(main)) {
		return { ok: false, reason: "could not locate controller/firstmate home" };
	}
	return assertControllerHome(main);
}
