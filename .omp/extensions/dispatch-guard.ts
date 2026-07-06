/**
 * dispatch-guard.ts - hard enforcement of the research-before-dispatch rule.
 *
 * Captain's directive (2026-07-06): "I need to encode this behavior into the
 * harness. I cannot rely on the model." The model kept dispatching workers and
 * estimating timelines without first grounding the mechanic in the actual code
 * (e.g. estimating a 45-minute CSS restructure that was a one-line
 * grid-template-areas swap already present at another breakpoint).
 *
 * Mechanism: every `task` tool dispatch is blocked unless EVERY task's
 * assignment (or the shared context) carries at least one concrete file:line
 * citation - proof that the dispatcher read the target code before briefing a
 * worker on it. Non-code work (mockups, pure research, brand-new files) opts
 * out explicitly with a stated reason via "GROUNDING-EXEMPT: <reason>".
 *
 * Enforcement is block-and-retry like textguard: the tool never runs on a
 * violation; the reason tells the dispatcher exactly how to fix the brief.
 * Fails open on malformed input (a guard must never brick dispatching).
 */

const FILE_LINE = /[\w./\\-]+\.(?:py|ts|tsx|js|jsx|rs|css|ya?ml|toml|json|md|sh|sql)(?::\d+|:\d+-\d+)/;
const EXEMPT = /GROUNDING-EXEMPT:\s*\S+/;

interface TaskEntry {
	assignment?: unknown;
	id?: unknown;
}

interface TaskInput {
	context?: unknown;
	tasks?: unknown;
}

function asString(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export default function dispatchGuard(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}): void {
	pi.on("tool_call", (event) => {
		const e = event as { toolName?: string; input?: TaskInput };
		if (e?.toolName !== "task") return;
		const input = e.input ?? {};
		const tasks = Array.isArray(input.tasks) ? (input.tasks as TaskEntry[]) : [];
		if (tasks.length === 0) return; // malformed / empty: not this guard's business
		const context = asString(input.context);
		const contextGrounded = FILE_LINE.test(context) || EXEMPT.test(context);
		const ungrounded: string[] = [];
		for (const t of tasks) {
			const a = asString(t?.assignment);
			if (a.length === 0) continue; // let the tool's own validation reject
			if (FILE_LINE.test(a) || EXEMPT.test(a) || contextGrounded) continue;
			ungrounded.push(asString(t?.id) || "(unnamed task)");
		}
		if (ungrounded.length === 0) return;
		return {
			block: true,
			reason:
				`dispatch-guard: ${ungrounded.length} task(s) lack code grounding [${ungrounded.join(", ")}]. ` +
				`Read the target code FIRST, then cite at least one concrete file:line for the mechanic the worker must touch ` +
				`(pattern like src/foo.ts:123) in the assignment or shared context. ` +
				`For genuinely non-code work (mockups, research, new files from scratch) add "GROUNDING-EXEMPT: <reason>" instead. ` +
				`This also forces the research that makes time estimates honest.`,
		};
	});
}
