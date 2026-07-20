// whiteboard config loader.
//
// Resolves portable global and agent board paths.
// The global board keeps the historical WHITEBOARD_FILE override.
// Agent boards are scoped to seeded secondmate homes via resolveCurrentIdentity().
//
// resolveCurrentIdentity() uses Firstmate's identity core to identify the current
// named-mate. It works for main firstmates (config/identity name= only, no .fm-secondmate-home
// marker) as well as secondmates (marker present).
// Sessions without a versioned identity (schema_version=1 plus nonempty name) return null and
// have no loop. Marker-only homes with no versioned identity no longer get agent board access.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	isVersioned,
	resolveHome as _fmResolveHome,
	resolveIdentity as _fmResolveIdentity,
	type IdentityEnv,
	type IdentityFiles,
	type ResolvedIdentity,
} from "../fm-identity/identity.ts";

export type { ResolvedIdentity };

export type BoardScopeKind = "global" | "agent";

export interface ResolvedBoardScope {
	kind: BoardScopeKind;
	id: string;
	label: string;
	path: string;
	home?: string;
}

/** Active omp agent directory. Honors `PI_CODING_AGENT_DIR` (set under `--profile`). */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR?.trim();
	return env && env.length > 0 ? env : join(homedir(), ".omp", "agent");
}

/** Path to the global whiteboard markdown file. Override with `WHITEBOARD_FILE`. */
export function boardPath(): string {
	const env = process.env.WHITEBOARD_FILE?.trim();
	return env && env.length > 0 ? env : join(agentDir(), "whiteboard.md");
}

export function globalScope(): ResolvedBoardScope {
	const path = boardPath();
	return { kind: "global", id: "global", label: "global", path };
}

export function currentAgentHome(): string | undefined {
	const home = process.env.FM_HOME?.trim();
	if (!home) return undefined;
	return existsSync(join(home, ".fm-secondmate-home")) ? home : undefined;
}

export function currentAgentId(home = currentAgentHome()): string | undefined {
	if (!home) throw new Error("agent whiteboard unavailable: FM_HOME is not a seeded secondmate home");
	try {
		const id = readFileSync(join(home, ".fm-secondmate-home"), "utf8").trim();
		if (id.length > 0) return id;
	} catch {
		// fall through to the canonical unavailable error
	}
	throw new Error("agent whiteboard unavailable: FM_HOME is not a seeded secondmate home");
}

export function agentScope(home = currentAgentHome()): ResolvedBoardScope {
	const identity = home
		? resolveCurrentIdentity({ FM_HOME: home, cwd: home })
		: resolveCurrentIdentity();
	if (identity) {
		return {
			kind: "agent",
			id: identity.id,
			label: `agent:${identity.id}`,
			home: identity.home,
			path: identityBoardPath(identity),
		};
	}
	throw new Error("agent whiteboard unavailable: no named-agent identity");
}

/**
 * Default scope: uses the current named-agent identity's board when one is present,
 * otherwise falls back to the global board.
 */
export function defaultScope(): ResolvedBoardScope {
	const identity = resolveCurrentIdentity();
	if (identity) {
		return {
			kind: "agent",
			id: identity.id,
			label: `agent:${identity.id}`,
			home: identity.home,
			path: identityBoardPath(identity),
		};
	}
	return globalScope();
}

/**
 * Resolve the named-mate identity for the current process using fleet-bus core logic.
 * Requires config/identity with schema_version=1 and a nonempty name=.
 * Supports versioned secondmates (marker provides the routing id) and main firstmates (slug(name)).
 * Returns null for unversioned or unnamed sessions.
 * `env` defaults to { FM_HOME, cwd: process.cwd() }.
 */
export function resolveCurrentIdentity(env?: IdentityEnv): ResolvedIdentity | null {
	const resolvedEnv: IdentityEnv = env ?? {
		FM_HOME: process.env.FM_HOME?.trim() || undefined,
		cwd: process.cwd(),
	};
	const home = _fmResolveHome(resolvedEnv);
	const markerPath = join(home, ".fm-secondmate-home");
	const identityPath = join(home, "config", "identity");
	const files: IdentityFiles = {
		markerText: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null,
		identityText: existsSync(identityPath) ? readFileSync(identityPath, "utf8") : null,
	};
	const identity = _fmResolveIdentity(home, files);
	return identity && isVersioned(identity) ? identity : null;
}

/**
 * The agent board path for a resolved identity.
 * Always <identity.home>/data/whiteboard.md.
 */
export function identityBoardPath(identity: ResolvedIdentity): string {
	return join(identity.home, "data", "whiteboard.md");
}

/** The durable backlog inventory for a resolved identity. */
export function identityBacklogPath(identity: ResolvedIdentity): string {
	return join(identity.home, "data", "backlog.md");
}
