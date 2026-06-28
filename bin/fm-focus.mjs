#!/usr/bin/env bun
// fm-focus.mjs - compute-on-read priority view: "what needs the captain now".
//
// The SINGLE source of truth for fleet attention ORDER. Recomputed on EVERY
// invocation from ground truth - state/<id>.meta, state/<id>.status, data/backlog.md,
// and best-effort herdr agent_status - never cached, so it cannot go stale. herdr's
// own panel cannot bear this guarantee (its sort is omp-state-owned and hardcoded);
// the design rationale is in data/priority-focus-plan.md.
//
// The pure rank() is exported and unit-tested; the wake digest imports it to lead
// its batch with #1. This tool is strictly READ-ONLY: it never mutates herdr, omp,
// git, data, or state.
//
// Usage:
//   bin/fm-focus            ranked table, #1 (most important) on top
//   bin/fm-focus --json     ranked JSON (for agents / the digest)
//   bin/fm-focus --home P   rank a specific firstmate home (default $FM_HOME or repo root)
//   bin/fm-focus --items F  rank items from a JSON file directly (bypass gather; for tests)
//   bin/fm-focus --no-color force plain output even on a TTY

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const FM_ROOT = process.env.FM_ROOT_OVERRIDE || join(SCRIPT_DIR, "..");
const LINEAGE = join(SCRIPT_DIR, "fm-lineage.sh");

// ---------------------------------------------------------------------------
// Pure ranking core (exported, unit-tested; no I/O).
// ---------------------------------------------------------------------------
export const CLASS_NAME = { 4: "CAPTAIN-BLOCKED", 3: "REVIEW-READY", 2: "IN-FLIGHT", 1: "DORMANT", 0: "UNKNOWN" };

// classify -> { cls, sev, tag }. Derives the attention CLASS from the crewmate
// STATUS LINE first (the captain-relevant signal), then falls back to herdr
// agent_status for the lower, informational classes. This is exactly why the
// guarantee lives here and not in herdr's panel: herdr only sees agent_status.
export function classify(item) {
  const s = (item.statusLine || "").trim().toLowerCase();
  const lead = (s.match(/^([a-z-]+):/) || [])[1] || "";
  // A secondmate is a persistent sub-supervisor: idle and done are HEALTHY, not
  // a standing captain item (its completion reports are FYIs to its supervisor).
  // Only an OPEN escalation needs the captain. Matches the supervision extension,
  // which skips stale for secondmate panes.
  if (item.kind === "secondmate") {
    if (lead === "failed") return { cls: 4, sev: 2, tag: "FAILED (secondmate)" };
    if (lead === "needs-decision") return { cls: 4, sev: 1, tag: "NEEDS DECISION (secondmate)" };
    if (lead === "blocked" || (item.agent_status || "").toLowerCase() === "blocked")
      return { cls: 4, sev: 1, tag: "BLOCKED (secondmate)" };
    if ((item.agent_status || "").toLowerCase() === "unknown")
      return { cls: 0, sev: 0, tag: "UNBOUND (secondmate)" };
    return { cls: 1, sev: 0, tag: "secondmate idle" };
  }
  // CAPTAIN-BLOCKED (4): work halted, only the captain unblocks.
  if (lead === "failed") return { cls: 4, sev: 2, tag: "FAILED" };
  if (lead === "needs-decision") return { cls: 4, sev: 1, tag: "NEEDS DECISION" };
  if (lead === "blocked") return { cls: 4, sev: 1, tag: "BLOCKED" };
  // REVIEW-READY (3): deliverable complete and safe, awaiting the captain's gate.
  if (/\bready in branch\b/.test(s)) return { cls: 3, sev: 1, tag: "READY (branch)" };
  if (/\bchecks green\b|\bpr ready\b/.test(s)) return { cls: 3, sev: 1, tag: "PR READY" };
  if (lead === "done") return /\bmerged\b/.test(s)
    ? { cls: 3, sev: 0, tag: "MERGED (teardown)" }
    : { cls: 3, sev: 1, tag: "DONE (review)" };
  if (/\bmerged\b/.test(s)) return { cls: 3, sev: 0, tag: "MERGED (teardown)" };
  // Fall back to live herdr agent_status for the informational classes.
  const a = (item.agent_status || "").toLowerCase();
  if (a === "blocked") return { cls: 4, sev: 1, tag: "BLOCKED (frozen)" };
  if (a === "working") return { cls: 2, sev: 0, tag: "working" };
  if (a === "done") return { cls: 3, sev: 0, tag: "done (closeout)" };
  if (a === "idle") return { cls: 1, sev: 0, tag: "idle" };
  if (a === "unknown" || a === "") return { cls: 0, sev: 0, tag: "UNBOUND" };
  return { cls: 1, sev: 0, tag: a };
}

