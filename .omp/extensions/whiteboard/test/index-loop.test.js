import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import whiteboard, {
	_resetFsWatch,
	_resetNow,
	_resetWatchDebounce,
	_setFsWatch,
	_setNow,
	_setWatchDebounce,
	loopBackoffMs,
	decodeEscapes,
} from "../index.ts";

function zodStub() {
	const chain = {
		int() { return this; },
		optional() { return this; },
		describe() { return this; },
	};
	return {
		object: () => chain,
		enum: () => chain,
		string: () => chain,
		number: () => chain,
	};
}

/**
 * loadExtension sets up a temp dir with the configured board paths and env vars,
 * then calls whiteboard(pi) with a fake pi that records registrations and messages.
 *
 * Options:
 *   agentId   - sets .fm-secondmate-home to this id AND creates config/identity
 *               with name=<agentId> so resolveCurrentIdentity() works.
 *   agentName - creates config/identity with name=<agentName> but NO marker,
 *               simulating a main-firstmate identity (id = slug(name)).
 *   markerOnly - creates .fm-secondmate-home without config/identity.
 *   settings   - object with autonomy and/or max_turns written to config/whiteboard-settings.
 *   autoDeliver - default true; when true, sendMessage auto-fires before_agent_start.
 */
function loadExtension(t, options = {}) {
	const commands = new Map();
	const tools = new Map();
	const listeners = new Map();
	const activeTools = new Set(options.activeTools ?? ["unrelated_tool"]);
	const activeToolUpdates = [];
	const notifications = [];
	const messages = [];
	const messageWaiters = [];
	const waitForMessageCount = count => {
		if (messages.length >= count) return Promise.resolve();
		return new Promise(resolve => messageWaiters.push({ count, resolve }));
	};
	const tempDir = mkdtempSync(join(tmpdir(), "whiteboard-loop-"));
	const paths = {
		global: join(tempDir, "whiteboard.md"),
		agentHome: join(tempDir, "agent-home"),
	};
	const previous = {
		WHITEBOARD_FILE: process.env.WHITEBOARD_FILE,
		FM_HOME: process.env.FM_HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		WB_LOOP_MIN_MS: process.env.WB_LOOP_MIN_MS,
		WB_LOOP_MAX_MS: process.env.WB_LOOP_MAX_MS,
	};

	process.env.WHITEBOARD_FILE = paths.global;
	process.env.WB_LOOP_MIN_MS = options.loopMinMs ?? "1";
	process.env.WB_LOOP_MAX_MS = options.loopMaxMs ?? "8";
	delete process.env.PI_CODING_AGENT_DIR;

	if (options.agentId || options.agentName || options.markerOnly) {
		mkdirSync(join(paths.agentHome, "config"), { recursive: true });
		process.env.FM_HOME = paths.agentHome;

		const markerId = options.agentId ?? options.markerOnly;
		if (markerId) {
			writeFileSync(join(paths.agentHome, ".fm-secondmate-home"), `${markerId}\n`, "utf8");
		}
		if (options.agentId || options.agentName) {
			const identityName = options.agentName ?? options.agentId;
			writeFileSync(join(paths.agentHome, "config", "identity"), `schema_version=1\nname=${identityName}\nrole=secondmate\n`, "utf8");
		}
		if (options.settings) {
			const lines = [];
			if ("autonomy" in options.settings) lines.push(`autonomy=${options.settings.autonomy}`);
			if ("max_turns" in options.settings) lines.push(`max_turns=${options.settings.max_turns}`);
			writeFileSync(join(paths.agentHome, "config", "whiteboard-settings"), lines.join("\n") + "\n", "utf8");
		}
	} else {
		const unnamedHome = join(tempDir, "unnamed-home");
		mkdirSync(unnamedHome, { recursive: true });
		process.env.FM_HOME = unnamedHome;
	}

	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	const pi = {
		zod: zodStub(),
		setLabel() {},
		registerShortcut() {},
		registerTool(spec) { tools.set(spec.name, spec); },
		getActiveTools() { return [...activeTools]; },
		async setActiveTools(names) {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
			activeToolUpdates.push([...activeTools]);
		},
		registerCommand(name, spec) { commands.set(name, spec.handler); },
		on(event, handler) { listeners.set(event, handler); },
		sendMessage(message, sendOptions) {
			messages.push({ message, options: sendOptions });
			for (let i = messageWaiters.length - 1; i >= 0; i--) {
				if (messages.length < messageWaiters[i].count) continue;
				messageWaiters.splice(i, 1)[0].resolve();
			}
			if (options.autoDeliver !== false) {
				listeners.get("before_agent_start")?.({ type: "before_agent_start", prompt: message.content });
			}
		},
	};
	whiteboard(pi);
	const statusUpdates = [];
	const ctx = { hasUI: true, ui: { notify(message, level = "info") { notifications.push({ message, level }); }, setStatus(key, text) { statusUpdates.push({ key, text }); } } };
	return {
		commands,
		listeners,
		notifications,
		messages,
		tools,
		ctx,
		statusUpdates,
		paths,
		waitForMessageCount,
		activeTools: () => [...activeTools],
		activeToolUpdates,
	};
}

const waitForTimers = () => new Promise(resolve => setTimeout(resolve, 10));

/** Wait until predicate becomes true, or fail at deadline. */
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
	throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Wait for message count with a deadline (observable transition, not a fixed sleep). */
function waitForMessages(app, count, timeoutMs = 2000) {
	return Promise.race([
		app.waitForMessageCount(count),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`timeout waiting for ${count} messages (have ${app.messages.length})`)), timeoutMs),
		),
	]);
}

/** Assert count stays put until minDelayMs; used to prove backoff has not fired early. */
async function expectMessageCountHolds(app, count, holdMs) {
	assert.equal(app.messages.length, count);
	const rose = await Promise.race([
		app.waitForMessageCount(count + 1).then(() => true),
		new Promise(resolve => setTimeout(() => resolve(false), holdMs)),
	]);
	assert.equal(rose, false, `message count rose above ${count} within ${holdMs}ms`);
	assert.equal(app.messages.length, count);
}

// Mirrors the production formatClock() in index.ts so footer-badge assertions stay
// in lockstep with whatever the extension actually renders for a given queue time.
const clockLabel = ms => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const COMPACT_TICK_DIRECTIVE = "Board tick: read the diff, do one next action, update the board, checkpoint.";

