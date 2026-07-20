import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as board from "../board.ts";
import * as config from "../config.ts";

// Helper: sets up a temp board environment, runs fn, then cleans up regardless.
function withTempBoard(fn) {
	return async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "whiteboard-ext-"));
		const previous = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			WHITEBOARD_FILE: process.env.WHITEBOARD_FILE,
			FM_HOME: process.env.FM_HOME,
		};
		delete process.env.FM_HOME;
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.WHITEBOARD_FILE = join(tempDir, "whiteboard.md");
		try {
			await fn({ tempDir, boardFile: process.env.WHITEBOARD_FILE });
		} finally {
			if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
			if (previous.WHITEBOARD_FILE === undefined) delete process.env.WHITEBOARD_FILE;
			else process.env.WHITEBOARD_FILE = previous.WHITEBOARD_FILE;
			if (previous.FM_HOME === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = previous.FM_HOME;
			rmSync(tempDir, { recursive: true, force: true });
		}
	};
}

test("read returns empty string for a missing board", withTempBoard(() => {
	assert.equal(board.read(), "");
}));

test("append creates the header and read returns the new board", withTempBoard(({ boardFile }) => {
	const next = board.append("First note");
	assert.equal(next, "# Whiteboard\n\nFirst note\n");
	assert.equal(readFileSync(boardFile, "utf8"), "# Whiteboard\n\nFirst note\n");
	assert.equal(board.read(), "# Whiteboard\n\nFirst note\n");
}));

test("append adds separated blocks", withTempBoard(() => {
	board.append("First note");
	const next = board.append("Second note");
	assert.equal(next, "# Whiteboard\n\nFirst note\n\nSecond note\n");
}));

test("replace overwrites the board", withTempBoard(() => {
	board.append("First note");
	const next = board.replace("Replacement");
	assert.equal(next, "Replacement");
	assert.equal(board.read(), "Replacement");
}));

test("explicit file paths isolate board operations from the global default", withTempBoard(({ tempDir, boardFile }) => {
	const scopedFile = join(tempDir, "scoped", "whiteboard.md");
	assert.equal(board.append("Global note"), "# Whiteboard\n\nGlobal note\n");
	assert.equal(board.append("Scoped note", scopedFile), "# Whiteboard\n\nScoped note\n");
	assert.equal(board.replaceRange(3, 3, "Scoped done", scopedFile), "# Whiteboard\n\nScoped done\n");
	assert.equal(board.read(scopedFile), "# Whiteboard\n\nScoped done\n");
	assert.equal(readFileSync(boardFile, "utf8"), "# Whiteboard\n\nGlobal note\n");
	assert.equal(board.path(scopedFile), scopedFile);
}));

test("diffSince returns only changed line window", () => {
	const before = "# Whiteboard\n\nAlpha\nBeta\nGamma\n";
	const after = "# Whiteboard\n\nAlpha\nBeta changed\nGamma\nDelta\n";
	assert.equal(board.diffSince(before, after), [
		"changed new lines 4-6; replaced old lines 4-5",
		"added/current:",
		"4  Beta changed",
		"5  Gamma",
		"6  Delta",
		"removed/previous:",
		"4  Beta",
		"5  Gamma",
	].join("\n"));
});

test("diffSince reports no changes", () => {
	assert.equal(board.diffSince("same\n", "same\n"), "(no whiteboard changes since last read)");
});

test("clear resets the board to the bare header", withTempBoard(() => {
	board.replace("Replacement");
	const next = board.clear();
	assert.equal(next, board.HEADER);
	assert.equal(board.read(), board.HEADER);
}));

test("atomic replace leaves no temp file behind", withTempBoard(({ tempDir, boardFile }) => {
	board.replace("Replacement");
	assert.equal(readFileSync(boardFile, "utf8"), "Replacement");
	assert.deepEqual(readdirSync(tempDir).filter(name => name.includes(".whiteboard.")), []);
}));

test("append over the size cap rejects with no write", withTempBoard(() => {
	board.append("seed");
	const before = board.read();
	assert.throws(() => board.append("x".repeat(board.MAX_BYTES)), /64 KB/);
	assert.equal(board.read(), before);
}));

test("replace over the size cap rejects with no write", withTempBoard(() => {
	const oversized = "x".repeat(board.MAX_BYTES + 1);
	assert.throws(() => board.replace(oversized), /64 KB/);
	assert.equal(board.read(), "");
}));

test("path resolution honors PI_CODING_AGENT_DIR and WHITEBOARD_FILE", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "whiteboard-config-"));
	const previous = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		WHITEBOARD_FILE: process.env.WHITEBOARD_FILE,
		FM_HOME: process.env.FM_HOME,
	};
	try {
		delete process.env.FM_HOME;
		delete process.env.WHITEBOARD_FILE;
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent-root");
		assert.equal(config.agentDir(), join(tempDir, "agent-root"));
		assert.equal(config.boardPath(), join(tempDir, "agent-root", "whiteboard.md"));
		assert.equal(board.path(), join(tempDir, "agent-root", "whiteboard.md"));

		process.env.WHITEBOARD_FILE = join(tempDir, "custom-board.md");
		assert.equal(config.boardPath(), join(tempDir, "custom-board.md"));
		assert.equal(board.path(), join(tempDir, "custom-board.md"));
	} finally {
		if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
		if (previous.WHITEBOARD_FILE === undefined) delete process.env.WHITEBOARD_FILE;
		else process.env.WHITEBOARD_FILE = previous.WHITEBOARD_FILE;
		if (previous.FM_HOME === undefined) delete process.env.FM_HOME;
		else process.env.FM_HOME = previous.FM_HOME;
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("scope resolution supports global and agent boards without domain", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "whiteboard-scope-"));
	const home = join(tempDir, "mate");
	const previous = {
		FM_HOME: process.env.FM_HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		WHITEBOARD_FILE: process.env.WHITEBOARD_FILE,
	};
	try {
		process.env.WHITEBOARD_FILE = join(tempDir, "global.md");
		process.env.FM_HOME = home;
		delete process.env.PI_CODING_AGENT_DIR;
		mkdirSync(join(home, "config"), { recursive: true });
		writeFileSync(join(home, ".fm-secondmate-home"), "solo\n", "utf8");
		writeFileSync(join(home, "config", "identity"), "schema_version=1\nname=solo\nrole=secondmate\n", "utf8");

		assert.equal(config.currentAgentHome(), home);
		assert.equal(config.agentScope().label, "agent:solo");
		assert.equal(config.agentScope().path, join(home, "data", "whiteboard.md"));
		assert.equal(config.defaultScope().label, "agent:solo");
		assert.equal(config.defaultScope().path, join(home, "data", "whiteboard.md"));
		assert.equal(config.globalScope().path, join(tempDir, "global.md"));

		// No domain concept.
		assert.equal(typeof config.currentDomainConfig, "undefined");
		assert.equal(typeof config.domainScope, "undefined");
	} finally {
		if (previous.FM_HOME === undefined) delete process.env.FM_HOME;
		else process.env.FM_HOME = previous.FM_HOME;
		if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
		if (previous.WHITEBOARD_FILE === undefined) delete process.env.WHITEBOARD_FILE;
		else process.env.WHITEBOARD_FILE = previous.WHITEBOARD_FILE;
		rmSync(tempDir, { recursive: true, force: true });
	}
});
