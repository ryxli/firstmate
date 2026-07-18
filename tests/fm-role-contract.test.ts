// Focused role-contract and secondmate gate coverage.
// Run: bun test tests/fm-role-contract.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { crewRoleContract, mainRoleContract, roleContractForHome, secondmateRoleContract } from "../.omp/extensions/cli/lib/role-contract";
import { injectOmpRoleContract } from "../.omp/extensions/cli/verbs/spawn";

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
	writeFileSync(join(home, ".fm-secondmate-home"), `${id}\n`);
	writeFileSync(join(home, "config", "identity"), `schema_version=1\nname=${name}\nrole=secondmate\n${parent ? `parent=${parent}\n` : ""}`);
	writeFileSync(join(home, "data", "charter.md"), `# Charter\n${name}\n\n# Routing scope\n${scope}\n\n# Project clones\nnone\n`);
	return home;
}

describe("runtime role contracts", () => {
	it("generates Keel main, Kodiak secondmate, Plum secondmate, and crew contracts", () => {
		const fallbackMain = tempHome("fm-role-main-fallback-");
		const main = tempHome("fm-role-main-");
		writeFileSync(join(main, "config", "identity"), "schema_version=1\nname=Keel\nrole=firstmate\n");
		const kodiak = secondmateHome("kodiak", "Kodiak", "frontend and design routing", "Keel");
		const plum = secondmateHome("plum", "Plum", "legacy evidence only", "Keel");
		try {
			expect(mainRoleContract({ home: fallbackMain })).toContain("name: firstmate\nkind: firstmate");
			expect(mainRoleContract({ home: main })).toContain("You are Keel, the first mate reporting to the captain.");
			expect(mainRoleContract({ home: main })).toContain("name: Keel\nkind: firstmate");
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

	it("updates stale generated secondmate parent when main identity is known", () => {
		const main = tempHome("fm-role-main-");
		writeFileSync(join(main, "config", "identity"), "schema_version=1\nname=Keel\nrole=firstmate\n");
		const kodiak = secondmateHome("kodiak", "Kodiak", "frontend", "OldMain");
		try {
			expect(secondmateRoleContract({ home: kodiak, mainHome: main })).toContain("reports_to: Keel");
			expect(readFileSync(join(kodiak, "config", "identity"), "utf8")).toContain("parent=Keel");
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(kodiak, { recursive: true, force: true });
		}
	});

	it("injects OMP role contracts at the same append-system priority on fresh and resume commands", () => {
		const contract = "# Runtime Role Contract\nkind: crew";
		expect(injectOmpRoleContract('omp --auto-approve "$(cat brief)"', contract).startsWith("omp --append-system-prompt=")).toBe(true);
		expect(injectOmpRoleContract("omp --auto-approve -c", contract).startsWith("omp --append-system-prompt=")).toBe(true);
	});
});

describe("shared AGENTS role neutrality", () => {
	it("does not contain an unconditional firstmate identity assertion", () => {
		const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
		expect(agents).not.toContain("You are the first mate.");
		expect(agents).toContain("# Fleet operating procedures");
		expect(agents).toContain("This file defines shared procedure, never active identity.");
		expect(agents).toContain("`kind:secondmate` or `kind:crew`");
		expect(agents).toContain("Captain-facing communication (conditional on `kind:firstmate`)");
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
		mkdirSync(smState);
		mkdirSync(join(main, "projects"));
		writeFileSync(join(mainState, ".lock"), "999999\n");
		writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "ps"), 0o755);
		try {
			const help = spawnSync(FM, ["--help"], { cwd: sm, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
			expect(help.status).toBe(0);
			expect(help.stdout).not.toContain("command: home");
			expect(help.stdout).toContain("fleet update");
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

	it("injects the secondmate role contract in actual fresh and resume spawn commands", () => {
		const fresh = spawnHarness();
		const env = { ...process.env, FM_HOME: fresh.main, FM_STATE_OVERRIDE: join(fresh.main, "state"), FM_DATA_OVERRIDE: join(fresh.main, "data"), FM_CONFIG_OVERRIDE: join(fresh.main, "config"), FM_PROJECTS_OVERRIDE: join(fresh.main, "projects"), PATH: `${fresh.bin}:${process.env.PATH ?? ""}` };
		try {
			const first = spawnSync(FM, ["spawn", "kodiak", fresh.sm, "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(first.status).toBe(0);
			const firstLog = readFileSync(fresh.log, "utf8");
			expect(firstLog).toContain("agent start kodiak");
			expect(firstLog).toContain("omp --append-system-prompt=");
			expect(firstLog).toContain("You are Kodiak, a secondmate reporting to Keel.");

			writeFileSync(join(fresh.main, "state", "kodiak.meta"), `home=${fresh.sm}\nworkspace=\n`);
			writeFileSync(fresh.log, "");
			const resume = spawnSync(FM, ["spawn", "kodiak", "omp", "--secondmate"], { cwd: REPO_ROOT, env, encoding: "utf8" });
			expect(resume.status).toBe(0);
			const resumeLog = readFileSync(fresh.log, "utf8");
			expect(resumeLog).toContain("omp --append-system-prompt=");
			expect(resumeLog).toContain("--auto-approve -c");
			expect(resumeLog).toContain("You are Kodiak, a secondmate reporting to Keel.");
		} finally {
			rmSync(fresh.main, { recursive: true, force: true });
			rmSync(fresh.sm, { recursive: true, force: true });
		}
	});
});
