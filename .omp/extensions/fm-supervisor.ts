/**
 * fm-supervisor.ts - in-process omp supervision extension for firstmate.
 *
 * Replaces the retired bash supervision stack (a polling watcher, a background
 * supervise daemon, a wake-queue, and a busy guard) with ONE in-process
 * extension that blocks on herdr fleet events and injects ONE dense,
 * self-contained wake digest per relevant
 * event. Higher signal-per-token at the LLM interface, and no per-turn
 * drain -> handle -> re-arm ritual: the supervision driver lives for the whole
 * session and never needs re-arming.
 *
 * =========================== omp APIs used ==============================
 * - default export factory `(pi: ExtensionAPI) => void`. At load time ONLY
 *   registration is valid; runtime action methods (sendMessage/exec) throw
 *   until ExtensionRunner.initialize() runs, so all live work starts from the
 *   `session_start` event, not from the factory body.
 * - pi.on("session_start", (event, ctx)): resolve the fleet and start the
 *   long-lived supervision driver once. ctx.cwd locates the firstmate home.
 * - pi.on("session_shutdown", ...): tear the socket / watcher / timers down.
 * - pi.exec(cmd, args, { timeout, signal, cwd }) -> { stdout, stderr, code,
 *   killed }: every herdr CLI call (agent get) and every *.check.sh run carries
 *   a timeout + the shutdown AbortSignal, so no herdr call is ever unbounded.
 * - pi.sendMessage(message, { deliverAs, triggerTurn }): inject a wake digest.
 *   The real API takes a CustomMessage-shaped object (the digest string rides
 *   in `content`), NOT a bare string as the prose spec sketched, so we pass
 *   `{ customType: "fm-wake", content: digest, display: true }`.
 * - pi.logger: best-effort diagnostics.
 *
 * ============ pi.sendMessage delivery semantics (assumed) =========
 * We inject with `{ deliverAs: "nextTurn", triggerTurn: true }`:
 *   - deliverAs "nextTurn" stores the message hidden from the editable
 *     pending-message UI and injects it on the next user prompt.
 *   - triggerTurn true starts a turn when the session is idle, and while the
 *     session is streaming it schedules an internal continuation that consumes
 *     the message on the next turn.
 * Therefore omp owns delivery timing: the extension does NOT need the bash
 * daemon's manual busy-guard / input-pending guard / submit-confirm retries.
 * One pi.sendMessage == one supervisor wake. (If live verification shows
 * nextTurn is too lazy for an idle supervisor, switch to "followUp"; the call
 * site is the single `inject()` helper.)
 *
 * ===================== herdr primitives (live loop) ====================
 * The live loop blocks on the herdr socket event STREAM,
 * not on N per-pane `herdr agent wait` shells:
 *   - ONE persistent unix-socket connection to $HERDR_SOCKET_PATH (fallback
 *     ~/.config/herdr/herdr.sock), newline-delimited JSON. We send one
 *     events.subscribe with a {type, pane_id} entry per in-flight pane for
 *     pane.agent_status_changed / pane.exited / pane.closed, get a
 *     subscription_started ack, then read pushed events. The socket read IS the
 *     block - never a busy-poll.
 *   - Pushed payload shape (captured live):
 *     {"event":"pane.agent_status_changed","data":{"pane_id","agent_status","agent","workspace_id"}}.
 *     The event carries only the NEW status, so previous status is tracked per
 *     pane to compute transitions. All pushed JSON is EXTERNAL input: it is
 *     parsed through type guards (asRecord/asString/toHerdrStatus), never cast
 *     to `any`.
 *   - The fleet is DYNAMIC (firstmate spawns/teardowns crewmates mid-session):
 *     fs.watch(state) re-resolves state/*.meta and we re-send the FULL
 *     subscription set. That is idempotent under both replace- and accumulate-
 *     subscription semantics because per-pane prevStatus dedups repeated events.
 *   - A herdr `wait` CLI is deliberately NOT used: `herdr wait agent-status`
 *     takes a SINGLE status (no unions) and rejects `done` ("UI attention
 *     state; use idle"). The socket stream is strictly better and is the only
 *     transport here; if the socket is unavailable, status-file watching below
 *     still carries every captain-relevant signal (crewmates write blocked:/
 *     done: lines to disk), so coverage degrades gracefully.
 *
 * ===================== firstmate state contract (parity with bin/) ==========
 *   - state dir = $FM_STATE_OVERRIDE || $FM_HOME/state || <cwd>/state.
 *   - state/<task>.meta: key=value lines; pane=, kind=, pr= consumed
 *     (last pr= wins, matching bash `tail -1`).
 *   - state/<task>.status: status lines; the last non-empty line is the signal.
 *   - state/<task>.check.sh: per-task poll; non-empty stdout == a wake.
 *   - state/.afk: when present, batch relevant events over a short window and
 *     inject ONE combined digest.
 *   - state/.status-internal.log: non-relevant status lines appended here, no
 *     wake (trimmed to the last STATUS_INTERNAL_LOG_MAX lines like bash).
 *   - the periodic stale NAG is SKIPPED for kind=secondmate panes and for ship
 *     tasks parked on a green PR (pr= set AND last status line is a terminal
 *     done-PR / PR-ready line); see benchmarks/model-lib.ts isParkedOnGreenPR.
 *     A secondmate working->idle transition instead arms a short, corroborated
 *     completion backstop (FM_SECONDMATE_IDLE_SECS) so a secondmate finishing
 *     routed work and going idle without a terminal status line still wakes.
 *   - live panes are resolved by DURABLE herdr agent identity (the agent slot is
 *     the task id): refreshFleet resolves each task's current pane via
 *     `herdr agent get <task>` and refreshes a drifted state/<task>.meta pane=,
 *     so a state change on a re-identified pane still wakes.
 *   - before any idle-backstop wake (stale or secondmate completion) the pane's
 *     existence is confirmed and herdr's idle verdict is corroborated against the
 *     pane's rendered busy banner (a crew mid long foreground tool call reads
 *     idle to herdr while its banner is up), so neither a gone nor a still-busy
 *     pane is acted on.
 *
 * The PURE export `classifyAndDigest` below is the single source of truth for
 * relevance + digest building (mirrors bin/fm-classify-status.sh and
 * benchmarks/relevance.ts exactly). It has no I/O and no omp/herdr imports, so
 * the benchmark imports it standalone under Bun. The live loop calls it too.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================== PURE SEAM ==============================
// No I/O, no omp/herdr imports. Bun-importable on its own. Mirrors the shared
// contract in local://supervisor-redesign.md and benchmarks/{types,relevance}.ts.

export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

// The unit replayed by the benchmark, consumed by both systems.
export type FleetEvent = {
	t: number; // ms offset within the scenario (ordered)
	kind: "status" | "herdr" | "check";
	pane: string; // e.g. "w8:p3"
	task: string; // e.g. "fix-login-k3"
	worker?: string; // live-only human display label (state/<id>.meta worker=); never set by the benchmark corpus
	status_line?: string; // kind=status: the appended status line
	herdr_from?: HerdrStatus; // kind=herdr
	herdr_to?: HerdrStatus;
	check_out?: string; // kind=check: stdout of a *.check.sh (empty = no wake)
	relevant: boolean; // GROUND TRUTH: should this wake the supervisor?
};

// Result of classifyAndDigest. Named here (no ReturnType<>) so the contract is
// importable directly by the benchmark and the live loop.
export interface ClassifyResult {
	wakes: number; // wake events generated
	digests: string[]; // one dense self-contained line per wake (afk: 1 combined)
	falseWakes: number; // wakes whose triggering events were all non-relevant
	detected: number; // distinct relevant events that produced a wake
}

// Matches bin/fm-classify-status.sh: optional ISO-ish timestamp prefix, then
// captain-relevant status prefixes or whole status phrases. Avoid substring
// matches such as "already", "unmerged", or "readying".
const STATUS_PREFIX_RE = /^(done|blocked|failed|needs-decision):/i;
const STATUS_PHRASE_RE = /(^|[^A-Za-z])(PR ready|checks green|ready in branch|merged)([^A-Za-z]|$)/i;

function captainRelevantStatusLine(line: string): boolean {
	const stripped = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "");
	return STATUS_PREFIX_RE.test(stripped) || STATUS_PHRASE_RE.test(stripped);
}

// Same grace as bash FM_SIGNAL_GRACE (30s): same-pane relevant events within
// this window coalesce into ONE wake (one digest), latest state wins.
const GRACE_MS = 30_000;

// Relevance per the shared contract (identical to benchmarks/relevance.ts):
//   status: regex match; check: non-empty output; herdr: ->blocked / ->done.
// A herdr working->idle is a turn-end (NOT a wake by itself); idle->idle is a
// re-observation (NOT a wake). The live loop turns a turn-end into a stale
// backstop, but stale is NOT modeled here - this fn is event-relevance only.
function isRelevant(e: FleetEvent): boolean {
	switch (e.kind) {
		case "status":
			return e.status_line !== undefined && captainRelevantStatusLine(e.status_line);
		case "check":
			return (e.check_out ?? "").length > 0;
		case "herdr":
			return e.herdr_to === "blocked" || e.herdr_to === "done";
		default:
			return false;
	}
}

// The recommended captain action for a relevant state string. Ordered so the
// most specific terminal outcome wins.
function actionFor(state: string): string {
	if (/merged/i.test(state)) return "confirm merge + teardown";
	if (/\bPR\b|PR ready|checks green|ready in branch/i.test(state)) return "review + merge PR";
	if (/needs-decision/i.test(state)) return "decide";
	if (/blocked/i.test(state)) return "unblock";
	if (/failed/i.test(state)) return "triage failure";
	if (/done/i.test(state)) return "review + close out";
	return "review";
}

// The state phrase for one event (what the crewmate is reporting).
function stateOf(e: FleetEvent): string {
	switch (e.kind) {
		case "status":
			return (e.status_line ?? "").trim();
		case "check":
			return ((e.check_out ?? "").trim().split("\n")[0] ?? "").trim();
		case "herdr":
			return `herdr ${e.herdr_from ?? "?"}->${e.herdr_to ?? "?"}`;
		default:
			return "";
	}
}

// One dense, self-contained wake line: task, pane, state, recommended action.
// The middle dot (U+00B7) is an intentional separator (NOT an em-dash).
function buildDigest(e: FleetEvent): string {
	const state = stateOf(e);
	const lineage = e.worker ? ` ${e.worker}` : "";
	return `[wake] ${e.task}${lineage} ${e.pane} - ${state} \u00b7 action: ${actionFor(state)}`;
}

// AFK: ONE combined digest covering every relevant event (still self-contained).
function buildBatchDigest(relevant: FleetEvent[]): string {
	const head = `[wake x${relevant.length}] afk batch - ${relevant.length} relevant event(s):`;
	const lines = relevant.map((e) => {
		const state = stateOf(e);
		const lineage = e.worker ? ` ${e.worker}` : "";
		return `  - ${e.task}${lineage} ${e.pane} - ${state} \u00b7 ${actionFor(state)}`;
	});
	return [head, ...lines].join("\n");
}

/**
 * Classify a batch of fleet events into wake digests. Single source of truth
 * for relevance + digest building; pure (no I/O), so the benchmark imports it
 * directly and the live loop reuses it.
 *
 * - Non-relevant events produce NO wake.
 * - A herdr working->idle coalesces with a relevant status in the grace window
 *   into ONE wake (the working->idle is non-relevant, so the relevant status
 *   drives the single wake); same-pane relevant events within the window also
 *   coalesce (latest state wins) while each still counts toward `detected`.
 * - opts.afk batches ALL relevant events into ONE combined digest (wakes = 1).
 * - falseWakes is 0 by construction: this model only ever wakes on relevant
 *   events, so a wake triggered solely by non-relevant events cannot occur.
 */
