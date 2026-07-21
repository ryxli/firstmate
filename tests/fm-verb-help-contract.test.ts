// Registry-driven top-level help contract: every loadVerbs() name plus root
// `fm --help` must be side-effect-free under an isolated FM_HOME.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { loadVerbs } from "../.omp/extensions/cli/lib/verb-registry";
import { SEND_HELP_DESCRIBE, SEND_PEER_BUS_NOTE } from "../.omp/extensions/cli/help";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FM = join(REPO_ROOT, "sbin/fm");

function walkFingerprint(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const abs = join(dir, name);
			const rel = relative(root, abs) || ".";
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) {
				let target = "";
				try {
					target = readlinkSync(abs);
				} catch {
					target = "?";
				}
				lines.push(`symlink\t${rel}\t${target}\t${(st.mode & 0o777).toString(8)}`);
				continue;
			}
			if (st.isDirectory()) {
				lines.push(`dir\t${rel}\t${(st.mode & 0o777).toString(8)}`);
				walk(abs);
				continue;
			}
			if (st.isFile()) {
				const body = readFileSync(abs);
				const digest = createHash("sha256").update(body).digest("hex");
				lines.push(`file\t${rel}\t${digest}\t${(st.mode & 0o777).toString(8)}`);
			} else {
				lines.push(`other\t${rel}\t${(st.mode & 0o777).toString(8)}`);
			}
		}
	};
	walk(root);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function makeIsolatedHome(): { home: string; bin: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "fm-help-home-"));
	const bin = join(home, "bin");
	mkdirSync(join(home, "state"), { recursive: true });
	mkdirSync(join(home, "data"), { recursive: true });
	mkdirSync(join(home, "config"), { recursive: true });
	mkdirSync(join(home, "projects"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(home, "config", "identity"), "schema_version=1\nname=Test\nrole=firstmate\n");
	writeFileSync(join(home, "data", "marker.txt"), "seed\n");
	// Stub herdr so accidental operational paths cannot touch the live fleet.
	writeFileSync(
		join(bin, "herdr"),
		`#!/bin/sh
printf '%s\\n' "herdr-stub: $*" >> "${home}/herdr.calls"
case "$1 $2" in
  "pane list") printf '{"result":{"panes":[]}}\\n'; exit 0 ;;
  "agent get") printf '{"error":"not found"}\\n'; exit 0 ;;
esac
echo "herdr stub refused unexpected invocation" >&2
exit 99
`,
	);
	chmodSync(join(bin, "herdr"), 0o755);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FM_HOME: home,
		FM_STATE_OVERRIDE: join(home, "state"),
		FM_DATA_OVERRIDE: join(home, "data"),
		FM_CONFIG_OVERRIDE: join(home, "config"),
		FM_PROJECTS_OVERRIDE: join(home, "projects"),
		PATH: `${bin}:${process.env.PATH ?? ""}`,
	};
	// Do not set FM_ROOT_OVERRIDE / FM_CODE_ROOT_OVERRIDE - real verb registry must load.
	delete env.FM_ROOT_OVERRIDE;
	delete env.FM_CODE_ROOT_OVERRIDE;
	return {
		home,
		bin,
		env,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

function runFm(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: [FM, ...args],
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		status: result.exitCode ?? 1,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
	};
}

function assertSafeHelp(label: string, out: { status: number; stdout: string; stderr: string }, opts: {
	commandName: string;
	beforeFp: string;
	afterFp: string;
	requireUsageOrDescribe?: boolean;
}) {
	expect(out.status, `${label}: status\nstdout=${out.stdout}\nstderr=${out.stderr}`).toBe(0);
	expect(out.stdout.trim().length, `${label}: empty stdout`).toBeGreaterThan(0);
	expect(out.stderr, `${label}: stderr must be empty`).toBe("");
	expect(out.stdout, `${label}: command name`).toContain(opts.commandName);
	if (opts.requireUsageOrDescribe !== false) {
		const hasUsage = /usage:/i.test(out.stdout) || out.stdout.includes("Usage:");
		const hasDescribe = /description:/i.test(out.stdout);
		expect(hasUsage || hasDescribe, `${label}: missing usage or description`).toBe(true);
	}
	expect(out.stdout.includes("error:"), `${label}: contains error:`).toBe(false);
	expect(opts.afterFp, `${label}: home fingerprint changed`).toBe(opts.beforeFp);
}