// score -> the lexicographic tuple. BLAST_RADIUS = 1 + queued items blocked by
// this task; AGE = seconds since the last status (anti-starvation); PROXIMITY
// favors direct reports over deep-forwarded escalations; id is the stable final
// key so the maximum is always unique and the top never flickers.
export function score(item, now) {
  const c = classify(item);
  return {
    cls: c.cls, sev: c.sev, tag: c.tag,
    blast: 1 + (item.blastBlocked || 0),
    ageSec: item.statusMtime ? Math.max(0, now - item.statusMtime) : 0,
    proximity: -(item.depth || 0),
    id: item.id,
  };
}

// rank -> items sorted DESCENDING by the score tuple; index 0 is #1.
export function rank(items, now = Math.floor(Date.now() / 1000)) {
  return items
    .map((it) => ({ item: it, s: score(it, now) }))
    .sort((a, b) =>
      b.s.cls - a.s.cls ||
      b.s.sev - a.s.sev ||
      b.s.blast - a.s.blast ||
      b.s.ageSec - a.s.ageSec ||
      b.s.proximity - a.s.proximity ||
      (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0))
    .map((r, i) => ({ rank: i + 1, ...r }));
}

function humanAge(sec) {
  if (sec >= 86400) return Math.floor(sec / 86400) + "d";
  if (sec >= 3600) return Math.floor(sec / 3600) + "h";
  if (sec >= 60) return Math.floor(sec / 60) + "m";
  return sec + "s";
}

// reason -> the glanceable one-line "why" for a ranked row.
export function reason(r) {
  const it = r.item, s = r.s;
  let out = s.tag;
  const note = (it.statusLine || "").replace(/^[a-z-]+:\s*/i, "").trim();
  if (note && s.cls >= 3) out += " - " + note.slice(0, 64);
  const extra = [];
  if (s.blast > 1) extra.push(`blocks ${s.blast - 1}`);
  if (s.ageSec >= 60 && s.cls >= 3) extra.push(humanAge(s.ageSec));
  if (s.proximity < 0) extra.push("forwarded");
  return out + (extra.length ? ` (${extra.join(", ")})` : "");
}

// ---------------------------------------------------------------------------
// Gather (I/O): assemble normalized items from the on-disk ground truth.
// ---------------------------------------------------------------------------
function parseMeta(text) {
  const o = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

function lastStatus(home, id) {
  const p = join(home, "state", id + ".status");
  try {
    const lines = readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const mtime = Math.floor(statSync(p).mtimeMs / 1000);
    return { line: lines.length ? lines[lines.length - 1] : "", mtime };
  } catch {
    return { line: "", mtime: 0 };
  }
}

// blastMap -> id -> count of Queued backlog items declaring blocked-by:<id>,
// across every home's data/backlog.md. Zero new instrumentation.
function blastMap(homePaths) {
  const m = {};
  for (const home of homePaths) {
    let text;
    try { text = readFileSync(join(home, "data", "backlog.md"), "utf8"); } catch { continue; }
    const re = /blocked-by:\s*([a-z0-9][a-z0-9-]*)/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
      const id = match[1];
      m[id] = (m[id] || 0) + 1;
    }
  }
  return m;
}

// secondmateHomes -> absolute home paths registered in data/secondmates.md.
function secondmateHomes(home) {
  let text;
  try { text = readFileSync(join(home, "data", "secondmates.md"), "utf8"); } catch { return []; }
  const out = [];
  const re = /home:\s*([^;)\s]+)/g;
  let match;
  while ((match = re.exec(text)) !== null) out.push(match[1]);
  return out;
}

