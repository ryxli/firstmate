import { describe, expect, it } from "bun:test";

import fmLifecycleGuard, { evaluateFleetToolCall } from "../.omp/hooks/pre/fm-lifecycle-guard.ts";

type ToolCall = { toolName: string; input?: Record<string, unknown> };
type Handler = (event: ToolCall) => { block: true; reason: string } | undefined;

let handler: Handler | undefined;
const pi = {
	on(event: string, registered: (event: unknown) => unknown): void {
		if (event === "tool_call") handler = registered as Handler;
	},
};
fmLifecycleGuard(pi);
if (!handler) throw new Error("fm lifecycle guard did not register a tool_call handler");

const WAIT_REASON =
	"fm-lifecycle-guard: event-driven supervision forbids wait calls; inspect current state or continue other work.";
const LIFECYCLE_REASON =
	"fm-lifecycle-guard: registered-mate lifecycle and state changes must use the owning fm verb; diagnose read-only and report a blocker if fm cannot complete safely.";
const RAW_WRAPPER_REASON =
	"fm-lifecycle-guard: OMP secondmates must use canonical fm spawn without a raw launch wrapper or positional prompt; the launcher injects role and charter context.";

let executorCalls = 0;
function invoke(call: ToolCall): { block: true; reason: string } | undefined {
	const decision = handler?.(call);
	if (!decision) executorCalls += 1;
	return decision;
}

function expectBlocked(call: ToolCall, reason: string): void {
	const before = executorCalls;
	expect(invoke(call)).toEqual({ block: true, reason });
	expect(executorCalls).toBe(before);
}

function expectAllowed(call: ToolCall): void {
	const before = executorCalls;
	expect(invoke(call)).toBeUndefined();
	expect(executorCalls).toBe(before + 1);
}

describe("bash Herdr supervision guards", () => {
	it("blocks wait, pane close, and send/type/paste calls", () => {
		for (const command of [
			"herdr wait agent-status riggs",
			"'herdr' wait agent-status riggs",
			"herdr 'wait' agent-status riggs",
			"/usr/local/bin/herdr wait agent-status riggs",
			"'/usr/local/bin/herdr' wait agent-status riggs",
			"'/usr/local/bin/herdr' 'wait' agent-status riggs",
		]) {
			expectBlocked({ toolName: "bash", input: { command } }, WAIT_REASON);
		}
		for (const command of [
			"herdr pane close pane-1",
			"herdr 'pane' close pane-1",
			"herdr pane 'close' pane-1",
			"herdr send pane-1 hello",
			"herdr 'send' pane-1 hello",
			"herdr type pane-1 hello",
			"herdr paste pane-1 hello",
		]) {
			expectBlocked({ toolName: "bash", input: { command } }, LIFECYCLE_REASON);
		}
	});

	it("allows read-only Herdr inspection and token-boundary lookalikes", () => {
		for (const command of [
			"herdr pane list",
			"herdr pane get pane-1",
			"herdr pane read pane-1",
			"herdr agent get riggs",
			"myherdr wait agent-status riggs",
			"my-herdr wait agent-status riggs",
			"herdr wait-list agent-status riggs",
		]) {
			expectAllowed({ toolName: "bash", input: { command } });
		}
	});
});

describe("foreground sleep guards", () => {
	it("blocks the sleep word in shell and eval-style execution", () => {
		for (const call of [
			{ toolName: "bash", input: { command: "sleep 60" } },
			{ toolName: "bash", input: { command: "python -c 'import time; time.sleep(60)'" } },
			{ toolName: "eval", input: { code: "await asyncio.sleep(60)" } },
			{ toolName: "python", input: { code: "from time import sleep\nsleep(60)" } },
		]) {
			expectBlocked(call, WAIT_REASON);
		}
	});

	it("allows token-boundary lookalikes and unrelated eval input", () => {
		expectAllowed({ toolName: "bash", input: { command: "printf sleepy" } });
		expectAllowed({ toolName: "eval", input: { code: "print('handoff complete')" } });
		expectAllowed({ toolName: "eval", input: { language: "py" } });
	});
});

