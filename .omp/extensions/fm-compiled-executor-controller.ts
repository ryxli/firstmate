/**
 * fm-compiled-executor-controller.ts - event-driven deadline controller for the
 * private `compiled-executor` speculative-execution lane.
 *
 * =============================== what it does ==============================
 * Firstmate spawns a compiled action as a DETACHED `compiled-executor` subagent
 * (an OMP `AsyncJobManager` "task" job). This controller bounds every such
 * action by its compiled deadline WITHOUT polling:
 *
 *   1. Preflight gate (fail closed BEFORE the job spawns). On the parent `task`
 *      tool_call it validates every `compiled-executor` spawn item's compiled
 *      contract - an explicit spawn id (name), a canonical `action_id:` line,
 *      and a canonical `deadline:` line (ISO-8601 UTC instant). A missing,
 *      unnamed, malformed, or already-expired contract BLOCKS the whole tool
 *      call, so a boundless action never runs. Valid contracts are cached keyed
 *      by `${toolCallId}:${itemIndex}` - the same coordinate the lifecycle event
 *      carries as `${parentToolCallId}:${index}`.
 *
 *   2. Arm at lifecycle `started` (fires after job registration, before the
 *      child executes its prompt). The started event's `id` is the exact
 *      `ctx.asyncJobs` job id. Correlate to the cached contract by
 *      `${parentToolCallId}:${index}` (never inferred from the id/name), then
 *      arm ONE unref'd timer at the absolute deadline. Progress is only a
 *      corroborating fallback - whichever arrives first arms; the rest dedupe.
 *
 *   3. At the deadline confirm the job is still running (`ctx.asyncJobs.inspect`),
 *      then cancel that exact job (`ctx.asyncJobs.cancel`). The native cancel
 *      aborts the job AND suppresses its late completion delivery, so a late
 *      loser cannot overwrite the reclaimed lane. On a successful cancel inject
 *      exactly ONE structured reclaim event (action id, agent id, deadline,
 *      cancellation result) with `{ triggerTurn: true, deliverAs: "nextTurn" }`
 *      so Firstmate starts or queues the next turn.
 *
 *   4. If completion wins first, the terminal lifecycle state clears the timer
 *      and the controller emits nothing: OMP's normal async result is the sole
 *      completion event.
 *
 * ============================= OMP APIs used ===============================
 * - default export factory `(pi) => void`; only registration is valid at load.
 * - pi.on("tool_call", h): preflight gate; returns `{ block, reason }` to reject.
 * - pi.on("session_start", (e, ctx)): captures `ctx.asyncJobs` (the owner-scoped
 *   ExtensionAsyncJobControl) and subscribes the bus handlers.
 * - pi.on("session_shutdown"): clears every armed timer + subscriptions.
 * - pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL / _PROGRESS_CHANNEL): the exact
 *   session EventBus the task executor emits subagent events on.
 * - ctx.asyncJobs.inspect(jobId) -> ExtensionAsyncJobInfo | null.
 * - ctx.asyncJobs.cancel(jobId) -> discriminated ExtensionAsyncJobCancelResult.
 * - pi.sendMessage(msg, { triggerTurn, deliverAs }): inject the reclaim event.
 *
 * The controller class + pure helpers are exported for deterministic tests; the
 * default export wires them to the live `pi`/`ctx`.
 */

// OMP native EventBus channels for detached-subagent events (task/types.ts).
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** The one definition name this controller governs. */
export const COMPILED_EXECUTOR_AGENT = "compiled-executor";

/** Custom message type carrying a reclaim event. */
export const RECLAIM_MESSAGE_TYPE = "compiled-executor-reclaim";

// ============================ frozen native contract ======================
// Structural mirror of OMP's ExtensionAsyncJobControl surface (ctx.asyncJobs).
// Kept local so the extension needs no value import from the OMP bundle.

