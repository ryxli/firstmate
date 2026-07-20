// whiteboard editor launcher - "really edit it", state-of-the-art behavior.
//
// omp's own pane has no TTY to host a full-screen editor inline, so we open the
// editor in a herdr SPLIT of the caller's pane (same tab). Quitting the editor
// runs `; exit`, so the split closes and focus returns to the omp session - no
// stray tab. Key niceties:
//  - REUSE: if the whiteboard editor is still open from a prior /wb, focus that
//    pane instead of opening a second one. For nvim we also raise the board buffer
//    in the SAME instance via `--server <sock> --remote` (single-instance editing).
//  - EDITOR RESOLUTION: honors $VISUAL/$EDITOR, but treats no-op/pager values
//    (true/false/cat/empty) as unset and falls back to nvim/vim - so `EDITOR=true`
//    (a real value on some machines) doesn't silently open nothing.
// @ts-nocheck
import { existsSync } from "node:fs";

type Exec = (cmd: string, args: string[]) => Promise<{ stdout?: string } | undefined>;

// Per-session (per-omp-process) tracking of the whiteboard's own editor.
let editorPane: string | undefined;
let nvimSock: string | undefined;

// No-op / pager commands that are not real interactive editors.
const NOOP_EDITORS: Record<string, true> = { true: true, false: true, cat: true, less: true, more: true, tee: true, "": true };

// Resolve a real interactive editor. $VISUAL/$EDITOR win unless they are no-ops.
export function resolveEditor(): string {
  for (const cand of [process.env.VISUAL, process.env.EDITOR]) {
    const v = (cand || "").trim();
    if (v && !NOOP_EDITORS[v.split(/\s+/)[0]]) return v;
  }
  return "nvim"; // box default
}

const isNvim = (ed: string) => /(^|\/)n?vim$/.test(ed.split(/\s+/)[0]);

const parsePane = (out?: string) => {
  try {
    const r = JSON.parse(out || "{}")?.result;
    return r?.pane_id || r?.pane?.pane_id;
  } catch { return undefined; }
};

const paneAlive = async (exec: Exec, pane: string) => {
  try {
    const out = await exec("herdr", ["pane", "get", pane]);
    const r = JSON.parse(out?.stdout || "{}")?.result;
    return !!(r && (r.pane_id || r.pane?.pane_id));
  } catch { return false; }
};

// nvim liveness on its socket (detect a stale/dead socket from a quit editor).
const nvimAlive = async (exec: Exec, sock: string) => {
  if (!sock || !existsSync(sock)) return false;
  try {
    const out = await exec("nvim", ["--server", sock, "--remote-expr", "1"]);
    return (out?.stdout || "").trim() === "1";
  } catch { return false; }
};

// Open the board. Returns a short status string for notify.
export async function openBoardEditor(exec: Exec, file: string): Promise<string> {
  const dir = file.slice(0, file.lastIndexOf("/")) || ".";
  const ed = resolveEditor();
  const self = process.env.HERDR_PANE_ID;

  // REUSE: editor still open from before? Focus it (+ raise the buffer for nvim).
  if (editorPane && (await paneAlive(exec, editorPane))) {
    try {
      if (isNvim(ed) && (await nvimAlive(exec, nvimSock))) {
        await exec("nvim", ["--server", nvimSock, "--remote", file]);
      }
      const info = JSON.parse((await exec("herdr", ["pane", "get", editorPane]))?.stdout || "{}")?.result;
      const t = info?.tab_id || info?.pane?.tab_id;
      if (t) await exec("herdr", ["tab", "focus", t]);
      return `reusing the editor already open (${ed})`;
    } catch { /* stale; fall through to fresh open */ }
  }

  // FRESH: split the caller's pane and launch the editor there.
  editorPane = undefined; nvimSock = undefined;
  const args = ["pane", "split", "--direction", "right", "--cwd", dir, "--focus"];
  if (self) args.splice(2, 0, self);
  const pane = parsePane((await exec("herdr", args))?.stdout);
  if (!pane) return "";

  editorPane = pane;
  let cmd: string;
  if (isNvim(ed)) {
    nvimSock = `${process.env.TMPDIR || "/tmp"}/wb-nvim-${pane.replace(/[^a-zA-Z0-9]/g, "_")}.sock`;
    // --listen makes this a reusable single instance; `; exit` closes the split on :q.
    cmd = `${ed} --listen ${nvimSock} ${file}; exit`;
  } else {
    cmd = `${ed} ${file}; exit`;
  }
  await exec("herdr", ["pane", "run", pane, cmd]);
  return `editing the board in ${ed} (split - :q returns here)`;
}
