// fm-identity - auto-attach a named firstmate mate's identity to its herdr
// pane at omp startup, replacing the manual post-launch `herdr agent rename`
// cleanup. USER-OWNED; lives beside the herdr-managed reporter and never edits
// it. Deliberately NOT tagged HERDR_INTEGRATION_ID so the herdr integration
// installer/uninstaller will not touch this file.
//
// At session_start, for a named-mate omp session (a home carrying
// config/identity with name=), it:
//   1. agent.rename        -> sets the durable, addressable routing handle to
//                             the mate id (idempotent; survives any launch path
//                             that left a stale fm-<id> / numbered name).
//   2. pane.report_metadata -> attaches display-only identity (display_agent =
//                             human name, title = "Name - role"). Display-only:
//                             it does NOT take lifecycle authority from the
//                             active omp<->herdr state reporter, so working/
//                             idle/blocked status keeps flowing untouched.
//   3. pi.setLabel          -> sets the in-session omp label.
//
// Ordinary task crewmates (no config/identity in cwd/FM_HOME) and headless /
// subagent sessions are no-ops.
//
// Layout follows the omp convention: only this index.ts is auto-discovered as
// an extension; identity.ts (pure) loads via import. To disable: add
// `extension-module:index` under this dir to disabledExtensions, or remove the
// directory.
// @ts-nocheck

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { planPropagation, resolveHome, type SocketRequest } from "./identity";

const socketPath = process.env.HERDR_SOCKET_PATH;

function readMaybe(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

// Fire-and-forget newline-delimited JSON over the herdr unix socket, matching
// the transport the herdr<->omp reporter uses. Resolves on first response,
// socket close, or a short timeout so startup never blocks.
function sendRequest(request: SocketRequest): Promise<void> {
	if (!socketPath) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		socket.destroy();
		resolve();
	};
	const id = `user:fm-identity:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	const socket = createConnection(socketPath);
	socket.on("error", finish);
	socket.on("connect", () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
	socket.on("data", finish);
	socket.on("end", finish);
	const timeout = setTimeout(finish, 1000);
	timeout.unref?.();
	return promise;
}

export default function (pi: ExtensionAPI) {
	pi.setLabel?.("fm identity");
	let propagated = false;

	pi.on("session_start", async (_event, ctx) => {
		if (propagated) return;
		// Skip headless / subagent sessions; they share the parent's pane and
		// would only re-send the same identity.
		if (ctx?.hasUI === false) return;

		const env = {
			FM_HOME: process.env.FM_HOME,
			cwd: process.cwd(),
			HERDR_ENV: process.env.HERDR_ENV,
			HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
			HERDR_PANE_ID: process.env.HERDR_PANE_ID,
		};
		const home = resolveHome(env);
		const files = {
			markerText: readMaybe(join(home, ".fm-secondmate-home")),
			identityText: readMaybe(join(home, "config", "identity")),
		};

		const plan = planPropagation(env, files);
		if (!plan) return;
		propagated = true;

		pi.setLabel?.(plan.label);
		try {
			for (const request of plan.requests) {
				await sendRequest(request);
			}
		} catch {
			// Best-effort: identity is cosmetic routing/presentation; never break
			// the session over it.
		}
	});
}
