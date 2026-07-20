// fm lib: herdr - shared herdr pane primitives for firstmate.
// Ported behavior-preserving from sbin/fm-herdr-lib.sh.
//
// Replaces fm-tmux-lib.sh. All functions operate on herdr pane IDs
// (e.g. "w8:p3") rather than tmux targets. Sourced (in bash) by fm send;
// the `fm peek` CLI verb inlines its own copy of the slice it needs.
//
// herdr tracks agent status natively (idle|working|blocked|done|unknown),
// so the ANSI ghost-text stripping and pane-hash busy detection from the
// tmux era are gone. The guarantees this lib provides instead:
//
//   1. resolveLivePane: resolve durable targets (fm-<id>) through the
//      live herdr agent identity, and refresh state/<id>.meta when pane=
//      drifts after a restart/reopen.
//   2. paneIsBusy: reads herdr agent status; true when "working".
//   3. paneInputPending: reads visible pane content to detect a
//      half-typed human line in the composer; same semantics as before but
//      simpler implementation (no ANSI parsing, no SGR stripping).
//
// Text submission lives in fm send and uses one atomic
// "herdr pane run" call. This library never retries or queues text.
//
// Real callers (grepped): fm spawn and fm reload call jsonGet;
// fm reload calls metaSet directly; fm send, fm reload, and
// fm teardown call resolveLivePane; fm reload calls
// herdrPaneAgentProcessVerdict directly; fm spawn calls
// herdrReapHuskSlot; fm send calls paneInputPending. herdrPaneId,
// metaValue, herdrAgentStatus, paneIsBusy, and herdrClassifySlot have no
// direct external caller but are real dependencies of the kept functions
// above (resolveLivePane, paneInputPending, herdrReapHuskSlot respectively)
// and so are kept as their support functions.
//
// Dropped as caller-less: fm_task_for_pane is defined but never invoked
// anywhere in the repo, not even by another function in the same bash file.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// jsonGet(text, ...keys): parse a JSON string, walk the nested keys given as
// positional arguments, and return the leaf value coerced to a string (or ""
// on any parse error / missing key). This is the canonical accessor for
// herdr's one-shot JSON responses; prefer it over regexing raw JSON.
export function jsonGet(text: string, ...keys: string[]): string {
	try {
		let value: unknown = JSON.parse(text);
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

// metaValue(metaPath, key): the value of the last `key=` line in metaPath, or
// "" when the file or key is absent.
export function metaValue(metaPath: string, key: string): string {
	if (!existsSync(metaPath)) return "";
	const matches = readFileSync(metaPath, "utf8")
		.split(/\r?\n/)
		.filter(line => line.startsWith(`${key}=`));
	if (matches.length === 0) return "";
	const last = matches[matches.length - 1];
	return last.slice(last.indexOf("=") + 1);
}

// metaSet(metaPath, key, value): rewrite metaPath so its last `key=` line (or
// a newly appended one) reads `key=value`, preserving every other line.
export function metaSet(metaPath: string, key: string, value: string): void {
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

// herdrPaneId(target): the pane_id from `herdr agent get <target>`, or "" on
// any failure or no match.
export type AgentSlotRead =
	| { presence: "present"; paneId: string; status: string }
	| { presence: "absent" }
	| { presence: "error"; reason: string };

/** Tri-state agent slot → pane binding. Only explicit not-found is absence. */
export function readAgentSlot(target: string): AgentSlotRead {
	const res = spawnSync("herdr", ["agent", "get", target], { encoding: "utf8" });
	const stdout = typeof res.stdout === "string" ? res.stdout : "";
	const stderr = typeof res.stderr === "string" ? res.stderr : "";
	const errorText = stdout + stderr;
	if (res.error || (res.status ?? 1) !== 0) {
		if (isExplicitNotFound(errorText)) return { presence: "absent" };
		return { presence: "error", reason: res.error?.message || `herdr agent get rc=${res.status ?? 1}` };
	}
	if (stdout.includes('"error"')) {
		if (isExplicitNotFound(stdout)) return { presence: "absent" };
		return { presence: "error", reason: jsonGet(stdout, "error", "message") || "herdr agent get error" };
	}
	const paneId = stdout.match(/"pane_id":"([^"]*)"/)?.[1] ?? "";
	if (!paneId) {
		// Successful get without a pane_id is malformed, not absence.
		return { presence: "error", reason: "agent get succeeded without pane_id" };
	}
	const status = stdout.match(/"agent_status":"([^"]*)"/)?.[1] ?? "";
	return { presence: "present", paneId, status };
}

export function herdrPaneId(target: string): string {
	const slot = readAgentSlot(target);
	return slot.presence === "present" ? slot.paneId : "";
}

export type LivePaneClass = "live-agent" | "shell" | "absent" | "stale-binding" | "unknown" | "error";

/** Tri-state Herdr observation: only explicit not-found is absence. */
export type HerdrPresence = "present" | "absent" | "error";

export interface PaneSnapshot {
	paneId: string;
	agentStatus: string;
	sessionId: string;
	sessionAgent: string;
	revision: string;
	presence: HerdrPresence;
	/** @deprecated use presence === "present" */
	present: boolean;
	errorCode?: string;
	errorMessage?: string;
}

function isExplicitNotFound(text: string): boolean {
	if (!text.includes('"error"') && !/not found/i.test(text)) return false;
	try {
		const parsed = JSON.parse(text) as { error?: string | { code?: string; message?: string } };
		if (typeof parsed.error === "string") return /not found/i.test(parsed.error);
		const code = String(parsed.error?.code ?? "").toLowerCase();
		const message = String(parsed.error?.message ?? "").toLowerCase();
		return (
			code.includes("not_found") ||
			code.includes("pane_not_found") ||
			code.includes("agent_not_found") ||
			message.includes("not found")
		);
	} catch {
		return /pane_not_found|not found/i.test(text);
	}
}

/** Read-only pane get snapshot. Never writes metadata. Tri-state presence. */
export function readPaneSnapshot(pane: string): PaneSnapshot {
	const res = spawnSync("herdr", ["pane", "get", pane], { encoding: "utf8" });
	const text = res.stdout ?? "";
	if (res.error || (res.status ?? 1) !== 0) {
		if (isExplicitNotFound(text)) {
			return { paneId: pane, agentStatus: "", sessionId: "", sessionAgent: "", revision: "", presence: "absent", present: false };
		}
		return {
			paneId: pane,
			agentStatus: "",
			sessionId: "",
			sessionAgent: "",
			revision: "",
			presence: "error",
			present: false,
			errorMessage: res.error?.message || `herdr pane get rc=${res.status ?? 1}`,
		};
	}
	if (!text) {
		return { paneId: pane, agentStatus: "", sessionId: "", sessionAgent: "", revision: "", presence: "error", present: false, errorMessage: "empty pane get" };
	}
	if (text.includes('"error"')) {
		if (isExplicitNotFound(text)) {
			return { paneId: pane, agentStatus: "", sessionId: "", sessionAgent: "", revision: "", presence: "absent", present: false };
		}
		return {
			paneId: pane,
			agentStatus: "",
			sessionId: "",
			sessionAgent: "",
			revision: "",
			presence: "error",
			present: false,
			errorCode: jsonGet(text, "error", "code"),
			errorMessage: jsonGet(text, "error", "message") || "herdr pane get error",
		};
	}
	return {
		paneId: jsonGet(text, "result", "pane", "pane_id") || pane,
		agentStatus: jsonGet(text, "result", "pane", "agent_status"),
		sessionId: jsonGet(text, "result", "pane", "agent_session", "value"),
		sessionAgent: jsonGet(text, "result", "pane", "agent_session", "agent"),
		revision: jsonGet(text, "result", "pane", "revision"),
		presence: "present",
		present: true,
	};
}

export type AgentStatusRead =
	| { presence: "present"; status: string }
	| { presence: "absent" }
	| { presence: "error"; reason: string };

/** Tri-state agent status. Empty/missing fields on a successful get are not absence. */
export function readHerdrAgentStatus(target: string): AgentStatusRead {
	const res = spawnSync("herdr", ["agent", "get", target], { encoding: "utf8" });
	const text = res.stdout ?? "";
	if (res.error || (res.status ?? 1) !== 0) {
		if (isExplicitNotFound(text)) return { presence: "absent" };
		return { presence: "error", reason: res.error?.message || `herdr agent get rc=${res.status ?? 1}` };
	}
	if (text.includes('"error"')) {
		if (isExplicitNotFound(text)) return { presence: "absent" };
		return { presence: "error", reason: jsonGet(text, "error", "message") || "herdr agent get error" };
	}
	const m = text.match(/"agent_status":"([^"]*)"/);
	return { presence: "present", status: m?.[1] ?? "" };
}

