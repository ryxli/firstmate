import dispatchGuard from "../.omp/extensions/dispatch-guard.ts";

type ToolCall = { toolName?: string; input?: { context?: unknown; tasks?: unknown } };
type Handler = (event: ToolCall) => unknown;

let handler: Handler | undefined;
dispatchGuard({
	on(event, registered) {
		if (event === "tool_call") handler = registered as Handler;
	},
});

if (!handler) throw new Error("dispatch guard did not register a tool_call handler");

function result(event: ToolCall) {
	return handler?.(event) as { block?: boolean; reason?: string } | undefined;
}

function expect(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

expect(result({ toolName: "bash", input: {} }) === undefined, "non-task tools must pass");
expect(
	result({ toolName: "task", input: { tasks: [{ id: "grounded", assignment: "Change src/app.ts:42." }] } }) === undefined,
	"a task assignment with a file:line citation must pass",
);
expect(
	result({ toolName: "task", input: { context: "Observed lib/core.ts:8-12.", tasks: [{ id: "context", assignment: "Apply the established pattern." }] } }) === undefined,
	"shared context grounding must pass every task",
);
expect(
	result({ toolName: "task", input: { tasks: [{ id: "research", assignment: "GROUNDING-EXEMPT: external API research" }] } }) === undefined,
	"an explicit non-code exemption must pass",
);
const blocked = result({ toolName: "task", input: { tasks: [{ id: "ungrounded", assignment: "Fix the bug." }] } });
expect(blocked?.block === true, "an ungrounded task must be blocked");
expect(blocked?.reason?.includes("ungrounded") === true, "the blocked task id must be named");
expect(blocked?.reason?.includes("file:line") === true, "the remedy must require a file:line citation");
console.log("dispatch guard grounding checks passed");