// agentStatusMap -> pane id -> herdr agent_status, best-effort from the whole
// recursive lineage tree. Returns {} if herdr/lineage is unavailable; the top
// classes (the guarantee) come from status lines and do not need this.
function agentStatusMap(mainHome) {
  const map = {};
  if (process.env.FM_FOCUS_NO_HERDR) return map; // hermetic hook: skip the live lineage/herdr subprocess
  let tree;
  try {
    const out = execFileSync(LINEAGE, ["--json", "--recursive", "--home", mainHome], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    tree = JSON.parse(out);
  } catch {
    return map;
  }
  const walk = (node) => {
    for (const ws of node.workspaces || []) {
      for (const tab of ws.tabs || []) {
        for (const pane of tab.panes || []) {
          if (pane.id) map[pane.id] = pane.agent_status || "";
          const sub = pane.task && pane.task.secondmate;
          if (sub) walk(sub);
        }
      }
    }
  };
  walk(tree);
  return map;
}

// gather -> the normalized item list for the whole tree rooted at mainHome.
export function gather(mainHome) {
  const homes = [];
  const seen = new Set();
  const queue = [{ path: mainHome, depth: 0 }];
  while (queue.length) {
    const { path, depth } = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    homes.push({ path, depth });
    for (const child of secondmateHomes(path)) queue.push({ path: child, depth: depth + 1 });
  }
  const blast = blastMap(homes.map((h) => h.path));
  const aStatus = agentStatusMap(mainHome);
  const items = [];
  for (const { path, depth } of homes) {
    const stateDir = join(path, "state");
    if (!existsSync(stateDir)) continue;
    let files;
    try { files = readdirSync(stateDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".meta")) continue;
      const id = f.slice(0, -5);
      let meta;
      try { meta = parseMeta(readFileSync(join(stateDir, f), "utf8")); } catch { continue; }
      const st = lastStatus(path, id);
      items.push({
        id, home: path, depth,
        kind: meta.kind || "", pane: meta.pane || "", worker: meta.worker || id,
        pr: meta.pr || "",
        agent_status: aStatus[meta.pane] || "",
        statusLine: st.line, statusMtime: st.mtime,
        blastBlocked: blast[id] || 0,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------
const COLOR = { 4: "\x1b[31m", 3: "\x1b[33m", 2: "\x1b[36m", 1: "\x1b[2m", 0: "\x1b[35m" };
const RESET = "\x1b[0m";

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "\u2026" : s; }

function formatTable(ranked, useColor) {
  if (!ranked.length) return "fm-focus: fleet is empty - nothing needs you.";
  const rows = ranked.map((r) => ({
    n: String(r.rank),
    cls: CLASS_NAME[r.s.cls],
    reason: clip(reason(r), 52),
    task: clip(r.item.id, 18),
    pane: r.item.pane || "-",
    cl: r.s.cls,
  }));
  const wCls = Math.max(5, ...rows.map((x) => x.cls.length));
  const wReason = Math.max(6, ...rows.map((x) => x.reason.length));
  const wTask = Math.max(4, ...rows.map((x) => x.task.length));
  const head = " " + pad("#", 2) + "  " + pad("CLASS", wCls) + "  " + pad("REASON", wReason) + "  " + pad("TASK", wTask) + "  PANE";
  const lines = [head];
  for (const x of rows) {
    let line = " " + pad(x.n, 2) + "  " + pad(x.cls, wCls) + "  " + pad(x.reason, wReason) + "  " + pad(x.task, wTask) + "  " + x.pane;
    if (useColor) line = (COLOR[x.cl] || "") + line + RESET;
    lines.push(line);
  }
  return "FOCUS - what needs you now (recomputed " + new Date().toISOString().replace("T", " ").slice(0, 19) + "Z)\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function main(argv) {
  let asJson = false, home = process.env.FM_HOME || FM_ROOT, itemsFile = "", color = process.stdout.isTTY;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--no-color") color = false;
    else if (a === "--home") home = argv[++i];
    else if (a === "--items") itemsFile = argv[++i];
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: fm-focus [--json] [--home <path>] [--items <file>] [--no-color]\n");
      return 0;
    } else {
      process.stderr.write("fm-focus: unknown argument: " + a + "\n");
      return 2;
    }
  }
  let items;
  if (itemsFile) {
    items = JSON.parse(readFileSync(itemsFile, "utf8"));
  } else {
    items = gather(home);
  }
  const ranked = rank(items);
  if (asJson) {
    const out = ranked.map((r) => ({
      rank: r.rank, id: r.item.id, class: CLASS_NAME[r.s.cls], reason: reason(r),
      pane: r.item.pane, worker: r.item.worker, kind: r.item.kind, home: r.item.home,
      score: { cls: r.s.cls, sev: r.s.sev, blast: r.s.blast, ageSec: r.s.ageSec, proximity: r.s.proximity },
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(formatTable(ranked, color) + "\n");
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
