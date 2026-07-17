// fm verb: capture-status - report whether the fleet hook and the
// supervisor-plane capture extension are live.
// Ported verbatim (behavior-preserving) from the former sbin/fm capture-status.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// The steer-capture hook lives in the send verb's source: send.ts invokes
// `fm capture steer ...` on every --steer. Probe that file for the call.
const FM_SEND_SRC = fileURLToPath(new URL("./send.ts", import.meta.url));

function fleetHookState(): "present" | "missing" {
	try {
		const contents = readFileSync(FM_SEND_SRC, "utf8");
		return contents.includes('"capture", "steer"') ? "present" : "missing";
	} catch {
		return "missing";
	}
}

function fmtTs(tsMs: unknown): string {
	if (!tsMs) return "-";
	try {
		const n = Number(tsMs);
		if (!Number.isFinite(n)) return String(tsMs);
		const d = new Date(n);
		const pad = (x: number) => String(x).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	} catch {
		return String(tsMs);
	}
}

function loadedState(loadedPath: string): { state: string; loaded: Record<string, unknown> | null } {
	if (!existsSync(loadedPath)) return { state: "fresh-session-start-only", loaded: null };
	try {
		const loaded = JSON.parse(readFileSync(loadedPath, "utf8")) as Record<string, unknown>;
		const pid = String(loaded.pid ?? "");
		if (pid && existsSync(`/proc/${pid}`)) {
			return { state: "live", loaded };
		}
		const ps = spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" });
		const state = ps.status === 0 && ps.stdout && ps.stdout.trim() ? "live" : "stale-marker";
		return { state, loaded };
	} catch {
		return { state: "bad-marker", loaded: null };
	}
}

function lastEvent(eventsPath: string): Record<string, unknown> | null {
	if (!existsSync(eventsPath)) return null;
	try {
		let last: Record<string, unknown> | null = null;
		const content = readFileSync(eventsPath, "utf8");
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line) last = JSON.parse(line);
		}
		return last;
	} catch {
		return { plane: "?", kind: "bad-event-log", ts: 0 };
	}
}

async function run(_argv: string[]): Promise<number> {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR || `${process.env.HOME ?? homedir()}/.omp/agent`;
		const captureDir = `${agentDir}/capture`;
		const eventsPath = process.env.CAPTURE_EVENTS_PATH || `${captureDir}/events.jsonl`;
		const loadedPath = process.env.CAPTURE_LOADED_PATH || `${captureDir}/loaded.json`;

		const fleetHook = fleetHookState();
		const { state: supervisorAuto, loaded } = loadedState(loadedPath);
		const last = lastEvent(eventsPath);

		const lines: string[] = [];
		lines.push(`fleet_hook\t${fleetHook}`);
		lines.push(`supervisor_auto\t${supervisorAuto}`);
		if (loaded) {
			lines.push(`loaded_ts\t${fmtTs(loaded.ts ?? 0)}`);
			lines.push(`loaded_pid\t${loaded.pid ?? ""}`);
			lines.push(`loaded_revision\t${loaded.revision ?? ""}`);
		}
		if (last) {
			lines.push(`last_event\t${last.plane ?? "?"}\t${last.kind ?? "?"}\t${fmtTs(last.ts ?? 0)}`);
		} else {
			lines.push("last_event\tnone");
		}
		process.stdout.write(`${lines.join("\n")}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

export default {
	name: "capture-status",
	describe: "Report whether the fleet hook and supervisor-plane capture extension are live.",
	run,
};
