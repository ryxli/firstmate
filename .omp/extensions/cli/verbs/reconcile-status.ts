// fm verb: reconcile-status - firstmate's own truth for a mate's working/idle
// state. Ported verbatim (behavior-preserving) out of the former
// sbin/fm reconcile-status.
//
// Why this exists: herdr's agent_status for omp panes is unreliable. The
// omp<->herdr socket integration drops state reports (a failed send resolves as
// success and poisons its dedup, so a live "working" turn silently reads
// "idle"), and herdr has no screen-detection rule for omp
// (`agent explain` shows evaluated_rules: [], visible_working: false, and
// default_known_agent_idle_fallback). An external `report-agent` from firstmate
// is ignored, so we cannot correct herdr's status field.
//
// Instead firstmate derives the real state directly from the pane screen, which
// is unambiguous: an omp turn in flight renders a braille spinner glyph and an
// `<esc>` interrupt hint next to the composer; an idle turn shows only the empty
// composer box. The supervisor uses THIS instead of trusting agent_status.
//
// Usage:
//   fm reconcile-status <pane_id>   print: working|idle|unknown (exit 0)
//                                    <pane> <name> herdr=<s> real=<s> [DRIFT]
//   fm reconcile-status --drift     print only drifting panes; exit 1
//                                    if any pane drifts, else 0
// Strictly read-only: only `herdr pane read` / `herdr pane list`. Never mutates.
//
// The screen classifier below is executed AS bash, not reimplemented in native
// TypeScript. This is deliberate, not laziness: the bracket range
// `[⠁-⣿]` in the original case statement is matched by the macOS system bash
// (3.2.57, frozen there for GPLv3 reasons - this is genuinely the interpreter
// `sbin/fm reconcile-status` ran under, and what `fm reconcile-status`
// must match). Verified empirically, its behavior is NOT a clean Unicode
// codepoint range check: under the shell's default UTF-8 locale it matches most
// multi-byte characters (braille spinners, box-drawing borders, CJK, emoji) but
// NOT a couple of Latin-1 letters (e.g. plain "é"/"ÿ" in isolation read idle),
// which only makes sense as locale collation-order comparison, not a codepoint
// range - and that collation table is OS/libc-version-specific, not something a
// native reimplementation could reproduce and verify. Delegating the exact
// original pattern to the same shell is the only way to port this verbatim
// rather than silently replacing an accidental-but-relied-upon bug with a
// "corrected" range check.
import { spawnSync } from "node:child_process";

// Verbatim body of the original script's classify_screen function (see the
// bash ground truth above). $1 is the captured screen text; stdout is exactly
// one of working|idle|unknown.
const CLASSIFY_SCREEN_SCRIPT = `
classify_screen() {
  local screen=$1
  [ -n "$screen" ] || { printf 'unknown\\n'; return; }
  case "$screen" in
    *[⠁-⣿]*) printf 'working\\n'; return ;;
    *'esc⟩'*|*'⟨esc'*|*'Working*|*'Thinking*) printf 'working\\n'; return ;;
  esac
  printf 'idle\\n'
}
classify_screen "$1"
`;

function classifyScreen(screen: string): "working" | "idle" | "unknown" {
	const res = spawnSync("bash", ["-c", CLASSIFY_SCREEN_SCRIPT, "bash", screen], { encoding: "utf8" });
	const out = (res.stdout ?? "").trim();
	return out === "working" || out === "idle" ? out : "unknown";
}

// herdr_read: visible screen of a pane; empty on failure (unknown, never idle).
function herdrRead(pane: string): string {
	const res = spawnSync("herdr", ["pane", "read", pane, "--source", "visible", "--lines", "12"], { encoding: "utf8" });
	return res.stdout ?? "";
}

function realState(pane: string): "working" | "idle" | "unknown" {
	return classifyScreen(herdrRead(pane));
}

interface ReconcilePane {
	pane: string;
	name: string;
	herdrState: string;
}

// pyOr(...values): the first value that is not python-falsy (undefined, null,
// false, "", 0), stringified - mirrors the former script's chained
// `a.get(x) or b.get(y) or "fallback"` python one-liner.
function pyOr(...values: unknown[]): string {
	for (const value of values) {
		if (value !== undefined && value !== null && value !== false && value !== "" && value !== 0) return String(value);
	}
	return "";
}

// Mirrors the python filter previously embedded in the bash script: parse
// `herdr pane list`, keep only panes with a truthy agent_session.value, and
// project pane_id/display_agent-or-label/agent_status with "unknown"
// fallbacks. Any parse failure (bad JSON, missing result/panes) yields an
// empty list rather than an error, exactly like the original try/except.
function panesForReconcile(panesJsonText: string): ReconcilePane[] {
	let panes: unknown[] = [];
	try {
		const parsed = JSON.parse(panesJsonText) as { result?: { panes?: unknown[] } };
		if (Array.isArray(parsed?.result?.panes)) panes = parsed.result.panes;
	} catch {
		// panes stays []
	}

	const out: ReconcilePane[] = [];
	for (const p of panes) {
		if (!p || typeof p !== "object") continue;
		const rec = p as Record<string, unknown>;
		const sess = rec.agent_session;
		if (!sess || typeof sess !== "object" || !(sess as Record<string, unknown>).value) continue;
		out.push({
			pane: pyOr(rec.pane_id, "unknown"),
			name: pyOr(rec.display_agent, rec.label, "unknown"),
			herdrState: pyOr(rec.agent_status, "unknown"),
		});
	}
	return out;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const first = args[0];

	if (first === "--all" || first === "--drift") {
		const mode = first;
		const listRes = spawnSync("herdr", ["pane", "list"], { encoding: "utf8" });
		const panes = panesForReconcile(listRes.stdout ?? "");

		let driftFound = false;
		for (const { pane, name, herdrState } of panes) {
			if (!pane) continue;
			const real = realState(pane);
			// Drift that matters: real work while herdr says idle/unknown. The reverse
			// (herdr working while screen idle) self-heals on the next turn and is not
			// actionable, so we do not flag it.
			const drift = real === "working" && herdrState !== "working";
			if (drift) driftFound = true;
			if (mode === "--all") {
				process.stdout.write(`${pane} ${name} herdr=${herdrState} real=${real} ${drift ? "DRIFT" : ""}\n`);
			} else if (drift) {
				process.stdout.write(`${pane} ${name} herdr=${herdrState} real=${real} DRIFT\n`);
			}
		}
		return driftFound ? 1 : 0;
	}

	const pane = first ?? "";
	if (!pane) {
		process.stderr.write("usage: fm reconcile-status <pane_id> | --all | --drift\n");
		return 2;
	}
	process.stdout.write(`${realState(pane)}\n`);
	return 0;
}

export default {
	name: "reconcile-status",
	describe: "Firstmate's own truth for a mate's working/idle state, derived from the pane screen.",
	run,
};