describe("fm verb help contract", () => {
	test("root fm --help is side-effect-free and accurate for send", () => {
		const iso = makeIsolatedHome();
		try {
			const before = walkFingerprint(iso.home);
			const out = runFm(["--help"], iso.env);
			const after = walkFingerprint(iso.home);
			assertSafeHelp("fm --help", out, {
				commandName: "fm",
				beforeFp: before,
				afterFp: after,
			});
			expect(out.stdout).toContain(SEND_PEER_BUS_NOTE);
			expect(out.stdout).toContain(SEND_HELP_DESCRIBE);
			expect(out.stdout.toLowerCase()).not.toMatch(/fm send[^\n]*(authenticated|attributed)/);
			expect(out.stdout.toLowerCase()).not.toContain("attributed send");
		} finally {
			iso.cleanup();
		}
	});

	test("every registry verb: --help and -h are safe", async () => {
		const verbs = await loadVerbs();
		expect(verbs.length).toBeGreaterThan(10);

		const iso = makeIsolatedHome();
		try {
			for (const verb of verbs) {
				for (const flag of ["--help", "-h"] as const) {
					const before = walkFingerprint(iso.home);
					const out = runFm([verb.name, flag], iso.env);
					const after = walkFingerprint(iso.home);
					const label = `fm ${verb.name} ${flag}`;
					assertSafeHelp(label, out, {
						commandName: verb.name,
						beforeFp: before,
						afterFp: after,
						// lock uses plain "Usage:" text; still matches.
						requireUsageOrDescribe: true,
					});
					// Help flags must never be treated as paths/ids.
					expect(out.stdout).not.toContain(`data/${flag}`);
					expect(out.stdout).not.toContain(`/${flag}/brief.md`);
					expect(statSync(iso.home).isDirectory()).toBe(true);
					expect(() => statSync(join(iso.home, "data", flag))).toThrow();
				}
			}
		} finally {
			iso.cleanup();
		}
	});

	test("spawn help covers crewmate and secondmate forms", () => {
		const iso = makeIsolatedHome();
		try {
			for (const flag of ["--help", "-h"] as const) {
				const before = walkFingerprint(iso.home);
				const out = runFm(["spawn", flag], iso.env);
				const after = walkFingerprint(iso.home);
				assertSafeHelp(`fm spawn ${flag}`, out, {
					commandName: "spawn",
					beforeFp: before,
					afterFp: after,
				});
				expect(out.stdout).toMatch(/project-dir|worktree|crewmate|task-id/i);
				expect(out.stdout).toContain("--visible");
				expect(out.stdout).toMatch(/OMP Task delivery/i);
				expect(out.stdout).toMatch(/secondmate/);
				expect(out.stdout).not.toContain("data/--help/brief.md");
				expect(out.stdout).not.toContain("data/-h/brief.md");
				expect(out.stdout).not.toContain("no brief at");
			}
		} finally {
			iso.cleanup();
		}
	});

	test("task alias help identifies invoked command", async () => {
		const verbs = await loadVerbs();
		if (!verbs.some(v => v.name === "task")) return;
		const iso = makeIsolatedHome();
		try {
			const before = walkFingerprint(iso.home);
			const out = runFm(["task", "--help"], iso.env);
			const after = walkFingerprint(iso.home);
			assertSafeHelp("fm task --help", out, {
				commandName: "task",
				beforeFp: before,
				afterFp: after,
			});
			expect(out.stdout).toMatch(/command:\s*task\b|command: task\b/);
		} finally {
			iso.cleanup();
		}
	});
});