function directiveBody(content) {
	const lines = content.split("\n");
	const markerIndex = lines.findIndex(line => line.startsWith("[wb-loop:"));
	assert.notEqual(markerIndex, -1, "directive has a wb-loop marker");
	assert.equal(lines[markerIndex - 1], "", "marker is separated from the directive body");
	const bodyEnd = markerIndex - 1;
	let bodyStart = bodyEnd - 1;
	while (bodyStart >= 0 && lines[bodyStart] !== "") bodyStart--;
	return lines.slice(bodyStart + 1, bodyEnd).join("\n");
}

async function command(app, args) {
	await app.commands.get("wb")(args, app.ctx);
}

function startLatestTick(app) {
	const prompt = app.messages.at(-1).message.content;
	app.listeners.get("before_agent_start")({ type: "before_agent_start", prompt });
}

function appCheckpoint(app, outcome, summary) {
	return app.tools.get("whiteboard_checkpoint").execute("cp", { outcome, summary });
}

// ---------------------------------------------------------------------------
// Required: only /wb is registered

test("only /wb is registered - no /whiteboard or /wbl commands exist", { concurrency: false }, t => {
	const app = loadExtension(t, { agentId: "solo" });
	assert.equal(app.commands.has("wb"), true, "/wb must be registered");
	assert.equal(app.commands.has("whiteboard"), false, "/whiteboard must NOT be registered");
	assert.equal(app.commands.has("wbl"), false, "/wbl must NOT be registered");
});

// ---------------------------------------------------------------------------
// Required: exact tool surface

test("exactly whiteboard_read, whiteboard_write, and whiteboard_checkpoint are registered inactive", { concurrency: false }, t => {
	const app = loadExtension(t, { agentId: "solo" });
	for (const name of ["whiteboard_read", "whiteboard_write", "whiteboard_checkpoint"]) {
		assert.equal(app.tools.has(name), true);
		assert.equal(app.tools.get(name).defaultInactive, true);
	}
	// Removed tools must not exist.
	assert.equal(app.tools.has("whiteboard_append"), false);
	assert.equal(app.tools.has("whiteboard_replace"), false);
	assert.equal(app.tools.has("whiteboard_remove_lines"), false);
	assert.equal(app.tools.has("whiteboard_replace_range"), false);
	assert.equal(app.tools.has("whiteboard_replace_section"), false);
	assert.equal(app.tools.has("whiteboard_log_append"), false);
	assert.equal(app.tools.has("whiteboard_schedule"), false);
	assert.deepEqual(app.activeTools(), ["unrelated_tool"]);
});

test("/wb view and status leave inactive whiteboard tools out of the active set", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "view");
	await command(app, "status");
	assert.deepEqual(app.activeTools(), ["unrelated_tool"]);
	assert.equal(app.activeToolUpdates.length, 0);
});

test("/wb loop activates and deactivates whiteboard tools without replacing unrelated tools", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.deepEqual(app.activeTools(), ["unrelated_tool", "whiteboard_read", "whiteboard_write", "whiteboard_checkpoint"]);
	assert.equal(app.messages.length, 1, "tools activate before the first loop turn queues");
	await command(app, "loop");
	assert.deepEqual(app.activeTools(), ["unrelated_tool"]);
});

test("/wb tick and /wb tick! activate for one explicit turn then deactivate", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	for (const verb of ["tick", "tick!"]) {
		await command(app, verb);
		assert.deepEqual(app.activeTools(), ["unrelated_tool", "whiteboard_read", "whiteboard_write", "whiteboard_checkpoint"]);
		await app.listeners.get("agent_end")();
		assert.deepEqual(app.activeTools(), ["unrelated_tool"]);
	}
});

// ---------------------------------------------------------------------------
// Required: /wb subcommand surface

test("/wb help shows exactly the documented verbs and nothing else", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "help");
	const msg = app.notifications.at(-1).message;
	// Documented verbs present.
	assert.match(msg, /\/wb\s+show the current board/);
	assert.match(msg, /loop\s+toggle/);
	assert.match(msg, /tick\s+run one board turn/);
	assert.match(msg, /settings\s+open the settings/);
	assert.match(msg, /status\s+loop on\/off/);
	assert.match(msg, /help\s+this list/);
	// Fast-edit verbs present.
	assert.match(msg, /\/wb rm <line/);
	assert.match(msg, /\/wb rr <line/);
	assert.match(msg, /\/wb rs <heading>/);
	// Old verbs must not appear.
	assert.doesNotMatch(msg, /init/);
	assert.doesNotMatch(msg, /check\b/);
	assert.doesNotMatch(msg, /\/wb add/);
	assert.doesNotMatch(msg, /\/wb set\b/);
	assert.doesNotMatch(msg, /clear\b/);
});

test("unknown verbs fall through to help", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "unknownverb");
	assert.match(app.notifications.at(-1).message, /\/wb\s+show the current board/);
});

// ---------------------------------------------------------------------------
// Fast-edit slash verbs (rm/rr/rs) + \n decoding

test("decodeEscapes turns \\n \\t \\\\ into their characters and leaves other text verbatim", () => {
	assert.equal(decodeEscapes("a\\nb"), "a\nb");
	assert.equal(decodeEscapes("a\\tb"), "a\tb");
	assert.equal(decodeEscapes("a\\\\nb"), "a\\nb");
	assert.equal(decodeEscapes("plain text"), "plain text");
});

test("/wb rr decodes \\n into real newlines (regression: literal-backslash bug)", { concurrency: false }, async t => {
	const app = loadExtension(t);
	writeFileSync(app.paths.global, "# Whiteboard\n\nold line\n", "utf8");
	await command(app, "rr 3 first\\nsecond");
	const content = readFileSync(app.paths.global, "utf8");
	assert.equal(content, "# Whiteboard\n\nfirst\nsecond\n", "\\n must become a real newline, not a literal backslash sequence");
	assert.doesNotMatch(content, /\\n/, "no literal backslash-n may survive on the board");
});

test("/wb rm removes a board line", { concurrency: false }, async t => {
	const app = loadExtension(t);
	writeFileSync(app.paths.global, "# Whiteboard\n\nalpha\nbeta\ngamma\n", "utf8");
	await command(app, "rm 4");
	assert.equal(readFileSync(app.paths.global, "utf8"), "# Whiteboard\n\nalpha\ngamma\n");
});

