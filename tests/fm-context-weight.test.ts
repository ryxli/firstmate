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
			"data/captain.md": "# Preferences\ncaptain context\n",
			"data/mate/brief.md": "You are a secondmate: supervise.\n\n# Charter\ncharter context\n",
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
		expect(stdout).toContain("\tdata/captain.md\n");
		expect(stdout).toContain("\tdata/mate/brief.md\n");
		expect(stdout).not.toContain("data/ordinary/brief.md");
		expect(stdout).toContain("\tAGENTS.md\tAgent\n");
		expect(stdout).toContain("\tAGENTS.md\tRules\n");
		expect(stdout).toContain("\tdata/mate/brief.md\t(preamble)\n");
		expect(stdout).toContain("\tdata/mate/brief.md\tCharter\n");

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
});
