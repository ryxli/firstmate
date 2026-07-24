import { join } from "node:path";
import { identityValue } from "./cli/lib/identity";

const FILE_LINE = /[\w./\\-]+\.(?:py|ts|tsx|js|jsx|rs|css|ya?ml|toml|json|md|sh|sql)(?::\d+|:\d+-\d+)/;
const EXEMPT = /GROUNDING-EXEMPT:\s*\S+/;

interface TaskEntry {
	assignment?: unknown;
	id?: unknown;
	name?: unknown;
	task?: unknown;
}

interface TaskInput extends TaskEntry {
	context?: unknown;
	tasks?: unknown;
}

interface ToolCall {
	toolName?: string;
	input?: TaskInput;
}

type Block = { block: true; reason: string };

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function managerAgentPrefix(home: string): string | null {
	const name = identityValue(join(home, "config"), "name");
	if (!name) return null;
	const camel = name
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
	return camel ? `${camel}Local` : null;
}


export function reviewTaskCall(call: ToolCall, home: string): Block | undefined {
	if (call.toolName !== "task") return;

	const input = call.input ?? {};
	const tasks = Array.isArray(input.tasks)
		? input.tasks as TaskEntry[]
		: asString(input.task) || asString(input.assignment)
			? [input]
			: [];
	if (tasks.length === 0) return;

	const prefix = managerAgentPrefix(home);
	const names = tasks
		.map((task) => asString(task.name) || asString(task.id))
		.filter(Boolean);
	if (!prefix && names.length > 0) {
		return {
			block: true,
			reason: "dispatch-guard: named agents require config/identity name; omit the name for a disposable worker.",
		};
	}
	const foreign = prefix ? names.filter((name) => !name.startsWith(prefix) || name.length === prefix.length) : [];
	if (foreign.length > 0) {
		return {
			block: true,
			reason:
				`dispatch-guard: named agents are manager-local and must start with ${prefix} ` +
				`[${foreign.join(", ")}]. Use ${prefix}<Specialist> or omit the name for a disposable worker.`,
		};
	}

	const context = asString(input.context);
	const contextGrounded = FILE_LINE.test(context) || EXEMPT.test(context);
	const ungrounded: string[] = [];
	for (const task of tasks) {
		const assignment = asString(task.task) || asString(task.assignment);
		if (assignment.length === 0) continue;
		if (contextGrounded || FILE_LINE.test(assignment) || EXEMPT.test(assignment)) continue;
		ungrounded.push(asString(task.name) || asString(task.id) || "(unnamed task)");
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
}

export default function dispatchGuard(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}): void {
	pi.on("tool_call", (event, ctx) => {
		const context = ctx as { cwd?: unknown } | undefined;
		const home = process.env.FM_HOME?.trim() || asString(context?.cwd) || process.cwd();
		return reviewTaskCall(event as ToolCall, home);
	});
}
