// Regression tests for .omp/extensions/cli/verbs/start.ts.
// Run: bun test tests/fm-start.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fmStartStatic, { emitFmStartStatic } from "../.omp/extensions/fm-start-static";

const REPO_ROOT = import.meta.dir.replace(/\/tests$/, "");
const FM = join(REPO_ROOT, "sbin", "fm");
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

const DEFAULT_OMP = `#!/bin/sh
state=\${FM_STATE_OVERRIDE:-$FM_HOME/state}
lock=$(cat "$state/.lock" 2>/dev/null || true)
printf '%s' "$PWD" > "$FM_START_TEST_OUTPUT.cwd"
printf '%s' "\${FM_SUPERVISED_SUCCESSOR:-}" > "$FM_START_TEST_OUTPUT.marker"
printf '%s' "$#" > "$FM_START_TEST_OUTPUT.argc"
printf '%s' "$$" > "$FM_START_TEST_OUTPUT.pid"
printf '%s' "$lock" > "$FM_START_TEST_OUTPUT.lock"
printf '%s' "\${FM_HOME:-}" > "$FM_START_TEST_OUTPUT.home"
printf '%s' "\${FM_START_STATIC_CONTEXT:-}" > "$FM_START_TEST_OUTPUT.static"
i=0
for arg in "$@"; do
  printf '%s' "$arg" > "$FM_START_TEST_OUTPUT.arg$i"
  i=$((i + 1))
done
[ "$lock" = "$$" ] || exit 42
`;

const LEGACY_OMP = `#!/bin/sh
printf '%s' "$PWD" > "$FM_START_TEST_OUTPUT.cwd"
printf '%s' "$#" > "$FM_START_TEST_OUTPUT.argc"
i=0
for arg in "$@"; do
  printf '%s' "$arg" > "$FM_START_TEST_OUTPUT.arg$i"
  i=$((i + 1))
done
`;

const EVENT_OMP = `#!/bin/sh
state=\${FM_STATE_OVERRIDE:-$FM_HOME/state}
lock=$(cat "$state/.lock" 2>/dev/null || true)
[ "$lock" = "$$" ] || exit 42
printf 'start %s\n' "$$" >> "$FM_START_TEST_OUTPUT.events"
sleep 0.2
printf 'end %s\n' "$$" >> "$FM_START_TEST_OUTPUT.events"
`;

interface Fixture {
	temp: string;
	home: string;
	state: string;
	bin: string;
	output: string;
	commandLog: string;
	fmHelper: string;
}

interface LaunchResult {
	cwd: string;
	marker?: string;
	rolePrompt: string;
	appendSystemPrompt: string;
	kickoff?: string;
	argc: string;
	pid?: string;
	lock?: string;
	home?: string;
	staticContext?: string;
	args: string[];
}

interface StartedFm {
	child: ChildProcess;
	stdout: () => string;
	stderr: () => string;
}

