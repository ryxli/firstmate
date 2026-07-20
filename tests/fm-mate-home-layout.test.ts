// Canonical mate-home layout contract behavior.
// Run: bun test tests/fm-mate-home-layout.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	MATE_HOME_DATA_CHILD_DIRS,
	MATE_HOME_ROOT_DIRS,
	checkMateHomeLayout,
	ensureMateHomeLayout,
	mateHomeRequiredRelPaths,
	repairMateHomeLayout,
} from "../.omp/extensions/cli/lib/mate-home-layout";

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "fm-mate-layout-"));
}

describe("mate-home layout manifest", () => {
	it("lists each required root and data child exactly once", () => {
		const roots = [...MATE_HOME_ROOT_DIRS];
		const children = [...MATE_HOME_DATA_CHILD_DIRS];
		expect(new Set(roots).size).toBe(roots.length);
		expect(new Set(children).size).toBe(children.length);
		expect(roots).toEqual(["bin", "config", "state", "data", "projects", "worktrees", "work", "tmp", ".lavish"]);
		expect(children).toEqual(["knowledge", "reports", "evidence", "archive"]);
		const required = mateHomeRequiredRelPaths();
		expect(new Set(required).size).toBe(required.length);
		expect(required).toEqual([
			"bin",
			"config",
			"state",
			"data",
			"projects",
			"worktrees",
			"work",
			"tmp",
			".lavish",
			"data/knowledge",
			"data/reports",
			"data/evidence",
			"data/archive",
		]);
	});
});

