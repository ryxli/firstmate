// fm verb: health - read-only, bounded health check for the local firstmate fleet.
// Migrated verbatim (behavior-preserving) out of the former sbin/fm health.
//
// One invocation reports (tab-separated: check<TAB>state<TAB>detail) to stdout:
//   - herdr / capture / roster availability
//   - each registered secondmate home: layout + identity
//   - live-pane count
//   - unknown live panes (agent panes in a tracked workspace, absent from state/*.meta)
//   - stale state/*.meta pane references (recorded pane no longer live)
//   - metadata/live identity or workspace mismatches
//
// This NEVER restarts agents, mutates fleet state, or requires the retired bin/ layout.
// A current home is valid when its sbin and extension links are correct; the mate's
// bin/ is not required to be real, symlinked, or present (a stale bin link is at most
// a warning). Exit non-zero only on required health failures; drift/diagnostic
// findings warn (exit 0).

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSecondmateRegistryLine } from "../lib/secondmate-registry";

// Physical location of this repo (unaffected by FM_ROOT_OVERRIDE), mirroring the
// original script's SCRIPT_DIR (derived from BASH_SOURCE, not from any override).
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

interface PaneRecord {
	pane_id?: string;
	agent?: string;
	display_agent?: string;
	cwd?: string;
	agent_status?: string;
}

