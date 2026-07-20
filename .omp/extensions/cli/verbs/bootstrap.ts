// fm verb: bootstrap - detect missing tools/auth, install approved tools, and
// run the fleet-refresh side effects (self-pane resync, herdr omp patch
// self-heal, cap-handoff gate, locked dependency sync, fleet sync).
// Ported behavior-preserving from sbin/fm bootstrap.
//
// Usage: fm bootstrap
//          Detect: prints one line per problem or capability fact and exits 0.
//          Silent = all good.
//          Lines: "MISSING: <tool> (install: <command>)", "NEEDS_GH_AUTH",
//                 "CREW_HARNESS_OVERRIDE: <name>", "FLEET_SYNC: <repo>: skipped: <reason>",
//                 "TASKS: native",
//                 "MISSING_EXT: <name> (provision: chezmoi apply - dotfiles repo is the canonical owner)".
//          MISSING_EXT covers the per-machine provisioned OMP extensions expected
//          as directories under ~/.omp/agent/extensions (override the dir with
//          FM_OMP_EXT_OVERRIDE). They are dotfiles-owned; bootstrap only declares,
//          never vendors or installs them.
//          TASKS: native is unconditional: the former optional external
//          tasks-axi capability probe is gone; native `fm task` (see the
//          `task` verb) always covers backlog management now.
//          Fleet sync fetches, fast-forwards, and prunes gone local branches;
//          it is bounded by FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT, default 20s.
//          Set FM_FLEET_PRUNE=0 to skip branch pruning during that refresh.
//        fm bootstrap install <tool>...
//          Install the named tools (only ones the cap approved).

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeFromCwd } from "../lib/root";
import { shellQuote } from "../lib/spawn";

// verbs -> cli -> extensions -> .omp -> repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

// herdr is the terminal/agent substrate and also manages secondmate home worktrees.
const TOOLS = ["herdr", "node", "gh", "gh-axi", "chrome-devtools-axi", "lavish-axi"];

// Per-machine provisioned OMP extensions, owned by the dotfiles repo (chezmoi).
// Bootstrap declares a missing one; it never vendors or installs extensions.
const OMP_EXTENSIONS = [
	"fleet-bus",
	"textguard",
	"thinking-tag-guard",
	"agent-effectiveness",
	"capture",
];

function envNonEmpty(name: string): string | undefined {
	const value = process.env[name];
	return value !== undefined && value !== "" ? value : undefined;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// commandExists(name): mirrors `command -v <name> >/dev/null 2>&1` for an
// external executable reachable via PATH.
function commandExists(name: string): boolean {
	const pathEnv = process.env.PATH ?? "";
	for (const raw of pathEnv.split(delimiter)) {
		const dir = raw === "" ? "." : raw;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return true;
		} catch {
			// keep scanning the rest of PATH
		}
	}
	return false;
}

function herdrServerRunning(): boolean {
	const res = spawnSync("herdr", ["status"], { encoding: "utf8" });
	return (res.stdout ?? "").includes("status: running");
}

function ghAuthOk(): boolean {
	const res = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
	return !res.error && res.status === 0;
}

// installCmd(tool): the human-facing install command for a known tool, or
// null for an unrecognized one (mirrors install_cmd's `*) return 1 ;;`).
function installCmd(tool: string): string | null {
	switch (tool) {
		case "herdr":
			return "mise install herdr  # or download from https://herdr.dev";
		case "node":
		case "gh":
			return `brew install ${tool}  # or the platform's package manager`;
		case "bun":
			return "brew install oven-sh/bun/bun  # or https://bun.sh/docs/installation";
		case "gh-axi":
		case "chrome-devtools-axi":
		case "lavish-axi":
			return `npm install -g ${tool} && ${tool} setup hooks`;
		default:
			return null;
	}
}

