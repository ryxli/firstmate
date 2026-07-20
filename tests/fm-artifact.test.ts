// Thin artifact spine unit tests.
// Run: bun test tests/fm-artifact.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
	ArtifactError,
	abandon,
	accept,
	authorizeDiscard,
	dependencySatisfied,
	ensureArtifact,
	isLanded,
	landAfterFfMerge,
	listActiveArtifacts,
	loadArtifact,
	needsAttention,
	reconcileLanded,
	revise,
	safeToDispose,
	saveArtifact,
	submitCandidate,
	supersede,
} from "../.omp/extensions/cli/lib/artifact";

function withHome<T>(fn: (home: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), "fm-art-"));
	mkdirSync(join(home, "data", "artifacts"), { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	mkdirSync(join(home, "projects"), { recursive: true });
	const prev = {
		FM_HOME: process.env.FM_HOME,
		FM_DATA_OVERRIDE: process.env.FM_DATA_OVERRIDE,
		FM_STATE_OVERRIDE: process.env.FM_STATE_OVERRIDE,
		FM_PROJECTS_OVERRIDE: process.env.FM_PROJECTS_OVERRIDE,
	};
	process.env.FM_HOME = home;
	process.env.FM_DATA_OVERRIDE = join(home, "data");
	process.env.FM_STATE_OVERRIDE = join(home, "state");
	process.env.FM_PROJECTS_OVERRIDE = join(home, "projects");
	try {
		return fn(home);
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	}
}

function gitInitRepo(path: string): { parent: string; child: string } {
	mkdirSync(path, { recursive: true });
	const run = (args: string[]) => {
		const res = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
		if ((res.status ?? 1) !== 0 && !args.includes("config")) {
			throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
		}
		return res;
	};
	run(["init"]);
	run(["checkout", "-b", "main"]);
	run(["config", "user.email", "t@example.com"]);
	run(["config", "user.name", "t"]);
	writeFileSync(join(path, "a.txt"), "one\n");
	run(["add", "a.txt"]);
	run(["commit", "-m", "base"]);
	const parent = (run(["rev-parse", "HEAD"]).stdout ?? "").trim();
	if (!parent) throw new Error("empty parent sha");
	writeFileSync(join(path, "a.txt"), "one\ntwo\n");
	run(["add", "a.txt"]);
	run(["commit", "-m", "change"]);
	const child = (run(["rev-parse", "HEAD"]).stdout ?? "").trim();
	if (!child) throw new Error("empty child sha");
	return { parent, child };
}

describe("predicates", () => {
	it("does not treat abandoned as dependencySatisfied or safeToDispose", () => {
		withHome(() => {
			const r = ensureArtifact("t1", "app");
			submitCandidate(r, {
				patchRef: "p",
				parentSha: "a",
				patchId: "i",
				candidateSha: "b",
			});
			abandon(r, "nope");
			saveArtifact(r);
			expect(dependencySatisfied("t1")).toBe(false);
			expect(safeToDispose(loadArtifact("t1")!)).toBe(false);
			authorizeDiscard(r, "cap", "discard ok");
			saveArtifact(r);
			expect(safeToDispose(loadArtifact("t1")!)).toBe(true);
			expect(dependencySatisfied("t1")).toBe(false);
		});
	});

	it("dependencySatisfied follows supersede chain to landed successor", () => {
		withHome(() => {
			const a = ensureArtifact("old", "app");
			submitCandidate(a, { patchRef: "p", parentSha: "a", patchId: "i", candidateSha: "b" });
			accept(a, "pr", { by: "test", criteria: ["c"] });
			supersede(a, "new");
			saveArtifact(a);
			const b = ensureArtifact("new", "app");
			submitCandidate(b, { patchRef: "p2", parentSha: "a", patchId: "j", candidateSha: "c" });
			accept(b, "pr", { by: "test", criteria: ["c"] });
			b.delivery!.state = "landed";
			saveArtifact(b);
			expect(dependencySatisfied("old")).toBe(true);
			expect(safeToDispose(loadArtifact("old")!)).toBe(false);
		});
	});

	it("needsAttention is true for candidate/revise/queued delivery only", () => {
		withHome(() => {
			const r = ensureArtifact("t2", "app");
			expect(needsAttention(r)).toBe(false);
			submitCandidate(r, { patchRef: "p", parentSha: "a", patchId: "i", candidateSha: "b" });
			expect(needsAttention(r)).toBe(true);
			accept(r, "trunk", { by: "test", criteria: ["c"] });
			saveArtifact(r);
			expect(needsAttention(r)).toBe(true);
			expect(listActiveArtifacts().some(x => x.taskId === "t2")).toBe(true);
		});
	});
});

describe("proven land", () => {
	it("landAfterFfMerge requires candidate ancestor of trunk", () => {
		withHome(home => {
			const repo = join(home, "projects", "app");
			const { parent, child } = gitInitRepo(repo);
			const r = ensureArtifact("t3", "app");
			const pid = spawnSync("git", ["-C", repo, "diff", `${parent}..${child}`], { encoding: "utf8" });
			const patchId = spawnSync("git", ["patch-id", "--stable"], { input: pid.stdout ?? "", encoding: "utf8" })
				.stdout?.trim()
				.split(/\s+/)[0];
			submitCandidate(r, {
				patchRef: `git:${parent}..${child}`,
				parentSha: parent,
				patchId: patchId!,
				candidateSha: child,
				filesChanged: ["a.txt"],
				evidence: ["git"],
			});
			accept(r, "trunk", { by: "test", criteria: ["c"] });
			saveArtifact(r);
			const trunk = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout!.trim();
			landAfterFfMerge("t3", { trunkSha: trunk, branch: "main", repo });
			expect(isLanded(loadArtifact("t3")!)).toBe(true);
			expect(dependencySatisfied("t3")).toBe(true);
			expect(safeToDispose(loadArtifact("t3")!)).toBe(true);
		});
	});

	it("reconcileLanded refuses when patch absent from trunk", () => {
		withHome(home => {
			const repo = join(home, "projects", "app");
			const { parent, child } = gitInitRepo(repo);
			// Reset trunk back to parent so child patch is not on trunk.
			spawnSync("git", ["-C", repo, "reset", "--hard", parent], { encoding: "utf8" });
			const pid = spawnSync("git", ["-C", repo, "diff", `${parent}..${child}`], { encoding: "utf8" });
			const patchId = spawnSync("git", ["patch-id", "--stable"], { input: pid.stdout ?? "", encoding: "utf8" })
				.stdout?.trim()
				.split(/\s+/)[0];
			// Keep child object reachable
			spawnSync("git", ["-C", repo, "branch", "candidate", child], { encoding: "utf8" });
			const r = ensureArtifact("t4", "app");
			submitCandidate(r, {
				patchRef: `git:${parent}..${child}`,
				parentSha: parent,
				patchId: patchId!,
				candidateSha: child,
			});
			accept(r, "trunk", { by: "test", criteria: ["c"] });
			saveArtifact(r);
			expect(() => reconcileLanded("t4")).toThrow(ArtifactError);
			expect(loadArtifact("t4")!.delivery?.state).toBe("blocked");
		});
	});

	it("refuses revise after accept", () => {
		withHome(() => {
			const r = ensureArtifact("t5", "app");
			submitCandidate(r, { patchRef: "p", parentSha: "a", patchId: "i", candidateSha: "b" });
			accept(r, "pr", { by: "test", criteria: ["c"] });
			expect(() =>
				revise(r, { why: "x", mustChange: "", mustRemain: "", nextAcceptanceBar: "y", priorPatchIds: [] }),
			).toThrow(ArtifactError);
		});
	});
});
