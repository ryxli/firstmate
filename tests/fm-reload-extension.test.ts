import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fmReload from "../.omp/extensions/fm-reload/index.ts";

// ---------------------------------------------------------------------------
// Fake `pi` API
// ---------------------------------------------------------------------------

interface CommandDef {
	description: string;
	handler: (args: string[], ctx: unknown) => string;
}

interface SessionContext {
	sessionManager: {
		getSessionId: () => string;
		getSessionFile: () => string;
	};
}

interface Harness {
	handlers: Record<string, (event: unknown, ctx?: SessionContext) => void>;
	commands: Record<string, CommandDef>;
}

function fireSessionStart(
	handlers: Harness["handlers"],
	sessionId: string,
	sessionPath: string,
	event: unknown = {},
): void {
	handlers["session_start"](event, {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionPath,
		},
	});
}

function makeHarness(): Harness {
	const handlers: Harness["handlers"] = {};
	const commands: Record<string, CommandDef> = {};
	const pi = {
		setLabel(_: string) {},
		on(name: string, h: (event: unknown, ctx?: SessionContext) => void) {
			handlers[name] = h;
		},
		registerCommand(name: string, def: CommandDef) {
			commands[name] = def;
		},
	};
	fmReload(pi as never);
	return { handlers, commands };
}

// ---------------------------------------------------------------------------
// Per-test isolated state directory
// ---------------------------------------------------------------------------

let tempDir: string;
let stateFile: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "fm-reload-ext-"));
	stateFile = join(tempDir, "fm-reload", "state.json");
	process.env.PI_CODING_AGENT_DIR = tempDir;
});

