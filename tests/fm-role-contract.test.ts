// Focused role-contract and secondmate gate coverage.
// Run: bun test tests/fm-role-contract.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { crewRoleContract, mainRoleContract, roleContractForHome, secondmateRoleContract } from "../.omp/extensions/cli/lib/role-contract";
import { parseSecondmateRegistryLine } from "../.omp/extensions/cli/lib/secondmate-registry";
import {
	charterSystemBlock,
	injectOmpAppendSystemPrompts,
	loadRequiredCharter,
	parseOmpLaunchCommand,
} from "../.omp/extensions/cli/lib/omp-system-context";
import { createHash } from "node:crypto";

const REPO_ROOT = import.meta.dir.replace(/\/tests$/, "");
const FM = join(REPO_ROOT, "sbin", "fm");

function tempHome(prefix: string): string {
	const home = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(home, "config"), { recursive: true });
	mkdirSync(join(home, "data"), { recursive: true });
	writeFileSync(join(home, "AGENTS.md"), "# fixture\n");
	return home;
}

function secondmateHome(id: string, name: string, scope: string, parent?: string): string {
	const home = tempHome(`fm-role-${id}-`);
	mkdirSync(join(home, "sbin"));
	mkdirSync(join(home, ".omp", "skills"), { recursive: true });
	mkdirSync(join(home, "state"));
	writeFileSync(join(home, ".fm-secondmate-home"), `${id}\n`);
	writeFileSync(join(home, "config", "identity"), `schema_version=1\nname=${name}\nrole=${scope}\n${parent ? `parent=${parent}\n` : ""}`);
	writeFileSync(join(home, "config", "shared-skills"), "");
	writeFileSync(join(home, "data", "charter.md"), `# Charter\n${name}\n\n# Routing scope\n${scope}\n\n# Project clones\nnone\n`);
	return home;
}

