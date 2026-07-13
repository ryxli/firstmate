import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "fm-supervisor-activation-"));
const state = join(home, "state");
const receiptPath = join(state, "activation-receipt.json");
mkdirSync(state, { recursive: true });
const sourceLink = join(home, "source-link");
symlinkSync(root, sourceLink, "dir");

process.env.FM_HOME = home;
process.env.FM_STATE_OVERRIDE = state;
process.env.FM_ROOT_OVERRIDE = sourceLink;
process.env.HERDR_SOCKET_PATH = join(home, "missing-herdr.sock");

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
await handlers.get("session_shutdown")();
if (existsSync(receiptPath)) throw new Error("matching shutdown did not remove activation receipt");
rmSync(home, { recursive: true, force: true });
console.log("supervisor activation receipt lifecycle passed");