function ompExtCheck(): string[] {
	const extDir = envNonEmpty("FM_OMP_EXT_OVERRIDE") ?? join(homedir(), ".omp", "agent", "extensions");
	const lines: string[] = [];
	for (const ext of OMP_EXTENSIONS) {
		if (!isDirectory(join(extDir, ext))) {
			lines.push(`MISSING_EXT: ${ext} (provision: chezmoi apply - dotfiles repo is the canonical owner)`);
		}
	}
	return lines;
}

function selfPaneSync(fmRoot: string): string[] {
	const fmBin = join(fmRoot, "sbin", "fm");
	if (!isExecutableFile(fmBin)) return [];
	if (!commandExists("herdr")) return [];
	if (!herdrServerRunning()) return [];

	// Combine stdout+stderr via a real `2>&1` shell redirection so the captured
	// text matches exactly what the bash version's `>"$tmp" 2>&1` sees.
	const cmd = `${shellQuote(fmBin)} self-pane 2>&1`;
	const res = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
	if (!res.error && res.status === 0) return [];

	const firstLine = (res.stdout ?? "").split(/\r?\n/)[0] ?? "";
	return firstLine ? [`SELF_PANE: ${firstLine}`] : [];
}

// Re-apply the herdr omp status-integration self-heal patch. A herdr update
// overwrites the managed integration file and reverts the patch, so bootstrap
// re-applies it every session. Idempotent and silent when already patched; only
// surfaces a line when it actually (re)patches after an update.
function herdrOmpPatchSync(fmRoot: string): string[] {
	const fmBin = join(fmRoot, "sbin", "fm");
	if (!isExecutableFile(fmBin)) return [];

	const checkRes = spawnSync(fmBin, ["patch-herdr-omp", "--check"], { stdio: "ignore" });
	if (!checkRes.error && checkRes.status === 0) return [];

	const applyRes = spawnSync(fmBin, ["patch-herdr-omp"], { stdio: "ignore" });
	if (!applyRes.error && applyRes.status === 0) {
		return ["HERDR_OMP_PATCH: re-applied status self-heal after integration update"];
	}
	const rc = applyRes.status ?? 1;
	if (rc === 4) {
		return ["HERDR_OMP_PATCH: restart OMP panes before applying the status self-heal patch"];
	}
	return [`HERDR_OMP_PATCH: failed to apply status self-heal patch (exit ${rc})`];
}

function lockedDependencySync(fmRoot: string): string[] {
	let codeRoot: string;
	try {
		codeRoot = realpathSync(fmRoot);
	} catch {
		return [];
	}
	if (!isFile(join(codeRoot, "package.json")) || !isFile(join(codeRoot, "bun.lock"))) return [];
	if (!commandExists("bun")) return [];

	const res = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: codeRoot, stdio: "ignore" });
	if (!res.error && res.status === 0) return [];
	return [`BUN_DEPENDENCY: locked install failed in ${codeRoot}`];
}

// fleetSync(fmRoot, projects): best-effort background refresh of every
// project clone, bounded by FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT (default 20s).
// On timeout, the whole process group is killed (mirrors `kill -TERM "-$pid"`
// against the backgrounded job) so a hung fetch cannot outlive bootstrap.
async function fleetSync(fmRoot: string, projects: string): Promise<string[]> {
	const fmBin = join(fmRoot, "sbin", "fm");
	if (!isExecutableFile(fmBin)) return [];
	if (!isDirectory(projects)) return [];

	const timeoutRaw = envNonEmpty("FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT");
	const timeoutSeconds = timeoutRaw && /^[0-9]+$/.test(timeoutRaw) ? Number(timeoutRaw) : 20;

	const { stdout, timedOut } = await new Promise<{ stdout: string; timedOut: boolean }>(resolve => {
		let settled = false;
		let out = "";
		const child = spawn(fmBin, ["fleet-sync"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
		child.stdout?.on("data", chunk => {
			out += chunk;
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {
					// already gone
				}
			}
			resolve({ stdout: out, timedOut: true });
		}, timeoutSeconds * 1000);
		child.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout: out, timedOut: false });
		});
		child.on("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout: out, timedOut: false });
		});
	});

	if (timedOut) return ["FLEET_SYNC: fleet: skipped: bootstrap refresh timed out"];

	const lines: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line) continue;
		if (line.endsWith(": skipped: trunk project")) continue;
		if (line.endsWith(": skipped: no origin remote")) continue;
		if (line.includes(": skipped:")) lines.push(`FLEET_SYNC: ${line}`);
	}
	return lines;
}

