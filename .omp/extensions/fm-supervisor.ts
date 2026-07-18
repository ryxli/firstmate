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
 * - On session_start it writes state/activation-receipt.json atomically. The
 *   receipt binds the live pane, session identity, start time, and exact
 *   load-once source manifest digest; matching shutdown removes it.
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
 *     status files are watched with a portable mtime watcher (Bun's directory
 *     fs.watch callback is not reliable on macOS), and we re-send the FULL
 *     socket subscription set when the fleet changes.
 *   - A herdr `wait` CLI is deliberately NOT used: `herdr wait agent-status`
 *     takes a SINGLE status (no unions) and rejects `done` ("UI attention
 *     state; use idle"). The socket stream is strictly better and is the only
 *     transport here; if the socket is unavailable, status-file watching below
 *     still carries every cap-relevant signal (crewmates write blocked:/
 *     done: lines to disk), so coverage degrades gracefully.
 *
 * ===================== firstmate state contract (parity with sbin/) ==========
 *   - state dir = $FM_STATE_OVERRIDE || $FM_HOME/state || <cwd>/state.
 *   - state/<task>.meta: key=value lines; pane=, kind=, pr= consumed
 *     (last pr= wins, matching bash `tail -1`).
 *   - state/<task>.status: status lines; the last non-empty line is the signal.
 *   - dependency-bearing meta records producer, named consumers, artifact path/SHA,
 *     and wake action; completed artifacts wake those consumers directly.
 *   - state/<task>.check.sh: per-task poll; non-empty stdout == a wake.
 *   - state/.afk: when present, batch relevant events over a short window and
 *     inject ONE combined digest.
 *   - state/.status-internal.log: non-relevant status lines appended here, no
 *     wake (trimmed to the last STATUS_INTERNAL_LOG_MAX lines like bash).
 *   - periodic stale wakes are skipped for kind=secondmate panes and for ship
 *     tasks parked on a green PR (pr= set AND last status line is a terminal
 *     done-PR / PR-ready line). A real working-to-idle transition arms a short
 *     completion backstop. For secondmates it makes routed-work completion
 *     observable without disturbing their healthy idle state; for ordinary
 *     crewmates it prevents a missing terminal status from leaving their
 *     supervisor idle and unaware.
 *
 *   - a live pane is refreshed from its durable herdr task identity before
 *     subscribing, and an idle backstop confirms that the pane still exists and
 *     is not rendering a busy banner before waking.
 * The PURE export `classifyAndDigest` below is the single source of truth for
 * relevance + digest building (the canonical definition; benchmarks/relevance.ts
 * mirrors it exactly). It has no I/O and no omp/herdr imports, so the benchmark
 * imports it standalone under Bun. The live loop calls it too.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unwatchFile, watchFile } from "node:fs";
