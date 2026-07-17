// fm verb: self-pane - resolve this firstmate's current herdr pane via
// `herdr pane current`, write pane/workspace/tab to state/self.meta, or
// --check for drift against the recorded value.
// Ported verbatim (behavior-preserving) out of the former sbin/fm self-pane.
// The fm_json_get / fm_meta_value helpers previously lived in
// sbin/fm-herdr-lib.sh; only the slice this command actually used is
// inlined here, not the whole lib.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveState(): { fmHome: string; state: string } {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return { fmHome, state: stateOverride || join(fmHome, "state") };
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

// fm_json_get, inlined for the one nested walk this command needs: read a
// JSON object and walk the given keys, returning "" on any parse error or
// missing key (mirrors the python helper's try/except swallow-and-print-nothing).
function jsonGet(json: string, ...keys: string[]): string {
	try {
		// biome-ignore lint: mirrors the former python json.load + nested key walk.
		let value: unknown = JSON.parse(json);
		for (const key of keys) {
			if (value === null || typeof value !== "object") return "";
			value = (value as Record<string, unknown>)[key];
		}
		if (value === undefined || value === null) return "";
		return String(value);
	} catch {
		return "";
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	let mode: "write" | "check" = "write";

	if (args.length === 0) {
		// stay write
	} else if (args.length === 1 && args[0] === "--check") {
		mode = "check";
	} else {
		process.stderr.write("usage: fm self-pane [--check]\n");
		return 2;
	}

	const { state } = resolveState();
	const metaPath = join(state, "self.meta");

	const result = spawnSync("herdr", ["pane", "current"], { encoding: "utf8" });
	const currentJson = (result.stdout ?? "").trim();
	if (!currentJson) return 1;

	const pane = jsonGet(currentJson, "result", "pane", "pane_id");
	const workspace = jsonGet(currentJson, "result", "pane", "workspace_id");
	const tab = jsonGet(currentJson, "result", "pane", "tab_id");
	const agentStatus = jsonGet(currentJson, "result", "pane", "agent_status");

	if (!pane || !workspace || !tab || !agentStatus) {
		process.stderr.write("error: herdr pane current did not resolve pane_id/workspace_id/tab_id/agent_status\n");
		return 1;
	}

	if (mode === "check") {
		const recorded = metaValue(metaPath, "pane");
		if (recorded !== pane) {
			process.stdout.write(`self-pane drift: recorded=${recorded || "absent"} current=${pane}\n`);
			return 1;
		}
		return 0;
	}

	mkdirSync(state, { recursive: true });
	const tmpPath = join(state, `.self.meta.${randomBytes(6).toString("hex")}`);
	writeFileSync(tmpPath, `pane=${pane}\nworkspace=${workspace}\ntab=${tab}\n`);
	renameSync(tmpPath, metaPath);
	process.stdout.write(`pane=${pane}\n`);
	return 0;
}

export default {
	name: "self-pane",
	describe: "Resolve this firstmate's current herdr pane and record it, or --check for drift.",
	run,
};