function readCrewHarness(config: string): string {
	const path = join(config, "crew-harness");
	if (!isFile(path)) return "";
	try {
		return readFileSync(path, "utf8").replace(/\s+/g, "");
	} catch {
		return "";
	}
}

async function runInstall(tools: string[]): Promise<number> {
	if (tools.length === 0) {
		process.stderr.write("usage: fm bootstrap install <tool>...\n");
		return 1;
	}
	for (const tool of tools) {
		const full = installCmd(tool);
		if (full === null) {
			process.stderr.write(`error: unknown tool ${tool}\n`);
			return 1;
		}
		const cmd = full.split("  #")[0];
		process.stdout.write(`installing ${tool}: ${cmd}\n`);
		spawnSync(cmd, [], { shell: true, stdio: "inherit" });
	}
	return 0;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);

	const rootOverride = envNonEmpty("FM_ROOT_OVERRIDE");
	const fmRoot = rootOverride ?? REPO_ROOT;

	if (args[0] === "install") {
		return runInstall(args.slice(1));
	}

	const envHome = envNonEmpty("FM_HOME");
	const fmHome = envHome ?? rootOverride ?? homeFromCwd() ?? fmRoot;
	const projects = envNonEmpty("FM_PROJECTS_OVERRIDE") ?? join(fmHome, "projects");
	const config = envNonEmpty("FM_CONFIG_OVERRIDE") ?? join(fmHome, "config");

	const lines: string[] = [];

	for (const tool of TOOLS) {
		if (!commandExists(tool)) lines.push(`MISSING: ${tool} (install: ${installCmd(tool)})`);
	}
	if (commandExists("herdr") && !herdrServerRunning()) {
		lines.push("MISSING: herdr-server (start with: herdr)");
	}
	lines.push(...ompExtCheck());
	lines.push(...selfPaneSync(fmRoot));
	lines.push(...herdrOmpPatchSync(fmRoot));

	if (!ghAuthOk()) lines.push("NEEDS_GH_AUTH");

	const crew = readCrewHarness(config);
	if (crew !== "" && crew !== "default") lines.push(`CREW_HARNESS_OVERRIDE: ${crew}`);

	// Native `fm task` always covers backlog management now; unlike the former
	// optional external tasks-axi probe, this line is unconditional.
	lines.push("TASKS: native");

	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);

	// Do not sync dependencies or fleet state from an unchecked cap handoff.
	const fmBin = join(fmRoot, "sbin", "fm");
	const handoffCmd = `${shellQuote(fmBin)} handoff-check 2>&1`;
	const handoffRes = spawnSync("sh", ["-c", handoffCmd], { encoding: "utf8" });
	if (handoffRes.error || handoffRes.status !== 0) {
		const trimmed = (handoffRes.stdout ?? "").replace(/\n+$/, "");
		process.stdout.write(`${trimmed}\n`);
		return 1;
	}

	const depLines = lockedDependencySync(fmRoot);
	if (depLines.length > 0) process.stdout.write(`${depLines.join("\n")}\n`);

	const fleetLines = await fleetSync(fmRoot, projects);
	if (fleetLines.length > 0) process.stdout.write(`${fleetLines.join("\n")}\n`);

	return 0;
}

export default {
	name: "bootstrap",
	describe: "Detect missing tools/auth, install approved tools, and run fleet-refresh side effects.",
	run,
};