export function classifyAndDigest(events: FleetEvent[], opts?: { afk?: boolean }): ClassifyResult {
	const afk = opts?.afk === true;
	const ordered = [...events].sort((a, b) => a.t - b.t);

	if (afk) {
		const relevant = ordered.filter(isRelevant);
		if (relevant.length === 0) return { wakes: 0, digests: [], falseWakes: 0, detected: 0 };
		return {
			wakes: 1,
			digests: [buildBatchDigest(relevant)],
			falseWakes: 0,
			detected: relevant.length,
		};
	}

	const digests: string[] = [];
	const idxByPane = new Map<string, number>();
	const lastTByPane = new Map<string, number>();
	let wakes = 0;
	let detected = 0;

	for (const e of ordered) {
		if (!isRelevant(e)) continue; // non-relevant -> no wake
		detected++;
		const prevT = lastTByPane.get(e.pane);
		const idx = idxByPane.get(e.pane);
		if (prevT !== undefined && idx !== undefined && e.t - prevT <= GRACE_MS) {
			digests[idx] = buildDigest(e); // coalesce into the open wake; latest wins
			lastTByPane.set(e.pane, e.t);
			continue;
		}
		idxByPane.set(e.pane, digests.length);
		lastTByPane.set(e.pane, e.t);
		digests.push(buildDigest(e));
		wakes++;
	}

	return { wakes, digests, falseWakes: 0, detected };
}