export type PaneReadResult =
	| { presence: "present"; lines: string[] }
	| { presence: "absent" }
	| { presence: "error"; reason: string };

/** Tri-state visible pane read for composer inspection. */
export function readPaneVisible(pane: string): PaneReadResult {
	const res = spawnSync("herdr", ["pane", "read", pane, "--lines", "3", "--source", "visible"], { encoding: "utf8" });
	const text = res.stdout ?? "";
	if (res.error || (res.status ?? 1) !== 0) {
		if (isExplicitNotFound(text)) return { presence: "absent" };
		return { presence: "error", reason: res.error?.message || `herdr pane read rc=${res.status ?? 1}` };
	}
	return { presence: "present", lines: text.split(/\r?\n/).filter(line => !/^[ \t]*$/.test(line)) };
}

export interface InspectLivePaneResult {
	class: LivePaneClass;
	slot: string;
	livePane: string;
	recordedPane: string;
	snapshot: PaneSnapshot | null;
	reason?: string;
}

/**
 * Read-only mate/slot classification. Never writes meta and never treats a
 * stale recorded pane as proof of the mate's live session without slot match.
 */
function classifyPresentPane(pane: string, slot: string, recordedPane: string, snap: PaneSnapshot): InspectLivePaneResult {
	if (snap.presence === "error") {
		return { class: "error", slot, livePane: pane, recordedPane, snapshot: snap, reason: snap.errorMessage || "pane read error" };
	}
	if (snap.presence === "absent") {
		return { class: "absent", slot, livePane: pane, recordedPane, snapshot: snap };
	}
	if (snap.sessionId || snap.agentStatus === "working" || snap.agentStatus === "idle" || snap.agentStatus === "blocked" || snap.agentStatus === "done") {
		return { class: "live-agent", slot, livePane: pane, recordedPane, snapshot: snap };
	}
	const verdict = herdrPaneAgentProcessVerdict(pane);
	if (verdict === "shell") return { class: "shell", slot, livePane: pane, recordedPane, snapshot: snap };
	if (verdict === "agent") return { class: "live-agent", slot, livePane: pane, recordedPane, snapshot: snap };
	if (verdict === "err") {
		return { class: "error", slot, livePane: pane, recordedPane, snapshot: snap, reason: "process-info error" };
	}
	return { class: "unknown", slot, livePane: pane, recordedPane, snapshot: snap };
}

