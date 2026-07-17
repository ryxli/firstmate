// fm verb: idle-digest - the bounded away-mode idle-digest loop's state machine.
// Ported verbatim (behavior-preserving) out of the former sbin/fm idle-digest.
//
// When the first mate would otherwise go idle and the cap is away (the
// /afk flag is set, or the cap has been silent past a threshold), it does
// not emit a trickle of tiny per-event closeouts. Instead it consolidates every
// update into ONE running digest and relays a single ~one-screen summary the
// moment the cap returns. This module owns the mechanical, testable bounds
// of that loop so the documented protocol (skill://idle-digest, AGENTS.md s.8)
// is enforced rather than trusted:
//
//   - begin   idempotent: create the running digest (or resume an in-progress
//             one across a restart) with a started= timestamp and passes=0.
//   - active  pure predicate: exit 0 while the refinement loop may keep running
//             (within the time window AND under the pass cap), exit 1 to STOP.
//   - pass    record one completed refinement pass; exit code mirrors `active`
//             AFTER the increment so the loop self-terminates.
//   - fold    append one bullet under a canonical section (dedups exact repeats,
//             rejects unknown sections) - this is how a closeout that WOULD have
//             woken the cap is folded into the digest instead.
//   - render  print the full accumulated digest (empty sections omitted).
//   - screen  print the one-screen-capped digest: "Needs you" is NEVER
//             truncated; other sections cap at FM_IDLE_DIGEST_SECTION_MAX with
//             an overflow pointer. This is what the cap sees on return.
//   - status  one machine-readable line: started/passes/elapsed/window/active.
//   - clear   delete the running digest (cap returned and was caught up).
//
// Bounds (seconds / counts; 0 disables that bound's refinement entirely):
//   FM_IDLE_DIGEST_WINDOW_SECS   refinement window           (default 1800)
//   FM_IDLE_DIGEST_MAX_PASSES    max refinement passes        (default 12)
//   FM_IDLE_DIGEST_SECTION_MAX   per-section bullet cap (screen)  (default 6)
//
// The loop NEVER changes who approves what or takes any project-mutating /
// destructive action: refinement is read-only, firstmate-repo-safe grooming.
// See skill://idle-digest for the consent, scope, and stop-condition contract.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function envOrDefault(name: string, fallback: string): string {
	const value = process.env[name];
	return value !== undefined && value !== "" ? value : fallback;
}

const FM_ROOT = envOrDefault("FM_ROOT_OVERRIDE", REPO_ROOT);
const FM_HOME = envOrDefault("FM_HOME", envOrDefault("FM_ROOT_OVERRIDE", FM_ROOT));
const STATE = envOrDefault("FM_STATE_OVERRIDE", join(FM_HOME, "state"));
const DIGEST = join(STATE, ".idle-digest.md");

const TITLE = "# While you were away";
// Canonical sections, in render order. "Needs you" is first and never capped.
const CANON = ["Needs you", "Landed", "In flight", "Queued & blocked", "Fleet & cost"];

const WINDOW = Number(envOrDefault("FM_IDLE_DIGEST_WINDOW_SECS", "1800"));
const MAX_PASSES = Number(envOrDefault("FM_IDLE_DIGEST_MAX_PASSES", "12"));
const SECTION_MAX = Number(envOrDefault("FM_IDLE_DIGEST_SECTION_MAX", "6"));

const USAGE = `fm idle-digest - the bounded idle-digest loop's state machine.

When the first mate would otherwise go idle and the cap is away (the
/afk flag is set, or the cap has been silent past a threshold), it does
not emit a trickle of tiny per-event closeouts. Instead it consolidates every
update into ONE running digest and relays a single ~one-screen summary the
moment the cap returns. This helper owns the mechanical, testable bounds
of that loop so the documented protocol (skill://idle-digest, AGENTS.md s.8)
is enforced rather than trusted:

  - begin   idempotent: create the running digest (or resume an in-progress
            one across a restart) with a started= timestamp and passes=0.
  - active  pure predicate: exit 0 while the refinement loop may keep running
            (within the time window AND under the pass cap), exit 1 to STOP.
  - pass    record one completed refinement pass; exit code mirrors \`active\`
            AFTER the increment so the loop self-terminates.
  - fold    append one bullet under a canonical section (dedups exact repeats,
            rejects unknown sections) - this is how a closeout that WOULD have
            woken the cap is folded into the digest instead.
  - render  print the full accumulated digest (empty sections omitted).
  - screen  print the one-screen-capped digest: "Needs you" is NEVER
            truncated; other sections cap at FM_IDLE_DIGEST_SECTION_MAX with
            an overflow pointer. This is what the cap sees on return.
  - status  one machine-readable line: started/passes/elapsed/window/active.
  - clear   delete the running digest (cap returned and was caught up).

Bounds (seconds / counts; 0 disables that bound's refinement entirely):
  FM_IDLE_DIGEST_WINDOW_SECS   refinement window           (default 1800)
  FM_IDLE_DIGEST_MAX_PASSES    max refinement passes        (default 12)
  FM_IDLE_DIGEST_SECTION_MAX   per-section bullet cap (screen)  (default 6)

The loop NEVER changes who approves what or takes any project-mutating /
destructive action: refinement is read-only, firstmate-repo-safe grooming.
See skill://idle-digest for the consent, scope, and stop-condition contract.

Usage:
  fm idle-digest begin  [reason]
  fm idle-digest active
  fm idle-digest pass
  fm idle-digest fold   <section> <line>
  fm idle-digest render
  fm idle-digest screen
  fm idle-digest status
  fm idle-digest clear`;

