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

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export default function dispatchGuard(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}): void {
	pi.on("tool_call", (event) => {
		const call = event as { toolName?: string; input?: TaskInput };
		if (call.toolName !== "task") return;

		const input = call.input ?? {};
		const tasks = Array.isArray(input.tasks) ? (input.tasks as TaskEntry[]) : [];
		if (tasks.length === 0) return;

		const context = asString(input.context);
		const contextGrounded = FILE_LINE.test(context) || EXEMPT.test(context);
		const ungrounded: string[] = [];
		for (const task of tasks) {
			const assignment = asString(task.assignment);
			if (assignment.length === 0) continue;
			if (contextGrounded || FILE_LINE.test(assignment) || EXEMPT.test(assignment)) continue;
			ungrounded.push(asString(task.id) || "(unnamed task)");
		}
		if (ungrounded.length === 0) return;

		return {
			block: true,
			reason:
				`dispatch-guard: ${ungrounded.length} task(s) lack code grounding [${ungrounded.join(", ")}]. ` +
				`Read the target code first, then cite a concrete file:line for the mechanic the worker must touch ` +
				`(for example, src/foo.ts:123) in the assignment or shared context. ` +
				`For genuinely non-code work, add "GROUNDING-EXEMPT: <reason>" instead.`,
		};
	});
}
