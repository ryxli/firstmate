// fm verb: reload - quit an omp pane, wait for the shell to return, then
// resume the exact prior session.
// Ported behavior-preserving from the former sbin/fm reload (and the
// fm_resolve_live_pane / fm_json_get / fm_herdr_pane_agent_process_verdict /
// fm_meta_set helpers it sourced from sbin/fm-herdr-lib.sh, now imported from
// ../lib/herdr).
//
// Usage: fm reload [target] [--cmd '<template>'] [--allow-fresh]
//                   [--timeout <sec>] [--proof-timeout <sec>]
//
// <target> may be:
//   w1:p3      explicit herdr pane id
//   fm-riggs   durable firstmate mate name (resolved via state/<id>.meta)
//   (none)     auto-detect via 'herdr pane current'
//
// The prior session id is captured BEFORE sending /quit so it is never lost
// to output scroll. After relaunch the command waits for omp to reappear in
// the pane and verifies the session id matches, then exits. It exits
// non-zero without touching the pane when no session id is found and
// --allow-fresh is not set. It exits non-zero after the quit when omp does
// not exit within <timeout> seconds, omp does not restart within
// <proof-timeout> seconds, or the resumed session id does not match the
// captured prior id.
//
// Self-reload: when this command is invoked from inside the very pane it
// targets (a child of that pane's agent), sending /quit would kill the agent
// and this process with it before the relaunch step, leaving the pane dead
// at a shell with the session apparently aborted. This is detected (target
// pane == 'herdr pane current') and, once every fail-closed check has passed
// synchronously, the quit/relaunch/proof sequence is handed to a detached
// worker process (a fresh `fm reload` invocation with FM_RELOAD_DETACHED=1)
// that survives the agent's exit. The caller returns immediately with the
// worker pid and a progress log path (state/.reload.<pane>.log); the worker
// appends a final "succeeded"/"FAILED" line there so the outcome stays
// observable.
//
// Pane survival: herdr closes a pane whose root process is the agent itself.
// When the target pane is gone after the quit, the relaunch provisions a
// replacement pane in the same workspace and cwd and resumes the session
// there; the session-id continuity proof runs against whichever pane hosts
// the resume. This applies to inline reloads as well as detached ones. When
// the target was a durable fm-<id> and the resume landed in a replacement
// pane, the target's state/<id>.meta is rebound (pane= and tab=) before
// success is reported, so supervision and later recovery follow the resumed
// session instead of the closed pane.
//
// Env overrides:
//   FM_RELOAD_CMD           Default value for --cmd.
//   FM_RELOAD_TIMEOUT       Default value for --timeout.
//   FM_RELOAD_PROOF_TIMEOUT Default value for --proof-timeout.
//   FM_RELOAD_QUIT_GRACE    Seconds to sleep after /quit before polling. Default: 1.
//   FM_RELOAD_ALLOW_FRESH   Set to a non-empty value to allow fresh session (same as --allow-fresh).
//   FM_OMP_SESSION_STORE    Base path for omp session store. Default: $HOME/.omp/agent/sessions.
//   FM_RELOAD_SESSION_ID    Use this session id instead of capturing one from the pane.
//   FM_RELOAD_SELF_TIMEOUT  Minimum quit-wait for the detached self-reload worker
//                           (the agent finishes its turn before honoring /quit). Default: 60.
//   FM_RELOAD_NO_GUARD      Set to a non-empty value to skip self-reload detection and run inline.
//   FM_RELOAD_DETACHED      Internal: set on the detached worker; do not set by hand.
//   FM_RELOAD_META          Internal: durable target's meta file, carried to the
//                           detached worker so it can rebind pane=/tab= after a
//                           replacement-pane recovery; do not set by hand.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonGet, herdrPaneAgentProcessVerdict, metaSet, resolveLivePane } from "../lib/herdr";
import { ensureSecondmateHomeSkills, injectOmpHomeConfig, isSecondmateHome } from "../lib/ensure-home-skills";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");
const FM_BIN = join(REPO_ROOT, "sbin", "fm");

function resolveState(): { fmRoot: string; state: string } {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return { fmRoot, state: stateOverride || join(fmHome, "state") };
}

function truthy(value: string | undefined): boolean {
	return !!value && value.length > 0;
}

function numEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTimestamp(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const offMinutes = -d.getTimezoneOffset();
	const sign = offMinutes >= 0 ? "+" : "-";
	const abs = Math.abs(offMinutes);
	const offHours = pad(Math.floor(abs / 60));
	const offRemainder = pad(abs % 60);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offHours}${offRemainder}`;
}

// session_id_from_store, ported: derive the omp resume session id from the
// omp session store when scrollback did not expose it. The pane cwd maps to
// a per-project bucket relative to $HOME (e.g. $HOME/code/mates/<id> ->
// -code-mates-<id>); the newest *.jsonl file's stem (after the first "_")
// is the session id omp uses.
function sessionIdFromStore(cwd: string, store: string): string {
	if (!cwd) return "";
	const home = process.env.HOME ?? "";
	let relCwd = cwd;
	if (home && cwd === home) relCwd = "/";
	else if (home && cwd.startsWith(`${home}/`)) relCwd = cwd.slice(home.length);
	const bucket = relCwd.replaceAll("/", "-");
	const storePath = join(store, bucket);
	let files: string[];
	try {
		if (!statSync(storePath).isDirectory()) return "";
		files = readdirSync(storePath).filter(f => f.endsWith(".jsonl"));
	} catch {
		return "";
	}
	if (files.length === 0) return "";
	let newest = files[0];
	let newestMtime = -Infinity;
	for (const f of files) {
		let mtime = -Infinity;
		try {
			mtime = statSync(join(storePath, f)).mtimeMs;
		} catch {
			// ignore: treat unreadable entries as oldest
		}
		if (mtime > newestMtime) {
			newestMtime = mtime;
			newest = f;
		}
	}
	const stem = newest.slice(0, -".jsonl".length);
	const sepIndex = stem.indexOf("_");
	return sepIndex >= 0 ? stem.slice(sepIndex + 1) : stem;
}

function lastResumeId(text: string): string {
	const matches = [...text.matchAll(/omp --resume ([0-9a-fA-F-]+)/g)];
	return matches.length ? matches[matches.length - 1][1] : "";
}

function herdrPaneReadText(args: string[]): string {
	const res = spawnSync("herdr", ["pane", "read", ...args], { encoding: "utf8" });
	return !res.error ? (res.stdout ?? "") : "";
}

function herdrPaneGetText(pane: string): string {
	const res = spawnSync("herdr", ["pane", "get", pane], { encoding: "utf8" });
	return !res.error ? (res.stdout ?? "") : "";
}

function paneCwd(pane: string): string {
	try {
		const parsed = JSON.parse(herdrPaneGetText(pane)) as { result?: { pane?: { cwd?: string } } };
		return parsed?.result?.pane?.cwd ?? "";
	} catch {
		return "";
	}
}

// pane_snapshot, ported: current-or-legacy herdr identity for the exit-wait
// and post-reload proof loops. Only cares about agent/status/legacy-omp.
interface PaneSnapshot {
	exists: boolean;
	agent: string;
	status: string;
	legacyOmp: boolean;
}

function paneSnapshot(pane: string): PaneSnapshot {
	const text = herdrPaneGetText(pane);
	try {
		// biome-ignore lint: mirrors the former python json.load + nested key walk.
		const p = (JSON.parse(text) as { result?: { pane?: Record<string, unknown> } })?.result?.pane;
		if (!p || typeof p !== "object") return { exists: false, agent: "", status: "unknown", legacyOmp: false };
		const legacy = p.agent_session;
		const legacyOmp = !("agent" in p) && !!legacy && typeof legacy === "object" && !Array.isArray(legacy) && (legacy as Record<string, unknown>).agent === "omp";
		const agent = legacyOmp ? "omp" : String(p.agent ?? "");
		const status = String(p.agent_status ?? "unknown");
		return { exists: true, agent, status, legacyOmp };
	} catch {
		return { exists: false, agent: "", status: "unknown", legacyOmp: false };
	}
}

// pane_details, ported: full tri-state (present/absent + value) identity read
// used for pin capture and revalidation. The base64 present/absent encoding
// the bash version used to survive an IFS tab round-trip is unnecessary here;
// a plain object carries the same {present, value} pair directly.
interface PaneDetail {
	present: boolean;
	value: string;
}

interface PaneDetails {
	agent: PaneDetail;
	status: PaneDetail;
	ws: PaneDetail;
	cwd: PaneDetail;
	label: PaneDetail;
	sessionPath: PaneDetail;
	sessionId: PaneDetail;
	legacyOmp: PaneDetail;
}

const ABSENT: PaneDetail = { present: false, value: "" };
const EMPTY_DETAILS: PaneDetails = {
	agent: ABSENT,
	status: ABSENT,
	ws: ABSENT,
	cwd: ABSENT,
	label: ABSENT,
	sessionPath: ABSENT,
	sessionId: ABSENT,
	legacyOmp: ABSENT,
};

function present(value: unknown, isPresent: boolean): PaneDetail {
	if (!isPresent) return ABSENT;
	return { present: true, value: value === null || value === undefined ? "" : String(value) };
}

function hasKey(p: Record<string, unknown>, key: string): boolean {
	return key in p && p[key] !== null && p[key] !== undefined;
}

function paneDetails(pane: string): PaneDetails {
	const text = herdrPaneGetText(pane);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return EMPTY_DETAILS;
	}
	const p = (parsed as { result?: { pane?: Record<string, unknown> } })?.result?.pane;
	if (!p || typeof p !== "object") return EMPTY_DETAILS;

	let agent: unknown = p.agent;
	let agentPresent = hasKey(p, "agent");
	let path: unknown = p.agent_session_path;
	let sid: unknown = p.agent_session_id;
	let pathPresent = hasKey(p, "agent_session_path");
	let sidPresent = hasKey(p, "agent_session_id");
	const legacy = p.agent_session;
	const legacyIsDict = !!legacy && typeof legacy === "object" && !Array.isArray(legacy);
	const legacyOmp = !("agent" in p) && legacyIsDict && (legacy as Record<string, unknown>).agent === "omp";
	if (legacyOmp) {
		agent = "omp";
		agentPresent = true;
	}
	if (legacyIsDict) {
		const legacyRecord = legacy as Record<string, unknown>;
		const value = legacyRecord.value;
		const kind = legacyRecord.kind;
		if (typeof value === "string" && value) {
			if ((kind === "id" || kind === "session_id") && !sidPresent) {
				sid = value;
				sidPresent = true;
			} else if ((kind === "path" || kind === "session_path" || kind === "file") && !pathPresent) {
				path = value;
				pathPresent = true;
			} else if (!kind && value.startsWith("/") && !pathPresent) {
				path = value;
				pathPresent = true;
			}
		}
	}

	return {
		agent: present(agent, agentPresent),
		status: present(p.agent_status, hasKey(p, "agent_status")),
		ws: present(p.workspace_id, hasKey(p, "workspace_id")),
		cwd: present(p.cwd, hasKey(p, "cwd")),
		label: present(p.label, hasKey(p, "label")),
		sessionPath: present(path, pathPresent),
		sessionId: present(sid, sidPresent),
		legacyOmp: present("1", legacyOmp),
	};
}

// screen_state, ported: `pane read visible` retains scrollback. Only the
// final visible compositor can establish idle; historical output before it
// is intentionally ignored.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const HEADER_RE = /^╭── .+(?: ─+|▶─+)╮$/;
const BOTTOM_RE = /^╰─( +)─╯$/;
const SPINNER_RE = /[⠁-⣿]|⟦esc⟧/;

function screenState(pane: string): string {
	const raw = herdrPaneReadText([pane, "--source", "visible", "--lines", "120"]);
	const lines = raw.split(/\r?\n/).map(line => line.replace(ANSI_RE, ""));
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	if (lines.length < 2) return "unknown";
	const header = lines[lines.length - 2];
	const bottom = lines[lines.length - 1];
	const headerMatch = HEADER_RE.test(header);
	const bottomMatch = BOTTOM_RE.test(bottom);
	let prior = lines.length - 3;
	while (prior >= 0 && lines[prior].trim() === "") prior--;
	if (prior >= 0 && SPINNER_RE.test(lines[prior])) return "unknown";
	if (headerMatch && bottomMatch) return "idle";
	return "unknown";
}

// wait_for_confirmed_idle, ported.
async function waitForConfirmedIdle(pane: string, timeoutSec: number): Promise<boolean> {
	const deadline = Date.now() + timeoutSec * 1000;
	let lastAgent = "";
	let lastStatus = "";
	while (Date.now() < deadline) {
		const snap = paneSnapshot(pane);
		if (!snap.exists) {
			process.stderr.write(`fm reload: pane ${pane} is absent; refusing /quit\n`);
			return false;
		}
		lastAgent = snap.agent;
		lastStatus = snap.status;
		const screen = screenState(pane);
		if (snap.agent === "omp" && (snap.status === "idle" || snap.status === "done" || (snap.status === "unknown" && snap.legacyOmp)) && screen === "idle") {
			return true;
		}
		await sleep(250);
	}
	process.stderr.write(`fm reload: pane ${pane} never reached confirmed idle; refusing /quit (agent=${lastAgent || "unknown"} status=${lastStatus || "unknown"})\n`);
	return false;
}

// Pinned target identity, captured once before any wait so pane ids that get
// compacted/reused mid-wait cannot silently swap the reload's target.
interface Pin {
	ws: string;
	wsPresent: boolean;
	cwd: string;
	cwdPresent: boolean;
	label: string;
	labelPresent: boolean;
	agentSessionPath: string;
	agentSessionPathPresent: boolean;
	agentSessionId: string;
	agentSessionIdPresent: boolean;
}

// revalidate_target, ported: the final pre-/quit check.
function revalidateTarget(pane: string, pin: Pin, sessionId: string): boolean {
	const d = paneDetails(pane);
	if (d.agent.value !== "omp") return false;
	if (d.status.value === "idle" || d.status.value === "done") {
		// ok
	} else if (d.status.value === "unknown" && d.legacyOmp.present && d.legacyOmp.value === "1" && screenState(pane) === "idle") {
		// ok
	} else {
		return false;
	}
	if (d.ws.present !== pin.wsPresent || d.cwd.present !== pin.cwdPresent || d.label.present !== pin.labelPresent) return false;
	if (d.ws.value !== pin.ws || d.cwd.value !== pin.cwd || d.label.value !== pin.label) return false;
	if (!pin.agentSessionPath && !pin.agentSessionId) return false;
	if (d.sessionPath.present !== pin.agentSessionPathPresent || d.sessionId.present !== pin.agentSessionIdPresent) return false;
	if (d.sessionPath.value !== pin.agentSessionPath || d.sessionId.value !== pin.agentSessionId) return false;
	if (sessionId) {
		let currentSid = lastResumeId(herdrPaneReadText([pane, "--source", "recent", "--lines", "120"]));
		if (!currentSid) currentSid = sessionIdFromStore(pin.cwd, resolveOmpStore());
		if (!currentSid) return false;
		if (currentSid !== sessionId) return false;
	}
	return true;
}

function resolveOmpStore(): string {
	return process.env.FM_OMP_SESSION_STORE?.trim() || join(process.env.HOME ?? "", ".omp", "agent", "sessions");
}

const USAGE_LINE = "usage: fm reload [target] [--cmd '<template>'] [--allow-fresh] [--timeout <sec>] [--proof-timeout <sec>]";

function printUsageErr(): void {
	process.stderr.write(`${USAGE_LINE}\n`);
}

function printHelp(): void {
	const lines = [
		USAGE_LINE,
		"",
		"Quit an omp pane, wait for the shell to return, then resume the exact prior session.",
		"",
		"Targets:",
		"  w1:p3      explicit herdr pane id",
		"  fm-riggs   durable firstmate mate name (resolved via state/<id>.meta)",
		"  (none)     auto-detect via 'herdr pane current'",
		"",
		"Options:",
		"  --cmd <template>      Relaunch with this command; '{id}' substituted with session id.",
		"  --allow-fresh         Fall back to 'omp -c' when no session id is found.",
		"  --timeout <sec>       Seconds to wait for omp to exit. Default: 8.",
		"  --proof-timeout <sec> Seconds to wait for omp to restart. Default: 30.",
		"",
		"Fails before sending /quit when no session id is found and --allow-fresh is not set.",
		"",
		"When invoked from inside the target pane itself, the quit/relaunch/proof",
		"sequence is handed to a detached worker that survives the agent's exit;",
		"progress and the final outcome land in state/.reload.<pane>.log.",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}

interface ParsedArgs {
	target?: string;
	resumeCmd: string;
	timeout: number;
	quitGrace: number;
	proofTimeout: number;
	allowFresh: boolean;
}

function parseArgs(args: string[]): ParsedArgs | number {
	let target: string | undefined;
	let resumeCmd = process.env.FM_RELOAD_CMD ?? "";
	let timeout = numEnv("FM_RELOAD_TIMEOUT", 8);
	let quitGrace = numEnv("FM_RELOAD_QUIT_GRACE", 1);
	let proofTimeout = numEnv("FM_RELOAD_PROOF_TIMEOUT", 30);
	let allowFresh = truthy(process.env.FM_RELOAD_ALLOW_FRESH);

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--cmd") {
			if (!args[i + 1]) {
				printUsageErr();
				return 1;
			}
			resumeCmd = args[++i];
			continue;
		}
		if (a === "--timeout") {
			if (!args[i + 1]) {
				printUsageErr();
				return 1;
			}
			timeout = Number(args[++i]);
			continue;
		}
		if (a === "--proof-timeout") {
			if (!args[i + 1]) {
				printUsageErr();
				return 1;
			}
			proofTimeout = Number(args[++i]);
			continue;
		}
		if (a === "--allow-fresh") {
			allowFresh = true;
			continue;
		}
		if (a === "-h" || a === "--help") {
			printHelp();
			return 0;
		}
		if (a.startsWith("-")) {
			process.stderr.write(`fm reload: unknown option '${a}'\n`);
			return 1;
		}
		if (target !== undefined) {
			process.stderr.write(`fm reload: unexpected extra argument '${a}'\n`);
			return 1;
		}
		target = a;
	}
	return { target, resumeCmd, timeout, quitGrace, proofTimeout, allowFresh };
}

function herdrPaneCurrent(): string {
	const res = spawnSync("herdr", ["pane", "current"], { encoding: "utf8" });
	try {
		const parsed = JSON.parse(!res.error ? (res.stdout ?? "") : "") as { result?: { pane?: { pane_id?: string } } };
		return parsed?.result?.pane?.pane_id ?? "";
	} catch {
		return "";
	}
}

interface TrackedState {
	pane?: string;
	relaunchPane?: string;
}

async function core(parsed: ParsedArgs, tracked: TrackedState): Promise<number> {
	const { target, allowFresh } = parsed;
	let { resumeCmd } = parsed;
	const { fmRoot, state } = resolveState();
	const ompStore = resolveOmpStore();

	// -------------------------------------------------------------------
	// Resolve target to a concrete herdr pane id.
	// -------------------------------------------------------------------
	let pane = "";
	let metaFile = process.env.FM_RELOAD_META ?? "";
	if (target) {
		const resolved = resolveLivePane(target, state);
		if (resolved === null) return 1;
		pane = resolved;
		if (target.includes(":")) {
			// no-op: keep whatever metaFile already is (env-provided for a worker)
		} else if (target.startsWith("fm-")) {
			metaFile = join(state, `${target.slice("fm-".length)}.meta`);
		}
	} else {
		pane = herdrPaneCurrent();
	}
	if (!pane) {
		process.stderr.write("fm-reload.sh: could not determine target pane\n");
		return 1;
	}
	tracked.pane = pane;

	// -------------------------------------------------------------------
	// Capture the session id BEFORE sending /quit.
	// -------------------------------------------------------------------
	let sessionId = process.env.FM_RELOAD_SESSION_ID ?? "";
	if (!sessionId) {
		sessionId = lastResumeId(herdrPaneReadText([pane, "--source", "recent", "--lines", "120"]));
	}
	if (!sessionId) {
		sessionId = sessionIdFromStore(paneCwd(pane), ompStore);
	}

	// Validate --cmd template before doing anything destructive.
	if (resumeCmd?.includes("{id}") && !sessionId) {
		process.stderr.write(`fm reload: --cmd contains '{id}' but no session id found in pane ${pane} output\n`);
		return 1;
	}

	// Fail closed: no session id and no explicit opt-out means we refuse to
	// reload. This check runs BEFORE /quit so the pane is left untouched on failure.
	if (!sessionId && !resumeCmd && !allowFresh) {
		process.stderr.write(`fm reload: no session id found in pane ${pane}; pass --allow-fresh to permit 'omp -c', or --cmd to specify the relaunch command\n`);
		return 1;
	}

	// -------------------------------------------------------------------
	// Capture the target identity before a detached self-reload forks. The
	// worker receives these values and must revalidate against them rather
	// than adopting a replacement pane/session as its new baseline.
	// -------------------------------------------------------------------
	let pinWsSet = truthy(process.env.FM_RELOAD_PIN_WS_SET);
	let pinWs = process.env.FM_RELOAD_PIN_WS ?? "";
	let pinWsPresent = process.env.FM_RELOAD_PIN_WS_PRESENT === "1";

	let pinCwdSet = truthy(process.env.FM_RELOAD_PIN_CWD_SET);
	let pinCwd = process.env.FM_RELOAD_PIN_CWD ?? "";
	let pinCwdPresent = process.env.FM_RELOAD_PIN_CWD_PRESENT === "1";

	let pinLabelSet = truthy(process.env.FM_RELOAD_PIN_LABEL_SET);
	let pinLabel = process.env.FM_RELOAD_PIN_LABEL ?? "";
	let pinLabelPresent = process.env.FM_RELOAD_PIN_LABEL_PRESENT === "1";

	let pinPathSet = truthy(process.env.FM_RELOAD_PIN_AGENT_SESSION_PATH_SET);
	let pinPath = process.env.FM_RELOAD_PIN_AGENT_SESSION_PATH ?? "";
	let pinPathPresent = process.env.FM_RELOAD_PIN_AGENT_SESSION_PATH_PRESENT === "1";

	let pinSidSet = truthy(process.env.FM_RELOAD_PIN_AGENT_SESSION_ID_SET);
	let pinSid = process.env.FM_RELOAD_PIN_AGENT_SESSION_ID ?? "";
	let pinSidPresent = process.env.FM_RELOAD_PIN_AGENT_SESSION_ID_PRESENT === "1";

	const cap = paneDetails(pane);

	if (!pinWsSet) {
		pinWs = cap.ws.value;
		pinWsPresent = cap.ws.present;
		pinWsSet = true;
	}
	if (!pinCwdSet) {
		pinCwd = cap.cwd.value;
		pinCwdPresent = cap.cwd.present;
		pinCwdSet = true;
	}
	if (!pinLabelSet) {
		pinLabel = cap.label.value;
		pinLabelPresent = cap.label.present;
		pinLabelSet = true;
	}
	if (!pinPathSet) {
		pinPath = cap.sessionPath.value;
		pinPathPresent = cap.sessionPath.present;
		pinPathSet = true;
	}
	if (!pinSidSet) {
		pinSid = cap.sessionId.value;
		pinSidPresent = cap.sessionId.present;
		pinSidSet = true;
	}

	if (!pinPath && !pinSid) {
		process.stderr.write(`fm reload: target pane ${pane} has no Herdr agent_session identity; refusing /quit\n`);
		return 1;
	}
	if (pinWsPresent !== cap.ws.present || pinCwdPresent !== cap.cwd.present || pinLabelPresent !== cap.label.present || pinWs !== cap.ws.value || pinCwd !== cap.cwd.value || pinLabel !== cap.label.value) {
		process.stderr.write("fm-reload.sh: target pane changed before identity capture; refusing /quit\n");
		return 1;
	}
	if (pinPathPresent !== cap.sessionPath.present || pinSidPresent !== cap.sessionId.present || pinPath !== cap.sessionPath.value || pinSid !== cap.sessionId.value) {
		process.stderr.write(`fm reload: target pane ${pane} agent_session identity changed before identity capture; refusing /quit\n`);
		return 1;
	}

	const pin: Pin = {
		ws: pinWs,
		wsPresent: pinWsPresent,
		cwd: pinCwd,
		cwdPresent: pinCwdPresent,
		label: pinLabel,
		labelPresent: pinLabelPresent,
		agentSessionPath: pinPath,
		agentSessionPathPresent: pinPathPresent,
		agentSessionId: pinSid,
		agentSessionIdPresent: pinSidPresent,
	};

	// Specialist homes must have a reconciled skill allowlist before /quit.
	if (pin.cwd && isSecondmateHome(pin.cwd)) {
		const skills = ensureSecondmateHomeSkills(pin.cwd, { quiet: true, codeRoot: fmRoot });
		if (skills && !skills.ok) {
			process.stderr.write(`fm reload: home skills reconciliation failed for ${pin.cwd}: ${skills.status}; refusing /quit\n`);
			return 1;
		}
	}

	// -------------------------------------------------------------------
	// Self-reload guard: this process running inside the pane it targets
	// dies with the agent when /quit lands, before the relaunch step. All
	// fail-closed checks above already passed synchronously, so hand the
	// quit/relaunch/proof sequence to a detached worker (own session,
	// log-backed stdio) that survives the agent's exit, and return immediately.
	// -------------------------------------------------------------------
	const noGuard = truthy(process.env.FM_RELOAD_NO_GUARD);
	const alreadyDetached = truthy(process.env.FM_RELOAD_DETACHED);
	let selfPane = "";
	if (!noGuard) {
		selfPane = herdrPaneCurrent();
	}
	if (!alreadyDetached && !noGuard && selfPane && selfPane === pane) {
		mkdirSync(state, { recursive: true });
		const reloadLog = join(state, `.reload.${pane.replaceAll(":", "-")}.log`);
		const selfTimeoutEnv = numEnv("FM_RELOAD_SELF_TIMEOUT", 60);
		const selfTimeout = parsed.timeout > selfTimeoutEnv ? parsed.timeout : selfTimeoutEnv;
		const workerArgs = [pane, "--timeout", String(selfTimeout), "--proof-timeout", String(parsed.proofTimeout)];
		if (resumeCmd) workerArgs.push("--cmd", resumeCmd);
		if (allowFresh) workerArgs.push("--allow-fresh");

		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			FM_RELOAD_DETACHED: "1",
			FM_RELOAD_SESSION_ID: sessionId,
			FM_RELOAD_META: metaFile,
			FM_STATE_OVERRIDE: state,
			FM_ROOT_OVERRIDE: fmRoot,
			FM_RELOAD_PIN_WS: pin.ws,
			FM_RELOAD_PIN_CWD: pin.cwd,
			FM_RELOAD_PIN_LABEL: pin.label,
			FM_RELOAD_PIN_AGENT_SESSION_PATH: pin.agentSessionPath,
			FM_RELOAD_PIN_AGENT_SESSION_ID: pin.agentSessionId,
			FM_RELOAD_PIN_WS_SET: "1",
			FM_RELOAD_PIN_CWD_SET: "1",
			FM_RELOAD_PIN_LABEL_SET: "1",
			FM_RELOAD_PIN_AGENT_SESSION_PATH_SET: "1",
			FM_RELOAD_PIN_AGENT_SESSION_ID_SET: "1",
			FM_RELOAD_PIN_WS_PRESENT: pin.wsPresent ? "1" : "0",
			FM_RELOAD_PIN_CWD_PRESENT: pin.cwdPresent ? "1" : "0",
			FM_RELOAD_PIN_LABEL_PRESENT: pin.labelPresent ? "1" : "0",
			FM_RELOAD_PIN_AGENT_SESSION_PATH_PRESENT: pin.agentSessionPathPresent ? "1" : "0",
			FM_RELOAD_PIN_AGENT_SESSION_ID_PRESENT: pin.agentSessionIdPresent ? "1" : "0",
		};

		let workerPid: number | undefined;
		try {
			const fd = openSync(reloadLog, "a");
			let child: ChildProcess | undefined;
			try {
				child = spawn(FM_BIN, ["reload", ...workerArgs], {
					env: childEnv,
					stdio: ["ignore", fd, fd],
					detached: true,
				});
			} finally {
				closeSync(fd);
			}
			workerPid = child?.pid;
			child?.unref();
		} catch {
			workerPid = undefined;
		}
		if (!workerPid) {
			process.stderr.write(`fm reload: failed to start detached self-reload worker for pane ${pane}\n`);
			return 1;
		}
		process.stdout.write(`fm reload: target pane ${pane} is this script's own pane; /quit would kill this process before the relaunch\n`);
		process.stdout.write(`fm reload: reload handed to detached worker (pid ${workerPid}); progress: ${reloadLog}\n`);
		return 0;
	}

	// -------------------------------------------------------------------
	// Best-effort bounded safety gate: Herdr's pane run has no conditional-
	// send primitive, so this check is fail-closed on every observed busy/
	// unknown/mismatch state but cannot eliminate a final check-to-/quit
	// TOCTOU race. A detached self-reload worker reaches this gate after the
	// current turn. Pin the target identity before waiting: pane ids can be
	// compacted/reused.
	// -------------------------------------------------------------------
	const cur = paneDetails(pane);
	if (cur.agent.value !== "omp" || cur.ws.present !== pin.wsPresent || cur.cwd.present !== pin.cwdPresent || cur.label.present !== pin.labelPresent || cur.ws.value !== pin.ws || cur.cwd.value !== pin.cwd || cur.label.value !== pin.label) {
		process.stderr.write("fm-reload.sh: target pane changed before idle wait; refusing /quit\n");
		return 1;
	}
	if (!pin.agentSessionPath && !pin.agentSessionId) {
		process.stderr.write(`fm reload: target pane ${pane} has no Herdr agent_session identity; refusing /quit\n`);
		return 1;
	}
	if (cur.sessionPath.present !== pin.agentSessionPathPresent || cur.sessionId.present !== pin.agentSessionIdPresent || cur.sessionPath.value !== pin.agentSessionPath || cur.sessionId.value !== pin.agentSessionId) {
		process.stderr.write(`fm reload: target pane ${pane} agent_session identity changed; refusing /quit\n`);
		return 1;
	}
	if (!(await waitForConfirmedIdle(pane, parsed.timeout))) {
		return 1;
	}

	const realState = screenState(pane);
	if (realState !== "idle") {
		process.stderr.write(`fm reload: pane ${pane} screen is ${realState || "unknown"}; refusing /quit\n`);
		return 1;
	}
	if (!revalidateTarget(pane, pin, sessionId)) {
		process.stderr.write(`fm reload: target pane ${pane} changed or session identity could not be revalidated; refusing /quit\n`);
		return 1;
	}

	// -------------------------------------------------------------------
	// Quit and wait for omp to exit.
	// Residual limitation: the separate `pane run` can race a pane transition
	// after revalidation; without Herdr conditional send, this is bounded
	// mitigation only.
	// -------------------------------------------------------------------
	{
		const res = spawnSync("herdr", ["pane", "run", pane, "/quit"], { encoding: "utf8" });
		if (res.error || res.status !== 0) return 1;
	}
	await sleep(parsed.quitGrace * 1000);

	let exitConfirmed = false;
	{
		const deadline = Date.now() + parsed.timeout * 1000;
		while (Date.now() < deadline) {
			const paneInfo = herdrPaneGetText(pane);
			if (paneInfo === "" || paneInfo.includes('"error"')) {
				exitConfirmed = true;
				break;
			}
			const agent = jsonGet(paneInfo, "result", "pane", "agent");
			const verdict = herdrPaneAgentProcessVerdict(pane);
			if (verdict === "shell") {
				exitConfirmed = true;
				break;
			}
			if (verdict === "err" && agent !== "omp") {
				exitConfirmed = true;
				break;
			}
			await sleep(250);
		}
	}
	if (!exitConfirmed) {
		process.stderr.write(`fm reload: pane ${pane} still running omp after ${parsed.timeout}s; reload aborted\n`);
		return 1;
	}

	// -------------------------------------------------------------------
	// Build the relaunch command.
	// -------------------------------------------------------------------
	let effectiveCmd = "";
	if (resumeCmd) {
		effectiveCmd = resumeCmd.includes("{id}") ? resumeCmd.replaceAll("{id}", sessionId) : resumeCmd;
	} else if (sessionId) {
		effectiveCmd = `omp --resume ${sessionId}`;
	} else if (allowFresh) {
		effectiveCmd = "omp -c";
	} else {
		process.stderr.write("fm-reload.sh: no session id found and --allow-fresh not set\n");
		return 1;
	}
	if (pin.cwd && isSecondmateHome(pin.cwd)) {
		effectiveCmd = injectOmpHomeConfig(effectiveCmd, pin.cwd);
	}

	// -------------------------------------------------------------------
	// Pick the relaunch pane. Reuse the target pane when it survived the quit
	// (agent launched from a persistent shell); when herdr closed it with the
	// agent, provision a replacement pane in the same workspace and cwd so
	// the session has somewhere usable to resume.
	// -------------------------------------------------------------------
	let relaunchPane = pane;
	let relaunchTab = "";
	{
		let stillThere = false;
		try {
			const parsedPane = JSON.parse(herdrPaneGetText(pane)) as { result?: { pane?: unknown } };
			stillThere = !!parsedPane?.result?.pane;
		} catch {
			stillThere = false;
		}
		if (!stillThere) {
			process.stderr.write(`fm reload: pane ${pane} closed with the agent; creating a replacement pane\n`);
			const tabArgs = ["--no-focus", "--label", pin.label || "fm-reload-recovered"];
			if (pin.ws) tabArgs.push("--workspace", pin.ws);
			if (pin.cwd) tabArgs.push("--cwd", pin.cwd);
			const createRes = spawnSync("herdr", ["tab", "create", ...tabArgs], { encoding: "utf8" });
			const createText = !createRes.error ? (createRes.stdout ?? "") : "";
			relaunchPane = jsonGet(createText, "result", "root_pane", "pane_id");
			relaunchTab = jsonGet(createText, "result", "tab", "tab_id");
			if (!relaunchPane) {
				process.stderr.write(`fm reload: could not create a replacement pane for ${pane}; session ${sessionId} not resumed\n`);
				return 1;
			}
			process.stderr.write(`fm reload: replacement pane ${relaunchPane} created; resuming session there\n`);
		}
	}
	tracked.relaunchPane = relaunchPane;

	{
		const res = spawnSync("herdr", ["pane", "run", relaunchPane, effectiveCmd], { encoding: "utf8" });
		if (res.error || res.status !== 0) {
			process.stderr.write(`fm reload: relaunch command failed in pane ${relaunchPane}\n`);
			return 1;
		}
	}

	// -------------------------------------------------------------------
	// Post-reload proof: verify omp restarted in the pane.
	// -------------------------------------------------------------------
	let proofAgent = "";
	{
		const deadline = Date.now() + parsed.proofTimeout * 1000;
		while (Date.now() < deadline) {
			const snap = paneSnapshot(relaunchPane);
			proofAgent = snap.agent;
			if (snap.exists && snap.agent === "omp") break;
			await sleep(500);
		}
	}
	if (proofAgent !== "omp") {
		process.stderr.write(`fm reload: omp did not restart in pane ${relaunchPane} within ${parsed.proofTimeout}s\n`);
		return 1;
	}
	// Session id continuity: only checked when we auto-generated
	// 'omp --resume <id>'. Skipped for --cmd (caller's responsibility) and
	// --allow-fresh (no id to verify).
	if (sessionId && !resumeCmd && !allowFresh) {
		const proofCwd = paneCwd(relaunchPane);
		let proofSid = lastResumeId(herdrPaneReadText([relaunchPane, "--source", "recent", "--lines", "60"]));
		if (!proofSid) proofSid = sessionIdFromStore(proofCwd, ompStore);
		if (proofSid !== sessionId) {
			process.stderr.write(`fm reload: session id mismatch after reload (expected ${sessionId}, saw ${proofSid || "none"})\n`);
			return 1;
		}
	}

	// -------------------------------------------------------------------
	// Durable-target rebind: the resume landed in a replacement pane, so
	// point the fm-<id> metadata at it before reporting success; otherwise
	// supervision and later recovery keep following the closed pane.
	// -------------------------------------------------------------------
	if (metaFile && relaunchPane !== pane && existsSync(metaFile)) {
		try {
			metaSet(metaFile, "pane", relaunchPane);
		} catch {
			process.stderr.write(`fm reload: session resumed in pane ${relaunchPane} but failed to rebind pane= in ${metaFile}\n`);
			return 1;
		}
		if (relaunchTab) {
			try {
				metaSet(metaFile, "tab", relaunchTab);
			} catch {
				process.stderr.write(`fm reload: session resumed in pane ${relaunchPane} but failed to rebind tab= in ${metaFile}\n`);
				return 1;
			}
		}
		process.stderr.write(`fm reload: rebound ${metaFile} to replacement pane ${relaunchPane}${relaunchTab ? ` (tab ${relaunchTab})` : ""}\n`);
	}

	return 0;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const parsed = parseArgs(args);
	if (typeof parsed === "number") return parsed;

	const detached = truthy(process.env.FM_RELOAD_DETACHED);
	if (detached) {
		process.stdout.write(`${formatTimestamp()} fm reload: detached self-reload worker started (target ${parsed.target ?? "auto"})\n`);
	}

	const tracked: TrackedState = {};
	let rc: number;
	try {
		rc = await core(parsed, tracked);
	} catch {
		rc = 1;
	}

	if (detached) {
		const ts = formatTimestamp();
		const pane = tracked.pane ?? "unresolved";
		if (rc === 0) {
			const relaunchPane = tracked.relaunchPane ?? pane;
			process.stdout.write(`${ts} fm reload: detached self-reload of pane ${pane} succeeded (session live in pane ${relaunchPane})\n`);
		} else {
			process.stdout.write(`${ts} fm reload: detached self-reload of pane ${pane} FAILED (exit ${rc})\n`);
		}
	}
	return rc;
}

export default {
	name: "reload",
	describe: "Quit an omp pane, wait for the shell to return, then resume the exact prior session.",
	run,
};