test("/wb rs replaces a markdown section with decoded \\n", { concurrency: false }, async t => {
	const app = loadExtension(t);
	writeFileSync(app.paths.global, "# Whiteboard\n\n## Plan\n- old\n\n## Notes\nkeep\n", "utf8");
	await command(app, "rs Plan :: ## Plan\\n- one\\n- two");
	const content = readFileSync(app.paths.global, "utf8");
	assert.match(content, /## Plan\n- one\n- two/);
	assert.match(content, /## Notes\nkeep/);
	assert.doesNotMatch(content, /\\n/);
});

test("/wb rr with a bad range reports usage without mutating", { concurrency: false }, async t => {
	const app = loadExtension(t);
	writeFileSync(app.paths.global, "# Whiteboard\n\nkeep\n", "utf8");
	await command(app, "rr notarange text");
	assert.match(app.notifications.at(-1).message, /usage: \/wb rr/);
	assert.equal(readFileSync(app.paths.global, "utf8"), "# Whiteboard\n\nkeep\n");
});

// ---------------------------------------------------------------------------
// /wb loop: skeleton seeding

test("/wb loop seeds a free-form skeleton when the board is absent", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	assert.ok(existsSync(boardPath), "board file must be created");
	const content = readFileSync(boardPath, "utf8");
	assert.match(content, /# Whiteboard/, "seeded board has the title");
	assert.match(content, /newest entries at the bottom/, "seeded skeleton is free-form with the bottom-append hint");
});

test("/wb loop never wipes a populated board that lacks the zone headings (regression)", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\nBear was mid-task here; important notes\n", "utf8");
	await command(app, "loop");
	const content = readFileSync(boardPath, "utf8");
	assert.match(content, /Bear was mid-task here; important notes/, "existing board content must be preserved, never overwritten by the skeleton");
	assert.doesNotMatch(content, /_Nothing yet/, "the empty skeleton must not replace real content");
});

test("/wb loop does not overwrite a board that already has both headings", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	const existing = "# Whiteboard\n\n## Now\n\ncap note\n\n## Working\n\n- item 1\n";
	writeFileSync(boardPath, existing, "utf8");
	await command(app, "loop");
	const content = readFileSync(boardPath, "utf8");
	assert.ok(content.includes("cap note"), "cap content must be preserved");
	assert.ok(content.includes("- item 1"), "working item must be preserved");
});

// ---------------------------------------------------------------------------
// /wb loop: enable and initial tick

test("/wb loop enables the loop and queues exactly one initial turn", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.equal(app.messages.length, 1, "exactly one turn queued");
	assert.equal(app.messages[0].message.customType, "wb-loop");
	assert.equal(app.messages[0].options.deliverAs, "nextTurn");
	assert.equal(app.messages[0].options.triggerTurn, true);
});

test("/wb loop directive identifies the agent and contains the board path", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	const content = app.messages[0].message.content;
	assert.match(content, /Agent: solo/);
	assert.match(content, /data\/whiteboard\.md/);
	assert.equal(directiveBody(content), COMPACT_TICK_DIRECTIVE);
	assert.match(content, /\[wb-loop:solo:1:/, "machine activation token still present");
	assert.doesNotMatch(content, /BOARD-AS-CONVERSATION TURN/, "first tick does not inject the full protocol");
	assert.doesNotMatch(content, /Append your reply at the BOTTOM/, "first tick body stays compact");
});

// ---------------------------------------------------------------------------
// /wb loop: settings loading

test("settings defaults: autonomy on, max_turns 12 when file absent", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await command(app, "status");
	const msg = app.notifications.at(-1).message;
	assert.match(msg, /autonomy=on/);
	assert.match(msg, /max_turns=12/);
});

test("settings file overrides: autonomy=off, max_turns=3", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", settings: { autonomy: "off", max_turns: 3 } });
	await command(app, "loop");
	await command(app, "status");
	const msg = app.notifications.at(-1).message;
	assert.match(msg, /autonomy=off/);
	assert.match(msg, /max_turns=3/);
});

test("settings file: unknown keys are silently ignored", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const settingsPath = join(app.paths.agentHome, "config", "whiteboard-settings");
	writeFileSync(settingsPath, "autonomy=on\nmax_turns=5\nunknown_key=banana\n", "utf8");
	await command(app, "loop");
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /max_turns=5/);
});

// ---------------------------------------------------------------------------
// /wb loop: toggle off

test("/wb loop toggles the loop off and cancels pending work", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.equal(app.messages.length, 1);
	await command(app, "loop");
	assert.equal(app.notifications.at(-1).message, "loop disabled for this session");
	// No further ticks after agent_end.
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
});

test("/wb loop on no identity warns", { concurrency: false }, async t => {
	const app = loadExtension(t);
	await command(app, "loop");
	assert.equal(app.notifications.at(-1).level, "warning");
	assert.match(app.notifications.at(-1).message, /named-agent identity/);
});

test("loopBackoffMs grows exponentially from min and caps at max", () => {
	assert.equal(loopBackoffMs(0, 100, 1000), 100);
	assert.equal(loopBackoffMs(1, 100, 1000), 200);
	assert.equal(loopBackoffMs(3, 100, 1000), 800);
	assert.equal(loopBackoffMs(4, 100, 1000), 1000);
	assert.equal(loopBackoffMs(-5, 100, 1000), 100);
	assert.equal(loopBackoffMs(Number.NaN, 100, 1000), 100);
});

test("an unchanged progress loop backs off instead of hot-spinning", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", loopMinMs: "60", loopMaxMs: "240" });
	await command(app, "loop");
	assert.equal(app.messages.length, 1, "initial tick queues immediately");

	await appCheckpoint(app, "progress", "no board change");
	app.listeners.get("agent_end")();
	await expectMessageCountHolds(app, 1, 20);
	await waitForMessages(app, 2, 500);
	await command(app, "loop");
});

test("a productive board change resets loop backoff", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", loopMinMs: "50", loopMaxMs: "400" });
	await command(app, "loop");
	await appCheckpoint(app, "progress", "idle first turn");
	app.listeners.get("agent_end")();
	await waitForMessages(app, 2, 500);

	await app.tools.get("whiteboard_write").execute("w", {
		text: "# Whiteboard\n\n## Now\n\nagent made progress\n\n## Working\n\n- changed\n",
	});
	await appCheckpoint(app, "progress", "changed board");
	app.listeners.get("agent_end")();
	await waitForMessages(app, 3, 250);
	await command(app, "loop");
});

