// fm verb: peek - print a bounded tail of a crewmate pane's output plus a
// one-line status header, resolving a bare pane name or explicit herdr pane id.
// Ported verbatim (behavior-preserving) out of the former sbin/fm peek.
// The pane-resolution logic (fm_resolve_live_pane and friends) previously
// lived in sbin/fm-herdr-lib.sh; only the slice this command actually used
// is inlined here, not the whole lib.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || join(fmHome, "state");
}

function metaValue(metaPath: string, key: string): string {
	if (!existsSync(metaPath)) return "";
	const matches = readFileSync(metaPath, "utf8")
		.split(/\r?\n/)
		.filter(line => line.startsWith(`${key}=`));
	if (matches.length === 0) return "";
	const last = matches[matches.length - 1];
	return last.slice(last.indexOf("=") + 1);
}

function metaSet(metaPath: string, key: string, value: string): void {
	let lines: string[] = [];
	if (existsSync(metaPath)) {
		lines = readFileSync(metaPath, "utf8").split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	}
	let found = false;
	const out: string[] = [];
	for (const line of lines) {
		if (line.startsWith(`${key}=`)) {
			out.push(`${key}=${value}`);
			found = true;
		} else {
			out.push(line);
		}
	}
	if (!found) out.push(`${key}=${value}`);
	writeFileSync(metaPath, out.map(line => `${line}\n`).join(""));
}

function herdrPaneId(target: string): string {
	const res = spawnSync("herdr", ["agent", "get", target], { encoding: "utf8" });
	if (res.error || typeof res.stdout !== "string") return "";
	const m = res.stdout.match(/"pane_id":"([^"]*)"/);
	return m ? m[1] : "";
}

// fm_resolve_live_pane, inlined: resolve a bare firstmate pane name (fm-xyz)
// through this home's state/<id>.meta, or pass an explicit herdr pane id
// (e.g. w8:p3) straight through. Refreshes the meta's pane= when it has
// drifted from the live herdr agent identity. Returns null (having already
// written the error to stderr) on failure, mirroring the shell function's
// `echo ... >&2; return 1`.
function resolveLivePane(target: string, state: string): string | null {
	if (target.includes(":")) return target;
	if (target.startsWith("fm-")) {
		if (!state) {
			process.stderr.write(`error: fm_resolve_live_pane needs a state dir for ${target}\n`);
			return null;
		}
		const metaPath = join(state, `${target.slice("fm-".length)}.meta`);
		if (!existsSync(metaPath)) {
			process.stderr.write(`error: no metadata for ${target} in ${state}; pass a pane id to target a pane outside this firstmate home\n`);
			return null;
		}
		const slot = metaValue(metaPath, "agent_slot") || target;
		const live = herdrPaneId(slot);
		if (live) {
			const pane = metaValue(metaPath, "pane");
			if (pane !== live) metaSet(metaPath, "pane", live);
			return live;
		}
		const pane = metaValue(metaPath, "pane");
		if (!pane) {
			process.stderr.write(`error: no pane recorded in ${metaPath}\n`);
			return null;
		}
		return pane;
	}
	const pane = herdrPaneId(target);
	if (!pane) {
		process.stderr.write(`error: no pane found for ${target}\n`);
		return null;
	}
	return pane;
}

function paneStatus(pane: string): string {
	let status = "";
	try {
		const res = spawnSync("herdr", ["pane", "get", pane], { encoding: "utf8" });
		if (!res.error && typeof res.stdout === "string") {
			// biome-ignore lint: mirrors the former python d.get("result",{}).get("pane",{}).get("agent_status","unknown") walk.
			const parsed = JSON.parse(res.stdout) as { result?: { pane?: { agent_status?: string } } };
			status = parsed?.result?.pane?.agent_status ?? "";
		}
	} catch {
		status = "";
	}
	return status || "unknown";
}

async function run(argv: string[]): Promise<number> {
	// Usage: fm peek [--full] [--status-only] <pane>
	//   --full        read 120 lines (default: 40)
	//   --status-only print only the one-line header (<name> <agent_status>)
	//   <pane> may be a bare firstmate pane name (fm-xyz), resolved through
	//   this home's state/<id>.meta, or an explicit herdr pane id (e.g. w8:p3).
	const args = argv.slice(1);
	let full = false;
	let statusOnly = false;
	let paneArg: string | undefined;

	for (const arg of args) {
		if (arg === "--full") {
			full = true;
			continue;
		}
		if (arg === "--status-only") {
			statusOnly = true;
			continue;
		}
		if (arg.startsWith("-")) {
			process.stderr.write(`error: unknown flag ${arg}\n`);
			return 1;
		}
		if (paneArg !== undefined) {
			process.stderr.write(`error: unexpected argument ${arg} (pane already set to ${paneArg})\n`);
			return 1;
		}
		paneArg = arg;
	}

	if (paneArg === undefined) {
		process.stderr.write("usage: fm peek [--full] [--status-only] <pane>\n");
		return 1;
	}

	const state = resolveState();
	const pane = resolveLivePane(paneArg, state);
	if (pane === null) return 1;

	const lines = full ? 120 : 40;

	// Fetch agent status from herdr pane get for the one-line header.
	const status = paneStatus(pane);
	process.stdout.write(`${paneArg} ${status}\n`);
	if (statusOnly) return 0;

	const attempt1 = spawnSync("herdr", ["pane", "read", pane, "--lines", String(lines), "--source", "recent-unwrapped"], { encoding: "buffer" });
	if (attempt1.stdout) process.stdout.write(attempt1.stdout);
	if (!attempt1.error && attempt1.status === 0) return 0;

	const attempt2 = spawnSync("herdr", ["pane", "read", pane, "--lines", String(lines)], { encoding: "buffer" });
	if (attempt2.stdout) process.stdout.write(attempt2.stdout);
	if (!attempt2.error && attempt2.status === 0) return 0;

	process.stderr.write(`error: could not read pane ${pane}\n`);
	return 1;
}

export default {
	name: "peek",
	describe: "Show a bounded tail of a mate's pane output.",
	surface: "captain",
	run,
};