// ============================== LIVE LOOP =============================
// Everything below runs only inside event handlers (after the runtime is
// initialized). Nothing here executes at import time, so importing this module
// for the benchmark stays side-effect free.

// Live-loop timing. These honor the same FM_* env tunables (in seconds) as the
// bash stack so behavior stays at parity and tests can shrink the windows. The
// pure GRACE_MS above stays a fixed constant: classifyAndDigest must be
// deterministic for the benchmark, independent of the environment.
const STATUS_INTERNAL_LOG_MAX = 500;
const INTERNAL_LOG_TRIM_EVERY = 50;

interface Tunables {
	flushGraceMs: number; // FM_SIGNAL_GRACE: non-afk coalescing window (default 30s)
	flushAfkMs: number; // FM_ESCALATE_BATCH_SECS: afk batch window (default 90s)
	staleMs: number; // FM_STALE_ESCALATE_SECS: idle-without-status backstop (default 240s)
	secondmateIdleMs: number; // FM_SECONDMATE_IDLE_SECS: secondmate working->idle completion backstop (default 20s)
	checkIntervalMs: number; // FM_CHECK_INTERVAL: *.check.sh cadence (default 300s)
	checkTimeoutMs: number; // FM_CHECK_TIMEOUT: per-check timeout (default 30s)
	herdrGetTimeoutMs: number; // herdr agent get seed timeout (fixed)
	busyReadTimeoutMs: number; // herdr pane read busy-banner corroboration timeout (fixed)
}

function envSec(name: string, defSec: number): number {
	const raw = process.env[name];
	if (raw === undefined) return defSec * 1000;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n * 1000 : defSec * 1000;
}

function readTunables(): Tunables {
	return {
		flushGraceMs: envSec("FM_SIGNAL_GRACE", 30),
		flushAfkMs: envSec("FM_ESCALATE_BATCH_SECS", 90),
		staleMs: envSec("FM_STALE_ESCALATE_SECS", 240),
		secondmateIdleMs: envSec("FM_SECONDMATE_IDLE_SECS", 20),
		checkIntervalMs: envSec("FM_CHECK_INTERVAL", 300),
		checkTimeoutMs: envSec("FM_CHECK_TIMEOUT", 30),
		herdrGetTimeoutMs: 5_000,
		busyReadTimeoutMs: 5_000,
	};
}

// Internal timer-handle type (cross-runtime; not a published contract).
type Timer = ReturnType<typeof setTimeout>;

interface Crewmate {
	task: string;
	pane: string;
	kind: "ship" | "scout" | "secondmate";
	pr?: string;
	worker?: string;
	harness?: string;
	agent_identity?: string;
}

interface MetaFields {
	pane?: string;
	kind: Crewmate["kind"];
	pr?: string;
	worker?: string;
	harness?: string;
	agent_identity?: string;
}

