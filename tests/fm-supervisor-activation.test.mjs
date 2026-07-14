import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "fm-supervisor-activation-"));
const defaultState = join(home, "state");
const state = join(home, "override-state");
const receiptPath = join(state, "activation-receipt.json");
mkdirSync(defaultState, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(join(home, "data"), { recursive: true });
mkdirSync(join(home, "sbin"), { recursive: true });
writeFileSync(join(home, "sbin", "fm-spawn.sh"), "");
writeFileSync(join(home, "data", "backlog.md"), "## In flight\n## Queued\n## Done\n");
writeFileSync(join(state, "self.meta"), "kind=ship\npane=w1:p1\nworker=self\n");
writeFileSync(join(state, "self.status"), "working: activation\n");
symlinkSync(join(root, "AGENTS.md"), join(home, "AGENTS.md"));
mkdirSync(join(home, ".omp"), { recursive: true });
symlinkSync(join(root, ".omp", "extensions"), join(home, ".omp", "extensions"), "dir");
const panesPath = join(home, "panes.json");
writeFileSync(panesPath, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: home, agent_status: "working", agent_session_id: "session-activation-1", agent: "omp" }] } }));
const sourceLink = join(home, "source-link");
symlinkSync(root, sourceLink, "dir");

process.env.FM_HOME = home;
process.env.FM_STATE_OVERRIDE = state;
process.env.FM_ROOT_OVERRIDE = sourceLink;
process.env.HERDR_SOCKET_PATH = join(home, "missing-herdr.sock");
process.env.FM_FLEET_PANES_FILE = panesPath;

const handlers = new Map();
const pi = {
  setLabel() {},
  on(name, handler) { handlers.set(name, handler); },
  async exec(command, args) {
    if (command === "herdr" && args[0] === "pane" && args[1] === "current") {
      return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }), stderr: "", code: 0, killed: false };
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  },
  sendMessage() {},
  logger: { warn() {} },
};

const module = await import(pathToFileURL(join(root, ".omp/extensions/fm-supervisor.ts")).href);
module.default(pi);
const ctx = {
  cwd: home,
  sessionManager: {
    getSessionId: () => "session-activation-1",
    getSessionFile: () => join(home, "session.jsonl"),
  },
};
await handlers.get("session_start")({}, ctx);
if (!existsSync(receiptPath)) throw new Error("session_start did not write activation receipt");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
if (receipt.schema !== "firstmate.activation-receipt/v1") throw new Error("receipt schema missing");
if (receipt.session_id !== "session-activation-1") throw new Error("receipt session id mismatch");
if (receipt.session_path !== join(home, "session.jsonl")) throw new Error("receipt session path mismatch");
if (receipt.pane_id !== "w1:p1") throw new Error("receipt pane id mismatch");
if (!/^\d{4}-\d{2}-\d{2}T/.test(receipt.started_at)) throw new Error("receipt start time is not ISO");
if (!/^[0-9a-f]{64}$/.test(receipt.manifest_sha256)) throw new Error("receipt manifest digest missing");
if (!Array.isArray(receipt.manifest) || receipt.manifest.length === 0) throw new Error("receipt manifest missing");
if (!receipt.manifest.some((entry) => entry.path === ".omp/extensions/bridge/index.ts")) throw new Error("recursive extension manifest missing");
const { collectSnapshot } = await import(pathToFileURL(join(root, ".omp/extensions/bridge/collect.ts")).href);
const snapshot = await collectSnapshot("2026-07-14T00:00:00Z");
if (snapshot.activation?.state !== "fresh" || snapshot.activation.fresh !== 1) throw new Error("collector did not accept override receipt");
if (existsSync(join(defaultState, "activation-receipt.json"))) throw new Error("receipt was written outside FM_STATE_OVERRIDE");
await handlers.get("session_shutdown")();
if (existsSync(receiptPath)) throw new Error("matching shutdown did not remove activation receipt");
rmSync(home, { recursive: true, force: true });
console.log("supervisor activation receipt lifecycle passed");
