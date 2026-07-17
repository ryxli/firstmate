// Regression tests for .omp/extensions/cli/verbs/start.ts.
// Run: bun test tests/fm-start.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import start from "../.omp/extensions/cli/verbs/start";

const REPO_ROOT = import.meta.dir.replace(/\/tests$/, "");
const originalEnv = { FM_HOME: process.env.FM_HOME, FM_START_TEST_OUTPUT: process.env.FM_START_TEST_OUTPUT, PATH: process.env.PATH };
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalEnv.FM_HOME === undefined) delete process.env.FM_HOME;
	else process.env.FM_HOME = originalEnv.FM_HOME;
	if (originalEnv.FM_START_TEST_OUTPUT === undefined) delete process.env.FM_START_TEST_OUTPUT;
	else process.env.FM_START_TEST_OUTPUT = originalEnv.FM_START_TEST_OUTPUT;
	if (originalEnv.PATH === undefined) delete process.env.PATH;
	else process.env.PATH = originalEnv.PATH;
});

interface LaunchResult {
	cwd: string;
	marker: string;
	appendSystemPrompt: string;
	kickoff: string;
	argc: string;
}

function launch(home?: string): LaunchResult {
	const temp = mkdtempSync(join(tmpdir(), "fm-start-test-"));
	tempDirs.push(temp);
	const bin = join(temp, "bin");
	mkdirSync(bin);
	const output = join(temp, "launch");
	const omp = join(bin, "omp");
	writeFileSync(omp, `#!/bin/sh
printf '%s' "$PWD" > "$FM_START_TEST_OUTPUT.cwd"
printf '%s' "\${FM_SUPERVISED_SUCCESSOR:-}" > "$FM_START_TEST_OUTPUT.marker"
printf '%s' "$#" > "$FM_START_TEST_OUTPUT.argc"
i=0
for arg in "$@"; do
  printf '%s' "$arg" > "$FM_START_TEST_OUTPUT.arg$i"
  i=$((i + 1))
done
`);
	chmodSync(omp, 0o755);
	process.env.PATH = bin;
	if (home === undefined) delete process.env.FM_HOME;
	else process.env.FM_HOME = home;
	process.env.FM_START_TEST_OUTPUT = output;

	expect(start.run(["start"])).toBe(0);
	return {
		cwd: readFileSync(`${output}.cwd`, "utf8"),
		marker: readFileSync(`${output}.marker`, "utf8"),
		appendSystemPrompt: readFileSync(`${output}.arg0`, "utf8"),
		kickoff: readFileSync(`${output}.arg1`, "utf8"),
		argc: readFileSync(`${output}.argc`, "utf8"),
	};
}

describe("fm start launch root", () => {
	it("uses the registered FM_HOME as OMP's cwd", () => {
		const home = mkdtempSync(join(tmpdir(), "fm-start-home-"));
		tempDirs.push(home);
		expect(launch(home).cwd).toBe(realpathSync(home));
	});

	it("uses the repository root when FM_HOME is absent", () => {
		expect(launch().cwd).toBe(REPO_ROOT);
	});
});

describe("fm start supervised successor contract", () => {
	it("propagates the supervised-successor marker and unambiguous lock-result branches", () => {
		const result = launch();
		expect(result.marker).toBe("1");
		expect(result.argc).toBe("2");
		expect(result.appendSystemPrompt).toContain("--append-system-prompt=");
		expect(result.appendSystemPrompt).toContain("FM_SUPERVISED_SUCCESSOR=1");
		expect(result.appendSystemPrompt).toContain("Your first startup action is to run `fm lock` before any repair, bootstrap, patch, reload, update, file write, registry change, pane mutation, or other mutation");
		expect(result.appendSystemPrompt).toContain("If `fm lock` prints `lock acquired`, this session has authority: proceed with the normal full startup sequence");
		expect(result.appendSystemPrompt).toContain("If `fm lock` prints `lock unchanged`, another live firstmate retains authority: remain read-only, skip bootstrap, repair, reload, update, and every other mutation");
		expect(result.appendSystemPrompt).toContain("do not claim shared write authority, do not steal the lock automatically");
		expect(result.appendSystemPrompt).toContain("report ready for handoff");
		expect(result.kickoff).toContain("run `fm lock` first");
		expect(result.kickoff).toContain("If it prints `lock acquired`, proceed with the normal full startup sequence");
		expect(result.kickoff).toContain("If it prints `lock unchanged`, remain read-only, skip bootstrap, repair, reload, update, and every other mutation");
		expect(result.kickoff).toContain("report ready for handoff");
	});
});