afterEach(() => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(ompScript = DEFAULT_OMP): Fixture {
	const temp = mkdtempSync(join(tmpdir(), "fm-start-test-"));
	tempDirs.push(temp);
	const home = join(temp, "home");
	const state = join(home, "state");
	const bin = join(temp, "bin");
	const commandLog = join(temp, "commands");
	const fmHelper = join(bin, "fm-helper");
	mkdirSync(state, { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(bin, "ps"), `#!/bin/sh
field= pid=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) field=$2; shift 2 ;;
    -p) pid=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "\${FM_START_TEST_HOLDER:-}" ] && [ "$pid" = "$FM_START_TEST_HOLDER" ]; then
  case "$field" in
    comm=) printf 'omp\n' ;;
    args=) printf 'omp --auto-approve\n' ;;
    ppid=) printf '1\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ -n "\${FM_STATE_OVERRIDE:-}" ] && [ -f "$FM_STATE_OVERRIDE/.lock" ] && [ "$(cat "$FM_STATE_OVERRIDE/.lock")" = "$pid" ]; then
  case "$field" in
    comm=) printf 'omp\n' ;;
    args=) printf 'omp --append-system-prompt\n' ;;
    ppid=) printf '1\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$field" in
  comm=) printf 'bash\n' ;;
  args=) printf 'bash /tmp/tool-call.sh\n' ;;
  ppid=) printf '1\n' ;;
  *) exit 1 ;;
esac
`);
	writeFileSync(join(bin, "omp"), ompScript);
	writeFileSync(fmHelper, `#!/bin/sh
printf '%s\n' "$*" >> "$FM_START_TEST_COMMAND_LOG"
scenario="\${FM_START_TEST_SCENARIO:-ok}"
count_file="$FM_START_TEST_OUTPUT.$(printf '%s' "$*" | tr ' /-' '___').count"
count=0
[ -f "$count_file" ] && count=$(cat "$count_file")
count=$((count + 1))
printf '%s' "$count" > "$count_file"
case "$*" in
  bootstrap)
    if [ "$scenario" = bootstrap-missing ]; then printf 'MISSING: gh (install: brew install gh)\n'; exit 0; fi
    printf 'TASKS: native\n'; exit 0 ;;
  "identity-migrate check")
    if [ "$scenario" = identity-home-repair ] && [ "$count" = 1 ]; then printf 'UNRESOLVED\triggs\t/tmp/riggs\tunversioned\n'; exit 1; fi
    if [ "$scenario" = identity-no-identity ] && [ "$count" = 1 ]; then printf 'UNRESOLVED\triggs\t/tmp/riggs\tno-identity\n'; exit 1; fi
    printf 'OK\triggs\t/tmp/riggs\n'; exit 0 ;;
  "identity-migrate migrate")
    printf 'MIGRATED\triggs\t/tmp/riggs\n'; exit 0 ;;
  "home check --all")
    if [ "$scenario" = identity-home-repair ] && [ "$count" = 1 ]; then printf 'drift\n'; exit 1; fi
    printf 'ok\n'; exit 0 ;;
  "home repair --all")
    printf 'repaired\n'; exit 0 ;;
  "lavish-open --recover")
    printf 'recovered: 0 steward(s)\n'; exit 0 ;;
  "fleet snapshot --json")
    cat <<JSON
{"schema":"fleet-snapshot/1","generatedAt":"2026-07-18T00:00:00.000Z","home":"\${FM_HOME:-$PWD}","health":{"state":"healthy","herdr":"ok","homes":2,"missingHomes":0,"livePanes":1},"activation":{"state":"fresh","total":2,"fresh":2,"stale":0,"unknown":0},"identity":{"state":"bound","bound":2,"mismatch":0,"unknown":0},"topology":{"state":"complete","present":2,"missing":0,"incomplete":0,"reason":"ok"},"mates":[{"name":"main","role":"firstmate","herdrStatus":"idle","load":1},{"name":"riggs","role":"secondmate","herdrStatus":"working","load":2}],"agents":[{"key":"main/task-1","id":"task-1","owner":"main","kind":"crew","status":"working","liveStatus":"working","pane":"%1","project":"alpha","topology":{"home":"\${FM_HOME:-$PWD}","pane":"%1"}}],"pending":[{"key":"main/task-2","cls":"CAP-BLOCKED","clsRank":4,"home":"\${FM_HOME:-$PWD}","id":"task-2","reason":"needs decision"}],"attention":[{"key":"main/task-2","cls":"CAP-BLOCKED","clsRank":4,"home":"\${FM_HOME:-$PWD}","id":"task-2","reason":"needs decision"}],"tasks":[{"key":"main/task-1","id":"task-1","state":"inflight","owner":"main","project":"alpha","workerState":"working","note":"doing work"},{"key":"main/task-3","id":"task-3","state":"queued","owner":"main","project":"beta","note":"ready"},{"key":"main/task-4","id":"task-4","state":"done","owner":"main","project":"gamma","note":"PR ready","pr":"https://github.com/acme/repo/pull/4","merged":false}],"otherLivePanes":[{"name":"stray","status":"idle","cwd":"/tmp/stray"}],"notes":["fixture note"]}
JSON
    [ "$scenario" = fleet-degraded ] && exit 1
    exit 0 ;;
  *) printf 'unexpected command: %s\n' "$*" >&2; exit 64 ;;
esac
`);
	chmodSync(join(bin, "ps"), 0o755);
	chmodSync(join(bin, "omp"), 0o755);
	chmodSync(fmHelper, 0o755);
	return { temp, home, state, bin, output: join(temp, "launch"), commandLog, fmHelper };
}

function fmEnv(fx: Fixture, home: string | undefined, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
		FM_STATE_OVERRIDE: fx.state,
		FM_START_FM_BIN: fx.fmHelper,
		FM_START_TEST_COMMAND_LOG: fx.commandLog,
		FM_START_TEST_OUTPUT: fx.output,
		...extra,
	};
	if (home === undefined) delete env.FM_HOME;
	else env.FM_HOME = home;
	return env;
}

function startFm(fx: Fixture, home: string | undefined, extra: NodeJS.ProcessEnv = {}, args: string[] = [], cwd = REPO_ROOT): StartedFm {
	let stdout = "";
	let stderr = "";
	const child = spawn(FM, ["start", ...args], {
		cwd,
		env: fmEnv(fx, home, extra),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	child.stdout?.on("data", chunk => {
		stdout += String(chunk);
	});
	child.stderr?.on("data", chunk => {
		stderr += String(chunk);
	});
	return { child, stdout: () => stdout, stderr: () => stderr };
}

async function statusOf(child: ChildProcess): Promise<number> {
	const [code] = await once(child, "exit");
	return typeof code === "number" ? code : 1;
}

async function runFm(fx: Fixture, home: string | undefined, extra: NodeJS.ProcessEnv = {}, args: string[] = [], cwd = REPO_ROOT): Promise<{ status: number; stdout: string; stderr: string }> {
	const started = startFm(fx, home, extra, args, cwd);
	const status = await statusOf(started.child);
	return { status, stdout: started.stdout(), stderr: started.stderr() };
}

function maybeRead(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function readLaunch(output: string): LaunchResult {
	const argc = Number(readFileSync(`${output}.argc`, "utf8"));
	const args = Array.from({ length: argc }, (_value, index) => readFileSync(`${output}.arg${index}`, "utf8"));
	return {
		cwd: readFileSync(`${output}.cwd`, "utf8"),
		marker: maybeRead(`${output}.marker`),
		rolePrompt: args[0],
		appendSystemPrompt: args[1],
		kickoff: args[2],
		argc: String(argc),
		pid: maybeRead(`${output}.pid`),
		lock: maybeRead(`${output}.lock`),
		home: maybeRead(`${output}.home`),
		staticContext: maybeRead(`${output}.static`),
		args,
	};
}

function commandLog(fx: Fixture): string[] {
	return existsSync(fx.commandLog) ? readFileSync(fx.commandLog, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
}

function liveHolder(): ChildProcess {
	const child = spawn("sleep", ["5"]);
	children.push(child);
	return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
	child.kill("SIGTERM");
	await once(child, "exit");
}

describe("fm start launch root", () => {
	it("uses the registered FM_HOME as OMP's cwd", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home);
		expect(run.status).toBe(0);
		expect(readLaunch(fx.output).cwd).toBe(realpathSync(fx.home));
	});

	it("uses the repository root when FM_HOME is absent", async () => {
		const fx = fixture();
		const run = await runFm(fx, undefined);
		expect(run.status).toBe(0);
		expect(readLaunch(fx.output).cwd).toBe(REPO_ROOT);
	});
});

describe("fm start main preflight", () => {
	it("recognizes the production descriptive main role", async () => {
		const fx = fixture();
		mkdirSync(join(fx.home, "config"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Keel\nrole=Main firstmate crew supervisor\nparent=captain\n");

		const run = await runFm(fx, fx.home);

		expect(run.status).toBe(0);
		expect(readLaunch(fx.output).rolePrompt).toContain("kind: firstmate");
		expect(commandLog(fx)).toEqual(["bootstrap", "identity-migrate check", "home check --all", "lavish-open --recover", "fleet snapshot --json"]);
	});

	it("runs deterministic startup commands before OMP launch", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home);
		expect(run.status).toBe(0);
		expect(commandLog(fx)).toEqual(["bootstrap", "identity-migrate check", "home check --all", "lavish-open --recover", "fleet snapshot --json"]);
		expect(readLaunch(fx.output).pid).toBeDefined();
	});

	it("migrates identity and repairs homes only after observed failures", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home, { FM_START_TEST_SCENARIO: "identity-home-repair" });
		expect(run.status).toBe(0);
		expect(commandLog(fx)).toEqual(["bootstrap", "identity-migrate check", "identity-migrate migrate", "identity-migrate check", "home check --all", "home repair --all", "home check --all", "lavish-open --recover", "fleet snapshot --json"]);
	});

	it("migrates missing identity files but fails closed on unsafe identity states", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home, { FM_START_TEST_SCENARIO: "identity-no-identity" });
		expect(run.status).toBe(0);
		expect(commandLog(fx)).toEqual(["bootstrap", "identity-migrate check", "identity-migrate migrate", "identity-migrate check", "home check --all", "lavish-open --recover", "fleet snapshot --json"]);
	});

	it("stops before OMP on hard bootstrap failure", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home, { FM_START_TEST_SCENARIO: "bootstrap-missing" });
		expect(run.status).toBe(1);
		expect(existsSync(`${fx.output}.pid`)).toBe(false);
		expect(run.stderr).toContain("fm start preflight failed:");
		expect(run.stderr).toContain("blocking bootstrap diagnostics");
		expect(commandLog(fx)).toEqual(["bootstrap"]);
	});

	it("launches with visible degraded fleet context", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home, { FM_START_TEST_SCENARIO: "fleet-degraded" });
		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(result.staticContext).toContain("fleet snapshot exit 1");
		expect(result.staticContext).toContain("FIRSTMATE START");
		expect(result.appendSystemPrompt).toContain("The static fleet representation is delivered as one visible `fm-start-static` session-start message");
		expect(result.appendSystemPrompt).not.toContain("fleet snapshot exit 1");
	});
});

