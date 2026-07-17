// fm lib: lavish - shared primitives for the Lavish render-delegation flow.
// Ported behavior-preserving from sbin/fm-lavish-lib.sh.
//
// The render-delegation flow keeps firstmate (and any crewmate) off the Lavish
// long-poll: a dedicated steward worker process (sbin/fm lavish-steward) holds
// `lavish-axi poll <file>` for each open session and relays the cap's feedback
// back to the originating agent's pane, so the agent's own thread is never tied up
// polling. This library is the seam those scripts share.
//
// CRITICAL FIDELITY: everything here mirrors lavish-axi's own client math so a
// key/URL derived here addresses the exact same session the CLI would:
//   - canonical file  = realpath(abs path)            (CLI canonicalFile)
//   - session key     = sha256(canonical).slice(0,16) (CLI sessionKey)
//   - base URL        = http://<host>:<port>          (CLI clientHost/defaultPort)
// This must stay bit-identical with lavish-axi's own computation - do not
// "simplify" the hashing or URL construction.
//
// Real callers (grepped): fm lavish-open calls lavishCanonical, lavishKey,
// lavishStateDir, lavishStewardAlive, lavishKillPolls. fm lavish-steward
// calls lavishStateDir. (.omp/extensions/cli/verbs/lavish-reply.ts mirrors
// lavishCanonical/lavishKey/lavishBaseUrl in its own inlined TS, not a call
// into this bash lib.)
//
// Dropped as caller-less: fm_lavish_server_up has zero callers anywhere in the repo.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, resolved from this module's own physical location
// (lib -> cli -> extensions -> .omp -> root), matching the depth other
// cli/verbs/*.ts and cli/lib/*.ts modules use.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

// lavishCanonical(file): the canonical absolute path lavish-axi keys a session
// by. Resolves symlinks like the CLI's realpath(); falls back to a plain
// abs-path when the file does not resolve (caller validates existence).
export function lavishCanonical(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		try {
			const dir = realpathSync(dirname(file));
			return join(dir, basename(file));
		} catch {
			return file;
		}
	}
}

// lavishKey(canonicalPath): the 16-hex session key. Mirrors the CLI's
// sessionKey: sha256 of the path string, first 16 hex chars.
export function lavishKey(canonicalPath: string): string {
	return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

// lavishBaseUrl(): the base URL of the local Lavish server, honoring the same
// env the CLI reads (LAVISH_AXI_HOST, LAVISH_AXI_PORT). A wildcard bind
// address maps to a loopback client host, and IPv6 hosts are bracketed for URLs.
export function lavishBaseUrl(): string {
	let host = process.env.LAVISH_AXI_HOST || "127.0.0.1";
	if (host === "0.0.0.0") host = "127.0.0.1";
	else if (host === "::") host = "::1";
	if (host.includes(":")) host = `[${host}]`;
	const port = process.env.LAVISH_AXI_PORT || "4387";
	return `http://${host}:${port}`;
}

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const root = rootOverride || REPO_ROOT;
	const home = process.env.FM_HOME?.trim() || rootOverride || root;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || join(home, "state");
}

// lavishStateDir(): the per-home directory where steward metadata + relayed
// feedback live (under the firstmate state dir, gitignored). Honors the same
// FM_HOME / FM_STATE_OVERRIDE resolution as the rest of sbin/.
export function lavishStateDir(): string {
	return join(resolveState(), "lavish");
}

// lavishStewardAlive(key): true if a steward for key is recorded and its pid
// is still running. Used for idempotent open and recovery.
export function lavishStewardAlive(key: string): boolean {
	const file = join(lavishStateDir(), `${key}.steward`);
	let pid = "";
	try {
		const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.startsWith("pid="));
		if (lines.length > 0) pid = lines[lines.length - 1].slice("pid=".length);
	} catch {
		return false;
	}
	if (!pid) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}

// lavishKillPolls(file): terminate any `lavish-axi poll <file>` process for
// this session. Reaps an orphaned poll left behind by a hard-crashed steward
// (one that could not run its TERM trap) before a fresh steward starts, so
// exactly one poll ever owns a session's feedback - two pollers would race
// and one would silently consume and drop a feedback event. Callers MUST
// first ensure no live steward owns the session. Matches the canonical path
// as a fixed string, so paths with regex metacharacters are handled safely.
export function lavishKillPolls(file: string): void {
	const pgrep = spawnSync("pgrep", ["-f", "lavish-axi poll"], { encoding: "utf8" });
	const pids = (pgrep.stdout ?? "").split(/\r?\n/).filter(Boolean);
	for (const pid of pids) {
		const ps = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
		const command = ps.stdout ?? "";
		if (command.includes(file)) {
			try {
				process.kill(Number(pid));
			} catch {
				// already gone
			}
		}
	}
}