interface Supervisor {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	stateDir: string;
	tunables: Tunables;
	abort: AbortController;
	socket?: Socket;
	socketBuf: string;
	crewByPane: Map<string, Crewmate>;
	prevStatus: Map<string, HerdrStatus>;
	staleTimers: Map<string, Timer>;
	pendingEvents: FleetEvent[];
	pendingStale: string[];
	flushTimer?: Timer;
	checkTimer?: Timer;
	watcher?: FSWatcher;
	lastStatusSeen: Map<string, string>; // task -> last processed status line
	internalLogWrites: number;
}

// A typed view of one herdr socket push (external input narrowed via guards).
type HerdrPush = { kind: "status"; pane: string; status: HerdrStatus } | { kind: "gone"; pane: string };

let started = false;
let supervisor: Supervisor | undefined;

export default function fmSupervisor(pi: ExtensionAPI): void {
	pi.setLabel("Firstmate supervisor");

	pi.on("session_start", async (_event, ctx) => {
		if (started) return; // one driver per session; never re-armed
		started = true;
		const sup = createSupervisor(pi, ctx);
		supervisor = sup;
		await startSupervision(sup);
	});

	pi.on("session_shutdown", async () => {
		if (supervisor) stopSupervision(supervisor);
		supervisor = undefined;
		started = false;
	});
}

function createSupervisor(pi: ExtensionAPI, ctx: ExtensionContext): Supervisor {
	return {
		pi,
		ctx,
		stateDir: resolveStateDir(ctx),
		tunables: readTunables(),
		abort: new AbortController(),
		socketBuf: "",
		crewByPane: new Map(),
		prevStatus: new Map(),
		staleTimers: new Map(),
		pendingEvents: [],
		pendingStale: [],
		lastStatusSeen: new Map(),
		internalLogWrites: 0,
	};
}

function resolveStateDir(ctx: ExtensionContext): string {
	const override = process.env.FM_STATE_OVERRIDE;
	if (override) return override;
	const home = process.env.FM_HOME ?? ctx.cwd;
	return join(home, "state");
}

function logWarn(sup: Supervisor, msg: string): void {
	try {
		sup.pi.logger?.warn?.(msg);
	} catch {
		// logging is best-effort
	}
}

async function startSupervision(sup: Supervisor): Promise<void> {
	await refreshFleet(sup);
	openSocket(sup);
	await seedStatuses(sup);
	await diagnoseOmpUnknown(sup);
	startWatch(sup);
	startCheckTimer(sup);
}

function stopSupervision(sup: Supervisor): void {
	sup.abort.abort();
	try {
		sup.socket?.destroy();
	} catch {
		// already gone
	}
	try {
		sup.watcher?.close();
	} catch {
		// already closed
	}
	clearTimeout(sup.flushTimer);
	clearTimeout(sup.checkTimer);
	for (const t of sup.staleTimers.values()) clearTimeout(t);
	sup.staleTimers.clear();
}

// ---------------------------- fleet resolution ------------------------

async function refreshFleet(sup: Supervisor): Promise<void> {
	let files: string[];
	try {
		files = (await readdir(sup.stateDir)).filter((f) => f.endsWith(".meta"));
	} catch {
		return; // no state dir yet
	}

	const next = new Map<string, Crewmate>();
	for (const f of files) {
		const task = f.slice(0, -".meta".length);
		const meta = await parseMeta(join(sup.stateDir, f));
		if (!meta.pane) continue;
		// Durable-identity resolution: key on the CURRENT live pane, not a
		// possibly-drifted recorded pane= (see resolveLivePane).
		const pane = await resolveLivePane(sup, task, meta.pane);
		next.set(pane, { ...meta, task, pane });
	}

	let changed = next.size !== sup.crewByPane.size;
	for (const pane of next.keys()) if (!sup.crewByPane.has(pane)) changed = true;
	for (const pane of sup.crewByPane.keys()) {
		if (!next.has(pane)) {
			changed = true;
			clearStaleTimer(sup, pane);
			sup.prevStatus.delete(pane);
		}
	}

	sup.crewByPane = next;
	if (changed && sup.socket && !sup.socket.destroyed) {
		subscribeAll(sup);
		await seedStatuses(sup);
	}
}

async function parseMeta(path: string): Promise<MetaFields> {
	const meta: MetaFields = { kind: "ship" };
	try {
		const txt = await readFile(path, "utf8");
		for (const line of txt.split("\n")) {
			const eq = line.indexOf("=");
			if (eq < 0) continue;
			const key = line.slice(0, eq);
			const value = line.slice(eq + 1).trim();
			switch (key) {
				case "pane":
					meta.pane = value;
					break;
				case "kind":
					if (value === "ship" || value === "scout" || value === "secondmate") meta.kind = value;
					break;
				case "pr":
					if (value) meta.pr = value; // last pr= wins (bash tail -1)
					break;
				case "worker":
					meta.worker = value;
					break;
				case "harness":
					meta.harness = value;
					break;
				case "agent_identity":
					meta.agent_identity = value;
					break;
				// unknown keys ignored
			}
		}
	} catch {
		// unreadable meta -> treated as absent
	}
	return meta;
}

function findCrewByTask(sup: Supervisor, task: string): Crewmate | undefined {
	for (const crew of sup.crewByPane.values()) if (crew.task === task) return crew;
	return undefined;
}

// ---------------------------- herdr socket ----------------------------