import { appendFile, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { capabilityForHome, readCapabilityRegistry, readSourceRevision } from "./bridge/update";
import { sourceRootForHome } from "./bridge/collect";
import { connect, type Socket } from "node:net";

import { dependencyDeliveries, parseDependencyEdge, prioritizeDependencyEdges, validateBlockedReport, type DependencyEdge } from "./dependency-handoff";

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
	dependency?: DependencyEdge;
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

// Canonical cap-relevance classifier: optional ISO-ish timestamp prefix, then
// cap-relevant status prefixes or whole status phrases. Avoid substring
// matches such as "already", "unmerged", or "readying". Working reports are
// internal even when they mention a completed merge elsewhere.
const STATUS_PREFIX_RE = /^(done|blocked|failed|needs-decision):/i;
const STATUS_PHRASE_RE = /(^|[^A-Za-z])(PR ready|checks green|ready in branch|merged)([^A-Za-z]|$)/i;
const WORKING_STATUS_RE = /^working(?:\s|:)/i;

function captainRelevantStatusLine(line: string): boolean {
	const stripped = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "");
	if (WORKING_STATUS_RE.test(stripped)) return false;
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

// The recommended cap action for a relevant state string. Ordered so the
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

// Compact UTC timestamp for wake prefixes. Milliseconds are intentionally
// truncated so every digest uses the same second-resolution wire format.
export function formatWakeTimestamp(epochMs: number): string {
	return new Date(Math.trunc(epochMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

// One dense, self-contained wake line: task, pane, state, recommended action.
// The middle dot (U+00B7) is an intentional separator (NOT an em-dash).
function buildDigest(e: FleetEvent): string {
	const state = stateOf(e);
	const lineage = e.worker ? ` ${e.worker}` : "";
	return `[wake ${formatWakeTimestamp(e.t)}] ${e.task}${lineage} ${e.pane} - ${state} \u00b7 action: ${actionFor(state)}`;
}

// AFK: ONE combined digest covering every relevant event (still self-contained).
function buildBatchDigest(relevant: FleetEvent[]): string {
	const stamp = formatWakeTimestamp(relevant[0]?.t ?? Date.now());
	const head = `[wake x${relevant.length} ${stamp}] afk batch - ${relevant.length} relevant event(s):`;
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

// ======================= AGENTS.md operator narrative ===================
// Relocated here from AGENTS.md section 7 (supervision protocol): this is the
// mechanism detail an engineer debugging or modifying this extension needs.
// AGENTS.md itself only keeps the compressed operative sentences (wake
// digest behavior, stale behavior, token discipline) that firstmate needs
// every turn - the rest was over-owned prose duplicating what this file
// already documents in code, so it lives here now, not in both places.
//   - Three sources feed the live loop: the herdr socket event stream (every
//     crewmate working/idle/blocked/done transition plus
//     pane.exited/pane.closed, pushed live - the fleet is dynamic, a new
//     state/<id>.meta adds a subscription and a closed pane drops it);
//     fs.watch on state/*.status (a crewmate's appended status line); and a
//     timer firing each state/*.check.sh (e.g. a merged-PR poll).
//   - Every event runs through the relevance rule above (STATUS_PREFIX_RE /
//     STATUS_PHRASE_RE / herdr ->blocked|->done / a check with non-empty
//     output, see isRelevant()). A relevant event becomes ONE dense,
//     self-contained wake digest injected via pi.sendMessage. Non-relevant
//     status lines only reach state/.status-internal.log.
//   - A herdr working->idle (turn-end) is not a wake by itself; it only
//     coalesces with a relevant status within GRACE_MS / FM_SIGNAL_GRACE
//     (default 30s, see readTunables() below).
//   - Stale backstop: on turn-end the driver arms staleMs /
//     FM_STALE_ESCALATE_SECS (default 240s, see readTunables() below);
//     firing directs firstmate to peek the pane (sbin/fm peek). Skipped
//     for kind=secondmate panes (an idle secondmate runs its own
//     supervision) and for ship tasks parked on a green PR (pr= set and a
//     terminal done: PR / PR-ready status line); those stay covered by the
//     merge check.sh and the status stream instead.
//   - Autonomous-loop incidents (notification spam, 429s, repeated blocked
//     wakes, cost growth): see docs/runbooks/autonomous-loop-incident-triage.md.
//   - Lean-loop reasoning discipline (fork self-contained side-work to a
//     disposable subagent, or route domain work to a secondmate, rather than
//     burning firstmate's own context on it) is a firstmate reasoning habit,
//     not a mechanism this extension implements; it is noted here only
//     because it was grouped with the incident-triage pointer in AGENTS.md's
//     former supervision-protocol prose. See AGENTS.md's thinking and
//     execution discipline section for the rule itself.
//
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
	secondmateIdleMs: number; // FM_SECONDMATE_IDLE_SECS: shared working->idle completion backstop (default 20s)
	blockedDebounceMs: number; // FM_BLOCKED_DEBOUNCE_SECS: per-pane ship/scout blocked-wake debounce (default 120s)
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
		blockedDebounceMs: envSec("FM_BLOCKED_DEBOUNCE_SECS", 120),
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
	dependency?: DependencyEdge;
}

interface MetaFields {
	pane?: string;
	kind: Crewmate["kind"];
	pr?: string;
	worker?: string;
	harness?: string;
	agent_identity?: string;
	dependency?: DependencyEdge;
}

export interface ActivationManifestEntry {
	path: string;
	sha256: string;
}

export interface ActivationReceipt {
	schema: "firstmate.activation-receipt/v1";
	session_id?: string;
	session_path?: string;
	pane_id: string;
	started_at: string;
	manifest_sha256: string;
	manifest: ActivationManifestEntry[];
	source_revision?: string;
	required_probe_result?: unknown;
}

interface ActivationIdentity {
	session_id?: string;
	session_path?: string;
}

const ACTIVATION_RECEIPT_NAME = "activation-receipt.json";

function sessionIdentity(ctx: ExtensionContext): ActivationIdentity {
	const manager = ctx.sessionManager;
	const id = manager?.getSessionId?.();
	const path = manager?.getSessionFile?.();
	return {
		session_id: typeof id === "string" && id ? id : undefined,
		session_path: typeof path === "string" && path ? path : undefined,
	};
}

function sameIdentity(a: ActivationIdentity, b: ActivationIdentity): boolean {
	return Boolean(
		(a.session_id && b.session_id && a.session_id === b.session_id) ||
		(a.session_path && b.session_path && a.session_path === b.session_path),
	);
}

async function collectExtensionPaths(root: string, relative: string, paths: string[], visited = new Set<string>()): Promise<void> {
	const directory = join(root, relative);
	const canonical = await realpath(directory);
	if (visited.has(canonical)) return;
	visited.add(canonical);
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = `${relative}/${entry.name}`;
		const target = await stat(join(root, path));
		if (target.isDirectory()) await collectExtensionPaths(root, path, paths, visited);
		else paths.push(path);
	}
}

async function loadOnceManifest(ctx: ExtensionContext, sourceRoot?: string, registryRoot?: string): Promise<ActivationManifestEntry[]> {
	let root = sourceRoot || process.env.FM_ROOT_OVERRIDE || process.env.FM_ROOT || join(import.meta.dir, "../..");
	let canonicalRegistryRoot = registryRoot || root;
	try {
		root = await realpath(root);
	} catch {
		// An unavailable source tree remains non-green through its incomplete manifest.
	}
	try {
		canonicalRegistryRoot = await realpath(canonicalRegistryRoot);
	} catch {
		// A missing canonical registry is handled as a failed capability lookup.
	}
	const paths = ["AGENTS.md"];
	try {
		const registry = await stat(join(canonicalRegistryRoot, ".omp", "fleet-capabilities.json"));
		if (registry.isFile()) paths.push(".omp/fleet-capabilities.json");
	} catch {
		// Missing registry is handled as a failed capability lookup.
	}
	try {
		await collectExtensionPaths(root, ".omp/extensions", paths);
	} catch {
		// Never emit an AGENTS-only receipt when the extension tree is unknown.
		return [];
	}
	paths.sort();
	const entries: ActivationManifestEntry[] = [];
	for (const path of paths) {
		try {
			const readRoot = path === ".omp/fleet-capabilities.json" ? canonicalRegistryRoot : root;
			const bytes = await readFile(join(readRoot, path));
			entries.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
		} catch {
			// Omit unreadable sources; the resulting manifest remains non-matching.
		}
	}
	if (!entries.some((entry) => entry.path === ".omp/extensions/fm-supervisor.ts")) return [];
	return entries;
}

function manifestDigest(entries: ActivationManifestEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.sha256);
		hash.update("\0");
	}
	return hash.digest("hex");
}
async function currentPaneId(pi: ExtensionAPI): Promise<string | undefined> {
	try {
		const result = await pi.exec("herdr", ["pane", "current"], { timeout: 5_000 });
		const parsed: unknown = JSON.parse(result.stdout);
		const root = asRecord(parsed);
		const resultRecord = asRecord(root?.result);
		const pane = asRecord(resultRecord?.pane);
		const livePane = asString(pane?.pane_id);
		if (livePane) return livePane;
	} catch {
		// Fall back to the process hint only when the live query is unavailable.
	}
	return process.env.HERDR_PANE_ID || process.env.FM_HERDR_PANE_ID || undefined;
}

function activationReceiptPath(ctx: ExtensionContext): string {
	const statePath = process.env.FM_STATE_OVERRIDE?.trim() || join(process.env.FM_HOME || ctx.cwd, "state");
	return join(statePath, ACTIVATION_RECEIPT_NAME);
}

async function writeActivationReceipt(sup: Supervisor): Promise<void> {
	const identity = sessionIdentity(sup.ctx);
	const paneId = await currentPaneId(sup.pi);
	if (!paneId || (!identity.session_id && !identity.session_path)) {
		logWarn(sup, "fm-supervisor: activation receipt unavailable (missing pane or session identity)");
		return;
	}
	const operationalHome = process.env.FM_HOME || sup.ctx.cwd;
	const sourceHome = process.env.FM_FLEET_SOURCE_HOME || process.env.FM_ROOT_OVERRIDE || process.env.FM_ROOT || sourceRootForHome(operationalHome) || operationalHome;
	const manifest = await loadOnceManifest(sup.ctx, operationalHome, sourceHome);
	const source = readSourceRevision(sourceHome);
	const capability = capabilityForHome(readCapabilityRegistry(sourceHome).registry, operationalHome);
	const observedProbe = { activation: manifest.length > 0 ? "ok" : "unknown" };
	const receipt: ActivationReceipt = {
		schema: "firstmate.activation-receipt/v1",
		...identity,
		pane_id: paneId,
		started_at: new Date().toISOString(),
		manifest_sha256: manifestDigest(manifest),
		manifest,
		...(source.revision ? { source_revision: source.revision } : {}),
		...(capability?.requiredProbe !== undefined ? { required_probe_result: observedProbe } : {}),
	};
	const path = activationReceiptPath(sup.ctx);
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(tmp, path);
		sup.activationReceiptPath = path;
		sup.activationIdentity = identity;
	} catch (err) {
		try { await unlink(tmp); } catch {}
		logWarn(sup, `fm-supervisor: activation receipt write failed: ${String(err)}`);
	}
}