describe("bash lifecycle and state guards", () => {
	it("blocks rm and unlink of state metadata before shell separators", () => {
		for (const command of [
			"rm state/riggs.meta",
			"rm -f /tmp/firstmate/state/riggs.meta; echo not reached",
			"echo before && unlink ./state/gauge.meta || echo not reached",
			"rm 'x;y' state/riggs.meta",
			"rm ignored\\; state/riggs.meta",
			"rm state\\/riggs.meta",
			"/usr/bin/rm state/gauge.meta",
			"'/usr/bin/unlink' ./state/ledger.meta",
		]) {
			expectBlocked({ toolName: "bash", input: { command } }, LIFECYCLE_REASON);
		}
	});

	it("allows status files, read-only state references, and canonical fm verbs", () => {
		for (const command of [
			"echo state/riggs.meta rm",
			"rm state/riggs.status",
			"rm x; echo state/riggs.meta",
			"cat state/riggs.meta",
			"printf 'state/riggs.meta'",
			"fm update --all",
			"fm finish riggs",
			"fm spawn riggs /homes/riggs omp --secondmate",
			"sbin/fm spawn riggs /homes/riggs omp --secondmate",
			"git status --short",
		]) {
			expectAllowed({ toolName: "bash", input: { command } });
		}
	});
});

describe("bash raw OMP secondmate wrappers", () => {
	it("blocks quoted prompt assignments and positional prompts", () => {
		for (const command of [
			"OMP_PROMPT='omp repair the fleet' fm spawn riggs /homes/riggs --secondmate",
			"fm spawn riggs /homes/riggs \"omp repair the fleet\" --secondmate",
			"sbin/fm spawn riggs /homes/riggs --secondmate PROMPT=\"omp repair the fleet\"",
			"(OMP_PROMPT='omp repair the fleet' fm spawn riggs /homes/riggs --secondmate)",
			"'sbin/fm' 'spawn' riggs /homes/riggs 'omp repair the fleet' '--secondmate'",
		]) {
			expectBlocked({ toolName: "bash", input: { command } }, RAW_WRAPPER_REASON);
		}
	});

	it("allows bare canonical spawn and commands missing a wrapper predicate", () => {
		for (const command of [
			"fm spawn riggs /homes/riggs omp --secondmate",
			"fm spawn riggs /homes/riggs \"prompt omp repair\" --secondmate",
			"fm spawn riggs /homes/riggs \"omp repair\"",
			"echo \"omp docs\"; fm spawn riggs /homes/riggs --secondmate",
			"echo \"omp repair\"",
			"myfm spawn riggs /homes/riggs \"omp repair\" --secondmate",
		]) {
			expectAllowed({ toolName: "bash", input: { command } });
		}
	});
});

describe("native hub calls", () => {
	it("blocks only hub wait", () => {
		expectBlocked({ toolName: "hub", input: { op: "wait" } }, WAIT_REASON);
		for (const op of ["list", "send", "inbox", "peek", "stats", "cancel", undefined]) {
			expectAllowed({ toolName: "hub", input: op === undefined ? {} : { op } });
		}
	});
});

describe("write state paths", () => {
	it("blocks state metadata writes and allows status or unrelated writes", () => {
		for (const path of ["state/riggs.meta", "./state/gauge.meta", "/tmp/firstmate/state/ledger.meta"]) {
			expectBlocked({ toolName: "write", input: { path, content: "changed" } }, LIFECYCLE_REASON);
		}
		for (const path of ["state/riggs.status", "state/riggs.meta.bak", "data/riggs.meta", "notes.txt"]) {
			expectAllowed({ toolName: "write", input: { path, content: "changed" } });
		}
	});
});

describe("hashline edit state paths", () => {
	it("blocks state headers, including REM, without scanning replacement text", () => {
		expectBlocked(
			{ toolName: "edit", input: { input: "*** Begin Patch\n[state/riggs.meta#AB12]\nREM\n*** End Patch" } },
			LIFECYCLE_REASON,
		);
		expectBlocked(
			{ toolName: "edit", input: { _input: "*** Begin Patch\n[state/ledger.meta#AA11]\nREM\n*** End Patch" } },
			LIFECYCLE_REASON,
		);
		expectBlocked(
			{ toolName: "edit", input: { input: "*** Begin Patch\n[/tmp/state/gauge.meta#00FF]\nSWAP 1.=1:\n+changed\n*** End Patch" } },
			LIFECYCLE_REASON,
		);
		expectAllowed({
			toolName: "edit",
			input: { input: "*** Begin Patch\n[notes.txt#AB12]\nSWAP 1.=1:\n+state/riggs.meta is documented here\n*** End Patch" },
		});
		expectAllowed({
			toolName: "edit",
			input: { input: "*** Begin Patch\n[state/riggs.status#AB12]\nREM\n*** End Patch" },
		});
	});
});

describe("non-fleet calls", () => {
	it("allow unrelated tools and malformed inputs", () => {
		expectAllowed({ toolName: "read", input: { path: "state/riggs.meta" } });
		expectAllowed({ toolName: "task", input: { command: "herdr wait" } });
		expectAllowed({ toolName: "bash", input: {} });
		expectAllowed({ toolName: "bash" });
		expect(evaluateFleetToolCall("bash", undefined)).toBeUndefined();
	});
});
