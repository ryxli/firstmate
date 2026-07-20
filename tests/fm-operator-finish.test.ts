// Operator surface: FM_HOME isolation, accept → finish <id>, compact receipts.
// Run: bun test tests/fm-operator-finish.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveMainHome } from "../.omp/extensions/bridge/collect";
import { finishTask, parseGhAxiPullToon } from "../.omp/extensions/cli/lib/operator";
import { isLanded, loadArtifact } from "../.omp/extensions/cli/lib/artifact";
import { BacklogStore } from "../.omp/extensions/cli/lib/backlog-store";

const ROOT = join(import.meta.dir, "..");
const FM = join(ROOT, "sbin", "fm");

function withHome<T>(fn: (home: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), "fm-op-"));
	mkdirSync(join(home, "data", "artifacts"), { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	mkdirSync(join(home, "projects"), { recursive: true });
	writeFileSync(join(home, "AGENTS.md"), "# test home\n");
	writeFileSync(
		join(home, "data", "backlog.md"),
		`## In flight\n\n## Queued\n\n## Done\n`,
	);
	const prev = { ...process.env };
	process.env.FM_HOME = home;
	delete process.env.FM_DATA_OVERRIDE;
	delete process.env.FM_STATE_OVERRIDE;
	delete process.env.FM_PROJECTS_OVERRIDE;
	delete process.env.FIRSTMATE_HOME;
	delete process.env.FM_ROOT_OVERRIDE;
	try {
		return fn(home);
	} finally {
		for (const k of Object.keys(process.env)) {
			if (!(k in prev)) delete process.env[k];
		}
		Object.assign(process.env, prev);
		rmSync(home, { recursive: true, force: true });
	}
}

function git(cwd: string, args: string[]): string {
	const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if ((res.status ?? 1) !== 0 && !args.includes("config")) {
		throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
	}
	return (res.stdout ?? "").trim();
}

function setupTrunkProject(home: string, name: string, taskId: string): { child: string; proj: string } {
	const proj = join(home, "projects", name);
	const wt = join(home, "worktrees", taskId);
	mkdirSync(proj, { recursive: true });
	mkdirSync(join(home, "worktrees"), { recursive: true });
	git(proj, ["init"]);
	git(proj, ["checkout", "-b", "main"]);
	git(proj, ["config", "user.email", "t@example.com"]);
	git(proj, ["config", "user.name", "t"]);
	writeFileSync(join(proj, "a.txt"), "one\n");
	git(proj, ["add", "a.txt"]);
	git(proj, ["commit", "-m", "base"]);
	git(proj, ["branch", `fm/${taskId}`]);
	git(proj, ["worktree", "add", wt, `fm/${taskId}`]);
	writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
	git(wt, ["add", "a.txt"]);
	git(wt, ["commit", "-m", "change"]);
	const child = git(wt, ["rev-parse", "HEAD"]);
	writeFileSync(
		join(home, "state", `${taskId}.meta`),
		`project=${proj}\nmode=trunk\nkind=ship\nyolo=off\nworktree=${wt}\n`,
	);
	writeFileSync(join(home, "data", "projects.md"), `- ${name} [trunk] - test\n`);
	const store = BacklogStore.load(join(home, "data", "backlog.md"));
	store.create({
		id: taskId,
		title: "demo change",
		state: "inflight",
		kind: "ship",
		repo: name,
		deps: [],
	});
	store.save();
	return { child, proj };
}

describe("FM_HOME isolation", () => {
	it("pins sole root when FM_HOME is set even without sbin markers", () => {
		withHome(home => {
			expect(resolveMainHome()).toBe(home);
			expect(resolveMainHome()).not.toContain("code/harness/firstmate");
		});
	});
});

describe("fm accept / finish", () => {
	it("accept prints compact receipt and queues trunk", () => {
		withHome(home => {
			const id = "demo-two";
			const { child } = setupTrunkProject(home, "app", id);
			const res = spawnSync(FM, ["accept", id, "--sha", child, "--mode", "trunk"], {
				encoding: "utf8",
				env: { ...process.env, FM_HOME: home },
			});
			expect(res.status).toBe(0);
			expect(res.stdout).toMatch(new RegExp(`accepted ${id} .* -> queued for trunk`));
			expect(res.stdout).not.toContain('"reviewState"');
			const art = loadArtifact(id);
			expect(art?.reviewState).toBe("accepted");
			expect(art?.delivery?.state).toBe("queued");
		});
	});

	it("finish integrates, lands, closes backlog, and is idempotent", () => {
		withHome(home => {
			const id = "demo-fin";
			const { child, proj } = setupTrunkProject(home, "app", id);
			const acc = spawnSync(FM, ["accept", id, "--sha", child, "--mode", "trunk"], {
				encoding: "utf8",
				env: { ...process.env, FM_HOME: home },
			});
			expect(acc.status).toBe(0);

			const first = finishTask(id);
			expect(first.ok).toBe(true);
			expect(first.lines.some(l => l.startsWith("integrated ") || l.startsWith("landed "))).toBe(true);
			expect(first.lines.some(l => l.includes("closed ") || l.includes("finished "))).toBe(true);
			expect(isLanded(loadArtifact(id)!)).toBe(true);
			expect(git(proj, ["rev-parse", "main"])).toBe(git(proj, ["rev-parse", child]));

			const store = BacklogStore.load(join(home, "data", "backlog.md"));
			expect(store.get(id)?.state).toBe("done");

			const second = finishTask(id);
			expect(second.ok).toBe(true);
			expect(second.lines.some(l => l.includes("finished "))).toBe(true);
		});
	});

	it("refuses trunk finish when fm/<id> advanced after accept", () => {
		withHome(home => {
			const id = "adv-branch";
			const { child, proj } = setupTrunkProject(home, "app", id);
			const wt = join(home, "worktrees", id);
			const mainBefore = git(proj, ["rev-parse", "main"]);
			expect(
				spawnSync(FM, ["accept", id, "--sha", child, "--mode", "trunk"], {
					encoding: "utf8",
					env: { ...process.env, FM_HOME: home },
				}).status,
			).toBe(0);

			writeFileSync(join(wt, "a.txt"), "one\ntwo\nthree\n");
			git(wt, ["add", "a.txt"]);
			git(wt, ["commit", "-m", "after-accept"]);
			const tip = git(wt, ["rev-parse", "HEAD"]);
			expect(tip).not.toBe(child);

			const result = finishTask(id);
			expect(result.ok).toBe(false);
			expect(result.lines.join("\n")).toMatch(/advanced after accept/);
			expect(git(proj, ["rev-parse", "main"])).toBe(mainBefore);
			expect(isLanded(loadArtifact(id)!)).toBe(false);
		});
	});

	it("PR finish lands from merge SHA while local trunk stays stale", () => {
		withHome(home => {
			const id = "pr-stale";
			const name = "web";
			const proj = join(home, "projects", name);
			const wt = join(home, "worktrees", id);
			mkdirSync(proj, { recursive: true });
			mkdirSync(join(home, "worktrees"), { recursive: true });
			git(proj, ["init"]);
			git(proj, ["checkout", "-b", "main"]);
			git(proj, ["config", "user.email", "t@example.com"]);
			git(proj, ["config", "user.name", "t"]);
			writeFileSync(join(proj, "a.txt"), "one\n");
			git(proj, ["add", "a.txt"]);
			git(proj, ["commit", "-m", "base"]);
			const base = git(proj, ["rev-parse", "HEAD"]);
			git(proj, ["branch", `fm/${id}`]);
			git(proj, ["worktree", "add", wt, `fm/${id}`]);
			writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
			git(wt, ["add", "a.txt"]);
			git(wt, ["commit", "-m", "change"]);
			const child = git(wt, ["rev-parse", "HEAD"]);
			// Simulate remote merge object present without advancing local main.
			git(proj, ["update-ref", "refs/remotes/origin/main", child]);

			writeFileSync(
				join(home, "state", `${id}.meta`),
				`project=${proj}\nmode=pr\nkind=ship\nyolo=off\nworktree=${wt}\npr=https://github.com/example/web/pull/42\n`,
			);
			writeFileSync(join(home, "data", "projects.md"), `- ${name} [pr] - test\n`);
			const store = BacklogStore.load(join(home, "data", "backlog.md"));
			store.create({ id, title: "pr change", state: "inflight", kind: "ship", repo: name, deps: [] });
			store.save();

			expect(
				spawnSync(FM, ["accept", id, "--sha", child, "--mode", "pr"], {
					encoding: "utf8",
					env: { ...process.env, FM_HOME: home },
				}).status,
			).toBe(0);

			const waiting = finishTask(id, {
				queryPr: () => ({ state: "OPEN", mergeSha: null }),
			});
			expect(waiting.ok).toBe(false);
			expect(waiting.waiting).toBe(true);
			expect(waiting.lines.join("\n")).toContain("waiting pr-stale: PR not merged");
			expect(loadArtifact(id)?.delivery?.state).toBe("queued");

			const done = finishTask(id, {
				queryPr: () => ({ state: "MERGED", mergeSha: child }),
			});
			expect(done.ok).toBe(true);
			expect(isLanded(loadArtifact(id)!)).toBe(true);
			const landed = loadArtifact(id)!;
			expect(String(landed.delivery?.receipts.find(r => r.type === "landed")?.detail?.trunkSha)).toBe(child);
			expect(git(proj, ["rev-parse", "main"])).toBe(base);
			expect(BacklogStore.load(join(home, "data", "backlog.md")).get(id)?.state).toBe("done");
		});
	});

	it("tasks start hint mentions accept/finish not done --pr", () => {
		withHome(home => {
			const id = "hint-me";
			setupTrunkProject(home, "app", id);
			// move to queued then start to get hint
			const store = BacklogStore.load(join(home, "data", "backlog.md"));
			store.transition(id, "queued");
			store.save();
			const res = spawnSync(FM, ["tasks", "start", id], {
				encoding: "utf8",
				env: { ...process.env, FM_HOME: home },
			});
			expect(res.status).toBe(0);
			expect(res.stdout).toContain(`fm accept ${id}`);
			expect(res.stdout).toContain(`fm finish ${id}`);
			expect(res.stdout).not.toContain("tasks done");
		});
	});
});

describe("gh-axi PR API TOON parse", () => {
	// Fixture mirrors `bunx gh-axi api /repos/.../pulls/N` after stripNoisyFields + encode
	// (keyFolding:safe): flat top-level merged/state/merge_commit_sha with nested head/base.
	const MERGED_PR_TOON = `id: 1
number: 42
state: closed
title: Fix thing
merged: true
merge_commit_sha: deadbeefcafebabe0123456789abcdef01234567
user.login: alice
head:
  ref: feature
  sha: aaa111
base:
  ref: main
  sha: bbb222
`;

	const OPEN_PR_TOON = `id: 2
number: 7
state: open
title: WIP
merged: false
merge_commit_sha: null
user.login: bob
`;

	it("parses real gh-axi TOON merged PR for merge_commit_sha", () => {
		const r = parseGhAxiPullToon(MERGED_PR_TOON);
		expect(r.state).toBe("MERGED");
		expect(r.mergeSha).toBe("deadbeefcafebabe0123456789abcdef01234567");
	});

	it("parses real gh-axi TOON open PR without merge sha", () => {
		const r = parseGhAxiPullToon(OPEN_PR_TOON);
		expect(r.state).toBe("OPEN");
		expect(r.mergeSha).toBeNull();
	});

	it("refuses JSON (gh-axi api emits TOON, not JSON)", () => {
		expect(() =>
			parseGhAxiPullToon(
				JSON.stringify({ state: "closed", merged: true, merge_commit_sha: "abc" }),
			),
		).toThrow(/TOON decode failed|not an object/i);
	});
});

describe("fleet under FM_HOME", () => {
	it("does not emit the real main-home path", () => {
		withHome(home => {
			const res = spawnSync(FM, ["tasks", "fleet"], {
				encoding: "utf8",
				env: { ...process.env, FM_HOME: home, HOME: home },
			});
			// May fail structurally but must not leak the real clone path
			expect(res.stdout + res.stderr).not.toContain("/Users/ryan/code/harness/firstmate/data");
			expect(resolveMainHome()).toBe(home);
		});
	});
});
