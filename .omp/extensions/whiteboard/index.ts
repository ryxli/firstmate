// whiteboard - board-as-conversation loop.
//
// The board is a shared, free-form markdown document that is the
// primary conversational channel between the cap and the agent.
// Newest entries go at the bottom; an optional ## Working section holds
// the shared next-action queue. Structure is convention only, never parsed.
//
// The cap edits the board in nvim; the agent reads the diff and replies by
// editing the board via whiteboard_write. Loop state is session-local: enable it
// in each named agent session; it is not persisted across sessions.
//
// /wb               view the board
// /wb loop          toggle the board-conversation loop on/off
// /wb tick          run one board turn now (manual)
// /wb settings      open the settings file
// /wb status        loop state
// /wb help          verb list
// ctrl+shift+w      open the board
// @ts-nocheck
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as board from "./board.ts";
import { formatMarkdown } from "./format.ts";
import { showBoard } from "./panel.ts";
import { openBoardEditor, resolveEditor } from "./editor.ts";
import {
	defaultScope,
	resolveCurrentIdentity,
	identityBoardPath,
	type ResolvedBoardScope,
} from "./config.ts";

// Wall-clock. Overridable in tests.
let _now = () => Date.now();
export function _setNow(fn) { _now = fn; }
export function _resetNow() { _now = () => Date.now(); }

// Watcher debounce. Overridable in tests (real default 100ms).
let _watchDebounceMs = 100;
export function _setWatchDebounce(ms: number) { _watchDebounceMs = ms; }
export function _resetWatchDebounce() { _watchDebounceMs = 100; }
// Watch factory. Overridable in tests so platform-specific event sequences stay deterministic.
let _fsWatch = fsWatch;
export function _setFsWatch(fn) { _fsWatch = fn; }
export function _resetFsWatch() { _fsWatch = fsWatch; }

// Board skeleton seeded only when the board is empty (/wb loop); free-form, newest entries at the bottom.
// Convention only - never parsed or validated beyond the heading presence check.
const SKELETON =
	"# Whiteboard\n\n_Free-form board - add newest entries at the bottom; the agent removes lines once they are acked._\n";

const HELP_TEXT = [
	"/wb                   show the current board",
	"/wb open              show the current board",
	"/wb view              show the current board",
	"/wb edit              open board in $EDITOR/nvim",
	"/wb -e                open board in $EDITOR/nvim",
	"/wb loop              toggle the board-conversation loop on/off",
	"/wb tick              run one board turn now (manual, one-shot)",
	"/wb tick now          interrupt the current turn with one coalesced board tick",
	"/wb settings          open the settings file in nvim",
	"/wb status            loop on/off, autonomy, consecutive-turn count, last outcome",
	"/wb rm <line[-line]>  remove board line(s)",
	"/wb rr <line[-line]> <text>  replace board line(s) (use \\n for new lines)",
	"/wb rs <heading> :: <text>   replace a markdown section (use \\n for new lines)",
	"/wb help              this list",
].join("\n");

// LoopRuntime is keyed by identity.home. Process-memory only; never persisted.
interface LoopRuntime {
	enabled:           boolean;
	queued:            boolean;
	timer?:            unknown;
	statusTimer?:      unknown;
	timerDueAt?:       number;
	watcher?:          FSWatcher;
	watchDebounce?:    unknown;
	identity:          { home: string; id: string; name: string; role: string };
	boardPath:         string;
	pendingTickId?:    string;
	activeTickId?:     string;
	lastTickStart?:    number;
	lastTickQueuedAt?: number;  // queue time of the previous tick, for the since-last-tick cadence delta
	lastUserEditAt?:   number;  // wall-clock of the last human (non-self) board edit, for the presence signal
	checkpointOutcome: string | null;
	checkpointSummary: string | null;
	lastIntervalMs?:   number;
	lastOutcome?:      string;
	lastSummary?:      string;
	tickCount:         number;
	consecutiveTurns:  number;  // self-continued turns since last cap edit
	autonomy:          boolean;
	maxTurns:          number;
	idleStreak:       number;  // consecutive self-continued ticks with no board change
	lastBoardContent?: string; // board snapshot at tick dispatch for productivity detection
	lastTrigger?:      string;  // queue reason of the last tick (metrics)
	lastGapMs?:        number;  // since-last-tick gap of the last tick (metrics)
	lastWasFull?:      boolean; // last directive full vs compact (metrics)
	lastEditGapMs?:    number;  // since-last-edit at the last tick (metrics)
	selfWriteContent?: string; // one-shot content marker for suppressing agent-originated fsWatch events
}