async function removeMatchingActivationReceipt(sup: Supervisor): Promise<void> {
	const path = sup.activationReceiptPath || activationReceiptPath(sup.ctx);
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		const record = asRecord(parsed);
		if (!record) return;
		const receiptIdentity: ActivationIdentity = {
			session_id: asString(record.session_id),
			session_path: asString(record.session_path),
		};
		const current = sup.activationIdentity || sessionIdentity(sup.ctx);
		if (sameIdentity(receiptIdentity, current)) await unlink(path);
	} catch {
		// Missing, malformed, or inaccessible receipts are already non-green.
	}
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
	lastBlockedWakeMs: Map<string, number>; // pane -> last blocked-wake ts (ship/scout debounce)
	pendingEvents: FleetEvent[];
	pendingStale: string[];
	deferredWakes: Array<{
		content: string;
		notifyOs: boolean;
		requiredMetaTasks: string[];
		afkBatch: boolean;
	}>;
	activeTurn: boolean;
	statusWatchers: Set<string>;
	statusRefreshTimer?: Timer;
	flushTimer?: Timer;
	checkTimer?: Timer;
	lastStatusSeen: Map<string, string>; // task -> last processed status line
	dependencyReceipts?: Map<string, string>;
	internalLogWrites: number;
	activationReceiptPath?: string;
	activationIdentity?: ActivationIdentity;
}