describe("fm start lock ownership", () => {
	it("does not launch OMP before a different live holder releases", async () => {
		const fx = fixture();
		const holder = liveHolder();
		if (holder.pid === undefined) throw new Error("holder pid unavailable");
		writeFileSync(join(fx.state, ".lock"), `${holder.pid}\n`);

		const waiting = Promise.withResolvers<void>();
		const started = startFm(fx, fx.home, { FM_START_TEST_HOLDER: String(holder.pid) });
		started.child.stdout?.on("data", chunk => {
			if (String(chunk).includes("waiting for live firstmate lock holder pid")) waiting.resolve();
		});
		await waiting.promise;
		expect(existsSync(`${fx.output}.pid`)).toBe(false);
		expect(commandLog(fx)).toEqual([]);
		await stopChild(holder);
		expect(await statusOf(started.child)).toBe(0);
		expect(started.stdout().split(/\r?\n/).filter(line => line.includes("waiting for live firstmate lock holder pid"))).toHaveLength(1);
		const result = readLaunch(fx.output);
		expect(result.lock).toBe(result.pid);
	});

	it("records the spawned child PID before fake OMP reads the lock", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home);
		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(result.lock).toBe(result.pid);
		expect(existsSync(join(fx.state, ".lock"))).toBe(false);
	});

	it("times out without launching OMP and cleans up the claim", async () => {
		const fx = fixture();
		const holder = liveHolder();
		if (holder.pid === undefined) throw new Error("holder pid unavailable");
		writeFileSync(join(fx.state, ".lock"), `${holder.pid}\n`);

		// This integration path intentionally exercises the real bounded timeout outside OMP launch.
		const run = await runFm(fx, fx.home, { FM_START_TEST_HOLDER: String(holder.pid), FM_START_LOCK_WAIT_TIMEOUT_SECS: "0.05" });
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("timed out waiting for live firstmate lock holder pid");
		expect(existsSync(`${fx.output}.pid`)).toBe(false);
		expect(readFileSync(join(fx.state, ".lock"), "utf8").trim()).toBe(String(holder.pid));
		expect(existsSync(join(fx.state, ".lock.claim"))).toBe(false);
		expect(commandLog(fx)).toEqual([]);
	});

	it("serializes concurrent starts so only one child owns the lock at a time", async () => {
		const fx = fixture(EVENT_OMP);
		const [first, second] = await Promise.all([runFm(fx, fx.home), runFm(fx, fx.home)]);
		expect(first.status).toBe(0);
		expect(second.status).toBe(0);
		const events = readFileSync(`${fx.output}.events`, "utf8").trim().split(/\r?\n/);
		expect(events).toHaveLength(4);
		expect(events[0].startsWith("start ")).toBe(true);
		expect(events[1]).toBe(events[0].replace("start ", "end "));
		expect(events[2].startsWith("start ")).toBe(true);
		expect(events[3]).toBe(events[2].replace("start ", "end "));
	});
});