function socketPath(): string {
	return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

function openSocket(sup: Supervisor): void {
	let sock: Socket;
	try {
		sock = connect(socketPath());
	} catch (err) {
		logWarn(sup, `fm-supervisor: socket connect failed: ${String(err)}`);
		scheduleReconnect(sup);
		return;
	}
	sup.socket = sock;
	sup.socketBuf = "";
	sock.on("connect", () => subscribeAll(sup));
	sock.on("data", (chunk: Buffer) => onSocketData(sup, chunk));
	sock.on("error", (err: Error) => logWarn(sup, `fm-supervisor: socket error: ${err.message}`));
	sock.on("close", () => {
		if (sup.abort.signal.aborted) return;
		scheduleReconnect(sup);
	});
}

function scheduleReconnect(sup: Supervisor): void {
	if (sup.abort.signal.aborted) return;
	setTimeout(() => {
		if (!sup.abort.signal.aborted) openSocket(sup);
	}, 2_000);
}

function subscribeAll(sup: Supervisor): void {
	const sock = sup.socket;
	if (!sock || sock.destroyed || sup.crewByPane.size === 0) return;
	const subscriptions: Array<{ type: string; pane_id: string }> = [];
	for (const pane of sup.crewByPane.keys()) {
		subscriptions.push({ type: "pane.agent_status_changed", pane_id: pane });
		subscriptions.push({ type: "pane.exited", pane_id: pane });
		subscriptions.push({ type: "pane.closed", pane_id: pane });
	}
	try {
		sock.write(`${JSON.stringify({ id: "fm-sub", method: "events.subscribe", params: { subscriptions } })}\n`);
	} catch (err) {
		logWarn(sup, `fm-supervisor: subscribe write failed: ${String(err)}`);
	}
}

function onSocketData(sup: Supervisor, chunk: Buffer): void {
	sup.socketBuf += chunk.toString();
	let nl = sup.socketBuf.indexOf("\n");
	while (nl >= 0) {
		const line = sup.socketBuf.slice(0, nl);
		sup.socketBuf = sup.socketBuf.slice(nl + 1);
		if (line.trim().length > 0) {
			const push = parseHerdrPush(line);
			if (push) handleHerdrPush(sup, push);
		}
		nl = sup.socketBuf.indexOf("\n");
	}
}

// ----- external-input guards (no `any`): narrow unknown herdr JSON -----

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function toHerdrStatus(v: unknown): HerdrStatus {
	return v === "idle" || v === "working" || v === "blocked" || v === "done" || v === "unknown"
		? v
		: "unknown";
}

function parseHerdrPush(line: string): HerdrPush | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const obj = asRecord(parsed);
	if (!obj) return undefined;
	const evt = asString(obj.event);
	const data = asRecord(obj.data);
	if (!evt || !data) return undefined; // acks / errors have no event+data pair
	const pane = asString(data.pane_id);
	if (!pane) return undefined;
	if (evt.includes("agent_status")) {
		return { kind: "status", pane, status: toHerdrStatus(data.agent_status) };
	}
	if (evt.includes("exit") || evt.includes("close")) {
		return { kind: "gone", pane };
	}
	return undefined;
}

function handleHerdrPush(sup: Supervisor, push: HerdrPush): void {
	const crew = sup.crewByPane.get(push.pane);
	if (!crew) return; // not one of this home's panes

	if (push.kind === "gone") {
		dropPane(sup, push.pane);
		return;
	}

	const prev = sup.prevStatus.get(push.pane) ?? "unknown";
	sup.prevStatus.set(push.pane, push.status);
	if (push.status === prev) return; // dedupe: no real transition

	if (push.status === "working") {
		clearStaleTimer(sup, push.pane); // turn started
		return;
	}
	if (push.status === "blocked") {
		// blocked transition is a captain wake.
		clearStaleTimer(sup, push.pane);
		enqueueEvent(sup, {
			t: Date.now(),
			kind: "herdr",
			pane: crew.pane,
			task: crew.task,
			...(crew.worker ? { worker: crew.worker } : {}),
			herdr_from: prev,
			herdr_to: "blocked",
			relevant: true,
		});
		return;
	}
	// idle / unknown / done: turn-end.
	// - secondmate: only a working->idle/done/unknown transition is a completion
	//   signal for routed work. A resting secondmate may re-seed as idle/done after
	//   restart or pane drift; that is healthy and must not nag.
	// - ship/scout: arm the stale backstop as before. A status line written
	//   right after the turn-end is caught by fs.watch and supersedes the timer
	//   (it calls clearStaleTimer).
	if (crew.kind === "secondmate") {
		if (prev === "working") armCompletionTimer(sup, crew);
		else clearStaleTimer(sup, push.pane);
	} else {
		armStaleTimer(sup, crew);
	}
}

function dropPane(sup: Supervisor, pane: string): void {
	sup.crewByPane.delete(pane);
	sup.prevStatus.delete(pane);
	clearStaleTimer(sup, pane);
}

async function seedStatuses(sup: Supervisor): Promise<void> {
	for (const pane of sup.crewByPane.keys()) {
		if (sup.prevStatus.has(pane)) continue;
		sup.prevStatus.set(pane, await herdrStatus(sup, pane));
	}
}

