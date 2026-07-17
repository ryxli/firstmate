// fm-reload omp extension: captures session identity so the fm-reload shell
// command can resume the conversation after an omp restart.
//
// What it does:
//   - session_start: writes {session_id, session_path, cwd, pane_id} to
//     ~/.omp/agent/fm-reload/state.json, indexed by both pane_id (when
//     HERDR_PANE_ID is set) and cwd. This gives fm-reload two lookup paths.
//   - /reload command: prints the session ID + exact command to resume after
//     exiting omp. Also tells you the state has been persisted.
//
// The state file is machine-local runtime state; it is gitignored via
// .chezmoiignore and never committed.
//
// To disable: add `extension-module:fm-reload` to `disabledExtensions` in
// ~/.omp/agent/config.yml.
// @ts-nocheck

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// stateDir() re-evaluates PI_CODING_AGENT_DIR on every call (test seam: lets
// tests redirect writes by setting the env var before invoking handlers).
function stateDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return join(agentDir, "fm-reload");
}

type SessionEntry = {
	session_id: string;
	session_path: string;
	cwd: string;
	pane_id: string;
	ts: number;
};

function readState(): Record<string, SessionEntry> {
	try {
		return JSON.parse(readFileSync(join(stateDir(), "state.json"), "utf8")) as Record<string, SessionEntry>;
	} catch {
		return {};
	}
}

function writeState(updates: Record<string, SessionEntry>): void {
	const dir = stateDir();
	try {
		mkdirSync(dir, { recursive: true });
		const state = readState();
		for (const [k, v] of Object.entries(updates)) {
			state[k] = v;
		}
		writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
	} catch {
		// Non-fatal: fm-reload falls back to session-dir scan.
	}
}

export default function fmReload(pi: ExtensionAPI) {
	pi.setLabel?.("fm-reload");

	let capturedSessionId = "";
	let capturedSessionPath = "";
	let capturedCwd = "";

	function readSessionIdentity(ctx: unknown): { id: string; path: string } {
		const sessionManager = (ctx as {
			sessionManager?: {
				getSessionId?: () => string;
				getSessionFile?: () => string;
			};
		} | undefined)?.sessionManager;
		let id = "";
		let path = "";
		try {
			id = sessionManager?.getSessionId?.() ?? "";
		} catch {
			// Session identity is best-effort during lifecycle startup.
		}
		try {
			path = sessionManager?.getSessionFile?.() ?? "";
		} catch {
			// Session identity is best-effort during lifecycle startup.
		}
		return { id, path };
	}

	function persistSessionIdentity(identity: { id: string; path: string }): void {
		if (!identity.id) return;

		const cwd = process.cwd();
		const changed =
			identity.id !== capturedSessionId ||
			identity.path !== capturedSessionPath ||
			cwd !== capturedCwd;
		capturedSessionId = identity.id;
		capturedSessionPath = identity.path;
		capturedCwd = cwd;
		if (!changed) return;

		const paneId = process.env.HERDR_PANE_ID ?? "";
		const entry: SessionEntry = {
			session_id: capturedSessionId,
			session_path: capturedSessionPath,
			cwd: capturedCwd,
			pane_id: paneId,
			ts: Date.now(),
		};

		// Index by both so fm-reload can look up by pane OR by cwd.
		const updates: Record<string, SessionEntry> = { [capturedCwd]: entry };
		if (paneId) {
			updates[`pane:${paneId}`] = entry;
		}
		writeState(updates);
	}

	function captureAndPersistSession(ctx: unknown): void {
		const identity = readSessionIdentity(ctx);
		if (!identity.id) return;
		persistSessionIdentity(identity);
	}

	pi.on("session_start", (_event, ctx) => {
		captureAndPersistSession(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		captureAndPersistSession(ctx);
	});

	pi.registerCommand?.("reload", {
		description: "Show how to reload omp (reload extensions without losing context)",
		handler: (_args: string[], _ctx: unknown): string => {
			if (!capturedSessionId) {
				return [
					"fm-reload: no session ID captured yet.",
					"",
					"If you just started this session, wait for session_start to complete.",
					"Otherwise: exit omp, then run fm-reload (it will scan your session history).",
				].join("\n");
			}

			const paneId = process.env.HERDR_PANE_ID ?? "";
			const resumeFlag = capturedSessionPath ? `--resume "${capturedSessionPath}"` : `--resume "${capturedSessionId}"`;

			const lines = [
				"To reload omp with this session:",
				"  1. Exit omp (type q, or Ctrl+C in interactive mode)",
				`  2. Run:  fm-reload`,
				"",
				"Or resume manually (WARNING: this drops any pinned FM_HOME/model tier -",
				"sbin/fm-reload.sh restores both from state/<id>.meta, this line does not):",
				`  omp ${resumeFlag} --cwd "${capturedCwd}"`,
				"",
				`Session ID   : ${capturedSessionId}`,
				`CWD          : ${capturedCwd}`,
			];
			if (capturedSessionPath) {
				lines.push(`Session path : ${capturedSessionPath}`);
			}
			if (paneId) {
				lines.push(`Pane ID      : ${paneId}`);
			}
			lines.push("", "State saved - fm-reload will pick it up after you exit.");
			return lines.join("\n");
		},
	});
}
