// fm verb: lavish-reply - post an agent's acknowledgement/reply into an open
// Lavish session via a one-shot, non-blocking HTTP POST to the agent-reply
// endpoint.
//
// After an agent applies the captain's feedback (relayed by the steward), it
// acknowledges in the browser with this command. It writes the reply to the
// write-only HTTP `/api/<key>/agent-reply` endpoint and returns immediately -
// it NEVER polls, so it can never consume feedback or race the steward's
// blocking poll for the same session. The steward keeps owning the long-poll;
// the agent's thread stays free.
//
// Session addressing mirrors lavish-axi's own client math so a key/URL
// derived here addresses the exact same session the CLI would:
//   - canonical file  = realpath(abs path)            (CLI canonicalFile)
//   - session key     = sha256(canonical).slice(0,16) (CLI sessionKey)
//   - base URL        = http://<host>:<port>          (CLI clientHost/defaultPort)
//
// Migrated verbatim (behavior-preserving) out of sbin/fm lavish-reply; the
// shared fm-lavish-lib.sh primitives this used (canonical/key/base-url) are
// inlined below rather than sourced, since that lib is still shared by other
// still-bash Lavish scripts.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const USAGE = "usage: fm lavish-reply <html-file> <message>";

// Mirrors fm_lavish_canonical: resolve symlinks like realpath(); fall back to
// the parent dir's real path + basename when the full path does not resolve.
function canonicalPath(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		try {
			return join(realpathSync(dirname(file)), basename(file));
		} catch {
			return file;
		}
	}
}

// Mirrors fm_lavish_key: sha256 of the path string, first 16 hex chars.
function sessionKey(path: string): string {
	return createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16);
}

// Mirrors fm_lavish_base_url: honors LAVISH_AXI_HOST / LAVISH_AXI_PORT, maps a
// wildcard bind address to loopback, and brackets bare IPv6 hosts.
function baseUrl(): string {
	let host = process.env.LAVISH_AXI_HOST || "127.0.0.1";
	if (host === "0.0.0.0") host = "127.0.0.1";
	else if (host === "::") host = "::1";
	if (host.includes(":")) host = `[${host}]`;
	const port = process.env.LAVISH_AXI_PORT || "4387";
	return `http://${host}:${port}`;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const file = args[0] ?? "";
	const message = args[1] ?? "";
	if (!file || args.length < 2) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}

	const canonical = canonicalPath(file);
	const key = sessionKey(canonical);
	const base = baseUrl();
	const body = JSON.stringify({ text: message });

	let resp: Response;
	try {
		resp = await fetch(`${base}/api/${key}/agent-reply`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		process.stderr.write(`error: could not reach Lavish server at ${base} (is the session still open?)\n`);
		return 1;
	}
	if (!resp.ok) {
		process.stderr.write(`error: could not reach Lavish server at ${base} (is the session still open?)\n`);
		return 1;
	}
	const text = await resp.text();
	if (text.includes('"status":"sent"')) {
		process.stdout.write(`reply sent to session ${key}\n`);
		return 0;
	}
	if (text.includes('"error"')) {
		process.stderr.write(`error: ${text}\n`);
		return 1;
	}
	process.stderr.write(`unexpected response: ${text}\n`);
	return 1;
}

export default {
	name: "lavish-reply",
	describe: "Post an agent's acknowledgement or reply into an open Lavish session (write-only, non-blocking).",
	run,
};