test("agent whiteboard_write during an active tick does not look like a cap edit", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	t.after(() => _resetWatchDebounce());

	const app = loadExtension(t, { agentId: "solo", autoDeliver: false, loopMinMs: "300", loopMaxMs: "1200" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\n_start_\n\n## Working\n\n_empty_\n", "utf8");

	await command(app, "loop");
	startLatestTick(app);
	await appCheckpoint(app, "progress", "first idle turn");
	app.listeners.get("agent_end")();
	await waitForMessages(app, 2, 1000);

	startLatestTick(app);
	await app.tools.get("whiteboard_write").execute("w", { text: readFileSync(boardPath, "utf8").replace("_empty_", "- agent checked in") });
	const agentBoard = readFileSync(boardPath, "utf8");
	writeFileSync(boardPath, `${agentBoard}\n`);
	writeFileSync(boardPath, agentBoard);
	await appCheckpoint(app, "progress", "second idle turn with self-write");
	app.listeners.get("agent_end")();
	// Self-write must not mint a cap-edit turn; hold through debounce + early backoff window.
	await expectMessageCountHolds(app, 2, 200);
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /consecutive=2/, "self-write must not reset consecutive turn count");

	await command(app, "loop");
});


// ---------------------------------------------------------------------------
// /wb status

test("/wb status shows expected fields when loop is off", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "status");
	const msg = app.notifications.at(-1).message;
	assert.match(msg, /loop disabled/);
	assert.match(msg, /state=disabled/);
	assert.match(msg, /id=solo/);
	assert.match(msg, /autonomy=/);
	assert.match(msg, /max_turns=/);
	assert.match(msg, /consecutive=/);
	assert.match(msg, /ticks=/);
	assert.match(msg, /session-only/);
	assert.match(msg, /open work:/);
});

test("/wb status shows enabled after /wb loop", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /loop enabled/);
	assert.match(app.notifications.at(-1).message, /queued=yes/);
	assert.match(app.notifications.at(-1).message, /state=running/);
});

test("/wb status on unnamed session warns", { concurrency: false }, async t => {
	const app = loadExtension(t);
	await command(app, "status");
	assert.equal(app.notifications.at(-1).level, "warning");
	assert.match(app.notifications.at(-1).message, /no named-agent identity/);
});

// ---------------------------------------------------------------------------
// Unnamed session

test("unnamed session warns on loop", { concurrency: false }, async t => {
	const app = loadExtension(t);
	await command(app, "loop");
	assert.equal(app.notifications.at(-1).level, "warning");
	assert.match(app.notifications.at(-1).message, /named-agent identity/);
	assert.equal(app.messages.length, 0);
});

// ---------------------------------------------------------------------------
// Board resolves to agent board with identity, global fallback without

test("whiteboard_read resolves to agent board when identity present", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const result = await app.tools.get("whiteboard_read").execute("r", { mode: "full" });
	assert.match(result.details.scope, /agent:solo/);
	assert.match(result.details.path, /data\/whiteboard\.md/);
});

test("whiteboard_read resolves to global fallback when no identity", { concurrency: false }, async t => {
	const app = loadExtension(t);
	const result = await app.tools.get("whiteboard_read").execute("r", { mode: "full" });
	assert.equal(result.details.scope, "global");
	assert.equal(result.details.path, app.paths.global);
});

// ---------------------------------------------------------------------------
// whiteboard_read: diff then full

test("whiteboard_read returns full board on first call (no prior lastRead)", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\nhello\n", "utf8");
	const result = await app.tools.get("whiteboard_read").execute("r", {});
	assert.equal(result.details.diff, false, "first read is full board, not diff");
	assert.match(result.content[0].text, /hello/);
});

test("whiteboard_read returns diff on second call when board changed", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\nhello\n", "utf8");
	await app.tools.get("whiteboard_read").execute("r", {});
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\nhello world\n", "utf8");
	const diff = await app.tools.get("whiteboard_read").execute("r", {});
	assert.equal(diff.details.diff, true);
	assert.match(diff.content[0].text, /hello world/);
});

test("whiteboard_read mode:full always returns numbered full board", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\nline two\n", "utf8");
	// First read (would be full anyway).
	await app.tools.get("whiteboard_read").execute("r", {});
	// Second read with mode:full forces full even though lastRead exists.
	const full = await app.tools.get("whiteboard_read").execute("r", { mode: "full" });
	assert.equal(full.details.diff, false);
	assert.match(full.content[0].text, /1  # Whiteboard/);
});

// ---------------------------------------------------------------------------
// whiteboard_write: atomic replace

test("whiteboard_write replaces the board atomically", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await app.tools.get("whiteboard_write").execute("w", {
		text: "# Whiteboard\n\n## Now\n\nagent reply\n\n## Working\n\n- done\n",
	});
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	const content = readFileSync(boardPath, "utf8");
	assert.ok(content.includes("agent reply"));
	assert.ok(content.includes("- done"));
});

// The cap's nvim formats the board on save (prettierd). The whiteboard_write
// tool must normalize the agent's write the same way so both authors converge on
// one canonical shape. Skipped when prettierd is not installed.
test("whiteboard_write formats the agent's write like nvim on save", { concurrency: false }, async t => {
	const { spawnSync } = await import("node:child_process");
	if (spawnSync("prettierd", ["--version"], { encoding: "utf8" }).status !== 0) {
		t.skip("prettierd not installed");
		return;
	}
	const app = loadExtension(t, { agentId: "solo" });
	await app.tools.get("whiteboard_write").execute("w", {
		text: "# Whiteboard\n\n\n## Now\n\nagent reply\n-  a\n-   b\n\n\n\n",
	});
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	const content = readFileSync(boardPath, "utf8");
	// Blank-line runs collapsed, list markers single-spaced, single trailing newline.
	assert.equal(content, "# Whiteboard\n\n## Now\n\nagent reply\n\n- a\n- b\n");
});

test("whiteboard_write updates lastRead so the next whiteboard_read gives a diff", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await app.tools.get("whiteboard_write").execute("w", { text: "# Whiteboard\nv1\n" });
	// Externally change the board.
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	writeFileSync(boardPath, "# Whiteboard\nv2\n", "utf8");
	const diff = await app.tools.get("whiteboard_read").execute("r", {});
	assert.equal(diff.details.diff, true, "write should have updated lastRead so next read is a diff");
	assert.match(diff.content[0].text, /v2/);
});

// ---------------------------------------------------------------------------
// whiteboard_checkpoint outcomes

test("checkpoint progress self-continues when autonomy on and under max_turns", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.equal(app.messages.length, 1);
	const result = await appCheckpoint(app, "progress", "did work");
	assert.equal(result.details.continuing, true);
	assert.equal(result.details.active, true);
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 2, "second tick must have been queued");
});

test("checkpoint settled rests and does not self-continue", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	const result = await appCheckpoint(app, "settled", "objective complete");
	assert.equal(result.details.continuing, false);
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1, "settled must not queue another tick");
});

test("checkpoint needs-decision rests", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "needs-decision", "cap input needed");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
});

test("checkpoint blocked rests", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "blocked", "waiting on external");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
});