interface SecondmateEntry {
	ident: string;
	home: string;
	workspace: string;
	name: string;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

// realpathSync throws on a nonexistent path; os.path.realpath (Python) never does.
function looseRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isDirNotSymlink(path: string): boolean {
	try {
		const info = lstatSync(path);
		return info.isDirectory() && !info.isSymbolicLink();
	} catch {
		return false;
	}
}

function isSymlinkPath(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function readlinkSafe(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

function firstLineValue(path: string, prefix: string): string | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith(prefix)) return line.slice(prefix.length);
	}
	return null;
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function normalizeTimeoutSeconds(raw: string | undefined): number {
	const value = raw ?? "";
	// Mirrors: case "$TIMEOUT" in ''|*[!0-9.]*|.*) TIMEOUT=10 ;; esac
	if (value === "" || /[^0-9.]/.test(value) || value.startsWith(".")) return 10;
	const num = Number(value);
	return Number.isFinite(num) && num >= 0 ? num : 10;
}

interface RunResult {
	ok: boolean;
	combined: string;
}

/** Run a command with a hard timeout; combined stdout+stderr mirrors the bash helper. */
function runCheck(command: string, args: string[], timeoutSec: number): RunResult {
	try {
		const result = spawnSync(command, args, {
			encoding: "utf8",
			timeout: Math.max(0, timeoutSec) * 1000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.error) {
			const err = result.error as NodeJS.ErrnoException;
			if (err.code === "ETIMEDOUT") return { ok: false, combined: "timed out\n" };
			return { ok: false, combined: `${err.message}\n` };
		}
		if (result.signal) return { ok: false, combined: "timed out\n" };
		const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		return { ok: result.status === 0, combined };
	} catch (error) {
		return { ok: false, combined: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}

// A current (sbin) home is valid when the operational dirs are local, the sbin
// link points at the canonical toolbelt, and every extension is linked. The mate
// bin/ is intentionally NOT checked here: homes may carry a stale bin symlink to
// the retired path, and bin is never required.
function checkCurrentHome(expectedId: string, home: string, fmRoot: string): boolean {
	const markerPath = join(home, ".fm-secondmate-home");
	if (!existsSync(markerPath)) return false;
	const markerRaw = readTextOrNull(markerPath);
	if (markerRaw === null) return false;
	const marker = markerRaw.trim();
	let identityName = "";
	const identityPath = join(home, "config", "identity");
	if (existsSync(identityPath)) {
		identityName = firstLineValue(identityPath, "name=") ?? "";
	}
	if (!marker) return false;
	const markerLower = marker.toLowerCase();
	const expectedLower = expectedId.toLowerCase();
	const identityLower = identityName.toLowerCase();
	if (markerLower !== expectedLower && (!identityLower || markerLower !== identityLower)) return false;
	for (const dir of ["data", "state", "config", "projects"]) {
		if (!isDirNotSymlink(join(home, dir))) return false;
	}
	const sbinPath = join(home, "sbin");
	if (!isSymlinkPath(sbinPath)) return false;
	const sbinTarget = readlinkSafe(sbinPath);
	if (sbinTarget !== join(fmRoot, "sbin")) return false;
	const extDir = join(home, ".omp", "extensions");
	if (!isDirectory(extDir) || isSymlinkPath(extDir)) return false;
	const rootExtDir = join(fmRoot, ".omp", "extensions");
	if (!isDirectory(rootExtDir)) return false;
	let entries: string[];
	try {
		entries = readdirSync(rootExtDir);
	} catch {
		return false;
	}
	for (const name of entries) {
		const entrySource = join(rootExtDir, name);
		const homeEntry = join(home, ".omp", "extensions", name);
		if (existsSync(homeEntry) && !isSymlinkPath(homeEntry)) continue;
		if (!isSymlinkPath(homeEntry)) return false;
		const target = readlinkSafe(homeEntry);
		if (target !== entrySource) return false;
	}
	return true;
}

// Depth-first registry walk: `- <ident> - ... (home: <path>[; workspace: ...][; name: ...])`.
// A registered home may itself register children via its own data/secondmates.md.
function walkRegistry(regPath: string, seenRegs: Set<string>, seenHomes: Set<string>, out: SecondmateEntry[]): void {
	const abs = resolve(regPath);
	if (seenRegs.has(abs)) return;
	let isFile = false;
	try {
		isFile = statSync(abs).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) return;
	seenRegs.add(abs);
	const text = readTextOrNull(abs) ?? "";
	for (const rawLine of text.split(/\r?\n/)) {
		const parsed = parseSecondmateRegistryLine(rawLine);
		if (!parsed || !parsed.home) continue;
		const home = expandHome(parsed.home);
		if (seenHomes.has(home)) continue;
		seenHomes.add(home);
		out.push({ ident: parsed.id, home, workspace: parsed.workspace, name: parsed.name });
		walkRegistry(join(home, "data", "secondmates.md"), seenRegs, seenHomes, out);
	}
}

function wsOf(paneId: string): string {
	const idx = paneId.indexOf(":");
	return idx >= 0 ? paneId.slice(0, idx) : "";
}

function labelOf(pane: PaneRecord): string {
	return pane.display_agent || pane.agent || "";
}

function parsePanes(text: string): PaneRecord[] {
	try {
		const parsed = JSON.parse(text) as { result?: { panes?: unknown } };
		const panes = parsed?.result?.panes;
		return Array.isArray(panes) ? (panes as PaneRecord[]) : [];
	} catch {
		return [];
	}
}

function parseMetaFile(text: string): Record<string, string> {
	const kv: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const idx = line.indexOf("=");
		if (idx === -1) continue;
		kv[line.slice(0, idx)] = line.slice(idx + 1);
	}
	return kv;
}

async function run(_argv: string[]): Promise<number> {
	const fmRootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = fmRootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || fmRootOverride || fmRoot;
	const data = process.env.FM_DATA_OVERRIDE?.trim() || join(fmHome, "data");
	const state = process.env.FM_STATE_OVERRIDE?.trim() || join(fmHome, "state");
	const helperDir = process.env.FM_HEALTH_SCRIPT_DIR?.trim() || join(REPO_ROOT, "sbin");
	const timeoutSec = normalizeTimeoutSeconds(process.env.FM_HEALTH_TIMEOUT);

	const lines: string[] = [];
	let status = 0;
	let warning = 0;
	const emit = (check: string, checkState: string, detail: string): void => {
		lines.push(`${check}\t${checkState}\t${detail}`);
		if (checkState === "fail") status = 1;
		if (checkState === "warn") warning = 1;
	};

	// --- herdr / capture / roster --------------------------------------------
	const herdrResult = runCheck("herdr", ["status"], timeoutSec);
	if (herdrResult.ok) {
		if (/status: running/.test(herdrResult.combined)) emit("herdr", "ok", "running");
		else emit("herdr", "fail", "not-running");
	} else {
		emit("herdr", "fail", "command-failed");
	}

	const captureResult = runCheck(join(helperDir, "fm"), ["capture-status"], timeoutSec);
	if (captureResult.ok) {
		const hook = findFirst(captureResult.combined, "fleet_hook");
		const supervisor = findFirst(captureResult.combined, "supervisor_auto");
		if (hook === "present" && supervisor === "live") emit("capture", "ok", `hook=${hook} supervisor=${supervisor}`);
		else if (hook === "present") emit("capture", "warn", `hook=${hook} supervisor=${supervisor ?? "unknown"}`);
		else emit("capture", "fail", `hook=${hook ?? "unknown"} supervisor=${supervisor ?? "unknown"}`);
	} else {
		emit("capture", "fail", "command-failed");
	}

	const rosterResult = runCheck(join(helperDir, "fm"), ["panes"], timeoutSec);
	if (rosterResult.ok) {
		const count = rosterResult.combined.split("\n").filter(line => line.length > 0).length;
		emit("roster", "ok", `panes=${count}`);
	} else {
		emit("roster", "fail", "command-failed");
	}

	// --- registered secondmate homes: layout + identity -----------------------
	const registryPath = join(data, "secondmates.md");
	const entries: SecondmateEntry[] = [];
	if (existsSync(registryPath)) {
		walkRegistry(registryPath, new Set<string>(), new Set<string>(), entries);
		for (const { ident, home, name } of entries) {
			if (isSymlinkPath(join(home, ".omp"))) {
				// Legacy plain-clone home (whole .omp symlinked): delegate to `fm home-link`.
				const legacy = runCheck(join(helperDir, "fm"), ["home-link", home, "--check"], timeoutSec);
				if (legacy.ok) {
					emit(`home:${ident}`, "ok", "checked");
				} else {
					const matches = [...legacy.combined.matchAll(/^result=(.*)$/gm)];
					const detail = matches.length ? matches[matches.length - 1][1] : "check-failed";
					emit(`home:${ident}`, "fail", detail || "check-failed");
				}
			} else if (checkCurrentHome(ident, home, fmRoot)) {
				emit(`home:${ident}`, "ok", "checked");
			} else {
				emit(`home:${ident}`, "fail", "current-layout");
			}
			// bin is optional; only a dangling bin symlink is worth a (non-fatal) warning.
			const binPath = join(home, "bin");
			if (isSymlinkPath(binPath) && !existsSync(binPath)) {
				emit(`bin:${ident}`, "warn", `stale-link -> ${readlinkSafe(binPath)}`);
			}
			// Identity is part of the named-home contract: versioned schema plus the
			// registry display name are required for reliable routing.
			const identityPath = join(home, "config", "identity");
			if (existsSync(identityPath)) {
				const schema = firstLineValue(identityPath, "schema_version=") ?? "";
				const idname = firstLineValue(identityPath, "name=") ?? "";
				if (schema !== "1") {
					emit(`identity:${ident}`, "fail", `schema_version=${schema || "missing"}`);
				} else if (!idname) {
					emit(`identity:${ident}`, "fail", "name-missing");
				} else if (name && idname !== name) {
					emit(`identity:${ident}`, "fail", `name registry=${name} config=${idname}`);
				} else {
					emit(`identity:${ident}`, "ok", `name=${idname}`);
				}
			} else {
				emit(`identity:${ident}`, "fail", "identity-missing");
			}
		}
	} else {
		emit("registry", "fail", "missing");
	}

	// --- live panes / drift (diagnostic; warn only) ----------------------------
	const panesResult = runCheck("herdr", ["pane", "list"], timeoutSec);
	if (panesResult.ok) {
		const panes = parsePanes(panesResult.combined);
		const live = new Map<string, PaneRecord>();
		for (const p of panes) if (p.pane_id) live.set(p.pane_id, p);
		const liveAgents = new Map<string, PaneRecord>();
		for (const [pid, p] of live) if (labelOf(p)) liveAgents.set(pid, p);
		emit("live-panes", "ok", `count=${liveAgents.size}`);

		let ownName = "";
		const identityFile = join(fmHome, "config", "identity");
		if (existsSync(identityFile)) ownName = firstLineValue(identityFile, "name=")?.trim() ?? "";
		const fmHomeReal = looseRealpath(fmHome);

		const metas = new Map<string, Record<string, string>>();
		let metaFiles: string[] = [];
		try {
			metaFiles = readdirSync(state).filter(name => name.endsWith(".meta")).sort();
		} catch {
			metaFiles = [];
		}
		for (const name of metaFiles) {
			const text = readTextOrNull(join(state, name));
			if (text === null) continue;
			metas.set(name.slice(0, -".meta".length), parseMetaFile(text));
		}
		const metaPanes = new Map<string, string>();
		for (const [ident, kv] of metas) if (kv.pane) metaPanes.set(kv.pane, ident);

		const reg = new Map<string, { home: string; ws: string; name: string }>();
		const mateLabels = new Set<string>();
		const homeWs = new Set<string>();
		for (const pane of metaPanes.keys()) if (pane) homeWs.add(wsOf(pane));
		for (const { ident, home, workspace, name } of entries) {
			reg.set(ident, { home, ws: workspace, name });
			mateLabels.add(ident.toLowerCase());
			if (name) mateLabels.add(name.toLowerCase());
			if (workspace) homeWs.add(workspace);
			if (workspace && looseRealpath(home) === looseRealpath(fmHome)) homeWs.add(workspace);
		}

		// Stale metadata: recorded pane no longer live.
		for (const [ident, kv] of metas) {
			const pane = kv.pane ?? "";
			if (pane && !live.has(pane)) emit(`meta:${ident}`, "warn", `stale-pane=${pane}`);
		}

		// Identity mismatch: recorded agent identity vs the live pane's agent.
		for (const [ident, kv] of metas) {
			const pane = kv.pane ?? "";
			if (pane && live.has(pane)) {
				const want = kv.agent_identity || kv.harness || "";
				const got = live.get(pane)?.agent || "";
				if (want && got && want !== got) emit(`meta:${ident}`, "warn", `mismatch agent meta=${want} live=${got}`);
			}
		}

		// Unknown live panes: an agent pane in a tracked workspace, not in any meta, not
		// a registered mate's supervisor pane, and not this firstmate's own supervisor
		// pane (own identity name + cwd == FM_HOME).
		for (const pid of [...liveAgents.keys()].sort()) {
			const p = liveAgents.get(pid)!;
			if (metaPanes.has(pid)) continue;
			if (homeWs.size > 0 && !homeWs.has(wsOf(pid))) continue;
			const lab = labelOf(p);
			if (mateLabels.has(lab.toLowerCase())) continue;
			const pcwd = p.cwd ?? "";
			if (ownName && lab.toLowerCase() === ownName.toLowerCase() && pcwd && looseRealpath(pcwd) === fmHomeReal) continue;
			emit(`pane:${pid}`, "warn", `unknown ws=${wsOf(pid)} label=${lab}`);
		}

		// Workspace mismatch: a registered mate's live pane not in its registered workspace.
		const byLabel = new Map<string, string>();
		for (const [pid, p] of liveAgents) {
			const lab = labelOf(p).toLowerCase();
			if (lab && !byLabel.has(lab)) byLabel.set(lab, pid);
		}
		for (const [ident, { ws, name }] of reg) {
			if (!ws) continue;
			const pid = byLabel.get((name || ident).toLowerCase());
			if (pid && wsOf(pid) !== ws) emit(`workspace:${ident}`, "warn", `registry=${ws} live=${wsOf(pid)}`);
		}
	} else {
		emit("live-panes", "warn", "pane-list-unavailable");
	}

	if (status !== 0) lines.push("overall\tfail\trequired check failed");
	else if (warning !== 0) lines.push("overall\twarn\twarnings present");
	else lines.push("overall\tok\tall checks passed");

	process.stdout.write(`${lines.join("\n")}\n`);
	return status;
}

function findFirst(text: string, key: string): string | undefined {
	const match = new RegExp(`^${key}[ \\t]*(.*)$`, "m").exec(text);
	return match ? match[1] : undefined;
}

export default {
	name: "health",
	describe: "Run a quick local fleet health check.",
	surface: "captain",
	run,
};