function formatInterval(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
	return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

// Local wall-clock label shared by the tick directive header and the footer badge,
// so both surfaces always agree on "what time was the latest tick queued".
function formatClock(ms: number): string {
	return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function notify(ctx, message: string, level = "info"): void {
	if (ctx?.hasUI === false) return;
	ctx?.ui?.notify?.(message, level);
}

// Parse $FM_HOME/config/whiteboard-settings (key=value). Unknown keys ignored.
function loadSettings(settingsPath: string): { autonomy: boolean; maxTurns: number } {
	const result = { autonomy: true, maxTurns: 12 };
	try {
		if (!existsSync(settingsPath)) return result;
		for (const line of readFileSync(settingsPath, "utf8").split("\n")) {
			const eq = line.indexOf("=");
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			const val = line.slice(eq + 1).trim();
			if (key === "autonomy") result.autonomy = val === "on";
			if (key === "max_turns") {
				const n = parseInt(val, 10);
				if (!isNaN(n) && n > 0) result.maxTurns = n;
			}
		}
	} catch { /* use defaults */ }
	return result;
}

// One-line open-work indicator for /wb status.
function openWorkIndicator(boardPath: string): string {
	try {
		const content = board.read(boardPath);
		const idx = content.indexOf("\n## Working");
		if (idx === -1) return "open work: no Working section";
		const after = content.slice(idx + 1);
		const bodyStart = (after.indexOf("\n") ?? -1) + 1;
		const bodyText = after.slice(bodyStart);
		// Next heading starts a sibling section - trim to it.
		const nextHeading = bodyText.match(/^#{1,6}\s/m);
		const body = nextHeading ? bodyText.slice(0, bodyText.indexOf(nextHeading[0])) : bodyText;
		const hasWork = body.split("\n").some(l => {
			const t = l.trim();
			return t && !t.startsWith("_") && !t.startsWith("#");
		});
		return hasWork ? "open work: yes" : "open work: none";
	} catch {
		return "open work: unknown";
	}
}

// Adaptive loop backoff. The next tick is delayed minMs, doubling per consecutive
// idle tick, capped at maxMs. Replaces the old zero-delay re-queue that hot-spun
// the loop. idleStreak resets to 0 whenever a tick changes the board, so an
// active loop stays responsive while an idle one backs off to the cap.
export function loopBackoffMs(idleStreak: number, minMs: number, maxMs: number): number {
	const streak = Number.isFinite(idleStreak) && idleStreak > 0 ? Math.floor(idleStreak) : 0;
	const scaled = minMs * 2 ** Math.min(streak, 20);
	return Math.min(maxMs, Math.max(minMs, scaled));
}

// Decode the backslash escapes a cap can type in a single-line slash arg into
// the characters they name: `\n` -> newline, `\t` -> tab, `\\` -> backslash,
// `\"` -> quote. Everything else is left verbatim. This is the ONLY place slash
// text is un-escaped; agent tools receive real text through JSON and never route
// through here. A single deterministic pass - never JSON.parse, whose backslash
// round-tripping is exactly what left `\n` a literal two-char sequence before.
export function decodeEscapes(text: string): string {
	return text.replace(/\\([\\nt"])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

// Parse a 1-based line spec: `N` (single line) or `N-M` (inclusive range).
function parseRangeSpec(input: string): { from: number; to: number } | null {
	const m = input.trim().match(/^(\d+)(?:-(\d+))?$/);
	if (!m) return null;
	const from = Number(m[1]);
	const to = m[2] === undefined ? from : Number(m[2]);
	return { from, to };
}

export default function whiteboard(pi: ExtensionAPI) {
	pi.setLabel?.("whiteboard");
	const z = pi.zod;
	const lastReads = new Map<string, string>();
	const loops = new Map<string, LoopRuntime>();
	const loopMinMs = Number(process.env.WB_LOOP_MIN_MS) || 15000;
	const loopMaxMs = Number(process.env.WB_LOOP_MAX_MS) || 300000;
	let statusUi: { setStatus?: (key: string, text: string | undefined) => void } | undefined;  // footer status handle captured from a command ctx (undefined in print/RPC)
	const loopStatusDetail = (runtime: LoopRuntime): string => {
		if (!runtime.enabled) return "disabled";
		if (runtime.watchDebounce !== undefined) return "edit";
		if (runtime.activeTickId !== undefined) return "running";
		if (runtime.pendingTickId !== undefined || runtime.queued) return "queued";
		if (runtime.timerDueAt !== undefined) {
			return `${Math.max(0, Math.ceil((runtime.timerDueAt - _now()) / 1000))}s`;
		}
		return "waiting";
	};
	const setLoopStatus = (runtime: LoopRuntime): void => {
		try {
			if (!statusUi?.setStatus) return;
			if (!runtime.enabled) { statusUi.setStatus("wb-loop", undefined); return; }
			const th = statusUi.theme;
			const label = `WB ${runtime.identity.id}`;
			// The clock is the queue time of the latest tick (stable across countdown refreshes;
			// it only advances when a new tick is actually queued), formatted the same way as the
			// tick directive header so the two surfaces never disagree.
			const clock = runtime.lastTickQueuedAt !== undefined ? ` \u00b7 ${formatClock(runtime.lastTickQueuedAt)}` : "";
			const detail = ` \u00b7 ${loopStatusDetail(runtime)}${clock}`;
			const text = th?.fg ? th.bold(th.fg("accent", label)) + th.fg("dim", detail) : label + detail;
			statusUi.setStatus("wb-loop", text);
		} catch { /* footer status is best-effort */ }
	};
	const clearStatusTimer = (runtime: LoopRuntime): void => {
		if (runtime.statusTimer !== undefined) {
			clearTimeout(runtime.statusTimer as never);
			runtime.statusTimer = undefined;
		}
	};
	const armCountdownStatus = (runtime: LoopRuntime): void => {
		clearStatusTimer(runtime);
		const refresh = () => {
			runtime.statusTimer = undefined;
			if (!runtime.enabled || runtime.timerDueAt === undefined || runtime.timer === undefined) {
				setLoopStatus(runtime);
				return;
			}
			setLoopStatus(runtime);
			const remaining = runtime.timerDueAt - _now();
			if (remaining <= 0) return;
			const nextBoundary = remaining - (Math.ceil(remaining / 1000) - 1) * 1000;
			runtime.statusTimer = setTimeout(refresh, Math.max(1, nextBoundary));
		};
		refresh();
	};
	const readBoardSafe = (boardPath: string): string | undefined => {
		try { return board.read(boardPath); } catch { return undefined; }
	};

	const clearLoopTimer = (runtime: LoopRuntime): void => {
		if (runtime.timer !== undefined) { clearTimeout(runtime.timer as never); runtime.timer = undefined; }
		runtime.timerDueAt = undefined;
		clearStatusTimer(runtime);
	};

	const loopRuntime = (identity): LoopRuntime => {
		let runtime = loops.get(identity.home);
		if (!runtime) {
			runtime = {
				enabled: false, queued: false,
				identity,
				boardPath: identityBoardPath(identity),
				checkpointOutcome: null, checkpointSummary: null,
				tickCount: 0, consecutiveTurns: 0, idleStreak: 0,
				autonomy: true, maxTurns: 12,
			};
			loops.set(identity.home, runtime);
		} else {
			runtime.identity = identity;
		}
		return runtime;
	};

	const buildDirective = (runtime: LoopRuntime, tickId: string, tickQueuedAt: number): string => {
		const ts = formatClock(tickQueuedAt);
		const { identity, boardPath, tickCount, consecutiveTurns, maxTurns, lastIntervalMs, lastOutcome, lastSummary, lastTickQueuedAt, lastUserEditAt } = runtime;
		// Header: identity + wall-clock, plus the gap since the previous tick (cadence) when one exists.
		// Clamp a negative delta (clock skew / sleep-resume) by omitting it rather than printing nonsense.
		const sinceLast = lastTickQueuedAt !== undefined ? tickQueuedAt - lastTickQueuedAt : undefined;
		runtime.lastGapMs = sinceLast;
		const clock = sinceLast !== undefined && sinceLast >= 0 ? `${ts} (+${formatInterval(sinceLast)} since last tick)` : ts;
		// Status fields render one per line so no single line wraps into an unreadable blob.
		const fields: string[] = [];
		// Presence: elapsed since the last human (non-self) board edit; grows while the cap is away, resets on their next edit.
		const editor = process.env.USER || "user";
		if (lastUserEditAt !== undefined && tickQueuedAt - lastUserEditAt >= 0) {
			const sinceEdit = tickQueuedAt - lastUserEditAt;
			const editAgo = sinceEdit < 2000 ? "just now" : `${formatInterval(sinceEdit)} ago`;
			fields.push(`${editor} edited: ${editAgo}`);
		}
		if (consecutiveTurns > 0) fields.push(`Consecutive: ${consecutiveTurns}/${maxTurns}`);
		if (lastIntervalMs !== undefined) fields.push(`Last turn: ${formatInterval(lastIntervalMs)} - ${lastOutcome ?? "?"}`);
		if (lastSummary) fields.push(`Last result: ${lastSummary}`);
		const boardLineCount = (readBoardSafe(boardPath) ?? "").split("\n").length;
		fields.push(`Board: ${boardPath} (${boardLineCount} lines)`);
		runtime.lastWasFull = false;
		const body = "Board tick: read the diff, do one next action, update the board, checkpoint.";
		return [
			`tick ${tickCount} \u00b7 Agent: ${identity.id} \u00b7 ${clock}`,
			...fields,
			"",
			body,
			"",
			`[wb-loop:${tickId}]`,
		].join("\n");
	};

	// Best-effort per-turn interaction-signal log (JSONL). One line per completed tick.
	const emitMetric = (runtime: LoopRuntime, outcome: string | null): void => {
		try {
			const content = readBoardSafe(runtime.boardPath);
			const rec = {
				t: new Date(_now()).toISOString(),
				agent: runtime.identity.id,
				tick: runtime.tickCount,
				trigger: runtime.lastTrigger ?? null,
				gap_ms: runtime.lastGapMs ?? null,
				turn_ms: runtime.lastIntervalMs ?? null,
				outcome: outcome ?? null,
				consecutive: runtime.consecutiveTurns,
				full: runtime.lastWasFull ?? null,
				edit_gap_ms: runtime.lastEditGapMs ?? null,
				board_bytes: content !== undefined ? Buffer.byteLength(content, "utf8") : null,
				board_lines: content !== undefined ? content.split("\n").length : null,
				board_changed: content !== undefined && runtime.lastBoardContent !== undefined ? content !== runtime.lastBoardContent : null,
			};
			const dir = join(runtime.identity.home, "state");
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, "whiteboard-metrics.jsonl"), JSON.stringify(rec) + "\n", "utf8");
		} catch { /* metrics are best-effort; never break the loop */ }
	};

	const queueLoopTick = (identity, ctx, reason = "tick", deliverAs: "nextTurn" | "steer" | "followUp" = "nextTurn"): boolean => {
		if (typeof pi.sendMessage !== "function") {
			notify(ctx, "loop: sendMessage unavailable in this harness", "warning");
			return false;
		}
		const runtime = loopRuntime(identity);
		// Only one not-yet-delivered tick may exist. A manual steer may interrupt an
		// active tick, but repeated commands coalesce behind that turn instead of
		// stacking multiple wb-loop messages for the next agent boundary.
		if (runtime.pendingTickId !== undefined || (runtime.queued && runtime.activeTickId === undefined)) {
			notify(ctx, deliverAs === "steer" ? "loop interrupt already queued" : "loop tick already queued");
			return true;
		}
		if (runtime.queued && deliverAs !== "steer") { notify(ctx, "loop tick already queued"); return true; }
		if (reason === "cap-edit") clearLoopTimer(runtime);
		const tickQueuedAt = _now();
		runtime.checkpointOutcome = null;
		runtime.checkpointSummary = null;
		runtime.tickCount += 1;
		const tickId = `${runtime.identity.id}:${runtime.tickCount}:${tickQueuedAt}`;
		runtime.pendingTickId = tickId;
		const directive = buildDirective(runtime, tickId, tickQueuedAt);
		runtime.lastTickQueuedAt = tickQueuedAt;
		runtime.lastTrigger = reason;
		runtime.lastEditGapMs = runtime.lastUserEditAt !== undefined ? tickQueuedAt - runtime.lastUserEditAt : undefined;
		const ts = formatClock(tickQueuedAt);
		runtime.queued = true;
		runtime.lastBoardContent = readBoardSafe(runtime.boardPath);
		pi.sendMessage({ customType: "wb-loop", content: directive, display: true }, { deliverAs, triggerTurn: true });
		notify(ctx, `loop ${reason} queued @ ${ts}`);
		setLoopStatus(runtime);
		return true;
	};

	const scheduleLoopTick = (runtime: LoopRuntime): void => {
		if (!runtime.enabled || runtime.queued || runtime.timer !== undefined) return;
		const delay = loopBackoffMs(runtime.idleStreak, loopMinMs, loopMaxMs);
		runtime.timerDueAt = _now() + delay;
		runtime.timer = setTimeout(() => {
			runtime.timer = undefined;
			runtime.timerDueAt = undefined;
			clearStatusTimer(runtime);
			if (runtime.enabled) queueLoopTick(runtime.identity, undefined, "next");
			else setLoopStatus(runtime);
		}, delay);
		armCountdownStatus(runtime);
	};

	const cancelLoopWatcher = (runtime: LoopRuntime): void => {
		if (runtime.watchDebounce !== undefined) { clearTimeout(runtime.watchDebounce as never); runtime.watchDebounce = undefined; }
		if (runtime.watcher) { try { runtime.watcher.close(); } catch {} runtime.watcher = undefined; }
	};

	// Watch the board's parent directory so atomic renames cannot detach the watcher.
	// Darwin reports an atomic save as a rename for the temporary filename only, so
	// every rename must debounce a fresh read of the canonical board. Content
	// equality below suppresses unrelated directory renames and stale events.
	const armLoopWatcher = (runtime: LoopRuntime): void => {
		if (runtime.watcher) return;
		const boardDir = dirname(runtime.boardPath);
		const boardBase = basename(runtime.boardPath);
		try {
			runtime.watcher = _fsWatch(boardDir, (eventType, filename) => {
				if (eventType !== "rename" && filename && String(filename) !== boardBase) return;
				clearTimeout(runtime.watchDebounce as never);
				runtime.watchDebounce = setTimeout(() => {
					runtime.watchDebounce = undefined;
					try {
						if (!runtime.enabled) return;
						const current = readBoardSafe(runtime.boardPath);
						if (runtime.selfWriteContent !== undefined) {
							const selfWriteContent = runtime.selfWriteContent;
							runtime.selfWriteContent = undefined;
							if (current !== undefined && current === selfWriteContent) return;
						}
						// FSEvents can deliver a stale notification after the watcher is
						// armed. Content equality proves no new board edit occurred.
						if (current !== undefined && current === runtime.lastBoardContent) return;
						// A human edit resets consecutive and idle counters, then triggers one turn.
						runtime.consecutiveTurns = 0;
						runtime.idleStreak = 0;
						runtime.lastUserEditAt = _now();
						if (!runtime.queued) queueLoopTick(runtime.identity, undefined, "cap-edit");
					} finally {
						setLoopStatus(runtime);
					}
				}, _watchDebounceMs);
				setLoopStatus(runtime);
			});
		} catch { /* board dir may not exist yet; the next /wb loop will try again */ }
	};

	const stopLoop = (runtime: LoopRuntime): void => {
		runtime.enabled = false;
		runtime.queued = false;
		runtime.pendingTickId = undefined;
		runtime.activeTickId = undefined;
		runtime.lastTickStart = undefined;
		runtime.lastTickQueuedAt = undefined;
		runtime.lastUserEditAt = undefined;
		runtime.checkpointOutcome = null;
		runtime.checkpointSummary = null;
		runtime.selfWriteContent = undefined;
		clearLoopTimer(runtime);
		cancelLoopWatcher(runtime);
		setLoopStatus(runtime);
	};

	const stopAllLoops = (): void => { for (const runtime of loops.values()) stopLoop(runtime); };
	const resetAllLoops = (): void => { stopAllLoops(); loops.clear(); };

	const openEditor = async (ctx, filePath: string) => {
		try {
			const msg = await openBoardEditor((c, a) => pi.exec?.(c, a), filePath);
			if (msg) { notify(ctx, msg); return; }
		} catch {}
		notify(ctx, `open it yourself: ${resolveEditor()} ${filePath}`, "warning");
	};

	const openBoard = async (ctx, scope: ResolvedBoardScope) => {
		const outcome = await showBoard(ctx, scope.path, scope.label);
		if (outcome === "edit") await openEditor(ctx, scope.path);
	};

	const handler = async (args: string, ctx) => {
		try {
			if (ctx && ctx.hasUI !== false && ctx.ui) statusUi = ctx.ui;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const rawVerb = tokens[0]?.toLowerCase() ?? "";
			// Raw remainder after the verb token, left-trimmed but otherwise verbatim
			// so rr/rs text keeps its interior spacing and escape sequences.
			const rest = args.trim().slice(tokens[0]?.length ?? 0).trimStart();

			if (rawVerb === "" || rawVerb === "view" || rawVerb === "open" || rawVerb === "o") {
				await openBoard(ctx, defaultScope()); return;
			}

			if (rawVerb === "-e" || rawVerb === "edit" || rawVerb === "e") {
				await openEditor(ctx, defaultScope().path); return;
			}

			if (rawVerb === "help") {
				notify(ctx, HELP_TEXT); return;
			}

			if (rawVerb === "settings") {
				const identity = resolveCurrentIdentity();
				if (!identity) { notify(ctx, "settings requires a named-agent identity", "warning"); return; }
				const settingsPath = join(identity.home, "config", "whiteboard-settings");
				if (!existsSync(settingsPath)) {
					mkdirSync(dirname(settingsPath), { recursive: true });
					writeFileSync(settingsPath, "autonomy=on\nmax_turns=12\n", "utf8");
				}
				await openEditor(ctx, settingsPath); return;
			}

			if (rawVerb === "status") {
				const identity = resolveCurrentIdentity();
				if (!identity) { notify(ctx, "no named-agent identity; no loop state", "warning"); return; }
				const runtime = loopRuntime(identity);
				const parts = [
					`loop ${runtime.enabled ? "enabled" : "disabled"}`,
					`state=${loopStatusDetail(runtime)}`,
					`id=${identity.id}`,
					`board=${runtime.boardPath}`,
					`autonomy=${runtime.autonomy ? "on" : "off"}`,
					`max_turns=${runtime.maxTurns}`,
					`consecutive=${runtime.consecutiveTurns}`,
					`ticks=${runtime.tickCount}`,
					`queued=${runtime.queued ? "yes" : "no"}`,
					"session-only",
				];
				if (runtime.lastIntervalMs !== undefined) {
					parts.push(`last_interval=${formatInterval(runtime.lastIntervalMs)}`);
					parts.push(`last_outcome=${runtime.lastOutcome ?? "?"}`);
				}
				if (runtime.lastSummary) parts.push(`last_result=${runtime.lastSummary}`);
				parts.push(openWorkIndicator(runtime.boardPath));
				notify(ctx, parts.join("; "));
				return;
			}

			if (rawVerb === "loop") {
				const identity = resolveCurrentIdentity();
				if (!identity) {
					notify(ctx, "loop requires a named-agent identity (config/identity name=); this session has none", "warning");
					return;
				}
				const runtime = loopRuntime(identity);
				// Toggle: disable if the loop is already enabled.
				if (runtime.enabled) {
					stopLoop(runtime);
					notify(ctx, "loop disabled for this session");
					return;
				}
				// Enable: load settings, seed the two-zone skeleton if absent, arm the watcher, queue the first turn.
				const settings = loadSettings(join(identity.home, "config", "whiteboard-settings"));
				runtime.autonomy = settings.autonomy;
				runtime.maxTurns = settings.maxTurns;
				const current = board.read(runtime.boardPath);
				if (current.trim() === "") {
					board.replace(SKELETON, runtime.boardPath);
				}
				runtime.enabled = true;
				runtime.consecutiveTurns = 0;
				runtime.idleStreak = 0;
				armLoopWatcher(runtime);
				queueLoopTick(identity, ctx, "enabled for this session");
				return;
			}

			if (rawVerb === "tick" || rawVerb === "tick!") {
				const identity = resolveCurrentIdentity();
				if (!identity) {
					notify(ctx, "tick requires a named-agent identity (config/identity name=); this session has none", "warning");
					return;
				}
				// Manual one-shot turn. "tick now" / "tick!" delivers as a steer that interrupts the current
				// turn instead of waiting for it to finish (the default nextTurn queues until the turn ends).
				const interrupt = rawVerb === "tick!" || ["now", "interrupt", "!", "steer"].includes((tokens[1] ?? "").toLowerCase());
				queueLoopTick(identity, ctx, interrupt ? "manual tick (interrupt)" : "manual tick", interrupt ? "steer" : "nextTurn");
				return;
			}

			if (rawVerb === "rm" || rawVerb === "del") {
				const spec = parseRangeSpec(rest);
				if (!spec) { notify(ctx, "usage: /wb rm <line[-line]>", "warning"); return; }
				const scope = defaultScope();
				notify(ctx, board.numberLines(board.removeLines(spec.from, spec.to, scope.path)));
				return;
			}

			if (rawVerb === "rr") {
				const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
				const spec = m ? parseRangeSpec(m[1]) : null;
				if (!m || !spec) { notify(ctx, "usage: /wb rr <line[-line]> <text> (use \\n for new lines)", "warning"); return; }
				const scope = defaultScope();
				notify(ctx, board.numberLines(board.replaceRange(spec.from, spec.to, decodeEscapes(m[2]), scope.path)));
				return;
			}

			if (rawVerb === "rs") {
				const idx = rest.indexOf("::");
				const heading = idx === -1 ? "" : rest.slice(0, idx).trim();
				const text = idx === -1 ? "" : decodeEscapes(rest.slice(idx + 2).trim());
				if (idx === -1 || heading.length === 0 || text.length === 0) {
					notify(ctx, "usage: /wb rs <heading> :: <text> (use \\n for new lines)", "warning"); return;
				}
				const scope = defaultScope();
				notify(ctx, board.numberLines(board.replaceSection(heading, text, scope.path)));
				return;
			}

			// Unknown verb -> help.
			notify(ctx, HELP_TEXT);
		} catch (error) {
			notify(ctx, `whiteboard: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.registerCommand("wb", {
		description: "Board-as-conversation: view; loop/tick/settings/status/help; edit; rm/rr/rs fast edits",
		handler,
	});

	pi.registerShortcut?.("ctrl+shift+w", {
		description: "Open the current board",
		handler: (ctx) => {
			try { return openBoard(ctx, defaultScope()); }
			catch (error) { notify(ctx, `whiteboard: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
		},
	});

	// Tick activation: set on delivery, not at queue time.
	const activatePendingTick = (content: string): void => {
		for (const runtime of loops.values()) {
			const tickId = runtime.pendingTickId;
			if (!tickId || !content.includes(`[wb-loop:${tickId}`)) continue;
			runtime.pendingTickId = undefined;
			runtime.activeTickId = tickId;
			runtime.lastTickStart = _now();
			setLoopStatus(runtime);
		}
	};

	pi.on?.("before_agent_start", event => activatePendingTick(event.prompt));
	pi.on?.("message_start", event => {
		// OMP may surface extension custom messages to hooks with role="developer"
		// even though customType remains intact. The type, not the rendered role,
		// is the stable activation discriminator.
		if (event.message.customType !== "wb-loop") return;
		const content = typeof event.message.content === "string"
			? event.message.content
			: event.message.content.filter(p => p.type === "text").map(p => p.text).join("");
		activatePendingTick(content);
	});

	pi.on?.("agent_end", event => {
		const now = _now();
		const lastAssistant = [...(event?.messages ?? [])].reverse().find(m => m.role === "assistant");
		const wasAborted = lastAssistant?.stopReason === "aborted";

		for (const runtime of loops.values()) {
			if (runtime.activeTickId === undefined || runtime.lastTickStart === undefined) continue;
			runtime.lastIntervalMs = now - runtime.lastTickStart;
			runtime.lastTickStart = undefined;

			if (wasAborted) {
				runtime.lastOutcome = "no-progress";
				runtime.lastSummary = "loop turn interrupted by user";
				runtime.checkpointOutcome = null;
				runtime.checkpointSummary = null;
				runtime.activeTickId = undefined;
				runtime.queued = false;
				emitMetric(runtime, "aborted");
				setLoopStatus(runtime);
				continue;
			}

			const checkpointOutcome = runtime.checkpointOutcome;
			const checkpointSummary = runtime.checkpointSummary ?? undefined;
			runtime.checkpointOutcome = null;
			runtime.checkpointSummary = null;
			runtime.activeTickId = undefined;
			runtime.queued = false;

			if (checkpointOutcome === "progress" && runtime.enabled && runtime.autonomy && runtime.consecutiveTurns < runtime.maxTurns) {
				// Self-continue: increment consecutive counter, adaptively pace the next tick.
				runtime.lastOutcome = "progress";
				runtime.lastSummary = checkpointSummary;
				runtime.consecutiveTurns++;
				const current = readBoardSafe(runtime.boardPath);
				if (runtime.lastBoardContent !== undefined && current !== undefined && current !== runtime.lastBoardContent) {
					runtime.idleStreak = 0;
				} else {
					runtime.idleStreak++;
				}
				scheduleLoopTick(runtime);
			} else {
				clearLoopTimer(runtime);
				// Rest: no self-continuation. Loop stays enabled; watcher remains armed.
				// The next cap edit (watcher fire) will reset consecutiveTurns and queue a new turn.
				if (checkpointOutcome !== null) {
					runtime.lastOutcome = checkpointOutcome;
					runtime.lastSummary = checkpointSummary;
				} else {
					runtime.lastOutcome = "no-progress";
					runtime.lastSummary = "no checkpoint provided";
				}
			}
			emitMetric(runtime, runtime.lastOutcome ?? "no-progress");
			setLoopStatus(runtime);
		}
	});

	pi.on?.("session_switch", resetAllLoops);
	pi.on?.("session_branch", resetAllLoops);
	pi.on?.("session_shutdown", stopAllLoops);

	// ── Tool registrations ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "whiteboard_read",
		label: "Whiteboard Read",
		description: "Read the current whiteboard. Default returns a diff since this session's last read; pass mode:\"full\" for the complete numbered board.",
		parameters: z.object({
			mode: z.enum(["auto", "diff", "full"]).optional().describe("auto/diff returns changes since the last read; full returns the complete numbered board"),
		}),
		async execute(_id, params) {
			const scope = defaultScope();
			const absPath = resolvePath(scope.path);
			const current = board.read(scope.path);
			const mode = params.mode ?? "auto";
			let text: string;
			let isDiff = false;
			if (mode === "full" || !lastReads.has(absPath)) {
				text = current ? board.numberLines(current) : "(empty)";
			} else {
				text = board.diffSince(lastReads.get(absPath)!, current);
				isDiff = true;
			}
			lastReads.set(absPath, current);
			return {
				content: [{ type: "text", text }],
				details: { scope: scope.label, path: scope.path, bytes: Buffer.byteLength(current, "utf8"), diff: isDiff },
			};
		},
	});

	pi.registerTool({
		name: "whiteboard_write",
		label: "Whiteboard Write",
		description: "Atomically replace the entire whiteboard with new content (full-board replace via board.replace).",
		parameters: z.object({
			text: z.string().describe("Full replacement content"),
		}),
		async execute(_id, params) {
			const scope = defaultScope();
			const absPath = resolvePath(scope.path);
			// Normalize the agent's write the same way the cap's nvim formats the
			// board on save (prettierd), so both authors converge on one canonical
			// shape and the diff never churns on whitespace. Fail-safe: unchanged on error.
			const formatted = formatMarkdown(params.text, absPath);
			const result = board.replace(formatted, scope.path);
			lastReads.set(absPath, result);
			for (const runtime of loops.values()) {
				if (resolvePath(runtime.boardPath) === absPath) runtime.selfWriteContent = result;
			}
			return {
				content: [{ type: "text", text: `whiteboard updated (${Buffer.byteLength(result, "utf8")} bytes)` }],
				details: { scope: scope.label, path: scope.path, bytes: Buffer.byteLength(result, "utf8") },
			};
		},
	});

	pi.registerTool({
		name: "whiteboard_checkpoint",
		label: "Whiteboard Checkpoint",
		description: "Record the outcome of this board-conversation turn. progress self-continues (when autonomy on and under max_turns); settled/needs-decision/blocked/error rest and wait for the next cap edit.",
		parameters: z.object({
			outcome: z.enum(["progress", "settled", "needs-decision", "blocked", "error"]).describe("Turn outcome"),
			summary: z.string().describe("One-sentence summary"),
		}),
		execute(_id, params) {
			const identity = resolveCurrentIdentity();
			if (!identity) {
				return {
					content: [{ type: "text", text: "whiteboard_checkpoint: no named-agent identity; no loop is active" }],
					details: { outcome: params.outcome, summary: params.summary, active: false },
				};
			}
			const runtime = loopRuntime(identity);
			const active = runtime.activeTickId !== undefined && runtime.lastTickStart !== undefined;
			if (!active) {
				return {
					content: [{ type: "text", text: "whiteboard_checkpoint: no active loop turn" }],
					details: { outcome: params.outcome, summary: params.summary, active: false },
				};
			}
			runtime.checkpointOutcome = params.outcome;
			runtime.checkpointSummary = params.summary;
			const willContinue = params.outcome === "progress"
				&& runtime.enabled && runtime.autonomy && runtime.consecutiveTurns < runtime.maxTurns;
			const modeNote = willContinue
				? `loop will self-continue (consecutive ${runtime.consecutiveTurns + 1}/${runtime.maxTurns})`
				: "loop will rest after this turn";
			return {
				content: [{ type: "text", text: `checkpoint ${params.outcome}: ${params.summary}. ${modeNote}.` }],
				details: { outcome: params.outcome, summary: params.summary, continuing: willContinue, active: true },
			};
		},
	});
}