test("checkpoint error rests", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "error", "something broke");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
});

test("autonomy=off: progress rests after one turn", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", settings: { autonomy: "off" } });
	await command(app, "loop");
	const result = await appCheckpoint(app, "progress", "did work");
	assert.equal(result.details.continuing, false, "autonomy off means no self-continue");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
});

test("max_turns cap: progress rests once consecutive equals max_turns", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", settings: { max_turns: 2 } });
	await command(app, "loop");

	// Tick 1: progress -> self-continue (consecutive becomes 1).
	await appCheckpoint(app, "progress", "turn 1");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 2);

	// Tick 2: progress -> self-continue (consecutive becomes 2).
	startLatestTick(app);
	await appCheckpoint(app, "progress", "turn 2");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 3);

	// Tick 3: consecutive is now 2 == max_turns=2 -> must rest.
	startLatestTick(app);
	const result = await appCheckpoint(app, "progress", "turn 3 at cap");
	assert.equal(result.details.continuing, false, "at cap consecutive must prevent self-continue");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 3, "no fourth tick - cap reached");
});

test("checkpoint progress increments consecutive counter", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "progress", "t1");
	app.listeners.get("agent_end")();
	await waitForTimers();
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /consecutive=1/);
});

// ---------------------------------------------------------------------------
// Watcher: board change while loop is on queues exactly one turn

test("board file change while loop is on queues exactly one turn", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	t.after(() => _resetWatchDebounce());

	const app = loadExtension(t, { agentId: "solo", autoDeliver: false });
	// Pre-create the board dir+file so the watcher has a stable directory to watch.
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\n_start_\n\n## Working\n\n_empty_\n", "utf8");

	await command(app, "loop");
	assert.equal(app.messages.length, 1, "initial tick queued by loop");

	// Deliver and complete the initial tick so queued=false.
	startLatestTick(app);
	await appCheckpoint(app, "settled", "initial done");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1, "settled: no self-continue");

	// Cap edits the board - direct write, no atomic rename.
	const capEditQueued = app.waitForMessageCount(2);
	writeFileSync(boardPath, readFileSync(boardPath, "utf8") + "\ncap task added\n");
	await capEditQueued;

	assert.equal(app.messages.length, 2, "cap edit must trigger exactly one new turn");
	assert.equal(app.messages[1].message.customType, "wb-loop");
});

test("temporary rename event re-reads the canonical board after an atomic save", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	let onWatch;
	_setFsWatch((_dir, listener) => {
		onWatch = listener;
		return { close() {} };
	});
	const fakeNow = 1_700_000_000_000;
	_setNow(() => fakeNow);
	t.after(() => {
		_resetWatchDebounce();
		_resetFsWatch();
		_resetNow();
	});

	const fixtureId = "fern";
	const ts = clockLabel(fakeNow);
	const app = loadExtension(t, { agentId: fixtureId, autoDeliver: false });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\noriginal\n", "utf8");

	await command(app, "loop");
	startLatestTick(app);
	await appCheckpoint(app, "settled", "initial done");
	app.listeners.get("agent_end")();
	assert.equal(app.messages.length, 1);

	writeFileSync(boardPath, "# Whiteboard\n\natomic cap edit\n", "utf8");
	onWatch("rename", `.whiteboard.md.${process.pid}.tmp`);
	assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 edit \u00b7 ${ts}`);
	await waitForTimers();

	assert.equal(app.messages.length, 2, "the temporary rename event must cause a canonical board re-read");
	assert.equal(app.messages.at(-1).message.customType, "wb-loop");
	assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 queued \u00b7 ${ts}`);
});

test("unrelated parent-directory rename leaves a settled loop resting", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	let onWatch;
	_setFsWatch((_dir, listener) => {
		onWatch = listener;
		return { close() {} };
	});
	const fakeNow = 1_700_000_000_000;
	_setNow(() => fakeNow);
	t.after(() => {
		_resetWatchDebounce();
		_resetFsWatch();
		_resetNow();
	});

	const fixtureId = "fern";
	const ts = clockLabel(fakeNow);
	const app = loadExtension(t, { agentId: fixtureId, autoDeliver: false });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\nunchanged\n", "utf8");

	await command(app, "loop");
	startLatestTick(app);
	await appCheckpoint(app, "settled", "initial done");
	app.listeners.get("agent_end")();
	assert.equal(app.messages.length, 1);
	assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 waiting \u00b7 ${ts}`);

	onWatch("rename", "unrelated.tmp");
	await waitForTimers();

	assert.equal(app.messages.length, 1, "unchanged canonical content must not queue another turn");
	assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 waiting \u00b7 ${ts}`);
});

test("watcher resets consecutive counter when cap edits while loop is active", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	t.after(() => _resetWatchDebounce());

	// Let /wb loop seed the skeleton (creates dir+file atomically), then arm the watcher.
	// Avoid pre-creating the board file so there are no stale FSEvents during the exhaust phase.
	const app = loadExtension(t, { agentId: "solo", settings: { max_turns: 2 }, autoDeliver: false });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");

	await command(app, "loop");
	// Swallow skeleton-write watcher noise while the initial tick is still queued.
	await expectMessageCountHolds(app, 1, 40);

	// Exhaust consecutive turns.
	startLatestTick(app);
	await appCheckpoint(app, "progress", "t1");
	app.listeners.get("agent_end")();
	await waitForTimers();
	startLatestTick(app);
	await appCheckpoint(app, "progress", "t2");
	app.listeners.get("agent_end")();
	await waitForTimers();
	startLatestTick(app);
	await appCheckpoint(app, "progress", "at cap");
	app.listeners.get("agent_end")();
	await expectMessageCountHolds(app, app.messages.length, 40);
	const beforeEdit = app.messages.length;

	// Cap edits -> watcher fires -> resets consecutiveTurns to 0 -> one new turn.
	const capEditQueued = waitForMessages(app, beforeEdit + 1, 1000);
	writeFileSync(boardPath, readFileSync(boardPath, "utf8") + "\ncap directive\n");
	await capEditQueued;

	assert.equal(app.messages.length, beforeEdit + 1, "cap edit queues a fresh turn");
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /consecutive=0/);
});