describe("mate-home layout seed/check/repair", () => {
	it("provisions the complete structure for a new home", () => {
		const home = tempHome();
		try {
			const result = ensureMateHomeLayout(home);
			expect(result.ok).toBe(true);
			expect(result.created.sort()).toEqual(mateHomeRequiredRelPaths().sort());
			expect(checkMateHomeLayout(home).ok).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("check succeeds for a complete home", () => {
		const home = tempHome();
		try {
			ensureMateHomeLayout(home);
			expect(checkMateHomeLayout(home)).toEqual({ ok: true, issues: [] });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("check reports every missing required directory", () => {
		const home = tempHome();
		try {
			mkdirSync(home, { recursive: true });
			const checked = checkMateHomeLayout(home);
			expect(checked.ok).toBe(false);
			expect(checked.issues.map(issue => issue.rel).sort()).toEqual(mateHomeRequiredRelPaths().sort());
			expect(checked.issues.every(issue => issue.code === "missing")).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("check reports every missing required directory after provisioning then cleanup", () => {
		const home = tempHome();
		try {
			ensureMateHomeLayout(home);
			rmSync(join(home, "bin"), { recursive: true, force: true });
			rmSync(join(home, "config"), { recursive: true, force: true });
			rmSync(join(home, "state"), { recursive: true, force: true });
			rmSync(join(home, "data"), { recursive: true, force: true });
			rmSync(join(home, "projects"), { recursive: true, force: true });
			rmSync(join(home, "worktrees"), { recursive: true, force: true });
			rmSync(join(home, "work"), { recursive: true, force: true });
			rmSync(join(home, "tmp"), { recursive: true, force: true });
			rmSync(join(home, ".lavish"), { recursive: true, force: true });
			const checked = checkMateHomeLayout(home);
			expect(checked.ok).toBe(false);
			expect(checked.issues.map(issue => issue.rel).sort()).toEqual(mateHomeRequiredRelPaths().sort());
			expect(checked.issues.every(issue => issue.code === "missing")).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("repair creates missing directories", () => {
		const home = tempHome();
		try {
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(true);
			expect(repaired.created.sort()).toEqual(mateHomeRequiredRelPaths().sort());
			expect(checkMateHomeLayout(home).ok).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("blocks repair when a regular file occupies a required directory path", () => {
		const home = tempHome();
		try {
			writeFileSync(join(home, "bin"), "not-a-directory\n");
			const before = readFileSync(join(home, "bin"), "utf8");
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.issues.some(issue => issue.rel === "bin" && issue.code === "conflicting-file")).toBe(true);
			expect(repaired.created).toEqual([]);
			expect(readFileSync(join(home, "bin"), "utf8")).toBe(before);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("blocks repair when an unsafe symlink occupies a required directory path", () => {
		const home = tempHome();
		const outside = tempHome();
		try {
			const target = join(outside, "escape-target");
			mkdirSync(target, { recursive: true });
			symlinkSync(target, join(home, "work"));
			const before = readlinkSync(join(home, "work"));
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.issues.some(issue => issue.rel === "work" && issue.code === "unsafe-symlink")).toBe(true);
			expect(lstatSync(join(home, "work")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(home, "work"))).toBe(before);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("blocks repair when a late conflict exists and creates nothing", () => {
		const home = tempHome();
		try {
			writeFileSync(join(home, "tmp"), "late-conflict\n");
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.created).toEqual([]);
			expect(existsSync(join(home, "bin"))).toBe(false);
			expect(readFileSync(join(home, "tmp"), "utf8")).toBe("late-conflict\n");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("blocks before creating roots when a data child conflicts", () => {
		const home = tempHome();
		try {
			mkdirSync(join(home, "data", "knowledge"), { recursive: true });
			writeFileSync(join(home, "data", "reports"), "conflict\n");
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.created).toEqual([]);
			expect(existsSync(join(home, "bin"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns a structured failure for a dangling required symlink", () => {
		const home = tempHome();
		try {
			symlinkSync(join(home, "missing-target"), join(home, "work"));
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.created).toEqual([]);
			expect(repaired.issues.some(issue => issue.rel === "work" && issue.code === "unsafe-symlink")).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns a structured failure for a regular file at data", () => {
		const home = tempHome();
		try {
			writeFileSync(join(home, "data"), "not-a-directory\n");
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.created).toEqual([]);
			expect(repaired.issues.some(issue => issue.rel === "data" && issue.code === "conflicting-file")).toBe(true);
			expect(repaired.issues.some(issue => issue.rel === "data/knowledge")).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not create target directories when an outward data symlink is missing children", () => {
		const home = tempHome();
		const outside = tempHome();
		try {
			const target = join(outside, "data-target");
			mkdirSync(target, { recursive: true });
			symlinkSync(target, join(home, "data"));
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(false);
			expect(repaired.created).toEqual([]);
			expect(repaired.issues.some(issue => issue.rel === "data" && issue.code === "unsafe-symlink")).toBe(true);
			expect(lstatSync(join(outside, "data-target")).isDirectory()).toBe(true);
			expect(() => lstatSync(join(outside, "data-target", "knowledge"))).toThrow();
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("preserves existing files inside required directories byte-for-byte across repair", () => {
		const home = tempHome();
		try {
			ensureMateHomeLayout(home);
			const markerPath = join(home, "data", "knowledge", "note.txt");
			const payload = "keep-me-byte-exact\nsecond-line\n";
			writeFileSync(markerPath, payload);
			const repaired = repairMateHomeLayout(home);
			expect(repaired.ok).toBe(true);
			expect(repaired.created).toEqual([]);
			expect(readFileSync(markerPath, "utf8")).toBe(payload);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("uses the same canonical contract for main-home and secondmate-home paths", () => {
		const main = tempHome();
		const second = tempHome();
		try {
			writeFileSync(join(second, ".fm-secondmate-home"), "riggs\n");
			const mainResult = ensureMateHomeLayout(main);
			const secondResult = ensureMateHomeLayout(second);
			expect(mainResult.created.sort()).toEqual(secondResult.created.sort());
			expect(checkMateHomeLayout(main).ok).toBe(true);
			expect(checkMateHomeLayout(second).ok).toBe(true);
			expect(mateHomeRequiredRelPaths()).toEqual(mateHomeRequiredRelPaths());
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});
});