afterEach(() => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	if (prev === tempDir) delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session_start handler
// ---------------------------------------------------------------------------

describe("session_start handler", () => {
	test("persists entry indexed by cwd when no HERDR_PANE_ID is set", () => {
		const { handlers } = makeHarness();
		const prevPaneId = process.env.HERDR_PANE_ID;
		delete process.env.HERDR_PANE_ID;

		fireSessionStart(handlers, "sess-abc", "/path/sess.jsonl", { session_id: "wrong-event-value" });

		if (prevPaneId !== undefined) process.env.HERDR_PANE_ID = prevPaneId;

		const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
		expect(state[process.cwd()]).toMatchObject({
			session_id: "sess-abc",
			session_path: "/path/sess.jsonl",
			cwd: process.cwd(),
			pane_id: "",
		});
		expect(typeof (state[process.cwd()] as Record<string, unknown>).ts).toBe("number");
		// No pane:* key written when HERDR_PANE_ID is absent.
		expect(Object.keys(state).some((k) => k.startsWith("pane:"))).toBe(false);
	});

	test("indexes by both cwd and pane:ID when HERDR_PANE_ID is set", () => {
		const { handlers } = makeHarness();
		const prevPaneId = process.env.HERDR_PANE_ID;
		process.env.HERDR_PANE_ID = "pane-42";

		fireSessionStart(handlers, "sess-pane", "");

		if (prevPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = prevPaneId;

		const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Record<string, unknown>>;
		expect(state["pane:pane-42"]).toMatchObject({ session_id: "sess-pane", pane_id: "pane-42" });
		expect(state[process.cwd()]).toMatchObject({ session_id: "sess-pane", pane_id: "pane-42" });
	});

	test("reads session identity from context and ignores event fields", () => {
		const { handlers, commands } = makeHarness();

		fireSessionStart(handlers, "sess-camel", "/path/camel.jsonl", { sessionId: "wrong-event-value" });

		const out = commands["reload"].handler([], null);
		// The captured ID shows up in /reload output - proving it was captured.
		expect(out).toContain("sess-camel");
		expect(out).toContain('--resume "/path/camel.jsonl"');
	});

	test("skips write and leaves capturedSessionId empty when session_id is empty", () => {
		const { handlers, commands } = makeHarness();

		fireSessionStart(handlers, "", "");

		// /reload must still report no session captured (empty id was not stored).
		const out = commands["reload"].handler([], null);
		expect(out).toContain("no session ID captured yet");
		// No state file should have been written.
		expect(() => readFileSync(stateFile, "utf8")).toThrow();
	});

	test("retries context identity on agent_start when startup getters are empty", () => {
		const { handlers } = makeHarness();
		const prevPaneId = process.env.HERDR_PANE_ID;
		process.env.HERDR_PANE_ID = "pane-delayed";
		let ready = false;
		const ctx: SessionContext = {
			sessionManager: {
				getSessionId: () => ready ? "late-session" : "",
				getSessionFile: () => ready ? "/path/late-session.jsonl" : "",
			},
		};

		handlers["session_start"](
			{ session_id: "ignored-event-id", session_path: "/ignored-event-path" },
			ctx,
		);
		expect(() => readFileSync(stateFile, "utf8")).toThrow();

		ready = true;
		handlers["agent_start"](
			{ session_id: "still-ignored-event-id", session_path: "/still-ignored-event-path" },
			ctx,
		);

		const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Record<string, unknown>>;
		const expected = {
			session_id: "late-session",
			session_path: "/path/late-session.jsonl",
			cwd: process.cwd(),
			pane_id: "pane-delayed",
		};
		expect(state[process.cwd()]).toMatchObject(expected);
		expect(state["pane:pane-delayed"]).toMatchObject(expected);
		if (prevPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = prevPaneId;
	});

	test("preserves a valid capture when an agent retry is still empty", () => {
		const { handlers } = makeHarness();
		fireSessionStart(handlers, "valid-session", "/path/valid-session.jsonl");
		const before = readFileSync(stateFile, "utf8");
		const emptyCtx: SessionContext = {
			sessionManager: {
				getSessionId: () => "",
				getSessionFile: () => "",
			},
		};

		handlers["agent_start"]({}, emptyCtx);

		expect(readFileSync(stateFile, "utf8")).toBe(before);
	});

	test("merges new entries into existing state without clobbering unrelated keys", () => {
		const { handlers: h1 } = makeHarness();
		const { handlers: h2 } = makeHarness();

		fireSessionStart(h1, "first-sess", "");
		// Simulate a second session starting (different cwd by using pane key).
		const prevPaneId = process.env.HERDR_PANE_ID;
		process.env.HERDR_PANE_ID = "pane-merge";
		fireSessionStart(h2, "second-sess", "");
		if (prevPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = prevPaneId;

		const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Record<string, unknown>>;
		// Both entries coexist.
		expect(state[process.cwd()]).toMatchObject({ session_id: "second-sess" });
		expect(state["pane:pane-merge"]).toMatchObject({ session_id: "second-sess" });
	});
});

// ---------------------------------------------------------------------------
// /reload command handler
// ---------------------------------------------------------------------------

describe("/reload command", () => {
	test("returns no-session message before any session_start fires", () => {
		const { commands } = makeHarness();
		const out = commands["reload"].handler([], null);
		expect(out).toContain("no session ID captured yet");
		// Must mention how to get out of the stuck state.
		expect(out).toContain("fm-reload");
	});

	test("returns manual resume command with session path after session_start", () => {
		const { handlers, commands } = makeHarness();

		fireSessionStart(handlers, "sess-resume", "/path/resume.jsonl");
		const out = commands["reload"].handler([], null);

		expect(out).toContain("sess-resume");
		expect(out).toContain(process.cwd());
		// Path variant: --resume uses the file path, not the bare ID.
		expect(out).toContain('--resume "/path/resume.jsonl"');
		expect(out).toContain("Session path");
	});

	test("falls back to session_id in resume command when session_path is empty", () => {
		const { handlers, commands } = makeHarness();

		fireSessionStart(handlers, "sess-id-only", "");
		const out = commands["reload"].handler([], null);

		expect(out).toContain('--resume "sess-id-only"');
		// No session path line emitted when path is absent.
		expect(out).not.toContain("Session path");
	});

	test("includes pane ID in output when HERDR_PANE_ID is set at command invocation", () => {
		const { handlers, commands } = makeHarness();

		fireSessionStart(handlers, "sess-pane-out", "");

		const prevPaneId = process.env.HERDR_PANE_ID;
		process.env.HERDR_PANE_ID = "pane-77";
		const out = commands["reload"].handler([], null);
		if (prevPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = prevPaneId;

		expect(out).toContain("Pane ID");
		expect(out).toContain("pane-77");
	});

	test("omits pane ID line when HERDR_PANE_ID is not set", () => {
		const { handlers, commands } = makeHarness();

		fireSessionStart(handlers, "sess-no-pane", "");

		const prevPaneId = process.env.HERDR_PANE_ID;
		delete process.env.HERDR_PANE_ID;
		const out = commands["reload"].handler([], null);
		if (prevPaneId !== undefined) process.env.HERDR_PANE_ID = prevPaneId;

		expect(out).not.toContain("Pane ID");
	});
});