test("cap-edit tick cancels a pending autonomous timer before terminal rest", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	t.after(() => _resetWatchDebounce());

	const app = loadExtension(t, { agentId: "solo", autoDeliver: false, loopMinMs: "80", loopMaxMs: "400" });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\n_start_\n\n## Working\n\n_empty_\n", "utf8");

	await command(app, "loop");
	startLatestTick(app);
	await appCheckpoint(app, "progress", "idle turn arms autonomous timer");
	app.listeners.get("agent_end")();
	await expectMessageCountHolds(app, 1, 40);

	const capEditQueued = waitForMessages(app, 2, 1000);
	writeFileSync(boardPath, readFileSync(boardPath, "utf8") + "\ncap edit before timer\n");
	await capEditQueued;

	startLatestTick(app);
	await appCheckpoint(app, "settled", "cap-edit tick is terminal");
	app.listeners.get("agent_end")();
	await expectMessageCountHolds(app, 2, 200);
	await command(app, "loop");
});

// ---------------------------------------------------------------------------
// Session events

test("message_start activates a wb-loop message rendered with developer role", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", autoDeliver: false });
	await command(app, "loop");
	const message = app.messages[0].message;

	app.listeners.get("message_start")({
		message: { ...message, role: "developer" },
	});

	const result = await appCheckpoint(app, "settled", "developer-role delivery");
	assert.equal(result.details.active, true, "customType activates regardless of rendered role");
});

test("session_switch clears all loop state", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.equal(app.messages.length, 1);
	await app.listeners.get("session_switch")();
	assert.deepEqual(app.activeTools(), ["unrelated_tool"]);
	// Checkpoint after switch should report no active turn.
	const result = await appCheckpoint(app, "progress", "post-switch");
	assert.equal(result.details.active, false);
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1, "switch must prevent further ticks");
});

test("session_branch clears all loop state", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await app.listeners.get("session_branch")();
	assert.deepEqual(app.activeTools(), ["unrelated_tool"]);
	const result = await appCheckpoint(app, "progress", "post-branch");
	assert.equal(result.details.active, false);
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /loop disabled/);
});

test("session_shutdown stops all loops without clearing runtime", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "progress", "in progress");
	app.listeners.get("agent_end")();
	app.listeners.get("session_shutdown")();
	await waitForTimers();
	assert.equal(app.messages.length, 1, "shutdown prevents further ticks");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1);
});

// ---------------------------------------------------------------------------
// Checkpoint: no active turn

test("checkpoint with no active turn returns active:false", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	// No loop enabled - no active tick.
	const result = await appCheckpoint(app, "progress", "nothing");
	assert.equal(result.details.active, false);
	assert.match(result.content[0].text, /no active loop turn/);
});

test("checkpoint with no identity returns active:false", { concurrency: false }, async t => {
	const app = loadExtension(t);
	const result = await appCheckpoint(app, "settled", "nothing");
	assert.equal(result.details.active, false);
	assert.match(result.content[0].text, /no named-agent identity/);
});

// ---------------------------------------------------------------------------
// Loop tick count and interval

test("tick count increments with each queued turn", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");  // tick 1
	await appCheckpoint(app, "progress", "t1");
	app.listeners.get("agent_end")();
	await waitForTimers();  // tick 2 scheduled
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /ticks=2/);
});

test("interval is measured from tick injection to agent_end", { concurrency: false }, async t => {
	let fakeNow = 10000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());

	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	fakeNow = 15000;  // 5 seconds later
	await appCheckpoint(app, "settled", "done");
	app.listeners.get("agent_end")();
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /last_interval=5\.0s/);
	assert.match(app.notifications.at(-1).message, /last_outcome=settled/);
});

// ---------------------------------------------------------------------------
// Status shows outcome after terminal checkpoint

test("status shows last_outcome after a terminal checkpoint", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "blocked", "waiting on API");
	app.listeners.get("agent_end")();
	await command(app, "status");
	const msg = app.notifications.at(-1).message;
	assert.match(msg, /last_outcome=blocked/);
	assert.match(msg, /last_result=waiting on API/);
});

// ---------------------------------------------------------------------------
// Identity resolution

test("main-firstmate identity (no marker) uses slug of name", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentName: "Keel" });
	await command(app, "loop");
	assert.equal(app.messages.length, 1);
	assert.match(app.messages[0].message.content, /Agent: keel/);
});

test("secondmate marker id takes precedence over slug of name", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "mate", agentName: "Named Mate" });
	await command(app, "loop");
	assert.match(app.messages[0].message.content, /Agent: mate/);
	assert.doesNotMatch(app.messages[0].message.content, /named-mate/);
});

test("marker-only home (no config/identity) has no agent board access", { concurrency: false }, async t => {
	const app = loadExtension(t, { markerOnly: "legacy" });
	await command(app, "loop");
	assert.equal(app.notifications.at(-1).level, "warning");
	assert.match(app.notifications.at(-1).message, /named-agent identity/);
	assert.equal(app.messages.length, 0);
});

// ---------------------------------------------------------------------------
// abort does not self-continue

test("aborted turn does not self-continue", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "progress", "partial");
	app.listeners.get("agent_end")({
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
	});
	await waitForTimers();
	assert.equal(app.messages.length, 1, "abort must not self-continue");
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /loop turn interrupted by user/);
});

// ---------------------------------------------------------------------------
// No checkpoint leaves loop resting

test("no checkpoint provided: loop rests with no-progress outcome", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1, "no checkpoint: must not self-continue");
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /no checkpoint provided/);
});

// ---------------------------------------------------------------------------
// Loop stays enabled (watching) after terminal outcomes

test("loop stays enabled after settled so watcher can trigger next cap turn", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	t.after(() => _resetWatchDebounce());

	const app = loadExtension(t, { agentId: "solo", autoDeliver: false });
	// Pre-create the board dir+file so the watcher has a stable directory.
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\n_start_\n\n## Working\n\n_empty_\n", "utf8");

	await command(app, "loop");
	startLatestTick(app);
	await appCheckpoint(app, "settled", "done");
	app.listeners.get("agent_end")();
	await waitForTimers();

	// Loop is still enabled (enabled=true, queued=false).
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /loop enabled/);

	// Cap edit triggers a new turn.
	const capEditQueued = waitForMessages(app, 2, 1000);
	writeFileSync(boardPath, readFileSync(boardPath, "utf8") + "\nnew cap task\n");
	await capEditQueued;
});

// ---------------------------------------------------------------------------
// /wb tick: manual one-shot turn

test("/wb tick queues one turn without enabling the loop", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "tick");
	assert.equal(app.messages.length, 1, "tick queues exactly one turn");
	assert.equal(app.messages[0].message.customType, "wb-loop");
	await command(app, "status");
	assert.match(app.notifications.at(-1).message, /loop disabled/, "tick must not enable the loop");
});

test("/wb tick does not self-continue after a progress checkpoint", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "tick");
	const result = await appCheckpoint(app, "progress", "one-shot work");
	assert.equal(result.details.active, true, "tick turn is active for checkpoint");
	assert.equal(result.details.continuing, false, "manual tick must not self-continue");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 1, "no second tick - loop is not enabled");
});

