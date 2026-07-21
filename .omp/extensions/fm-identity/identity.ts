// Pure identity-resolution + herdr-request builders for the fm-identity omp
// extension. ZERO bun/node imports so this module is trivially unit-testable
// (the factory in index.ts wires the real fs + socket IO around it).
//
// Contract: given the process env and the contents of a named mate's
// `config/identity` + `.fm-secondmate-home` files, decide whether this omp
// session is a named firstmate mate and, if so, produce the herdr socket
// requests that attach its identity at launch:
//   - agent.rename       -> durable routing handle when the launcher did not
//                           already claim the mate's canonical slot
//   - pane.report_metadata -> display-only identity (name + role), which does
//                              NOT take lifecycle authority from the active
//                              herdr<->omp state reporter.

export const IDENTITY_SOURCE = "user:fm-identity";
export const CURRENT_SCHEMA_VERSION = "1";

export type IdentityEnv = {
	FM_HOME?: string;
	cwd: string;
	FM_AGENT_SLOT?: string;
	HERDR_ENV?: string;
	HERDR_SOCKET_PATH?: string;
	HERDR_PANE_ID?: string;
};

export type IdentityFiles = {
	// Contents of `<home>/.fm-secondmate-home` (the mate id), or null if absent.
	markerText: string | null;
	// Contents of `<home>/config/identity` (key=value lines), or null if absent.
	identityText: string | null;
};

export type ResolvedIdentity = {
	home: string;
	id: string;
	name: string;
	role: string;
	fields: Record<string, string>;
};

export type SocketRequest = {
	method: string;
	params: Record<string, unknown>;
};

export type PropagationPlan = {
	identity: ResolvedIdentity;
	label: string;
	requests: SocketRequest[];
};

// Parse `key=value` lines (the firstmate config/identity format). Ignores blank
// lines and `#` comments; trims keys and values; later keys win.
export function parseIdentityFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

// Slugify a human name into a herdr-safe routing handle: lowercase, spaces to
// hyphens, and drop anything outside [a-z0-9._-]. This is the canonical
// name -> routing-handle transformation when a home carries no explicit
// `.fm-secondmate-home` marker (e.g. the main firstmate home).
export function slug(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
}

// Returns true when the resolved identity declares schema_version=1 — the
// versioned identity contract. Older config/identity files that carry only
// name/role (and optional parent) are still valid and functional; this
// predicate lets callers gate on the migration having been applied.
export function isVersioned(identity: ResolvedIdentity): boolean {
	return identity.fields.schema_version === CURRENT_SCHEMA_VERSION;
}

export function resolveHome(env: IdentityEnv): string {
	const fm = env.FM_HOME && env.FM_HOME.trim();
	return fm || env.cwd;
}

// Resolve the named-mate identity, or null when this is not a named mate.
// Activation requires a config/identity file carrying a non-empty `name=`,
// the durable signal of a firstmate named-mate home. The id (routing handle)
// comes from the `.fm-secondmate-home` marker, falling back to a slug of the
// human name (so the main firstmate "Keel" resolves to the handle "keel",
// never its home basename "firstmate").
export function resolveIdentity(home: string, files: IdentityFiles): ResolvedIdentity | null {
	const fields = files.identityText ? parseIdentityFile(files.identityText) : {};
	const name = (fields.name ?? "").trim();
	if (!name) return null;
	const marker = (files.markerText ?? "").trim();
	const id = marker || slug(name);
	if (!id) return null;
	const role = (fields.role ?? "").trim();
	return { home, id, name, role, fields };
}

export function buildRenameRequest(paneId: string, id: string): SocketRequest {
	return { method: "agent.rename", params: { target: paneId, name: id } };
}

export function buildMetadataRequest(paneId: string, identity: ResolvedIdentity): SocketRequest {
	return {
		method: "pane.report_metadata",
		params: {
			pane_id: paneId,
			source: IDENTITY_SOURCE,
			// Guard: apply only while the pane's authoritative agent is omp, so
			// we never override another harness's presentation.
			agent: "omp",
			display_agent: identity.name,
			title: identity.role ? `${identity.name} - ${identity.role}` : identity.name,
		},
	};
}

// The full decision: enabled gate + identity resolution + request set.
// Returns null when the session is not a herdr-managed named-mate omp pane.
export function planPropagation(env: IdentityEnv, files: IdentityFiles): PropagationPlan | null {
	if (env.HERDR_ENV !== "1") return null;
	const paneId = env.HERDR_PANE_ID && env.HERDR_PANE_ID.trim();
	const socketPath = env.HERDR_SOCKET_PATH && env.HERDR_SOCKET_PATH.trim();
	if (!paneId || !socketPath) return null;

	const identity = resolveIdentity(resolveHome(env), files);
	if (!identity) return null;

	const requests = [buildMetadataRequest(paneId, identity)];
	if ((env.FM_AGENT_SLOT ?? "").trim() !== identity.id) {
		requests.unshift(buildRenameRequest(paneId, identity.id));
	}
	return {
		identity,
		label: identity.name,
		requests,
	};
}