export type AsyncJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface ExtensionAsyncJobInfo {
	id: string;
	type: "bash" | "task";
	status: AsyncJobStatus;
	label: string;
	startTime: number;
	agentId?: string;
}

export type ExtensionAsyncJobCancelResult =
	| { cancelled: true; job: ExtensionAsyncJobInfo }
	| { cancelled: false; reason: "not-found" }
	| { cancelled: false; reason: "not-running"; job: ExtensionAsyncJobInfo };

export interface ExtensionAsyncJobControl {
	inspect(jobId: string): ExtensionAsyncJobInfo | null;
	cancel(jobId: string): ExtensionAsyncJobCancelResult;
}

// ============================== canonical syntax ==========================
// One canonical compiled-action header. Both lines are REQUIRED in a
// compiled-executor assignment and mirrored in the agent contract:
//
//   action_id: <identifier>            # echoed verbatim as the action's id
//   deadline: <ISO-8601 UTC instant>   # e.g. 2026-07-15T04:05:06Z (optional .mmm)
//
// The deadline is an absolute UTC instant so a stale/replayed compiled action
// with a past deadline fails closed instead of being re-granted a fresh window.

const ACTION_ID_RE = /(?:^|\n)[ \t]*action_id[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*(?=\n|$)/i;
const DEADLINE_RE = /(?:^|\n)[ \t]*deadline[ \t]*:[ \t]*(\S[^\n]*?)[ \t]*(?=\n|$)/i;
// Strict ISO-8601 UTC instant with a mandatory Z; optional millis. One shape.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type DeadlineFailure = "missing-deadline" | "malformed-deadline" | "expired-deadline";
export type ContractFailure = "unnamed-spawn" | "missing-action-id" | DeadlineFailure;

export interface CompiledContract {
	name: string;
	actionId: string;
	deadlineRaw: string;
	deadlineMs: number;
}

export type ContractParse =
	| { ok: true; contract: CompiledContract }
	| { ok: false; failure: ContractFailure };

/**
 * Validate a single compiled-executor spawn item against the canonical
 * contract at preflight time. `now` is the reference instant used to reject an
 * already-expired deadline. Order of checks is fixed so the reported failure is
 * deterministic: name, then action id, then deadline presence/shape/expiry.
 */
export function parseCompiledContract(name: string, assignment: string, now: number): ContractParse {
	const trimmedName = name.trim();
	if (trimmedName.length === 0) return { ok: false, failure: "unnamed-spawn" };

	const actionMatch = ACTION_ID_RE.exec(assignment);
	const actionId = actionMatch?.[1]?.trim() ?? "";
	if (actionId.length === 0) return { ok: false, failure: "missing-action-id" };

	const deadlineMatch = DEADLINE_RE.exec(assignment);
	const deadlineRaw = deadlineMatch?.[1]?.trim() ?? "";
	if (deadlineRaw.length === 0) return { ok: false, failure: "missing-deadline" };
	if (!ISO_UTC_RE.test(deadlineRaw)) return { ok: false, failure: "malformed-deadline" };
	const deadlineMs = Date.parse(deadlineRaw);
	if (!Number.isFinite(deadlineMs)) return { ok: false, failure: "malformed-deadline" };
	if (deadlineMs <= now) return { ok: false, failure: "expired-deadline" };

	return { ok: true, contract: { name: trimmedName, actionId, deadlineRaw, deadlineMs } };
}

// ================================ type guards =============================

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

// =============================== controller ===============================

/** Opaque timer handle so tests can inject a deterministic scheduler. */
export type TimerHandle = unknown;

export interface ControllerDeps {
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
}

export interface ReclaimPayload {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
}

export interface SendOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface ControllerHost {
	asyncJobs: ExtensionAsyncJobControl;
	sendMessage: (message: ReclaimPayload, options: SendOptions) => void;
	logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

type ArmReason = "deadline-exceeded" | "uncompiled-contract";

interface ArmedAction {
	jobId: string;
	actionId: string | null;
	deadlineRaw: string | null;
	reason: ArmReason;
	timer: TimerHandle;
}

/** A subagent event coordinate the controller cares about. */
interface SubagentSignal {
	jobId: string;
	agent: string;
	detached: boolean;
	parentToolCallId: string;
	index: number;
}

export class CompiledExecutorController {
	// Preflight-validated contracts, keyed by `${toolCallId}:${index}`.
	readonly #pending = new Map<string, CompiledContract>();
	// Armed actions, keyed by the exact async job id (lifecycle/progress `id`).
	readonly #armed = new Map<string, ArmedAction>();
	#host: ControllerHost | undefined;

	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, ms: number) => TimerHandle;
	readonly #clearTimer: (handle: TimerHandle) => void;

	constructor(deps: ControllerDeps = {}) {
		this.#now = deps.now ?? Date.now;
		this.#setTimer =
			deps.setTimer ??
			((callback, ms) => {
				const handle: unknown = setTimeout(callback, ms);
				// Never keep the process alive for a deadline timer. `setTimeout`
				// returns a `number` under the DOM lib and a timer object with
				// `unref` under Node/Bun; narrow structurally to stay lib-agnostic.
				if (handle && typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") {
					handle.unref();
				}
				return handle;
			});
		this.#clearTimer =
			deps.clearTimer ?? (handle => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
	}

	/** Bind the live runtime surface (ctx.asyncJobs, sendMessage) at session start. */
	bind(host: ControllerHost): void {
		this.#host = host;
	}

	/**
	 * Preflight gate for the parent `task` tool_call. Returns a block result
	 * when any compiled-executor spawn item carries an incomplete or expired
	 * compiled contract; otherwise caches every valid contract and returns
	 * undefined (allow). Non-task calls and calls with no compiled-executor
	 * item are ignored.
	 */
	reviewToolCall(event: unknown): { block: true; reason: string } | undefined {
		const call = asRecord(event);
		if (!call || asString(call.toolName) !== "task") return undefined;
		const toolCallId = asString(call.toolCallId);
		if (toolCallId.length === 0) return undefined;
		const input = asRecord(call.input);
		if (!input) return undefined;

		const topAgent = asString(input.agent);
		const items = this.#spawnItems(input, topAgent);
		const compiled = items.filter(item => item.agent === COMPILED_EXECUTOR_AGENT);
		if (compiled.length === 0) return undefined;

		const now = this.#now();
		const staged: Array<{ key: string; contract: CompiledContract }> = [];
		const violations: string[] = [];
		for (const item of compiled) {
			const parsed = parseCompiledContract(item.name, item.assignment, now);
			if (parsed.ok) {
				staged.push({ key: `${toolCallId}:${item.index}`, contract: parsed.contract });
			} else {
				violations.push(`item[${item.index}]: ${FAILURE_DESCRIPTION[parsed.failure]}`);
			}
		}

		if (violations.length > 0) {
			// Fail closed: the whole call is rejected, so no boundless
			// compiled-executor job is ever registered.
			return {
				block: true,
				reason:
					`compiled-executor controller rejected ${violations.length} compiled action(s): ` +
					`${violations.join("; ")}. Every compiled-executor spawn needs an explicit id (name), ` +
					`an "action_id: <id>" line, and a "deadline: <ISO-8601 UTC, e.g. 2026-07-15T04:05:06Z>" ` +
					`line whose instant is in the future.`,
			};
		}

		for (const { key, contract } of staged) this.#pending.set(key, contract);
		return undefined;
	}

	/** Subscribe the lifecycle + progress handlers to the session EventBus. */
	subscribe(events: { on(channel: string, handler: (data: unknown) => void): () => void }): () => void {
		const unsubscribers = [
			events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => this.onLifecycle(data)),
			events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => this.onProgress(data)),
		];
		return () => {
			for (const off of unsubscribers) off();
		};
	}

	/** Lifecycle handler: arm on `started`, clean up on any terminal state. */
	onLifecycle(data: unknown): void {
		const payload = asRecord(data);
		if (!payload) return;
		const signal = this.#signal(payload, asString(payload.id));
		if (!signal) return;
		const status = asString(payload.status);
		if (status === "started") {
			this.#arm(signal, "deadline-exceeded");
			return;
		}
		if (status === "completed" || status === "failed" || status === "aborted") {
			this.#clear(signal.jobId, `${signal.parentToolCallId}:${signal.index}`);
		}
	}

	/** Progress handler: corroborating fallback arm (deduped by job id). */
	onProgress(data: unknown): void {
		const payload = asRecord(data);
		if (!payload) return;
		const progress = asRecord(payload.progress);
		const jobId = asString(progress?.id);
		const signal = this.#signal(payload, jobId);
		if (!signal) return;
		this.#arm(signal, "deadline-exceeded");
	}

	/** Clear all armed timers and cached contracts (session shutdown/dispose). */
	reset(): void {
		for (const entry of this.#armed.values()) this.#clearTimer(entry.timer);
		this.#armed.clear();
		this.#pending.clear();
		this.#host = undefined;
	}

	// --------------------------------- internals ---------------------------

	// Normalize the task-tool params across OMP builds. The installed schema is
	// per-item `{ name, agent, task }` (batch items carry their OWN agent, no
	// top-level agent); a newer build uses `{ id, assignment }` with a single
	// top-level agent. Read both namings, and let each item's own agent win over
	// the top-level one, so compiled-executor spawns are seen under either shape.
	#spawnItems(
		input: Record<string, unknown>,
		topAgent: string,
	): Array<{ index: number; agent: string; name: string; assignment: string }> {
		const tasks = input.tasks;
		if (Array.isArray(tasks)) {
			return tasks.map((raw, index) => {
				const item = asRecord(raw);
				return {
					index,
					agent: (item && asString(item.agent)) || topAgent,
					name: (item && (asString(item.name) || asString(item.id))) || "",
					assignment: (item && (asString(item.task) || asString(item.assignment))) || "",
				};
			});
		}
		return [
			{
				index: 0,
				agent: topAgent,
				name: asString(input.name) || asString(input.id),
				assignment: asString(input.task) || asString(input.assignment),
			},
		];
	}

	#signal(payload: Record<string, unknown>, jobId: string): SubagentSignal | undefined {
		if (payload.detached !== true) return undefined;
		if (asString(payload.agent) !== COMPILED_EXECUTOR_AGENT) return undefined;
		if (jobId.length === 0) return undefined;
		if (typeof payload.parentToolCallId !== "string") return undefined;
		const parentToolCallId = payload.parentToolCallId;
		const index = payload.index;
		if (typeof index !== "number") return undefined;
		return { jobId, agent: COMPILED_EXECUTOR_AGENT, detached: true, parentToolCallId, index };
	}

	#arm(signal: SubagentSignal, reason: ArmReason): void {
		if (this.#armed.has(signal.jobId)) return; // register once per action
		const key = `${signal.parentToolCallId}:${signal.index}`;
		const contract = this.#pending.get(key);
		if (!contract) {
			// A compiled-executor job with no cached contract slipped past the
			// preflight gate: fail closed by reclaiming it immediately.
			this.#armed.set(signal.jobId, {
				jobId: signal.jobId,
				actionId: null,
				deadlineRaw: null,
				reason: "uncompiled-contract",
				timer: undefined,
			});
			this.#fire(signal.jobId);
			return;
		}
		this.#pending.delete(key);
		const delay = Math.max(0, contract.deadlineMs - this.#now());
		const jobId = signal.jobId;
		const timer = this.#setTimer(() => this.#fire(jobId), delay);
		this.#armed.set(jobId, {
			jobId,
			actionId: contract.actionId,
			deadlineRaw: contract.deadlineRaw,
			reason,
			timer,
		});
	}

	#clear(jobId: string, key: string): void {
		const entry = this.#armed.get(jobId);
		if (entry) {
			this.#armed.delete(jobId);
			this.#clearTimer(entry.timer);
		}
		this.#pending.delete(key);
	}

	/**
	 * Deadline (or fail-closed) reclaim. Claims the action exactly once, confirms
	 * the job is still running, cancels it, and injects one reclaim event only
	 * when the cancel actually stopped a running job. If completion won the race
	 * (inspect not running, or cancel reports not-running/not-found) it emits
	 * nothing - OMP's normal async result remains the sole completion event.
	 */
	#fire(jobId: string): void {
		const entry = this.#armed.get(jobId);
		if (!entry) return; // already cleared by a terminal state or a prior fire
		this.#armed.delete(jobId);
		this.#clearTimer(entry.timer);

		const host = this.#host;
		if (!host) return;

		const info = host.asyncJobs.inspect(jobId);
		if (!info || info.status !== "running") return; // completion won / job gone

		const result = host.asyncJobs.cancel(jobId);
		if (!result.cancelled) return; // lost the race; the completion delivers

		host.sendMessage(buildReclaimMessage(entry, result), { triggerTurn: true, deliverAs: "nextTurn" });
	}
}