describe("fm start prompt", () => {
	it("passes static context by env with no default kickoff or duplicate prompt payload", async () => {
		const fx = fixture();
		const run = await runFm(fx, undefined, { FM_SUPERVISED_SUCCESSOR: "should-not-leak" });
		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(result.marker).toBe("");
		expect(result.home).toBe("");
		expect(result.argc).toBe("2");
		expect(result.kickoff).toBeUndefined();
		expect(result.rolePrompt.startsWith("--append-system-prompt=")).toBe(true);
		expect(result.appendSystemPrompt.startsWith("--append-system-prompt=")).toBe(true);
		expect(result.rolePrompt).toContain("kind: firstmate");
		expect(run.stdout).toBe("");
		expect(result.staticContext).toContain("FIRSTMATE START");
		expect(result.staticContext).toContain("Refresh: fm fleet");
		expect(result.appendSystemPrompt).not.toContain(result.staticContext);
		expect(result.appendSystemPrompt).not.toContain("FM_SUPERVISED_SUCCESSOR");
		expect(result.appendSystemPrompt).not.toContain("skill://firstmate-bootstrap");
		expect(result.appendSystemPrompt).not.toContain("skill://firstmate-recovery");
		expect(result.appendSystemPrompt).not.toContain("Run `sbin/fm bootstrap`");
		expect(result.appendSystemPrompt).not.toContain("Run `sbin/fm lock`");
		expect(result.appendSystemPrompt).not.toContain("Recovery procedure");
	});

	it("passes explicit OMP args unchanged after the injected context", async () => {
		const fx = fixture();
		const run = await runFm(fx, fx.home, {}, ["-c", "previous"]);
		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(result.argc).toBe("4");
		expect(result.rolePrompt.startsWith("--append-system-prompt=")).toBe(true);
		expect(result.appendSystemPrompt.startsWith("--append-system-prompt=")).toBe(true);
		expect(result.args.slice(2)).toEqual(["-c", "previous"]);
	});

	it("preserves secondmate model-driven startup without main-firstmate skill bodies", async () => {
		const fx = fixture();
		writeFileSync(join(fx.home, "AGENTS.md"), "# secondmate\n");
		writeFileSync(join(fx.home, ".fm-secondmate-home"), "riggs\n");
		mkdirSync(join(fx.home, "config"), { recursive: true });
		mkdirSync(join(fx.home, "data"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Riggs\nrole=frontend and implementation domain\nparent=Keel\n");
		writeFileSync(join(fx.home, "data", "charter.md"), "# Charter\nRiggs\n\n# Routing scope\nfrontend routing\n");
		writeFileSync(join(fx.home, "data", "cap.md"), "Cap prefs\n");
		const run = await runFm(fx, undefined, {}, [], fx.home);
		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(commandLog(fx)).toEqual([]);
		expect(run.stdout).toBe("");
		expect(result.argc).toBe("3");
		expect(result.rolePrompt).toContain("kind: secondmate");
		expect(result.rolePrompt).toContain("You are Riggs, a secondmate reporting to Keel.");
		expect(result.rolePrompt).toContain("reports_to: Keel");
		expect(result.lock).toBe(result.pid);
		expect(result.kickoff).toContain("You are Riggs, a secondmate reporting to Keel.");
		expect(result.appendSystemPrompt).toContain("# Secondmate startup context");
		expect(result.appendSystemPrompt).toContain("frontend routing");
		expect(result.appendSystemPrompt).toContain("Cap prefs");
		expect(result.appendSystemPrompt).not.toContain("Firstmate bootstrap");
		expect(result.appendSystemPrompt).not.toContain("Firstmate recovery");
		expect(result.appendSystemPrompt).not.toContain("Run `sbin/fm bootstrap`");
		expect(result.appendSystemPrompt).not.toContain("Run `fm home`");
	});

	it("propagates a structurally resolved secondmate home to OMP and its session lock", async () => {
		const fx = fixture();
		writeFileSync(join(fx.home, "AGENTS.md"), "# secondmate\n");
		writeFileSync(join(fx.home, ".fm-secondmate-home"), "riggs\n");
		mkdirSync(join(fx.home, "config"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Riggs\nrole=frontend and implementation domain\nparent=Keel\n");

		const run = await runFm(fx, undefined, { FM_STATE_OVERRIDE: "" }, [], fx.home);

		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(result.home).toBe(realpathSync(fx.home));
		expect(result.lock).toBe(result.pid);
		expect(existsSync(join(fx.home, "state", ".lock"))).toBe(false);
	});

	it("uses an ambient secondmate FM_HOME when starting elsewhere", async () => {
		const fx = fixture();
		writeFileSync(join(fx.home, "AGENTS.md"), "# secondmate\n");
		writeFileSync(join(fx.home, ".fm-secondmate-home"), "riggs\n");
		mkdirSync(join(fx.home, "config"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Riggs\nrole=frontend and implementation domain\nparent=Keel\n");

		const run = await runFm(fx, fx.home, { FM_STATE_OVERRIDE: "" }, [], fx.temp);

		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(result.home).toBe(fx.home);
		expect(result.rolePrompt).toContain("kind: secondmate");
		expect(result.rolePrompt).not.toContain("kind: firstmate");
	});

	it("fails read-only when a production secondmate identity lacks its structural marker", async () => {
		const fx = fixture();
		const ambientMain = join(fx.temp, "main");
		mkdirSync(join(ambientMain, "state"), { recursive: true });
		writeFileSync(join(ambientMain, "AGENTS.md"), "# main\n");
		writeFileSync(join(fx.home, "AGENTS.md"), "# secondmate\n");
		mkdirSync(join(fx.home, "config"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Riggs\nrole=frontend and implementation domain\nparent=Keel\n");

		const run = await runFm(fx, ambientMain, { FM_STATE_OVERRIDE: "" }, [], fx.home);

		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(commandLog(fx)).toEqual([]);
		expect(result.rolePrompt).toContain("kind: unverified");
		expect(result.rolePrompt).toContain("authority: read-only");
		expect(result.rolePrompt).toContain("parent is Keel");
		expect(result.rolePrompt).not.toContain("kind: firstmate");
		expect(result.home).toBe(realpathSync(fx.home));
	});

	it("fails read-only when marker and configured identity role disagree", async () => {
		const fx = fixture();
		writeFileSync(join(fx.home, "AGENTS.md"), "# secondmate\n");
		writeFileSync(join(fx.home, ".fm-secondmate-home"), "riggs\n");
		mkdirSync(join(fx.home, "config"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Riggs\nrole=firstmate\nparent=Keel\n");

		const run = await runFm(fx, undefined, { FM_STATE_OVERRIDE: "" }, [], fx.home);

		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(commandLog(fx)).toEqual([]);
		expect(result.rolePrompt).toContain("kind: unverified");
		expect(result.rolePrompt).toContain("authority: read-only");
		expect(result.rolePrompt).not.toContain("kind: firstmate");
		expect(result.rolePrompt).not.toContain("kind: secondmate");
	});

	it("fails read-only when a secondmate marker conflicts with parent=captain", async () => {
		const fx = fixture();
		writeFileSync(join(fx.home, "AGENTS.md"), "# secondmate\n");
		writeFileSync(join(fx.home, ".fm-secondmate-home"), "riggs\n");
		mkdirSync(join(fx.home, "config"), { recursive: true });
		writeFileSync(join(fx.home, "config", "identity"), "schema_version=1\nname=Riggs\nrole=frontend and implementation domain\nparent=captain\n");

		const run = await runFm(fx, undefined, { FM_STATE_OVERRIDE: "" }, [], fx.home);

		expect(run.status).toBe(0);
		const result = readLaunch(fx.output);
		expect(commandLog(fx)).toEqual([]);
		expect(result.rolePrompt).toContain("kind: unverified");
		expect(result.rolePrompt).toContain("authority: read-only");
		expect(result.rolePrompt).toContain("parent is captain");
		expect(result.rolePrompt).not.toContain("kind: firstmate");
		expect(result.rolePrompt).not.toContain("kind: secondmate");
	});
});

describe("fm-start-static extension", () => {
	it("emits one visible custom message without triggering a turn when static context is present", () => {
		const sent: { message: { customType: string; content: string; display: boolean }; options: { triggerTurn: boolean } }[] = [];
		const emitted = emitFmStartStatic({ sendMessage: (message, options) => sent.push({ message, options }) }, { FM_START_STATIC_CONTEXT: "STATIC-BYTES" });
		expect(emitted).toBe(true);
		expect(sent).toEqual([{ message: { customType: "fm-start-static", content: "STATIC-BYTES", display: true }, options: { triggerTurn: false } }]);
	});

	it("session_start emits absent static context as no-op", () => {
		const handlers = new Map<string, () => void>();
		const sent: unknown[] = [];
		const previous = process.env.FM_START_STATIC_CONTEXT;
		delete process.env.FM_START_STATIC_CONTEXT;
		try {
			fmStartStatic({
				on(event, handler) {
					handlers.set(event, () => handler({}, {}));
				},
				sendMessage(message, options) {
					sent.push({ message, options });
				},
			});
			handlers.get("session_start")?.();
		} finally {
			if (previous === undefined) delete process.env.FM_START_STATIC_CONTEXT;
			else process.env.FM_START_STATIC_CONTEXT = previous;
		}
		expect(sent).toEqual([]);
	});
});