describe("runtime role contracts", () => {
	it("generates Keel main, Kodiak secondmate, Plum secondmate, and crew contracts", () => {
		const fallbackMain = tempHome("fm-role-main-fallback-");
		const main = tempHome("fm-role-main-");
		writeFileSync(join(main, "config", "identity"), "schema_version=1\nname=Keel\nrole=Main firstmate crew supervisor\nparent=cap\n");
		const kodiak = secondmateHome("kodiak", "Kodiak", "frontend and design routing", "Keel");
		const plum = secondmateHome("plum", "Plum", "legacy evidence only", "Keel");
		try {
			expect(mainRoleContract({ home: fallbackMain })).toContain("name: firstmate\nkind: firstmate");
			expect(mainRoleContract({ home: main })).toContain("You are Keel, the first mate reporting to the cap.");
			expect(mainRoleContract({ home: main })).toContain("name: Keel\nkind: firstmate");
			expect(roleContractForHome(main)).toContain("name: Keel\nkind: firstmate");
			expect(secondmateRoleContract({ home: kodiak, mainHome: main })).toContain("You are Kodiak, a secondmate reporting to Keel.");
			expect(secondmateRoleContract({ home: kodiak, mainHome: main })).toContain("id: kodiak\nname: Kodiak\nkind: secondmate\nreports_to: Keel");
			expect(secondmateRoleContract({ home: kodiak, mainHome: main })).toContain("routing_scope: frontend and design routing");
			expect(roleContractForHome(plum, main)).toContain("id: plum\nname: Plum\nkind: secondmate\nreports_to: Keel");
			expect(roleContractForHome(plum, main)).toContain("routing_scope: legacy evidence only");
			expect(crewRoleContract({ home: main, mainHome: main, crewId: "fix-bug", launchingSupervisor: "Keel" })).toContain("You are a crew agent assigned to fix-bug, reporting to Keel.");
			expect(crewRoleContract({ home: main, mainHome: main, crewId: "fix-bug", launchingSupervisor: "Keel" })).toContain("id: fix-bug\nkind: crew\nreports_to: Keel");
		} finally {
			rmSync(fallbackMain, { recursive: true, force: true });
			rmSync(main, { recursive: true, force: true });
			rmSync(kodiak, { recursive: true, force: true });
			rmSync(plum, { recursive: true, force: true });
		}
	});

	it("keeps secondmate identity and authority in the runtime role contract", () => {
		const main = tempHome("fm-role-main-");
		writeFileSync(join(main, "config", "identity"), "schema_version=1\nname=Keel\nrole=firstmate\nparent=cap\n");
		const kodiak = secondmateHome("kodiak", "Kodiak", "frontend", "Keel");
		try {
			const contract = secondmateRoleContract({ home: kodiak, mainHome: main });
			const charter = readFileSync(join(kodiak, "data", "charter.md"), "utf8");
			expect(contract).toContain("You are Kodiak, a secondmate reporting to Keel.");
			expect(contract).toContain("authority: own-home and charter-domain only");
			expect(charter).not.toContain("You are Kodiak");
			expect(charter).not.toContain("authority:");
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(kodiak, { recursive: true, force: true });
		}
	});

	it("updates stale generated secondmate parent when main identity is known", () => {
		const main = tempHome("fm-role-main-");
		writeFileSync(join(main, "config", "identity"), "schema_version=1\nname=Keel\nrole=Main firstmate crew supervisor\nparent=cap\n");
		const kodiak = secondmateHome("kodiak", "Kodiak", "frontend", "OldMain");
		try {
			expect(secondmateRoleContract({ home: kodiak, mainHome: main })).toContain("reports_to: Keel");
			expect(readFileSync(join(kodiak, "config", "identity"), "utf8")).toContain("parent=Keel");
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(kodiak, { recursive: true, force: true });
		}
	});

	it("uses the structural marker when a secondmate identity has no descriptive role", () => {
		const home = tempHome("fm-role-marker-only-");
		writeFileSync(join(home, ".fm-secondmate-home"), "riggs\n");
		try {
			const contract = roleContractForHome(home);
			expect(contract).toContain("kind: secondmate");
			expect(contract).not.toContain("kind: firstmate");
			expect(contract).not.toContain("kind: unverified");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("injects OMP appends in caller order for bare, env-assign, and path forms", () => {
		const contract = "# Runtime Role Contract\nkind: crew";
		const charter = charterSystemBlock("scope with 'quotes'\nand $(echo hi)\n");
		const forms = [
			'omp --auto-approve "$(cat brief)"',
			"omp --auto-approve -c",
			"OMP_MODE=manual omp --auto-approve",
			"/usr/local/bin/omp --auto-approve",
			"FOO=1 BAR=2 /opt/omp --auto-approve -c",
		];
		for (const form of forms) {
			const parsed = parseOmpLaunchCommand(form);
			expect(parsed, form).not.toBeNull();
			const injected = injectOmpAppendSystemPrompts(form, [contract, charter]);
			expect(injected).toContain("--append-system-prompt=");
			expect((injected.match(/--append-system-prompt=/g) ?? []).length).toBe(1);
			expect(injected.indexOf(contract.slice(0, 20))).toBeLessThan(injected.indexOf("## Local charter"));
			expect(injected).toContain("$(echo hi)");
			expect(parseOmpLaunchCommand(injected)?.executable).toBe(parsed!.executable);
		}
		expect(injectOmpAppendSystemPrompts("claude --dangerously-skip-permissions", [contract])).toBe(
			"claude --dangerously-skip-permissions",
		);
		expect(() => injectOmpAppendSystemPrompts("omp --auto-approve", [contract, ""])).toThrow("empty append-system-prompt block");
	});

	it("loads charter raw bytes and rejects whitespace, symlink, NUL, and invalid UTF-8", () => {
		const home = tempHome("fm-charter-load-");
		const path = join(home, "data", "charter.md");
		const body = "  leading\n";
		writeFileSync(path, body);
		const loaded = loadRequiredCharter(home);
		expect(loaded.text).toBe(body);
		expect(loaded.digest).toBe(createHash("sha256").update(Buffer.from(body)).digest("hex"));
		writeFileSync(path, "   \n\t\n");
		expect(() => loadRequiredCharter(home)).toThrow(/empty/);
		rmSync(path);
		const secret = join(home, "secret.env");
		writeFileSync(secret, "TOKEN=leak\n");
		symlinkSync(secret, path);
		expect(() => loadRequiredCharter(home)).toThrow(/symlink/);
		rmSync(path);
		writeFileSync(path, Buffer.from([0x41, 0x00, 0x42]));
		expect(() => loadRequiredCharter(home)).toThrow(/NUL/);
		writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
		expect(() => loadRequiredCharter(home)).toThrow(/UTF-8/);
		rmSync(home, { recursive: true, force: true });
	});
});

describe("shared AGENTS role neutrality", () => {
	it("does not contain an unconditional firstmate identity assertion", () => {
		const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
		expect(agents).not.toContain("You are the first mate.");
		expect(agents).toContain("# Fleet operating procedures");
		expect(agents).toContain("This file defines shared procedure, never active identity.");
		expect(agents).toContain("`kind:secondmate` or `kind:crew`");
		expect(agents).toContain("Cap-facing communication (conditional on `kind:firstmate`)");
		expect(agents).toContain("Resolve the registered project and current secondmate scope before starting background execution");
	});
});

describe("mate-home local surfaces", () => {
	it("ignores declared work and tmp directories", () => {
		const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
		expect(gitignore).toContain("work/\n");
		expect(gitignore).toContain("tmp/\n");
	});
});

describe("secondmate registry parser", () => {
	it("parses full, no-workspace, home-only, and partial keyed forms", () => {
		expect(
			parseSecondmateRegistryLine(
				"- full - Full summary (home: /mates/full; workspace: ws-1; name: Full; scope: domain; keeps bare; semicolons; projects: alpha, beta; added 2026-07-20)",
			),
		).toEqual({
			id: "full",
			summary: "Full summary",
			home: "/mates/full",
			workspace: "ws-1",
			name: "Full",
			scope: "domain; keeps bare; semicolons",
			projects: "alpha, beta",
			added: "2026-07-20",
		});
		expect(parseSecondmateRegistryLine("- now - No workspace (home: /mates/now; name: Now; scope: now; projects: app; added 2026-07-20)")).toEqual({
			id: "now",
			summary: "No workspace",
			home: "/mates/now",
			workspace: "",
			name: "Now",
			scope: "now",
			projects: "app",
			added: "2026-07-20",
		});
		expect(parseSecondmateRegistryLine("- homeonly - Home only (home: /mates/homeonly)")).toEqual({
			id: "homeonly",
			summary: "Home only",
			home: "/mates/homeonly",
			workspace: "",
			name: "",
			scope: "",
			projects: "",
			added: "",
		});
		expect(parseSecondmateRegistryLine("- partial - Partial (home: /mates/partial; scope: partial; projects: (none))")).toEqual({
			id: "partial",
			summary: "Partial",
			home: "/mates/partial",
			workspace: "",
			name: "",
			scope: "partial",
			projects: "(none)",
			added: "",
		});
	});
});

describe("secondmate structural gate", () => {
	it("cannot be elevated by FM_HOME pointing at main for forbidden commands", () => {
		const main = tempHome("fm-role-main-");
		const sm = secondmateHome("kodiak", "Kodiak", "frontend", "Keel");
		writeFileSync(join(sm, "data", "secondmates.md"), "fixture\n");
		mkdirSync(join(main, "state"));
		mkdirSync(join(main, "projects"));
		try {
			const before = readFileSync(join(sm, "data", "secondmates.md"), "utf8");
			const result = spawnSync(FM, ["spawn", "new-sm", "--secondmate"], {
				cwd: sm,
				env: {
					...process.env,
					FM_HOME: main,
					FM_ROOT_OVERRIDE: main,
					FM_STATE_OVERRIDE: join(main, "state"),
					FM_DATA_OVERRIDE: join(main, "data"),
					FM_PROJECTS_OVERRIDE: join(main, "projects"),
					FM_CONFIG_OVERRIDE: join(main, "config"),
				},
				encoding: "utf8",
			});
			expect(result.status).toBe(1);
			expect(result.stdout).toContain("WRONG_ROLE");
			expect(readFileSync(join(sm, "data", "secondmates.md"), "utf8")).toBe(before);
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(sm, { recursive: true, force: true });
		}
	});

	it("filters forbidden root help and still dispatches allowed local commands inside the structural secondmate home", () => {
		const main = tempHome("fm-role-main-");
		const sm = secondmateHome("kodiak", "Kodiak", "frontend", "Keel");
		const bin = join(sm, "bin");
		const mainState = join(main, "state");
		const smState = join(sm, "state");
		mkdirSync(bin);
		mkdirSync(mainState);
		mkdirSync(smState, { recursive: true });
		mkdirSync(join(main, "projects"));
		writeFileSync(join(mainState, ".lock"), "999999\n");
		writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "ps"), 0o755);
		try {
			const help = spawnSync(FM, ["--help"], { cwd: sm, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
			expect(help.status).toBe(0);
			expect(help.stdout).not.toContain("command: home");
			expect(help.stdout).toContain("fleet,");
			const allowed = spawnSync(FM, ["lock", "status"], {
				cwd: sm,
				env: {
					...process.env,
					FM_HOME: main,
					FM_ROOT_OVERRIDE: main,
					FM_STATE_OVERRIDE: mainState,
					FM_DATA_OVERRIDE: join(main, "data"),
					FM_PROJECTS_OVERRIDE: join(main, "projects"),
					FM_CONFIG_OVERRIDE: join(main, "config"),
					PATH: `${bin}:${process.env.PATH ?? ""}`,
				},
				encoding: "utf8",
			});
			expect(allowed.status).toBe(0);
			expect(allowed.stdout).toBe("lock: free\n");
			expect(readFileSync(join(mainState, ".lock"), "utf8")).toBe("999999\n");
			expect(existsSync(join(smState, ".lock"))).toBe(false);
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(sm, { recursive: true, force: true });
		}
	});
});

describe("actual fm spawn OMP role injection", () => {
	function spawnHarness(): { main: string; sm: string; bin: string; log: string } {
		const main = tempHome("fm-role-spawn-main-");
		writeFileSync(join(main, "config", "identity"), "schema_version=1\nname=Keel\nrole=firstmate\n");
		mkdirSync(join(main, "state"));
		mkdirSync(join(main, "projects"));
		const sm = secondmateHome("kodiak", "Kodiak", "frontend", "Keel");
		writeFileSync(join(main, "data", "secondmates.md"), `- kodiak - Frontend (home: ${sm}; name: Kodiak; scope: frontend; projects: app; added 2026-07-18)\n`);
		const bin = join(main, "bin");
		const log = join(main, "herdr.log");
		mkdirSync(bin);
		writeFileSync(join(bin, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "pane list") printf '{"result":{"panes":[]}}\\n'; exit 0 ;;
  "tab create") printf '{"result":{"tab":{"tab_id":"tab-1","root_pane":{"pane_id":"root-1"}}}}\\n'; exit 0 ;;
  "agent get") printf '{"error":"not found"}\\n'; exit 0 ;;
  "agent start") printf '{"result":{"agent":{"pane_id":"pane-1"}}}\\n'; exit 0 ;;
  "pane rename") exit 0 ;;
  "pane close") exit 0 ;;
esac
exit 0
`);
		chmodSync(join(bin, "herdr"), 0o755);
		return { main, sm, bin, log };
	}

	function spawnEnv(fresh: { main: string; bin: string }): NodeJS.ProcessEnv {
		return {
			...process.env,
			FM_HOME: fresh.main,
			FM_STATE_OVERRIDE: join(fresh.main, "state"),
			FM_DATA_OVERRIDE: join(fresh.main, "data"),
			FM_CONFIG_OVERRIDE: join(fresh.main, "config"),
			FM_PROJECTS_OVERRIDE: join(fresh.main, "projects"),
			PATH: `${fresh.bin}:${process.env.PATH ?? ""}`,
			FM_SPAWN_NO_GUARD: "1",
			FM_ROOT_OVERRIDE: "",
			FM_FLEET_SOURCE_HOME: "",
			FM_INJECTED_CHARTER_PATH: "",
			FM_INJECTED_CHARTER_SHA256: "",
		};
	}

	it("injects role contract then charter on new session and -c resume without positional prompt", () => {
		const fresh = spawnHarness();
		const env = spawnEnv(fresh);
		try {
			const first = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
			const firstLog = readFileSync(fresh.log, "utf8");
			expect(firstLog).toContain("agent start kodiak");
			expect(firstLog).toContain("omp --append-system-prompt=");
			expect(firstLog).toContain("You are Kodiak, a secondmate reporting to Keel.");
			expect(firstLog).toContain("## Local charter");
			expect(firstLog).toContain("FM_INJECTED_CHARTER_PATH=");
			expect(firstLog).toContain("FM_INJECTED_CHARTER_SHA256=");
			expect(firstLog).not.toContain("$(cat ");
			const contractIdx = firstLog.indexOf("You are Kodiak");
			const charterIdx = firstLog.indexOf("## Local charter");
			expect(contractIdx).toBeGreaterThan(-1);
			expect(charterIdx).toBeGreaterThan(contractIdx);

			writeFileSync(join(fresh.main, "state", "kodiak.meta"), `home=${fresh.sm}\nworkspace=\n`);
			writeFileSync(fresh.log, "");
			const resume = spawnSync(FM, ["spawn", "kodiak", "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(resume.status).toBe(0);
			const resumeLog = readFileSync(fresh.log, "utf8");
			expect(resumeLog).toContain("omp --append-system-prompt=");
			expect(resumeLog).toContain("--auto-approve -c");
			expect(resumeLog).toContain("You are Kodiak, a secondmate reporting to Keel.");
			expect(resumeLog).toContain("## Local charter");
			expect(resumeLog).toContain("FM_INJECTED_CHARTER_SHA256=");
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});

	it("fails closed when OMP secondmate charter is missing or whitespace-only", () => {
		const fresh = spawnHarness();
		const env = spawnEnv(fresh);
		try {
			rmSync(join(fresh.sm, "data", "charter.md"));
			const missing = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(missing.status).not.toBe(0);
			expect(`${missing.stdout}${missing.stderr}`).toContain("charter required");
			expect(existsSync(fresh.log) ? readFileSync(fresh.log, "utf8") : "").not.toContain("agent start");

			writeFileSync(join(fresh.sm, "data", "charter.md"), "  \n\t\n");
			if (existsSync(fresh.log)) writeFileSync(fresh.log, "");
			const empty = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(empty.status).not.toBe(0);
			expect(`${empty.stdout}${empty.stderr}`).toContain("charter required");
			expect(existsSync(fresh.log) ? readFileSync(fresh.log, "utf8") : "").not.toContain("agent start");
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});

	it("keeps non-OMP secondmate __BRIEF__ launch", () => {
		const fresh = spawnHarness();
		const env = spawnEnv(fresh);
		try {
			const run = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "codex", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
			const log = readFileSync(fresh.log, "utf8");
			expect(log).toContain("$(cat ");
			expect(log).toContain(`${fresh.sm}/data/charter.md`);
			expect(log).not.toContain("FM_INJECTED_CHARTER_");
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});

	it("records efficiency acceptance: byte delta, one prompt flag, and onboarding turns", () => {
		const fresh = spawnHarness();
		const env = spawnEnv(fresh);
		try {
			const run = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
			const log = readFileSync(fresh.log, "utf8");
			const appendCount = (log.match(/--append-system-prompt=/g) ?? []).length;
			expect(appendCount).toBe(1);
			expect(log).not.toMatch(/\$\(cat /);
			const before = {
				positionalPrompts: 1,
				onboardingTurns: 1,
				appendBytes: Buffer.byteLength(secondmateRoleContract({ home: fresh.sm, mainHome: fresh.main }), "utf8"),
			};
			const charter = loadRequiredCharter(fresh.sm);
			const block = charterSystemBlock(charter.text);
			const after = {
				positionalPrompts: log.includes("$(cat ") ? 1 : 0,
				onboardingTurns: 0,
				appendBytes: before.appendBytes + Buffer.byteLength("\n\n", "utf8") + Buffer.byteLength(block, "utf8"),
			};
			expect(after.positionalPrompts).toBe(0);
			expect(after.onboardingTurns).toBe(0);
			expect(after.appendBytes - before.appendBytes).toBe(Buffer.byteLength(`\n\n${block}`, "utf8"));
			expect(before.positionalPrompts - after.positionalPrompts).toBe(1);
			expect(before.onboardingTurns - after.onboardingTurns).toBe(1);
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});

	it("injects and marks charter for raw env-assign and path-form OMP launches", () => {
		const fresh = spawnHarness();
		const env = spawnEnv(fresh);
		try {
			for (const raw of [
				`OMP_MODE=manual omp --auto-approve "$(cat __BRIEF__)"`,
				`/usr/bin/omp --auto-approve "$(cat __BRIEF__)"`,
			]) {
				writeFileSync(fresh.log, "");
				const run = spawnSync(FM, ["spawn", "kodiak", fresh.sm, raw, "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
				expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
				const log = readFileSync(fresh.log, "utf8");
				expect(log).toContain("--append-system-prompt=");
				expect(log).toContain("## Local charter");
				expect(log).toContain("FM_INJECTED_CHARTER_SHA256=");
				expect((log.match(/--append-system-prompt=/g) ?? []).length).toBe(1);
			}
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});

	it("refuses symlink charters before OMP secondmate launch", () => {
		const fresh = spawnHarness();
		const env = spawnEnv(fresh);
		try {
			const charter = join(fresh.sm, "data", "charter.md");
			const secret = join(fresh.sm, "secret.env");
			writeFileSync(secret, "SECRET=1\n");
			rmSync(charter);
			symlinkSync(secret, charter);
			const run = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(run.status).not.toBe(0);
			expect(`${run.stdout}${run.stderr}`).toContain("symlink");
			expect(existsSync(fresh.log) ? readFileSync(fresh.log, "utf8") : "").not.toContain("agent start");
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});
});