test("/wb tick on no identity warns", { concurrency: false }, async t => {
	const app = loadExtension(t);
	await command(app, "tick");
	assert.equal(app.notifications.at(-1).level, "warning");
	assert.match(app.notifications.at(-1).message, /named-agent identity/);
	assert.equal(app.messages.length, 0);
});

// ---------------------------------------------------------------------------
// Directive rendering: per-line fields + since-last-tick cadence delta

test("directive renders header + fields as separate lines, not one bracket blob", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	const content = app.messages[0].message.content;
	const lines = content.split("\n");
	assert.match(lines[0], /^tick 1 \u00b7 Agent: solo \u00b7 /, "header leads with tick + agent + clock");
	assert.ok(lines.some(l => l.startsWith("Board: ")), "board path is on its own line");
	assert.doesNotMatch(content, /\| Agent:/, "no pipe-delimited metadata blob");
	assert.match(content, /\[wb-loop:solo:1:/, "machine activation token still present");
});

test("directive omits the cadence delta on the first tick and shows it on the next", { concurrency: false }, async t => {
	let fakeNow = 100000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");  // tick 1 at 100000
	assert.doesNotMatch(app.messages[0].message.content, /since last tick/, "first tick has no prior to measure from");
	fakeNow = 130000;  // 30s later
	await appCheckpoint(app, "progress", "did work");
	app.listeners.get("agent_end")();
	await waitForTimers();  // adaptive backoff queues tick 2
	assert.equal(app.messages.length, 2, "second tick queued");
	assert.match(app.messages[1].message.content, /\(\+30\.0s since last tick\)/, "second tick shows the inter-tick cadence gap");
});

// ---------------------------------------------------------------------------
// Presence: since-last-edit signal (labeled with $USER)

test("presence signal reads 'just now' on the edit tick, then grows on self-continued ticks", { concurrency: false }, async t => {
	_setWatchDebounce(5);
	t.after(() => _resetWatchDebounce());
	const prevUser = process.env.USER;
	process.env.USER = "cap";
	t.after(() => { if (prevUser === undefined) delete process.env.USER; else process.env.USER = prevUser; });
	let fakeNow = 500000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());

	const app = loadExtension(t, { agentId: "solo", autoDeliver: false });
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n\n## Now\n\n_start_\n\n## Working\n\n_empty_\n", "utf8");

	await command(app, "loop");
	assert.doesNotMatch(app.messages[0].message.content, /edited:/, "no presence field before any human edit");

	// Settle the initial tick so queued=false.
	startLatestTick(app);
	await appCheckpoint(app, "settled", "initial");
	app.listeners.get("agent_end")();
	await waitForTimers();
	const beforeEdit = app.messages.length;

	// Cap edits at fakeNow=500000 -> watcher records the edit time and queues a tick at the same instant.
	const capEditQueued = app.waitForMessageCount(beforeEdit + 1);
	writeFileSync(boardPath, readFileSync(boardPath, "utf8") + "\ncap task\n");
	await capEditQueued;
	assert.equal(app.messages.length, beforeEdit + 1, "cap edit queued a tick");
	assert.match(app.messages.at(-1).message.content, /cap edited: just now/, "edit tick names $USER and reads just now");

	// Agent self-continues 45s later -> presence grows.
	startLatestTick(app);
	fakeNow = 545000;
	await appCheckpoint(app, "progress", "worked");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, beforeEdit + 2, "progress self-continued");
	assert.match(app.messages.at(-1).message.content, /cap edited: 45\.0s ago/, "presence grows to 45s on the self-continued tick");
});

test("directive body is exactly the contracted one-sentence operation", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.equal(directiveBody(app.messages[0].message.content), COMPACT_TICK_DIRECTIVE);
});

// ---------------------------------------------------------------------------
// Compact directive: first, near-successive, and long-gap ticks all stay one sentence

test("near-successive ticks send the contracted compact directive body", { concurrency: false }, async t => {
	let fakeNow = 100000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.equal(directiveBody(app.messages[0].message.content), COMPACT_TICK_DIRECTIVE, "first tick is compact");
	fakeNow = 110000;
	await appCheckpoint(app, "progress", "quick edit");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 2);
	const c2 = app.messages[1].message.content;
	assert.equal(directiveBody(c2), COMPACT_TICK_DIRECTIVE, "second tick is compact");
	assert.doesNotMatch(c2, /BOARD-AS-CONVERSATION TURN/, "near tick omits the full protocol block");
	assert.doesNotMatch(c2, /^\d+\. /m, "near tick omits numbered protocol steps");
	assert.match(c2, /^tick 2 \u00b7 Agent: solo \u00b7 /, "compact keeps the status header");
	assert.match(c2, /\[wb-loop:solo:2:/, "compact keeps the activation token");
});

test("a tick after a long gap still sends the contracted compact directive body", { concurrency: false }, async t => {
	let fakeNow = 100000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	fakeNow = 100000 + 30 * 60 * 1000;
	await appCheckpoint(app, "progress", "resumed after idle");
	app.listeners.get("agent_end")();
	await waitForTimers();
	assert.equal(app.messages.length, 2);
	assert.equal(directiveBody(app.messages[1].message.content), COMPACT_TICK_DIRECTIVE);
	assert.doesNotMatch(app.messages[1].message.content, /BOARD-AS-CONVERSATION TURN/, "a long gap does not re-inject the full protocol");
});

test("directive no longer injects cleanup protocol boilerplate", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.doesNotMatch(app.messages[0].message.content, /delete your own prior lines/, "cleanup protocol is not re-injected in the tick body");
});

// ---------------------------------------------------------------------------
// Interaction-signal metrics (action item #1)

test("agent_end appends an interaction-signal metric line", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await appCheckpoint(app, "settled", "done");
	app.listeners.get("agent_end")();
	await waitForTimers();
	const metricsPath = join(app.paths.agentHome, "state", "whiteboard-metrics.jsonl");
	assert.ok(existsSync(metricsPath), "metrics file created");
	const lines = readFileSync(metricsPath, "utf8").trim().split("\n");
	const rec = JSON.parse(lines.at(-1));
	assert.equal(rec.agent, "solo", "record carries the agent id");
	assert.equal(rec.tick, 1, "record carries the tick number");
	assert.equal(rec.outcome, "settled", "record carries the terminal outcome");
	assert.equal(rec.trigger, "enabled for this session", "record carries the trigger");
	assert.equal(typeof rec.board_lines, "number", "record carries board size");
	assert.equal(rec.board_changed, false, "a turn with no board change records board_changed false");
	assert.ok("gap_ms" in rec && "turn_ms" in rec && "full" in rec && "edit_gap_ms" in rec, "record carries the cadence/duration/full/presence signals");
});

