// Behavioral tests for sbin/fm-context-weight.
// Run: bun test tests/fm-context-weight.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countTokens } from "../benchmarks/tokenizer.ts";

const COMMAND = join(import.meta.dir, "..", "sbin", "fm-context-weight");
const homes: string[] = [];

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

function tree(root: string): string[] {
	const entries: string[] = [];
	function visit(path: string, prefix: string): void {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const label = join(prefix, entry.name);
			entries.push(entry.isDirectory() ? `${label}/` : `${label}:${readFileSync(join(path, entry.name), "utf8")}`);
			if (entry.isDirectory()) visit(join(path, entry.name), label);
		}
	}
	visit(root, "");
	return entries.sort();
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("fm-context-weight", () => {
	it("reports sorted file and section weights for shared and home context without writing", () => {
		const fixture = mkdtempSync(join(tmpdir(), "fm-context-weight-"));
		homes.push(fixture);
		const codeRoot = join(fixture, "code");
		const home = join(fixture, "home");
		const inputs = {
			"AGENTS.md": "# Agent\nshared context\n## Rules\nkeep it small\n",
			".agents/skills/alpha/SKILL.md": "# Alpha\nskill context\n",
			"data/cap.md": "# Preferences\ncaptain context\n",
			"data/mates/mate/brief.md": "You are a secondmate: supervise.\n\n# Charter\ncharter context\n",
		};
		for (const [path, text] of Object.entries(inputs)) {
			write(join(path.startsWith("data/") ? home : codeRoot, path), text);
		}
		write(join(home, "data", "ordinary", "brief.md"), "You are a crewmate.\n# Task\nnot loaded\n");
		const before = tree(fixture);

		const result = Bun.spawnSync({
			cmd: [COMMAND],
			env: {
				...process.env,
				FM_CODE_ROOT_OVERRIDE: codeRoot,
				FM_HOME: home,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(tree(fixture)).toEqual(before);

		const expectedTotal = Object.values(inputs).reduce((sum, text) => sum + countTokens(text), 0);
		expect(stdout).toContain(`estimated_total_tokens\t${expectedTotal}\n`);
		expect(stdout).toContain("tokenizer\tchars/4\n");
		expect(stdout).toContain("\tAGENTS.md\n");
		expect(stdout).toContain("\t.agents/skills/alpha/SKILL.md\n");
		expect(stdout).toContain("\tdata/cap.md\n");
		expect(stdout).toContain("\tdata/mates/mate/brief.md\n");
		expect(stdout).not.toContain("data/ordinary/brief.md");
		expect(stdout).toContain("\tAGENTS.md\tAgent\n");
		expect(stdout).toContain("\tAGENTS.md\tRules\n");
		expect(stdout).toContain("\tdata/mates/mate/brief.md\t(preamble)\n");
		expect(stdout).toContain("\tdata/mates/mate/brief.md\tCharter\n");

		const fileRows = stdout
			.split("\n\n")[1]
			.split("\n")
			.slice(2)
			.filter(Boolean)
			.map(line => Number(line.split("\t")[0]));
		expect(fileRows).toEqual([...fileRows].sort((a, b) => b - a));
		const sectionRows = stdout
			.split("\n\n")[2]
			.split("\n")
			.slice(2)
			.filter(Boolean)
			.map(line => Number(line.split("\t")[0]));
		expect(sectionRows).toEqual([...sectionRows].sort((a, b) => b - a));
	});

	it("reports per-mate includeSkills weight resolved via home and cache, degrading gracefully for missing config and unresolvable skills", () => {
		const fixture = mkdtempSync(join(tmpdir(), "fm-context-weight-mate-"));
		homes.push(fixture);
		const codeRoot = join(fixture, "code");
		const home = join(fixture, "home");
		const mateHomeA = join(fixture, "mate-a");
		const mateHomeB = join(fixture, "mate-b");
		const ompCache = join(fixture, "cache-omp");
		const claudeCache = join(fixture, "cache-claude"); // left empty: never created

		write(join(codeRoot, "AGENTS.md"), "# Agent\nshared context\n");

		const sharedText = "# Shared\nshared skill content\n";
		const localOnlyText = "# Local\nmate-local skill content that is a bit longer\n";
		const cachedText = "# Cached\nmachine-cache skill content\n";
		write(join(mateHomeA, ".agents", "skills", "shared", "SKILL.md"), sharedText);
		write(join(mateHomeA, ".agents", "skills", "local-only", "SKILL.md"), localOnlyText);
		write(join(ompCache, "cached-skill", "SKILL.md"), cachedText);
		write(
			join(mateHomeA, "config", "omp.yml"),
			[
				"skills:",
				"  includeSkills:",
				"    - shared",
				"    - local-only",
				"    - missing-skill",
				"    - cached-skill",
				"",
				"compaction:",
				"  strategy: context-full",
			].join("\n"),
		);
		mkdirSync(mateHomeB, { recursive: true });

		write(
			join(home, "data", "secondmates.md"),
			[
				`- matea - fixture mate a (home: ${mateHomeA}; workspace: w1; name: MateA; scope: test; projects: (none); added 2026-07-17)`,
				`- mateb - fixture mate b, no config (home: ${mateHomeB}; workspace: w2; name: MateB; scope: test; projects: (none); added 2026-07-17)`,
			].join("\n"),
		);
		const before = tree(fixture);

		const result = Bun.spawnSync({
			cmd: [COMMAND],
			env: {
				...process.env,
				FM_CODE_ROOT_OVERRIDE: codeRoot,
				FM_HOME: home,
				FM_SKILL_CACHE_OMP_OVERRIDE: ompCache,
				FM_SKILL_CACHE_CLAUDE_OVERRIDE: claudeCache,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(tree(fixture)).toEqual(before);

		expect(stdout).toContain("per-mate\n");
		expect(stdout).toContain("mate\tskill\ttokens\tsource\n");

		const sharedTokens = countTokens(sharedText);
		const localOnlyTokens = countTokens(localOnlyText);
		const cachedTokens = countTokens(cachedText);
		const mateaTotal = sharedTokens + localOnlyTokens + cachedTokens;

		expect(stdout).toContain(`matea\tshared\t${sharedTokens}\thome/.agents\n`);
		expect(stdout).toContain(`matea\tlocal-only\t${localOnlyTokens}\thome/.agents\n`);
		expect(stdout).toContain("matea\tmissing-skill\t0\tunresolved\n");
		expect(stdout).toContain(`matea\tcached-skill\t${cachedTokens}\tcache:omp-managed-skills\n`);
		expect(stdout).toContain(`matea\tTOTAL\t${mateaTotal}\t-\n`);
		expect(stdout).toContain("mateb\t(no config/omp.yml)\t0\t-\n");
	});
});

describe("fm-context-weight --budget", () => {
	const AGENTS_TEXT = "# Agent\nshared always-on context\n## Rules\nkeep it small\n";
	const SKILL_TEXT = "# Alpha\nskill context that is lazy\n";
	const ALWAYS_ON = countTokens(AGENTS_TEXT);
	const GOVERNANCE = countTokens(AGENTS_TEXT) + countTokens(SKILL_TEXT);

	// Builds a tracked-layer fixture plus a deliberately large local-layer file
	// that must never count toward the budget. Omit `budget` to leave out the
	// ceiling file entirely.
	function fixture(budget?: { alwaysOnMax: number; governanceMax: number }): string {
		const root = mkdtempSync(join(tmpdir(), "fm-context-budget-"));
		homes.push(root);
		const codeRoot = join(root, "code");
		write(join(codeRoot, "AGENTS.md"), AGENTS_TEXT);
		write(join(codeRoot, ".agents", "skills", "alpha", "SKILL.md"), SKILL_TEXT);
		write(join(root, "home", "data", "cap.md"), "# Preferences\n".repeat(500));
		if (budget) {
			writeFileSync(join(codeRoot, "context-budget.toml"), `always_on_max = ${budget.alwaysOnMax}\ngovernance_max = ${budget.governanceMax}\n`);
		}
		return codeRoot;
	}

	function runBudget(codeRoot: string): { code: number; stdout: string; stderr: string } {
		const result = Bun.spawnSync({
			cmd: [COMMAND, "--budget"],
			env: { ...process.env, FM_CODE_ROOT_OVERRIDE: codeRoot, FM_HOME: join(codeRoot, "..", "home") },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	}

	it("passes at the ceiling and excludes the large local-layer file", () => {
		const result = runBudget(fixture({ alwaysOnMax: ALWAYS_ON, governanceMax: GOVERNANCE }));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`= ceiling ${String(GOVERNANCE).padStart(6)}`);
	});

	it("fails and reports the overage when the always-on layer exceeds its ceiling", () => {
		const result = runBudget(fixture({ alwaysOnMax: ALWAYS_ON - 5, governanceMax: GOVERNANCE }));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("FAIL  always_on");
		expect(result.stdout).toContain("(+5 over budget)");
		expect(result.stderr).toContain("context budget exceeded");
	});

	it("passes but nudges to tighten when a ceiling has slack", () => {
		const result = runBudget(fixture({ alwaysOnMax: ALWAYS_ON + 1000, governanceMax: GOVERNANCE + 1000 }));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("ratchet: lower to");
		expect(result.stderr).toContain("context budget has slack");
	});

	it("fails when the budget file is missing", () => {
		const result = runBudget(fixture());
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no budget file");
	});

	// The live ratchet, re-homed from CI into the suite: the real tracked layer
	// must stay within the committed ceilings. This is what fires when AGENTS.md
	// or a skill grows without a paid-for cut.
	it("keeps the real tracked layer within its committed budget", () => {
		const repoRoot = join(import.meta.dir, "..");
		const result = Bun.spawnSync({
			cmd: [COMMAND, "--budget"],
			env: { ...process.env, FM_CODE_ROOT_OVERRIDE: repoRoot },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			throw new Error(`context budget breached:\n${result.stdout.toString()}${result.stderr.toString()}`);
		}
		expect(result.exitCode).toBe(0);
	});
});