async function herdrStatus(sup: Supervisor, pane: string): Promise<HerdrStatus> {
	try {
		const res = await sup.pi.exec("herdr", ["agent", "get", pane], {
			timeout: sup.tunables.herdrGetTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		const m = res.stdout.match(/"agent_status":"([^"]*)"/);
		return toHerdrStatus(m?.[1]);
	} catch {
		return "unknown";
	}
}

// Startup-only diagnostic (NON-WAKING). An OMP pane whose authoritative agent
// identity is still `omp` but seeds as `unknown` usually means an accidental
// `herdr agent rename` (which pins agent_status to unknown) or a missing OMP
// herdr status integration. Surfaced through the logger only; never a captain
// wake, because stale or non-agent panes can legitimately read unknown.
async function diagnoseOmpUnknown(sup: Supervisor): Promise<void> {
	if (!sup.socket || sup.socket.destroyed) return; // herdr unreachable: seedStatuses already read unknown for every pane; skip the per-pane probe storm
	for (const crew of sup.crewByPane.values()) {
		if (sup.abort.signal.aborted) return;
		if (crew.harness !== "omp" || crew.agent_identity !== "omp") continue;
		if (sup.prevStatus.get(crew.pane) !== "unknown") continue;
		if (!(await paneReachable(sup, crew.pane))) continue; // unreachable/non-agent pane: not diagnosable here
		const worker = crew.worker ? ` worker=${crew.worker}` : "";
		logWarn(
			sup,
			`fm-supervisor: omp pane seeds agent_status=unknown for task=${crew.task} pane=${crew.pane}${worker}` +
				" - check for an accidental 'herdr agent rename' (it pins agent_status to unknown) or a missing OMP/herdr status integration",
		);
	}
}

// True when `herdr pane get <pane>` resolves to a real pane (read-only probe).
async function paneReachable(sup: Supervisor, pane: string): Promise<boolean> {
	try {
		const res = await sup.pi.exec("herdr", ["pane", "get", pane], {
			timeout: sup.tunables.herdrGetTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		return /"pane_id":/.test(res.stdout);
	} catch {
		return false;
	}
}

// ---------------------------- stale backstop --------------------------

function armStaleTimer(sup: Supervisor, crew: Crewmate): void {
	clearStaleTimer(sup, crew.pane);
	if (crew.kind === "secondmate") return; // secondmates self-manage: no stale wake
	const idleStart = Date.now();
	const timer = setTimeout(() => {
		sup.staleTimers.delete(crew.pane);
		void fireStale(sup, crew, idleStart);
	}, sup.tunables.staleMs);
	sup.staleTimers.set(crew.pane, timer);
}

function clearStaleTimer(sup: Supervisor, pane: string): void {
	clearTimeout(sup.staleTimers.get(pane));
	sup.staleTimers.delete(pane);
}

async function fireStale(sup: Supervisor, crew: Crewmate, idleStart: number): Promise<void> {
	if (sup.abort.signal.aborted) return;
	const cur = sup.prevStatus.get(crew.pane);
	if (cur !== "idle" && cur !== "unknown") return; // no longer idle
	// Target-existence (port of kun #188-adjacent): never fire a "peek" wake for
	// a pane that no longer exists; a missed exit event means the pane is gone.
	if (!(await paneReachable(sup, crew.pane))) {
		dropPane(sup, crew.pane);
		return;
	}
	// herdr idle-state corroboration (port of kun #207): herdr agent_status
	// reports generation state, so a crew blocked on its own long foreground
	// tool call reads idle while its pane still shows the busy banner. Re-arm
	// instead of spuriously flagging it stale.
	if (await paneShowsBusyBanner(sup, crew.pane)) {
		armStaleTimer(sup, crew);
		return;
	}
	if (await isAwaitingMerge(sup, crew)) return; // parked on a green PR: by design
	const last = await lastStatusLine(sup, crew.task);
	if (last && captainRelevantStatusLine(last)) return; // already reported something captain-worthy
	const mins = Math.max(1, Math.round((Date.now() - idleStart) / 60_000));
	const lineage = crew.worker ? ` ${crew.worker}` : "";
	enqueueStale(
		sup,
		`[wake] ${crew.task}${lineage} ${crew.pane} - STALE ${mins}m idle, no status \u00b7 action: peek pane`,
	);
}

async function isAwaitingMerge(sup: Supervisor, crew: Crewmate): Promise<boolean> {
	if (!crew.pr) return false;
	const last = await lastStatusLine(sup, crew.task);
	if (!last) return false;
	// awaiting-merge rule (see benchmarks/model-lib.ts isParkedOnGreenPR):
	// terminal "done:...<space>PR<space>" line, or a "PR ready" line.
	return /^done:.*\bPR\b/i.test(last) || /PR ready/i.test(last);
}

// ---------------------- secondmate completion backstop ----------------------

// A secondmate is idle-by-default for routed work, so it is excluded from the
// stale nag (an idle secondmate is healthy). But a secondmate that FINISHES
// routed work and goes idle without leaving a terminal captain-relevant status
// line was not waking the main firstmate at all - the awareness gap this closes.
// A working->idle transition (armed only on the TRANSITION, never periodically)
// is that completion signal: arm a short, corroborated backstop.
function armCompletionTimer(sup: Supervisor, crew: Crewmate): void {
	clearStaleTimer(sup, crew.pane); // reuse the per-pane timer slot (a pane is crew XOR secondmate)
	const timer = setTimeout(() => {
		sup.staleTimers.delete(crew.pane);
		void fireCompletion(sup, crew);
	}, sup.tunables.secondmateIdleMs);
	sup.staleTimers.set(crew.pane, timer);
}

async function fireCompletion(sup: Supervisor, crew: Crewmate): Promise<void> {
	if (sup.abort.signal.aborted) return;
	const cur = sup.prevStatus.get(crew.pane);
	if (cur !== "idle" && cur !== "unknown" && cur !== "done") return; // resumed working
	// target-existence (#188): a gone secondmate pane is dropped, not woken on.
	if (!(await paneReachable(sup, crew.pane))) {
		dropPane(sup, crew.pane);
		return;
	}
	// herdr idle corroboration (#207): still-busy pane (mid long tool call) is
	// not a real completion - re-arm and re-check.
	if (await paneShowsBusyBanner(sup, crew.pane)) {
		armCompletionTimer(sup, crew);
		return;
	}
	// status log: if the secondmate already wrote a captain-relevant line, the
	// status-file watcher woke the captain; do not double-wake.
	const last = await lastStatusLine(sup, crew.task);
	if (last && captainRelevantStatusLine(last)) return;
	const lineage = crew.worker ? ` ${crew.worker}` : "";
	enqueueStale(
		sup,
		`[wake] ${crew.task}${lineage} ${crew.pane} - secondmate idle after routed work, no status \u00b7 action: review + close out`,
	);
}

// ---------------------- durable-identity pane resolution ---------------------

// Resolve the CURRENT live pane for a task by its durable herdr agent identity.
// bin/fm-spawn.sh registers every direct report under an agent SLOT named for
// the task id, so `herdr agent get <task>` resolves the live pane even after the
// pane is re-identified (restart/reopen), when the recorded pane= has drifted.
// Port of origin/fm-live-pane-refresh: refresh state/<task>.meta pane= when it
// drifts so a state change on the re-identified pane still wakes. Falls back to
// the recorded pane when herdr is unreachable or the agent slot is gone.
async function resolveLivePane(sup: Supervisor, task: string, recordedPane: string): Promise<string> {
	let live: string | undefined;
	try {
		const res = await sup.pi.exec("herdr", ["agent", "get", task], {
			timeout: sup.tunables.herdrGetTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		live = res.stdout.match(/"pane_id":"([^"]*)"/)?.[1];
	} catch {
		return recordedPane;
	}
	if (!live) return recordedPane;
	if (live !== recordedPane) await writeMetaPane(sup, task, live);
	return live;
}

// Rewrite state/<task>.meta pane= in place (last pane= wins, matching parseMeta).
async function writeMetaPane(sup: Supervisor, task: string, pane: string): Promise<void> {
	const path = join(sup.stateDir, `${task}.meta`);
	try {
		const txt = await readFile(path, "utf8");
		const lines = txt.split("\n");
		let found = false;
		const out = lines.map((l) => {
			if (l.startsWith("pane=")) {
				found = true;
				return `pane=${pane}`;
			}
			return l;
		});
		if (!found) out.push(`pane=${pane}`);
		await writeFile(path, out.join("\n"));
	} catch {
		// best-effort meta refresh; a failed write just leaves the drifted pane=
	}
}

// ------------------------ busy-banner corroboration -------------------------

// Corroborate a herdr `idle` verdict against the pane's own rendered text (port
// of kun #207). Returns true when the pane still renders the harness busy banner
// (BUSY_REGEX / FM_BUSY_REGEX), i.e. it is NOT genuinely idle (a crew mid long
// foreground tool call). Best-effort: an unreadable pane reads not-busy so the
// other corroboration signals still apply.
async function paneShowsBusyBanner(sup: Supervisor, pane: string): Promise<boolean> {
	let text: string;
	try {
		const res = await sup.pi.exec("herdr", ["pane", "read", pane, "--lines", "6", "--source", "visible"], {
			timeout: sup.tunables.busyReadTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		text = res.stdout;
	} catch {
		return false;
	}
	const source =
		process.env.FM_BUSY_REGEX ??
		[
			"esc (to )?interrupt",
			"⟨esc⟩",
			"Working(\\.\\.\\.|…)?",
			"Thinking",
		].join("|");
	let re: RegExp;
	try {
		re = new RegExp(source, "i");
	} catch {
		re = /esc (to )?interrupt|⟨esc⟩|Working(\.\.\.|…)?|Thinking/i;
	}
	return text
		.split("\n")
		.map((l) => l.replace(/[\u2502\u2503|\u2500\u2501\u256d\u256e\u2570\u256f\u250c\u2510\u2514\u2518]/g, "").trim()) // strip composer box-drawing chrome (mirrors bin/fm-herdr-lib.sh)
		.filter((l) => l.length > 0)
		.some((l) => re.test(l));
}

// ---------------------------- status files ----------------------------

function startWatch(sup: Supervisor): void {
	try {
		sup.watcher = watch(sup.stateDir, (_eventType, filename) => {
			if (sup.abort.signal.aborted) return;
			if (!filename) {
				void refreshFleet(sup);
				return;
			}
			const name = filename.toString();
			if (name.endsWith(".status")) void onStatusFileChange(sup, name);
			else if (name.endsWith(".meta")) void refreshFleet(sup);
		});
	} catch (err) {
		logWarn(sup, `fm-supervisor: watch failed: ${String(err)}`);
	}
}

async function onStatusFileChange(sup: Supervisor, filename: string): Promise<void> {
	const task = filename.slice(0, -".status".length);
	const last = await lastStatusLine(sup, task);
	if (last === undefined) return;
	if (sup.lastStatusSeen.get(task) === last) return; // already processed this line
	sup.lastStatusSeen.set(task, last);

	const crew = findCrewByTask(sup, task);
	const pane = crew?.pane ?? "?";

	if (captainRelevantStatusLine(last)) {
		clearStaleTimer(sup, pane); // a real status supersedes the stale backstop
		enqueueEvent(sup, {
			t: Date.now(),
			kind: "status",
			pane,
			task,
			...(crew?.worker ? { worker: crew.worker } : {}),
			status_line: last,
			relevant: true,
		});
	} else {
		await appendInternalLog(sup, task, last); // non-relevant: log, no wake
	}
}

async function lastStatusLine(sup: Supervisor, task: string): Promise<string | undefined> {
	try {
		const txt = await readFile(join(sup.stateDir, `${task}.status`), "utf8");
		const lines = txt
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		return lines.length > 0 ? lines[lines.length - 1] : undefined;
	} catch {
		return undefined;
	}
}

async function appendInternalLog(sup: Supervisor, task: string, line: string): Promise<void> {
	const stamp = new Date().toISOString();
	const logPath = join(sup.stateDir, ".status-internal.log");
	try {
		await appendFile(logPath, `[${stamp}] ${task}.status: ${line}\n`);
		sup.internalLogWrites++;
		if (sup.internalLogWrites % INTERNAL_LOG_TRIM_EVERY === 0) await trimInternalLog(sup, logPath);
	} catch {
		// best-effort log
	}
}

async function trimInternalLog(sup: Supervisor, logPath: string): Promise<void> {
	try {
		const txt = await readFile(logPath, "utf8");
		const lines = txt.split("\n");
		if (lines.length <= STATUS_INTERNAL_LOG_MAX) return;
		const kept = lines.slice(lines.length - STATUS_INTERNAL_LOG_MAX);
		await writeFile(logPath, kept.join("\n"));
	} catch {
		// best-effort trim
	}
}

// ---------------------------- check polls -----------------------------

function startCheckTimer(sup: Supervisor): void {
	const tick = async (): Promise<void> => {
		if (sup.abort.signal.aborted) return;
		await runChecks(sup);
		if (!sup.abort.signal.aborted) sup.checkTimer = setTimeout(() => void tick(), sup.tunables.checkIntervalMs);
	};
	sup.checkTimer = setTimeout(() => void tick(), sup.tunables.checkIntervalMs);
}

async function runChecks(sup: Supervisor): Promise<void> {
	let files: string[];
	try {
		files = (await readdir(sup.stateDir)).filter((f) => f.endsWith(".check.sh"));
	} catch {
		return;
	}
	for (const f of files) {
		if (sup.abort.signal.aborted) return;
		const task = f.slice(0, -".check.sh".length);
		const crew = findCrewByTask(sup, task);
		let out = "";
		try {
			const res = await sup.pi.exec("bash", [join(sup.stateDir, f)], {
				timeout: sup.tunables.checkTimeoutMs,
				signal: sup.abort.signal,
				cwd: sup.ctx.cwd,
			});
			out = res.stdout.trim();
		} catch {
			out = ""; // a failed/timed-out check is silence (no wake), like bash
		}
		if (out.length > 0) {
			enqueueEvent(sup, {
				t: Date.now(),
				kind: "check",
				pane: crew?.pane ?? "?",
				task,
				...(crew?.worker ? { worker: crew.worker } : {}),
				check_out: out,
				relevant: true,
			});
		}
	}
}

// ---------------------------- wake delivery ---------------------------

function enqueueEvent(sup: Supervisor, e: FleetEvent): void {
	sup.pendingEvents.push(e);
	scheduleFlush(sup);
}

function enqueueStale(sup: Supervisor, digest: string): void {
	sup.pendingStale.push(digest);
	scheduleFlush(sup);
}

function scheduleFlush(sup: Supervisor): void {
	if (sup.flushTimer) return; // a flush is already queued; coalesce into it
	const delay = isAfkActive(sup) ? sup.tunables.flushAfkMs : sup.tunables.flushGraceMs;
	sup.flushTimer = setTimeout(() => {
		sup.flushTimer = undefined;
		void flush(sup);
	}, delay);
}

function isAfkActive(sup: Supervisor): boolean {
	try {
		return existsSync(join(sup.stateDir, ".afk"));
	} catch {
		return false;
	}
}

async function flush(sup: Supervisor): Promise<void> {
	if (sup.abort.signal.aborted) return;
	const events = sup.pendingEvents.splice(0);
	const stale = sup.pendingStale.splice(0);
	if (events.length === 0 && stale.length === 0) return;

	const afk = isAfkActive(sup);
	const { digests } = classifyAndDigest(events, { afk });
	const all = [...digests, ...stale];
	if (all.length === 0) return;

	if (afk) {
		// classifyAndDigest already combined events; fold any stale lines in so
		// the captain gets exactly ONE message while away.
		inject(sup, all.length === 1 ? (all[0] ?? "") : all.join("\n"));
	} else {
		for (const d of all) inject(sup, d);
	}
}

function inject(sup: Supervisor, content: string): void {
	try {
		sup.pi.sendMessage(
			{ customType: "fm-wake", content, display: true },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	} catch (err) {
		logWarn(sup, `fm-supervisor: inject failed: ${String(err)}`);
	}
}
