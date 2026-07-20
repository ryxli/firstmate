import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
	_resetSpawn,
	_setSpawn,
	formatMarkdown,
} from "../../.omp/extensions/whiteboard/format.ts";

const BOARD = "/tmp/whiteboard-format-test/whiteboard.md";

// Build a fake spawnSync return with just the fields formatMarkdown reads.
function ret(over: Partial<{ status: number; stdout: string; error: Error }>) {
	return { status: 0, stdout: "", error: undefined, ...over } as ReturnType<typeof spawnSync>;
}

describe("formatMarkdown decision logic", () => {
	test("returns the formatter's output on success", () => {
		_setSpawn(() => ret({ status: 0, stdout: "# Clean\n\nbody\n" }));
		try {
			expect(formatMarkdown("#Clean\n\n\nbody", BOARD)).toBe("# Clean\n\nbody\n");
		} finally {
			_resetSpawn();
		}
	});

	test("passes the board path so the markdown parser is selected", () => {
		const seen: { cmd: string; args: string[] }[] = [];
		_setSpawn((cmd, args) => {
			seen.push({ cmd, args });
			return ret({ status: 0, stdout: "ok\n" });
		});
		try {
			formatMarkdown("x", BOARD);
			expect(seen[0].cmd).toBe("prettierd");
			expect(seen[0].args).toEqual([BOARD]);
		} finally {
			_resetSpawn();
		}
	});

	test("falls back to the raw text when the formatter exits non-zero", () => {
		_setSpawn(() => ret({ status: 2, stdout: "Error: broken\n" }));
		try {
			expect(formatMarkdown("keep me", BOARD)).toBe("keep me");
		} finally {
			_resetSpawn();
		}
	});

	test("falls back when the binary is missing (spawn error)", () => {
		_setSpawn(() => ret({ status: null as unknown as number, error: new Error("ENOENT") }));
		try {
			expect(formatMarkdown("keep me", BOARD)).toBe("keep me");
		} finally {
			_resetSpawn();
		}
	});

	test("falls back when spawn throws", () => {
		_setSpawn(() => {
			throw new Error("boom");
		});
		try {
			expect(formatMarkdown("keep me", BOARD)).toBe("keep me");
		} finally {
			_resetSpawn();
		}
	});

	test("never returns empty output from the formatter", () => {
		_setSpawn(() => ret({ status: 0, stdout: "   \n" }));
		try {
			expect(formatMarkdown("real content", BOARD)).toBe("real content");
		} finally {
			_resetSpawn();
		}
	});

	test("tries the next formatter after the first fails (stop-after-first)", () => {
		const calls: string[] = [];
		_setSpawn((cmd) => {
			calls.push(cmd);
			if (cmd === "prettierd") return ret({ status: 1, stdout: "" });
			return ret({ status: 0, stdout: "via prettier\n" });
		});
		try {
			expect(formatMarkdown("x", BOARD)).toBe("via prettier\n");
			expect(calls).toEqual(["prettierd", "prettier"]);
		} finally {
			_resetSpawn();
		}
	});

	test("stops at the first successful formatter", () => {
		const calls: string[] = [];
		_setSpawn((cmd) => {
			calls.push(cmd);
			return ret({ status: 0, stdout: "done\n" });
		});
		try {
			formatMarkdown("x", BOARD);
			expect(calls).toEqual(["prettierd"]);
		} finally {
			_resetSpawn();
		}
	});

	test("skips the subprocess entirely for empty input", () => {
		let called = false;
		_setSpawn(() => {
			called = true;
			return ret({ status: 0, stdout: "x" });
		});
		try {
			expect(formatMarkdown("   \n", BOARD)).toBe("   \n");
			expect(called).toBe(false);
		} finally {
			_resetSpawn();
		}
	});
});

// End-to-end against the real formatter the captain's nvim uses. Skipped when no
// formatter is installed so the suite stays green on a bare machine.
const hasPrettierd = spawnSync("prettierd", ["--version"], { encoding: "utf8" }).status === 0;
const e2e = hasPrettierd ? test : test.skip;

describe("formatMarkdown end-to-end", () => {
	e2e("normalizes list markers and blank-line runs like nvim on save", () => {
		const messy = "# Title\n\n\nsome text\n-  a\n-   b\n\n\n\n## H2\n1.  one\n2.  two\n";
		const out = formatMarkdown(messy, BOARD);
		expect(out).toBe("# Title\n\nsome text\n\n- a\n- b\n\n## H2\n\n1.  one\n2.  two\n");
	});

	e2e("preserves the sentence-per-line prose convention (proseWrap preserve)", () => {
		const prose = "# Notes\n\nFirst sentence here.\nSecond sentence on its own line.\n";
		const out = formatMarkdown(prose, BOARD);
		expect(out).toBe(prose);
	});

	e2e("is idempotent on already-formatted content", () => {
		const clean = "# Title\n\n- a\n- b\n";
		expect(formatMarkdown(formatMarkdown(clean, BOARD), BOARD)).toBe(clean);
	});
});