export function inspectLivePane(target: string, state: string): InspectLivePaneResult {
	if (target.includes(":")) {
		const snap = readPaneSnapshot(target);
		return classifyPresentPane(target, target, target, snap);
	}

	if (!target.startsWith("fm-")) {
		const slotRead = readAgentSlot(target);
		if (slotRead.presence === "error") {
			return { class: "error", slot: target, livePane: "", recordedPane: "", snapshot: null, reason: slotRead.reason };
		}
		if (slotRead.presence === "absent") {
			return { class: "absent", slot: target, livePane: "", recordedPane: "", snapshot: null, reason: "no agent slot" };
		}
		return inspectLivePane(slotRead.paneId, state);
	}

	const canonicalSlot = target;
	const metaPath = state ? join(state, `${target.slice("fm-".length)}.meta`) : "";
	const hasMeta = Boolean(metaPath && existsSync(metaPath));
	const slot = hasMeta ? metaValue(metaPath, "agent_slot") || canonicalSlot : canonicalSlot;
	const recordedPane = hasMeta ? metaValue(metaPath, "pane") : "";

	// Prefer configured agent_slot; fall back to fm-<id> only for discovery.
	// inspect.slot is whichever name actually bound — never require both later.
	const slotRead = readAgentSlot(slot);
	const canonicalRead = slot === canonicalSlot ? slotRead : readAgentSlot(canonicalSlot);
	const liveRead =
		slotRead.presence === "present"
			? slotRead
			: canonicalRead.presence === "present"
				? canonicalRead
				: slotRead.presence === "error"
					? slotRead
					: canonicalRead;
	const resolvedSlot =
		slotRead.presence === "present" ? slot : canonicalRead.presence === "present" ? canonicalSlot : slot;

	if (liveRead.presence === "error") {
		return {
			class: "error",
			slot: resolvedSlot,
			livePane: "",
			recordedPane,
			snapshot: null,
			reason: hasMeta ? liveRead.reason : `missing meta; ${liveRead.reason}`,
		};
	}
	if (liveRead.presence === "absent") {
		if (recordedPane) {
			const snap = readPaneSnapshot(recordedPane);
			if (snap.presence === "error") {
				return {
					class: "error",
					slot: resolvedSlot,
					livePane: "",
					recordedPane,
					snapshot: snap,
					reason: snap.errorMessage || "recorded pane read error",
				};
			}
			if (snap.presence === "present") {
				return {
					class: "stale-binding",
					slot: resolvedSlot,
					livePane: "",
					recordedPane,
					snapshot: snap,
					reason: "recorded pane exists but agent slot is unbound",
				};
			}
		}
		if (!hasMeta && !state) {
			return { class: "error", slot: canonicalSlot, livePane: "", recordedPane: "", snapshot: null, reason: "state dir required" };
		}
		return { class: "absent", slot: resolvedSlot, livePane: "", recordedPane, snapshot: null };
	}

	const snap = readPaneSnapshot(liveRead.paneId);
	return classifyPresentPane(liveRead.paneId, resolvedSlot, recordedPane, snap);
}