// A typed view of one herdr socket push (external input narrowed via guards).
type HerdrPush = { kind: "status"; pane: string; status: HerdrStatus } | { kind: "gone"; pane: string };

let started = false;
let supervisor: Supervisor | undefined;

export default function fmSupervisor(pi: ExtensionAPI): void {
	pi.setLabel("Firstmate supervisor");

	pi.on("agent_start", () => {
		if (supervisor) supervisor.activeTurn = true;
	});
	pi.on("agent_end", () => {
		if (!supervisor) return;
		supervisor.activeTurn = false;
		flushDeferredWakes(supervisor);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (started) return; // one driver per session; never re-armed
		started = true;
		const sup = createSupervisor(pi, ctx);
		supervisor = sup;
		await writeActivationReceipt(sup);
		await startSupervision(sup);
	});

	pi.on("session_shutdown", async () => {
		if (supervisor) {
			await removeMatchingActivationReceipt(supervisor);
			stopSupervision(supervisor);
		}
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
		lastBlockedWakeMs: new Map(),
		staleTimers: new Map(),
		pendingEvents: [],
		pendingStale: [],
		deferredWakes: [],
		activeTurn: false,
		statusWatchers: new Set(),
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
	await seedStatuses(sup);
	await reconcileDependencyArtifacts(sup);
	openSocket(sup);
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
	for (const path of sup.statusWatchers) unwatchFile(path);
	sup.statusWatchers.clear();
	clearTimeout(sup.statusRefreshTimer);
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
		// state/self.meta records this firstmate's own pane identity for recovery
		// and labels; the supervisor must never treat its own pane as a crewmate
		// (it would fire idle/stale/completion wakes at its own resting turns).
		if (task === "self") continue;
		const meta = await parseMeta(join(sup.stateDir, f));
		if (!meta.pane) continue;
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
		// Seed newly discovered panes before replacing the subscription set so
		// reconnects and fleet refreshes cannot turn idle replays into edges.
		await seedStatuses(sup);
		subscribeAll(sup);
	}
}

async function parseMeta(path: string): Promise<MetaFields> {
	const meta: MetaFields = { kind: "ship" };
	try {
		const txt = await readFile(path, "utf8");
		meta.dependency = parseDependencyEdge(txt);
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
					if (value) meta.pr = value;
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
	if (push.kind === "gone") {
		applyHerdrPush(sup, push);
		return;
	}
	void (async () => {
		const reconciled = await reconciledPaneStatus(sup, push.pane);
		applyHerdrPush(sup, reconciled ? { ...push, status: reconciled } : push);
	})();
}

function applyHerdrPush(sup: Supervisor, push: HerdrPush): void {
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
		clearStaleTimer(sup, push.pane);
		// Secondmates self-manage and escalate material blockers through the peer
		// bus. Their transient blocked states must not wake the cap.
		if (crew.kind === "secondmate") return;
		const nowMs = Date.now();
		const lastBlocked = sup.lastBlockedWakeMs.get(push.pane) ?? 0;
		if (nowMs - lastBlocked < sup.tunables.blockedDebounceMs) return;
		sup.lastBlockedWakeMs.set(push.pane, nowMs);
		enqueueEvent(sup, {
			t: nowMs,
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
	if (prev === "working" && (crew.kind === "secondmate" || push.status === "idle")) {
		armCompletionTimer(sup, crew);
	} else if (crew.kind === "secondmate") {
		clearStaleTimer(sup, push.pane);
	} else {
		armStaleTimer(sup, crew);
	}
}

function dropPane(sup: Supervisor, pane: string): void {
	sup.crewByPane.delete(pane);
	sup.prevStatus.delete(pane);
	sup.lastBlockedWakeMs.delete(pane);
	clearStaleTimer(sup, pane);
}

async function seedStatuses(sup: Supervisor): Promise<void> {
	for (const pane of sup.crewByPane.keys()) {
		if (sup.prevStatus.has(pane)) continue;
		sup.prevStatus.set(pane, await herdrStatus(sup, pane));
	}
}

async function herdrStatus(sup: Supervisor, pane: string): Promise<HerdrStatus> {
	let herdr: HerdrStatus = "unknown";
	try {
		const res = await sup.pi.exec("herdr", ["agent", "get", pane], {
			timeout: sup.tunables.herdrGetTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		const m = res.stdout.match(/"agent_status":"([^"]*)"/);
		herdr = toHerdrStatus(m?.[1]);
	} catch {
		// Screen reconciliation below may still recover a useful state.
	}
	const reconciled = await reconciledPaneStatus(sup, pane);
	return reconciled ?? herdr;
}

// The screen-based reconciler is the operational fallback for the known OMP
// herdr status gap. Missing/unreadable screens return no override, preserving
// herdr's state rather than inventing idle.
async function reconciledPaneStatus(sup: Supervisor, pane: string): Promise<HerdrStatus | undefined> {
	const script = join(sup.ctx.cwd, "sbin", "fm");
	if (!existsSync(script)) return undefined;
	try {
		const res = await sup.pi.exec(script, ["reconcile-status", pane], {
			timeout: sup.tunables.busyReadTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		const state = res.stdout.trim();
		return state === "working" || state === "idle" ? state : undefined;
	} catch {
		return undefined;
	}
}

// Startup-only diagnostic (NON-WAKING). An OMP pane whose authoritative agent
// identity is still `omp` but seeds as `unknown` usually means an accidental
// `herdr agent rename` (which pins agent_status to unknown) or a missing OMP
// herdr status integration. Surfaced through the logger only; never a cap
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
	if (!(await paneReachable(sup, crew.pane))) {
		dropPane(sup, crew.pane);
		return;
	}
	if (await paneShowsBusyBanner(sup, crew.pane)) {
		armStaleTimer(sup, crew);
		return;
	}
	if (await isAwaitingMerge(sup, crew)) return; // parked on a green PR: by design
	const last = await lastStatusLine(sup, crew.task);
	const mins = Math.max(1, Math.round((Date.now() - idleStart) / 60_000));
	if (last && captainRelevantStatusLine(last)) return; // already reported something cap-worthy
	const lineage = crew.worker ? ` ${crew.worker}` : "";
	enqueueStale(
		sup,
		`[wake] ${crew.task}${lineage} ${crew.pane} - STALE ${mins}m idle, no status \u00b7 action: peek pane`,
		Date.now(),
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

// ------------------------- completion backstop -------------------------

function armCompletionTimer(sup: Supervisor, crew: Crewmate): void {
	clearStaleTimer(sup, crew.pane);
	const timer = setTimeout(() => {
		sup.staleTimers.delete(crew.pane);
		void fireCompletion(sup, crew);
	}, sup.tunables.secondmateIdleMs);
	sup.staleTimers.set(crew.pane, timer);
}

async function fireCompletion(sup: Supervisor, crew: Crewmate): Promise<void> {
	if (sup.abort.signal.aborted) return;
	const cur = sup.prevStatus.get(crew.pane);
	if (cur !== "idle" && cur !== "unknown" && cur !== "done") return;
	if (!(await paneReachable(sup, crew.pane))) {
		dropPane(sup, crew.pane);
		return;
	}
	if (await paneShowsBusyBanner(sup, crew.pane)) {
		armCompletionTimer(sup, crew);
		return;
	}
	const last = await lastStatusLine(sup, crew.task);
	if (last && captainRelevantStatusLine(last)) return;
	const lineage = crew.worker ? ` ${crew.worker}` : "";
	const idleState =
		crew.kind === "secondmate" ? "secondmate idle after routed work" : "crewmate idle after task";
	enqueueStale(
		sup,
		`[wake] ${crew.task}${lineage} ${crew.pane} - ${idleState}, no status \u00b7 action: review + close out`,
		Date.now(),
	);
}

// ---------------------- durable-identity pane resolution ---------------------

async function resolveLivePane(sup: Supervisor, task: string, recordedPane: string): Promise<string> {
	try {
		const res = await sup.pi.exec("herdr", ["agent", "get", task], {
			timeout: sup.tunables.herdrGetTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		const live = res.stdout.match(/"pane_id":"([^"]*)"/)?.[1];
		if (!live) return recordedPane;
		if (live !== recordedPane) await writeMetaPane(sup, task, live);
		return live;
	} catch {
		return recordedPane;
	}
}

async function writeMetaPane(sup: Supervisor, task: string, pane: string): Promise<void> {
	const path = join(sup.stateDir, `${task}.meta`);
	try {
		const txt = await readFile(path, "utf8");
		const lines = txt.split("\n");
		let found = false;
		const next = lines.map((line) => {
			if (!line.startsWith("pane=")) return line;
			found = true;
			return `pane=${pane}`;
		});
		if (!found) next.push(`pane=${pane}`);
		await writeFile(path, next.join("\n"));
	} catch {
		// Best-effort metadata refresh. The recorded pane remains a safe fallback.
	}
}

// ------------------------ busy-banner corroboration -------------------------

async function paneShowsBusyBanner(sup: Supervisor, pane: string): Promise<boolean> {
	let text: string;
	try {
		const res = await sup.pi.exec("herdr", ["pane", "read", pane, "--lines", "12", "--source", "visible"], {
			timeout: sup.tunables.busyReadTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		});
		text = res.stdout;
	} catch {
		return false;
	}
	// omp renders a working turn as a braille spinner glyph plus an interrupt
	// hint; other harnesses use Working/Thinking text. The braille set is the
	// decisive omp signal because its socket status report to herdr is
	// unreliable (drops leave agent_status stuck at idle mid-turn), so without
	// this the completion/stale backstops fire false wakes on a live mate.
	const spinner = "[\u2801-\u28ff]"; // any non-blank braille cell = an omp spinner frame
	const source =
		process.env.FM_BUSY_REGEX ??
		["esc (to )?interrupt", "⟨esc⟩", "Working(\\.\\.\\.|…)?", "Thinking", spinner].join("|");
	let busy: RegExp;
	try {
		busy = new RegExp(source, "i");
	} catch {
		busy = /esc (to )?interrupt|⟨esc⟩|Working(\.\.\.|…)?|Thinking|[\u2801-\u28ff]/i;
	}
	return text
		.split("\n")
		.map((line) => line.replace(/[\u2502\u2503|\u2500\u2501\u256d\u256e\u2570\u256f\u250c\u2510\u2514\u2518]/g, "").trim())
		.filter((line) => line.length > 0)
		.some((line) => busy.test(line));
}

// ---------------------------- status files ----------------------------

function startWatch(sup: Supervisor): void {
	const refreshStatusWatchers = async (): Promise<void> => {
		if (sup.abort.signal.aborted) return;
		await refreshFleet(sup);
		try {
			const files = (await readdir(sup.stateDir)).filter((f) => f.endsWith(".status"));
			for (const file of files) {
				const path = join(sup.stateDir, file);
				if (sup.statusWatchers.has(path)) continue;
				sup.statusWatchers.add(path);
				watchFile(path, { interval: 100 }, () => void onStatusFileChange(sup, file));
			}
		} catch {
			// State directory may not exist yet; the next refresh will retry.
		}
		if (!sup.abort.signal.aborted) {
			sup.statusRefreshTimer = setTimeout(() => void refreshStatusWatchers(), 500);
		}
	};
	void refreshStatusWatchers();
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
		if (crew?.dependency && !validateBlockedReport(last).valid) {
			await appendInternalLog(sup, task, `rejected malformed blocked report: ${last}`);
			return;
		}
		clearStaleTimer(sup, pane);
		enqueueEvent(sup, {
			t: Date.now(),
			kind: "status",
			pane,
			task,
			...(crew?.worker ? { worker: crew.worker } : {}),
			...(crew?.dependency ? { dependency: crew.dependency } : {}),
			status_line: last,
			relevant: true,
		});
	} else {
		await appendInternalLog(sup, task, last);
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
		const metaPath = join(sup.stateDir, `${task}.meta`);
		// A check script can outlive teardown or a manually removed task meta.
		// Never poll an orphaned check: its output must not wake the cap.
		if (!existsSync(metaPath)) continue;
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
		if (out.length > 0 && existsSync(metaPath)) {
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

function enqueueStale(sup: Supervisor, digest: string, enqueueMs: number): void {
	const content = digest.replace(/^\[wake\]/, `[wake ${formatWakeTimestamp(enqueueMs)}]`);
	sup.pendingStale.push(content);
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
	const events = sup.pendingEvents.splice(0).filter(
		(e) => e.kind !== "check" || existsSync(join(sup.stateDir, `${e.task}.meta`)),
	);
	const stale = sup.pendingStale.splice(0);
	if (events.length === 0 && stale.length === 0) return;
	const afk = isAfkActive(sup);
	const { digests } = classifyAndDigest(events, { afk });
	const checkTasks = [...new Set(events.filter((e) => e.kind === "check").map((e) => e.task))];
	const requiredMetaTasksFor = (content: string): string[] =>
		checkTasks.filter((task) => content.includes(`] ${task} `) || content.includes(`- ${task} `));
	const all = [...digests, ...stale];
	if (all.length > 0) {
		if (afk) {
			const content = all.length === 1 ? (all[0] ?? "") : all.join("\n");
			inject(sup, content, digests.length > 0, requiredMetaTasksFor(content), true);
		} else {
			for (const digest of digests) inject(sup, digest, true, requiredMetaTasksFor(digest));
			for (const staleDigest of stale) inject(sup, staleDigest, false);
		}
	}
	await deliverDependencyWakes(sup, prioritizeDependencyEdges(
		events.flatMap((event) => event.dependency ? [event.dependency] : []),
	), events, true, "record");
}

async function reconcileDependencyArtifacts(sup: Supervisor): Promise<void> {
	await pruneDependencyReceipts(sup);
	const events: FleetEvent[] = [];
	for (const crew of sup.crewByPane.values()) {
		if (!crew.dependency) continue;
		const status = await lastStatusLine(sup, crew.task);
		if (!status || !/\b(done|merged|ready in branch|pr ready|checks green):?/i.test(status)) continue;
		events.push({
			t: Date.now(),
			kind: "status",
			pane: crew.pane,
			task: crew.task,
			status_line: status,
			dependency: crew.dependency,
			relevant: true,
		});
	}
	await deliverDependencyWakes(sup, prioritizeDependencyEdges(events.flatMap((event) => event.dependency ? [event.dependency] : [])), events, false, "suppress-and-record");
}

type DependencyReceiptMode = "record" | "suppress-and-record";
type DependencyReceiptStore = Map<string, string>;
type DependencyReceiptRecord = { key: string; producer: string };

function dependencyReceiptPath(sup: Supervisor): string {
	return join(sup.stateDir, ".dependency-handoffs.json");
}

async function dependencyReceiptSet(sup: Supervisor): Promise<DependencyReceiptStore> {
	if (sup.dependencyReceipts) return sup.dependencyReceipts;
	try {
		const parsed = JSON.parse(await readFile(dependencyReceiptPath(sup), "utf8"));
		const entries = Array.isArray(parsed) ? parsed.flatMap((value): DependencyReceiptRecord[] => {
			if (typeof value === "string") return [{ key: value, producer: "" }];
			if (value && typeof value === "object") {
				const record = value as Record<string, unknown>;
				if (typeof record.key === "string" && typeof record.producer === "string") return [{ key: record.key, producer: record.producer }];
			}
			return [];
		}) : [];
		sup.dependencyReceipts = new Map(entries.map((entry) => [entry.key, entry.producer]));
	} catch {
		sup.dependencyReceipts = new Map();
	}
	return sup.dependencyReceipts;
}

async function writeDependencyReceiptFile(path: string, receipts: DependencyReceiptStore, onError?: (message: string) => void): Promise<boolean> {
	const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	try {
		const records = [...receipts].map(([key, producer]) => ({ key, producer })).sort((left, right) => left.key.localeCompare(right.key));
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, `${JSON.stringify(records)}\n`);
		await rename(tmp, path);
		return true;
	} catch (error) {
		try {
			await unlink(tmp);
		} catch {
			// best-effort cleanup
		}
		onError?.(`fm-supervisor: dependency receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export async function writeDependencyReceiptFileForTest(path: string, records: readonly DependencyReceiptRecord[]): Promise<boolean> {
	return await writeDependencyReceiptFile(path, new Map(records.map((record) => [record.key, record.producer])));
}

async function persistDependencyReceipts(sup: Supervisor, receipts: DependencyReceiptStore): Promise<boolean> {
	const path = dependencyReceiptPath(sup);
	return await writeDependencyReceiptFile(path, receipts, (message) => logWarn(sup, message));
}

async function pruneDependencyReceipts(sup: Supervisor): Promise<void> {
	const receipts = await dependencyReceiptSet(sup);
	const liveProducers = new Set([...sup.crewByPane.values()].map((crew) => crew.task));
	let changed = false;
	for (const [key, producer] of receipts) {
		if (!producer || liveProducers.has(producer)) continue;
		receipts.delete(key);
		changed = true;
	}
	if (changed) await persistDependencyReceipts(sup, receipts);
}

function dependencyReceiptKey(edge: DependencyEdge, terminalState: string, observedSha: string): string {
	return createHash("sha256").update(JSON.stringify({
		producer: edge.producer,
		consumers: [...edge.consumers].sort(),
		artifactPath: edge.artifactPath,
		expectedSha: edge.artifactSha,
		observedSha,
		wakeAction: edge.wakeAction,
		criticalPath: edge.criticalPath,
		terminalState,
	})).digest("hex");
}

async function deliverDependencyWakes(sup: Supervisor, edges: readonly DependencyEdge[], events: readonly FleetEvent[], parentAlreadyDelivered: boolean, receiptMode: DependencyReceiptMode): Promise<void> {
	const seen = new Set<string>();
	const receipts = await dependencyReceiptSet(sup);
	let receiptsChanged = false;
	for (const edge of edges) {
		const terminalState = events.find((event) => event.task === edge.producer && event.kind === "status" && /\b(done|merged|ready in branch|pr ready|checks green):?/i.test(event.status_line ?? ""))?.status_line ?? "";
		if (!terminalState || seen.has(edge.producer)) continue;
		seen.add(edge.producer);
		let observedSha = "";
		try {
			const bytes = await readFile(edge.artifactPath);
			observedSha = createHash("sha256").update(bytes).digest("hex");
		} catch {
			observedSha = "";
		}
		const matches = observedSha.length > 0 && observedSha === edge.artifactSha;
		const receiptKey = dependencyReceiptKey(edge, terminalState, observedSha);
		if (receiptMode === "suppress-and-record" && receipts.has(receiptKey)) continue;
		let failed = false;
		let delivered = false;
		for (const delivery of dependencyDeliveries(edge, matches, matches)) {
			const message = `dependency ${edge.producer} completed; artifact ${edge.artifactPath} exists sha=${edge.artifactSha}; action: ${delivery.action}`;
			if (delivery.target === "parent") {
				if (!parentAlreadyDelivered) inject(sup, message, true);
				delivered = true;
				continue;
			}
			if (!delivery.consumer) continue;
			try {
				await sup.pi.exec("bash", [join(sup.ctx.cwd, "sbin/fm-send.sh"), `fm-${delivery.consumer}`, message], {
					timeout: sup.tunables.busyReadTimeoutMs,
					signal: sup.abort.signal,
					cwd: sup.ctx.cwd,
				});
				delivered = true;
			} catch (err) {
				failed = true;
				logWarn(sup, `fm-supervisor: dependency wake failed for ${delivery.consumer}: ${String(err)}`);
			}
		}
		if (delivered && !failed) {
			receipts.set(receiptKey, edge.producer);
			receiptsChanged = true;
		}
	}
	if (receiptsChanged) await persistDependencyReceipts(sup, receipts);
}

export const FM_WAKE_DELIVERY_OPTIONS = { deliverAs: "nextTurn", triggerTurn: true } as const;

function inject(
	sup: Supervisor,
	content: string,
	notifyOs = false,
	requiredMetaTasks: string[] = [],
	afkBatch = false,
): void {
	if (sup.activeTurn) {
		// Never ask OMP to schedule a continuation inside the supervisor's own
		// active turn. Keep the message hidden and deliver it at agent_end.
		sup.deferredWakes.push({ content, notifyOs, requiredMetaTasks, afkBatch });
		return;
	}
	deliverWake(sup, content, notifyOs);
}

function deliverWake(sup: Supervisor, content: string, notifyOs: boolean): void {
	try {
		sup.pi.sendMessage(
			{ customType: "fm-wake", content, display: true },
			FM_WAKE_DELIVERY_OPTIONS,
		);
	} catch (err) {
		logWarn(sup, `fm-supervisor: inject failed: ${String(err)}`);

		return;
	}
	if (notifyOs) notifyCaptainOs(sup, content);
}

function filterAfkBatch(content: string, missingTasks: string[]): string | undefined {
	if (missingTasks.length === 0) return content;
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const headerMatch = header.match(/^\[wake x\d+ ([^\]]+)\] afk batch - \d+ relevant event\(s\):$/);
	if (!headerMatch) return undefined;
	const keptLines = lines.slice(1).filter(
		(line) => !line.startsWith("  - ") || !missingTasks.some((task) => line.startsWith(`  - ${task} `)),
	);
	const entryCount = keptLines.filter((line) => line.startsWith("  - ")).length;
	if (entryCount === 0) {
		const tail = keptLines.filter((line) => !line.startsWith("  - "));
		return tail.length > 0 ? tail.join("\n") : undefined;
	}
	const nextHeader = `[wake x${entryCount} ${headerMatch[1]}] afk batch - ${entryCount} relevant event(s):`;
	return [nextHeader, ...keptLines].join("\n");
}

function flushDeferredWakes(sup: Supervisor): void {
	if (sup.activeTurn || sup.deferredWakes.length === 0) return;
	const pending = sup.deferredWakes.splice(0);
	for (const wake of pending) {
		// A check digest can be deferred across an active turn; teardown may remove
		// its meta before agent_end, so discard it instead of delivering stale work.
		const missingTasks = wake.requiredMetaTasks.filter(
			(task) => !existsSync(join(sup.stateDir, `${task}.meta`)),
		);
		if (missingTasks.length > 0) {
			if (!wake.afkBatch) continue;
			const filtered = filterAfkBatch(wake.content, missingTasks);
			if (filtered === undefined) continue;
			deliverWake(sup, filtered, wake.notifyOs);
			continue;
		}
		deliverWake(sup, wake.content, wake.notifyOs);
	}
}

function notifyCaptainOs(sup: Supervisor, content: string): void {
	if (process.env.FM_CAPTAIN_OS_NOTIFY === "0" || process.platform !== "darwin") return;
	const home = process.env.FM_HOME ?? sup.ctx.cwd;
	if (existsSync(join(home, ".fm-secondmate-home"))) return;
	const firstLine = content.replace(/^\[wake[^\]]*\]\s*/, "").split("\n")[0] ?? "";
	const safe = firstLine.slice(0, 220).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `display notification "${safe}" with title "firstmate" sound name "Ping"`;
	void Promise.resolve(
		sup.pi.exec("osascript", ["-e", script], {
			timeout: sup.tunables.herdrGetTimeoutMs,
			signal: sup.abort.signal,
			cwd: sup.ctx.cwd,
		}),
	).catch(() => {});
}