const FAILURE_DESCRIPTION: Record<ContractFailure, string> = {
	"unnamed-spawn": "missing explicit spawn id (name)",
	"missing-action-id": "missing canonical action_id line",
	"missing-deadline": "missing canonical deadline line",
	"malformed-deadline": "deadline is not a canonical ISO-8601 UTC instant",
	"expired-deadline": "deadline is already in the past",
};

function buildReclaimMessage(entry: ArmedAction, result: ExtensionAsyncJobCancelResult): ReclaimPayload {
	const action = entry.actionId ?? "unknown";
	const deadline = entry.deadlineRaw ?? "unknown";
	const cancellation = result.cancelled
		? { cancelled: true as const, jobStatus: result.job.status }
		: { cancelled: false as const, reason: result.reason };
	return {
		customType: RECLAIM_MESSAGE_TYPE,
		display: true,
		content:
			`[${RECLAIM_MESSAGE_TYPE}] job=${entry.jobId} action=${action} deadline=${deadline} ` +
			`reason=${entry.reason} cancelled=${cancellation.cancelled} - the compiled action was reclaimed ` +
			`at its deadline and its late result is suppressed. Reclaim the lane: start or queue the next turn.`,
		details: {
			kind: RECLAIM_MESSAGE_TYPE,
			jobId: entry.jobId,
			actionId: entry.actionId,
			deadline: entry.deadlineRaw,
			reason: entry.reason,
			cancellation,
		},
	};
}

// ================================ live wiring =============================

interface HostContext {
	asyncJobs: ExtensionAsyncJobControl;
}

interface ExtensionEvents {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

interface CompiledExecutorPi {
	on(event: string, handler: (event: unknown, ctx: HostContext) => unknown): void;
	events: ExtensionEvents;
	sendMessage: (message: ReclaimPayload, options: SendOptions) => void;
	logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export default function compiledExecutorController(pi: CompiledExecutorPi): void {
	const controller = new CompiledExecutorController();
	let unsubscribe: (() => void) | undefined;

	// Preflight gate is valid from load: tool calls only fire once running.
	pi.on("tool_call", event => controller.reviewToolCall(event));

	pi.on("session_start", (_event, ctx) => {
		controller.bind({
			asyncJobs: ctx.asyncJobs,
			sendMessage: (message, options) => pi.sendMessage(message, options),
			logger: pi.logger,
		});
		unsubscribe?.();
		unsubscribe = controller.subscribe(pi.events);
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		controller.reset();
	});
}