/** Explicit binding refresh for a snapshotted stop target after live slot validation. */
export function refreshPaneBinding(target: string, state: string, livePane: string): void {
	if (!target.startsWith("fm-") || !state || !livePane) return;
	const metaPath = join(state, `${target.slice("fm-".length)}.meta`);
	if (!existsSync(metaPath)) return;
	const pane = metaValue(metaPath, "pane");
	if (pane !== livePane) metaSet(metaPath, "pane", livePane);
}

// resolveLivePane(target, state): resolve durable targets (fm-<id>) through
// the live herdr agent identity, and refresh state/<id>.meta when pane=
// drifts after a restart/reopen. A bare "w8:p3"-shaped pane id passes through
// unchanged; anything else is resolved via `herdr agent get`. Returns null
// (having already written the error to stderr) on failure, mirroring the
// bash function's `echo ... >&2; return 1`.
export function resolveLivePane(target: string, state: string): string | null {
	if (target.includes(":")) return target;
	if (target.startsWith("fm-")) {
		if (!state) {
			process.stderr.write(`error: fm_resolve_live_pane needs a state dir for ${target}\n`);
			return null;
		}
		const metaPath = join(state, `${target.slice("fm-".length)}.meta`);
		if (!existsSync(metaPath)) {
			process.stderr.write(
				`error: no metadata for ${target} in ${state}; pass a pane id to target a pane outside this firstmate home\n`,
			);
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

// herdrAgentStatus(pane): the current herdr agent status for a pane id, one
// of idle|working|blocked|done|unknown in practice - but note this returns ""
// (not "unknown") when the field is simply absent from the response, exactly
// like the bash version: its `|| printf 'unknown'` fallback is gated on the
// whole pipeline's exit status, and since the pipeline's last command (sed)
// exits 0 even on empty input, that fallback is effectively dead code that
// never fires. Ported verbatim rather than "fixed" to preserve behavior.
export function herdrAgentStatus(pane: string): string {
	const res = spawnSync("herdr", ["agent", "get", pane], { encoding: "utf8" });
	const text = res.stdout ?? "";
	const m = text.match(/"agent_status":"([^"]*)"/);
	return m ? m[1] : "";
}

// paneIsBusy(pane): true if the agent is currently working (agent mid-turn).
export function paneIsBusy(pane: string): boolean {
	return herdrAgentStatus(pane) === "working";
}

export type ProcessVerdict = "agent" | "shell" | "err";

// herdrPaneAgentProcessVerdict(pane): determine whether a pane contains a
// live coding harness when native status is still unknown. "shell" proves an
// agent-less restored shell; "agent" and "err" must fail closed.
export function herdrPaneAgentProcessVerdict(pane: string): ProcessVerdict {
	const res = spawnSync("herdr", ["pane", "process-info", "--pane", pane], { encoding: "utf8" });
	const processInfo = !res.error && res.status === 0 ? (res.stdout ?? "") : "";
	if (!processInfo) return "err";
	let processes: unknown;
	try {
		const parsed = JSON.parse(processInfo) as { result?: { process_info?: { foreground_processes?: unknown } } };
		processes = parsed?.result?.process_info?.foreground_processes;
	} catch {
		return "err";
	}
	if (!Array.isArray(processes)) return "err";
	const harness = /\b(omp|claude|codex|opencode|pi|node|bun|deno)\b/;
	for (const proc of processes) {
		const p = proc as Record<string, unknown>;
		const text = ["argv0", "name", "cmdline"].map(key => String(p?.[key] ?? "")).join(" ");
		if (harness.test(text)) return "agent";
	}
	return "shell";
}

export type SlotVerdict = "free" | "husk" | "live" | "unknown";

// herdrClassifySlot(slot): decide whether a persisted agent registration may
// be safely reused after herdr restores a session layout. Only a confirmed
// agent-less husk is reusable. A bound or booting agent remains protected.
export function herdrClassifySlot(slot: string): SlotVerdict {
	const agentRes = spawnSync("herdr", ["agent", "get", slot], { encoding: "utf8" });
	if (agentRes.error || agentRes.status !== 0) return "free";
	const info = agentRes.stdout ?? "";
	if (info.includes('"error"')) return "free";
	const pane = jsonGet(info, "result", "agent", "pane_id");
	if (!pane) return "free";
	const paneRes = spawnSync("herdr", ["pane", "get", pane], { encoding: "utf8" });
	const paneInfo = !paneRes.error && paneRes.status === 0 ? (paneRes.stdout ?? "") : "";
	if (!paneInfo || paneInfo.includes('"error"')) return "husk";
	const status = jsonGet(paneInfo, "result", "pane", "agent_status");
	if (status === "working" || status === "idle" || status === "blocked" || status === "done") return "live";
	return herdrPaneAgentProcessVerdict(pane) === "shell" ? "husk" : "unknown";
}

async function sleepSeconds(seconds: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// herdrReapHuskSlot(slot): remove only a confirmed session-restore husk.
// Callers must create the replacement tab before this resolves so closing the
// restored tab cannot leave its workspace empty. Returns true (rc 0) on
// success (including the free no-op case) or false (rc 1) after writing an
// explanatory error to stderr, mirroring the bash function's return codes.
export async function herdrReapHuskSlot(slot: string): Promise<boolean> {
	const verdict = herdrClassifySlot(slot);
	if (verdict === "free") return true;
	if (verdict === "husk") {
		const agentRes = spawnSync("herdr", ["agent", "get", slot], { encoding: "utf8" });
		const info = !agentRes.error && agentRes.status === 0 ? (agentRes.stdout ?? "") : "";
		const tab = jsonGet(info, "result", "agent", "tab_id");
		const pane = jsonGet(info, "result", "agent", "pane_id");
		if (tab) {
			spawnSync("herdr", ["tab", "close", tab]);
		} else if (pane) {
			spawnSync("herdr", ["pane", "close", pane]);
		}
		const settle = Number(process.env.FM_HUSK_REAP_SETTLE ?? "0.3");
		await sleepSeconds(settle);
		process.stderr.write(`info: reaped husk agent slot '${slot}' before respawn\n`);
		return true;
	}
	if (verdict === "live") {
		process.stderr.write(`error: agent slot '${slot}' is held by a live agent - refusing to replace\n`);
		return false;
	}
	process.stderr.write(`error: agent slot '${slot}' is occupied and not confidently a husk - refusing to replace\n`);
	return false;
}

// Composer observation: pending draft vs clear vs observation error.
// Observation errors must not masquerade as composer-blocked.
const OMP_COMPOSER_HEADER_RE = /^╭── .+(?: ──|▶────)╮$/;
const OMP_EMPTY_COMPOSER_BOTTOM_RE = /^╰─( +)─╯$/;

export type ComposerObservation =
	| { state: "pending" }
	| { state: "clear" }
	| { state: "error"; reason: string };

/**
 * Tri-state composer inspection. Errors are distinct from a human draft.
 * Note: --lines is not honored by --source visible (herdr returns the full
 * visible viewport), so this scans the whole visible tail.
 */
export function observeComposer(pane: string): ComposerObservation {
	// If the agent is mid-turn, the visible last line is agent output, never
	// unsubmitted human text. Defer to the busy check so a working pane is
	// never misread as holding pending input.
	const status = readHerdrAgentStatus(pane);
	if (status.presence === "error") return { state: "error", reason: status.reason };
	if (status.presence === "present" && status.status === "working") return { state: "clear" };

	const read = readPaneVisible(pane);
	if (read.presence === "error") return { state: "error", reason: read.reason };
	if (read.presence === "absent") return { state: "clear" };
	const raw = read.lines;
	if (raw.length === 0) return { state: "clear" };

	// OMP renders its status inside the composer's rounded top border. When
	// empty, the exact final compositor is that header immediately followed by
	// a spaces-only rounded bottom border. Recognize the bounded final frame
	// before scanning historical viewport content, which would otherwise leave
	// the decorated status row as a false draft candidate. Any interior row or
	// non-space bottom content breaks this exact match and remains fail-closed.
	if (
		raw.length >= 2 &&
		OMP_COMPOSER_HEADER_RE.test(raw[raw.length - 2]) &&
		OMP_EMPTY_COMPOSER_BOTTOM_RE.test(raw[raw.length - 1])
	) {
		return { state: "clear" };
	}

	let found = false;
	let result = "";
	// Scan the visible tail top-to-bottom, keeping only the LAST line that is
	// neither known trailing chrome nor a border-only row; that survivor is the
	// composer's real content line. Current Claude Code layouts render, below
	// the composer's bottom border, a persistent mode-indicator footer (e.g.
	// "bypass permissions on (shift+tab to cycle)") and sometimes a shortcuts
	// hint - neither reflects composer content, so both are skipped instead of
	// being misread as an unsent draft (this was the false-positive bug: that
	// footer line was previously the last non-blank line, so it alone decided
	// pending/not-pending). A border-only row (e.g. omp/opus's "╰── … ──╯", or
	// Claude Code's plain rule lines) collapses to whitespace once box-drawing
	// chrome is stripped and is skipped the same way, since it carries no
	// signal either way. For the remaining known layouts, nothing real follows
	// the composer's actual content line, so the last surviving candidate is
	// that content line. "result" (not "stripped") carries the winning
	// candidate across iterations, since a later skipped border/chrome row must
	// not clobber it.
	for (const line of raw) {
		if (line.includes("shift+tab to cycle") || line.includes("for shortcuts")) continue;
		let stripped = line
			.replaceAll("│", "")
			.replaceAll("┃", "")
			.replaceAll("|", "")
			.replaceAll("─", "")
			.replaceAll("━", "")
			.replaceAll("╭", "")
			.replaceAll("╮", "")
			.replaceAll("╰", "")
			.replaceAll("╯", "")
			.replaceAll("┌", "")
			.replaceAll("┐", "")
			.replaceAll("└", "")
			.replaceAll("┘", "");
		stripped = stripped.trim();
		if (!stripped) continue;
		found = true;
		result = stripped;
	}
	if (!found) return { state: "clear" };
	// Bare prompt glyph = empty composer.
	if (result === ">" || result === "❯" || result === "$" || result === "%" || result === "#") {
		return { state: "clear" };
	}
	// Custom idle-compositor override (after border stripping), e.g. for custom prompt patterns.
	const idleRe = process.env.FM_COMPOSER_IDLE_RE;
	if (idleRe) {
		if (new RegExp(idleRe).test(result)) return { state: "clear" };
	}
	// A busy footer on the cursor line is not pending input.
	const busyRe = process.env.FM_BUSY_REGEX || "esc (to )?interrupt|Working\\.\\.\\.";
	if (new RegExp(busyRe, "i").test(result)) return { state: "clear" };
	return { state: "pending" };
}

/** True only when a human draft is observed. Observation errors are not pending. */
export function paneInputPending(pane: string): boolean {
	return observeComposer(pane).state === "pending";
}