test("metric records board_changed true when the turn changed the board", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	await app.tools.get("whiteboard_write").execute("w", { text: "# Whiteboard\n\nagent changed the board this turn\n" });
	await appCheckpoint(app, "progress", "did real work");
	app.listeners.get("agent_end")();
	await waitForTimers();
	const metricsPath = join(app.paths.agentHome, "state", "whiteboard-metrics.jsonl");
	const rec = JSON.parse(readFileSync(metricsPath, "utf8").trim().split("\n").at(-1));
	assert.equal(rec.board_changed, true, "a turn that changed the board records verified output (board_changed true)");
});

test("directive Board field reports the board line count", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	assert.match(app.messages[0].message.content, /Board: .*\(\d+ lines\)/, "board field shows the line count as a compaction cue");
});

test("directive body stays compact while status metadata remains present", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "loop");
	const content = app.messages[0].message.content;
	assert.match(content, /^tick 1 \u00b7 Agent: solo \u00b7 /, "status header remains present");
	assert.match(content, /^Board: .*data\/whiteboard\.md \(\d+ lines\)$/m, "board metadata remains present");
	assert.equal(directiveBody(content), COMPACT_TICK_DIRECTIVE);
});

test("/wb tick now interrupts with a steer delivery instead of nextTurn", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "tick now");
	assert.equal(app.messages.at(-1).options.deliverAs, "steer", "tick now delivers as a steer to interrupt the current turn");
});

test("/wb tick now coalesces when a tick is already pending delivery", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", autoDeliver: false });
	await command(app, "loop");
	const before = app.messages.length;
	await command(app, "tick now");
	await command(app, "tick");
	assert.equal(app.messages.length, before, "manual ticks do not stack behind an undelivered tick");
	assert.match(app.notifications.at(-2).message, /interrupt already queued/);
	assert.match(app.notifications.at(-1).message, /tick already queued/);
});

test("repeated /wb tick now requests coalesce to one steer behind an active tick", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo", autoDeliver: false });
	await command(app, "loop");
	startLatestTick(app);
	const before = app.messages.length;

	await command(app, "tick now");
	assert.equal(app.messages.length, before + 1, "the first request queues one interrupt");
	assert.equal(app.messages.at(-1).options.deliverAs, "steer");

	await command(app, "tick now");
	await command(app, "tick!");
	assert.equal(app.messages.length, before + 1, "duplicate interrupt requests collapse into the pending steer");
	assert.match(app.notifications.at(-1).message, /interrupt already queued/);
});

test("footer badge resolves distinct runtime identities and hides when disabled", { concurrency: false }, async t => {
	const fixtureIds = ["fern", "cedar"];
	const fakeNow = 1_700_000_000_000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());
	const ts = clockLabel(fakeNow);
	for (const fixtureId of fixtureIds) {
		const app = loadExtension(t, { agentId: fixtureId, autoDeliver: false });
		const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
		mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
		writeFileSync(boardPath, "# Whiteboard\n", "utf8");

		await command(app, "loop");
		assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 queued \u00b7 ${ts}`);

		startLatestTick(app);
		assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 running \u00b7 ${ts}`);

		await appCheckpoint(app, "settled", "done");
		app.listeners.get("agent_end")();
		assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 waiting \u00b7 ${ts}`);

		for (const update of app.statusUpdates.filter(update => typeof update.text === "string")) {
			assert.doesNotMatch(update.text, /\bt\d+\b/i);
		}

		await command(app, "loop");
		assert.equal(app.statusUpdates.at(-1).key, "wb-loop");
		assert.equal(app.statusUpdates.at(-1).text, undefined, "disabling the loop clears the footer badge");
	}
});

test("scheduled continuation footer shows a real decrementing countdown", { concurrency: false }, async t => {
	const fixtureId = "maple";
	const app = loadExtension(t, {
		agentId: fixtureId,
		autoDeliver: false,
		loopMinMs: "1500",
		loopMaxMs: "1500",
	});
	const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
	mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
	writeFileSync(boardPath, "# Whiteboard\n", "utf8");

	const queuedAt = Date.now();
	await command(app, "loop");
	const ts = clockLabel(queuedAt);
	startLatestTick(app);
	await appCheckpoint(app, "progress", "continue");
	app.listeners.get("agent_end")();
	assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 2s \u00b7 ${ts}`, "timestamp is the latest queued tick, not the live clock");

	const expected = `WB ${fixtureId} \u00b7 1s \u00b7 ${ts}`;
	await waitUntil(
		() => app.statusUpdates.at(-1)?.text === expected,
		{ timeoutMs: 2000, label: "countdown status refresh to 1s" },
	);
	assert.equal(app.statusUpdates.at(-1).text, expected, "timestamp stays stable across countdown refreshes");

	await command(app, "loop");
	assert.equal(app.statusUpdates.at(-1).text, undefined);
});

test("terminal checkpoint outcomes all rest with a waiting footer", { concurrency: false }, async t => {
	const outcomes = ["settled", "needs-decision", "blocked", "error"];
	const fakeNow = 1_700_000_000_000;
	_setNow(() => fakeNow);
	t.after(() => _resetNow());
	const ts = clockLabel(fakeNow);
	for (const outcome of outcomes) {
		const fixtureId = `fixture-${outcome}`;
		const app = loadExtension(t, { agentId: fixtureId, autoDeliver: false });
		const boardPath = join(app.paths.agentHome, "data", "whiteboard.md");
		mkdirSync(join(app.paths.agentHome, "data"), { recursive: true });
		writeFileSync(boardPath, "# Whiteboard\n", "utf8");

		await command(app, "loop");
		startLatestTick(app);
		await appCheckpoint(app, outcome, "rest");
		app.listeners.get("agent_end")();
		assert.equal(app.statusUpdates.at(-1).text, `WB ${fixtureId} \u00b7 waiting \u00b7 ${ts}`);
		await command(app, "loop");
	}
});

test("a manual /wb tick with the loop off does not set a footer status", { concurrency: false }, async t => {
	const app = loadExtension(t, { agentId: "solo" });
	await command(app, "tick");
	const set = app.statusUpdates.filter(u => u.key === "wb-loop" && typeof u.text === "string");
	assert.equal(set.length, 0, "a manual one-shot tick (loop disabled) shows no whiteboard badge");
});