function usage(): number {
	process.stderr.write(`${USAGE}\n`);
	return 2;
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

// Returns null when the digest exists (caller proceeds); otherwise writes the
// same error fm idle-digest wrote and returns the exit code to propagate.
function requireDigest(): number | null {
	if (!existsSync(DIGEST)) {
		process.stderr.write("fm-idle-digest: no running digest; run 'begin' first\n");
		return 3;
	}
	return null;
}

// Read one header field (started|passes|reason) from the digest's metadata line.
function headerField(field: string): string {
	const content = readFileSync(DIGEST, "utf8");
	const match = content.match(new RegExp(`<!-- fm-idle-digest .*${field}=([^ ]*).*-->`));
	return match ? match[1] : "";
}

function isCanon(section: string): boolean {
	return CANON.includes(section);
}

// active_check <elapsed> <passes> -> true if the loop may continue, else false.
function activeCheck(elapsed: number, passes: number): boolean {
	if (!(WINDOW > 0)) return false;
	if (!(MAX_PASSES > 0)) return false;
	if (!(elapsed < WINDOW)) return false;
	if (!(passes < MAX_PASSES)) return false;
	return true;
}

function cmdBegin(args: string[]): number {
	const reason = args[0] ?? "silence";
	if (existsSync(DIGEST)) {
		process.stdout.write(`resumed: started=${headerField("started")} passes=${headerField("passes")} reason=${headerField("reason")}\n`);
		return 0;
	}
	mkdirSync(STATE, { recursive: true });
	const lines = [`<!-- fm-idle-digest started=${now()} passes=0 reason=${reason} -->`, TITLE, "", ...CANON.map(section => `## ${section}`)];
	writeFileSync(DIGEST, `${lines.join("\n")}\n`);
	process.stdout.write(`begun: started=${headerField("started")} reason=${reason} window=${WINDOW}s max_passes=${MAX_PASSES}\n`);
	return 0;
}

function cmdActive(): number {
	const blocked = requireDigest();
	if (blocked !== null) return blocked;
	const started = Number(headerField("started"));
	const passes = Number(headerField("passes"));
	const elapsed = now() - started;
	return activeCheck(elapsed, passes) ? 0 : 1;
}

function cmdPass(): number {
	const blocked = requireDigest();
	if (blocked !== null) return blocked;
	const started = Number(headerField("started"));
	let passes = Number(headerField("passes"));
	passes += 1;
	// Rewrite passes= in the metadata header.
	const content = readFileSync(DIGEST, "utf8");
	const updated = content.replace(/(<!-- fm-idle-digest .*passes=)[0-9]+( )/, `$1${passes}$2`);
	writeFileSync(DIGEST, updated);
	const elapsed = now() - started;
	if (activeCheck(elapsed, passes)) {
		process.stdout.write(`pass ${passes}/${MAX_PASSES} (${elapsed}s/${WINDOW}s elapsed)\n`);
		return 0;
	}
	process.stdout.write(`pass ${passes}/${MAX_PASSES} (${elapsed}s/${WINDOW}s elapsed) - loop budget reached, stop refining\n`);
	return 1;
}

function cmdFold(args: string[]): number {
	if (args.length !== 2) return usage();
	const blocked = requireDigest();
	if (blocked !== null) return blocked;
	const section = args[0];
	const rawLine = args[1];
	const line = rawLine.startsWith("- ") ? rawLine.slice(2) : rawLine;
	if (!isCanon(section)) {
		process.stderr.write(`fm-idle-digest: unknown section '${section}' (one of: ${CANON.join(" ")})\n`);
		return 2;
	}
	const foldTarget = `## ${section}`;
	const foldBullet = `- ${line}`;
	const content = readFileSync(DIGEST, "utf8");
	const hasTrailingNewline = content.endsWith("\n");
	const rawLines = content.split("\n");
	const body = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;

	const out: string[] = [];
	let inTarget = false;
	let seen = false;
	let inserted = false;
	const flush = () => {
		if (inTarget && !seen && !inserted) {
			out.push(foldBullet);
			inserted = true;
		}
	};
	for (const raw of body) {
		if (raw.startsWith("## ")) {
			flush();
			inTarget = raw === foldTarget;
			if (inTarget) {
				seen = false;
				inserted = false;
			}
			out.push(raw);
			continue;
		}
		if (inTarget && raw === foldBullet) seen = true;
		out.push(raw);
	}
	flush();
	writeFileSync(DIGEST, `${out.join("\n")}\n`);
	return 0;
}

// render_digest <cap>  (cap 0 = uncapped; "Needs you" is never capped)
function renderDigest(cap: number): string {
	const content = readFileSync(DIGEST, "utf8");
	const hasTrailingNewline = content.endsWith("\n");
	const rawLines = content.split("\n");
	const body = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;
	const protect = "## Needs you";

	const printed: string[] = [];
	let heading = "";
	let buf: string[] = [];
	const flush = () => {
		if (heading === "" || buf.length === 0) {
			heading = "";
			buf = [];
			return;
		}
		printed.push(heading);
		let lim = buf.length;
		if (cap > 0 && heading !== protect && buf.length > cap) lim = cap;
		for (let i = 0; i < lim; i += 1) printed.push(buf[i]);
		if (lim < buf.length) printed.push(`- (+${buf.length - lim} more; full picture in data/backlog.md)`);
		printed.push("");
		heading = "";
		buf = [];
	};

	for (const line of body) {
		if (line.startsWith("<!--")) continue;
		if (line.startsWith("# ")) {
			printed.push(line);
			printed.push("");
			continue;
		}
		if (line.startsWith("## ")) {
			flush();
			heading = line;
			buf = [];
			continue;
		}
		if (line.startsWith("- ")) {
			buf.push(line);
			continue;
		}
		// Any other line (e.g. a blank separator) has no matching awk rule
		// in the original script and is silently dropped; match that.
	}
	flush();
	return printed.map(line => `${line}\n`).join("");
}

function cmdRender(): number {
	const blocked = requireDigest();
	if (blocked !== null) return blocked;
	process.stdout.write(renderDigest(0));
	return 0;
}

function cmdScreen(): number {
	const blocked = requireDigest();
	if (blocked !== null) return blocked;
	process.stdout.write(renderDigest(SECTION_MAX));
	return 0;
}

function cmdStatus(): number {
	const blocked = requireDigest();
	if (blocked !== null) return blocked;
	const started = Number(headerField("started"));
	const passes = Number(headerField("passes"));
	const reason = headerField("reason");
	const elapsed = now() - started;
	const active = activeCheck(elapsed, passes) ? "yes" : "no";
	const content = readFileSync(DIGEST, "utf8");
	const bullets = (content.match(/^- /gm) ?? []).length;
	process.stdout.write(`started=${started} reason=${reason} passes=${passes}/${MAX_PASSES} elapsed=${elapsed}s window=${WINDOW}s active=${active} bullets=${bullets}\n`);
	return 0;
}

function cmdClear(): number {
	rmSync(DIGEST, { force: true });
	rmSync(`${DIGEST}.bak`, { force: true });
	rmSync(`${DIGEST}.tmp`, { force: true });
	process.stdout.write("cleared\n");
	return 0;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length < 1) return usage();
	const sub = args[0];
	const rest = args.slice(1);
	switch (sub) {
		case "begin":
			return cmdBegin(rest);
		case "active":
			return cmdActive();
		case "pass":
			return cmdPass();
		case "fold":
			return cmdFold(rest);
		case "render":
			return cmdRender();
		case "screen":
			return cmdScreen();
		case "status":
			return cmdStatus();
		case "clear":
			return cmdClear();
		default:
			return usage();
	}
}

export default {
	name: "idle-digest",
	describe: "Bounded away-mode idle digest loop's state machine.",
	run,
};
