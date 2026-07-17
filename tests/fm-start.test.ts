// Regression tests for .omp/extensions/cli/verbs/start.ts.
// Run: bun test tests/fm-start.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import start from "../.omp/extensions/cli/verbs/start";

const REPO_ROOT = import.meta.dir.replace(/\/tests$/, "");
const originalEnv = { FM_HOME: process.env.FM_HOME, PATH: process.env.PATH };
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalEnv.FM_HOME === undefined) delete process.env.FM_HOME;
	else process.env.FM_HOME = originalEnv.FM_HOME;
	if (originalEnv.PATH === undefined) delete process.env.PATH;
	else process.env.PATH = originalEnv.PATH;
});

function launchCwd(home?: string): string {
	const temp = mkdtempSync(join(tmpdir(), "fm-start-test-"));
	tempDirs.push(temp);
	const bin = join(temp, "bin");
	mkdirSync(bin);
	const output = join(temp, "cwd");
	const omp = join(bin, "omp");
	writeFileSync(omp, `#!/bin/sh\nprintf '%s' "$PWD" > "$FM_START_TEST_OUTPUT"\n`);
	chmodSync(omp, 0o755);
	process.env.PATH = bin;
	if (home === undefined) delete process.env.FM_HOME;
	else process.env.FM_HOME = home;
	process.env.FM_START_TEST_OUTPUT = output;

	expect(start.run(["start"])).toBe(0);
	return readFileSync(output, "utf8");
}

describe("fm start launch root", () => {
	it("uses the registered FM_HOME as OMP's cwd", () => {
		const home = mkdtempSync(join(tmpdir(), "fm-start-home-"));
		tempDirs.push(home);
		expect(launchCwd(home)).toBe(realpathSync(home));
	});

	it("uses the repository root when FM_HOME is absent", () => {
		expect(launchCwd()).toBe(REPO_ROOT);
	});
});
