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
mkdirSync(join(home, ".omp"), { recursive: true });
mkdirSync(join(home, "sbin"), { recursive: true });
writeFileSync(join(home, "sbin", "fm-spawn.sh"), "");
writeFileSync(join(home, "data", "backlog.md"), "## In flight\n## Queued\n## Done\n");
writeFileSync(join(home, ".omp", "fleet-capabilities.json"), JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [{ id: "home", home, surfaces: ["AGENTS.md"], required_probe_result: { activation: "ok" } }] }));
writeFileSync(join(state, "self.meta"), "kind=ship\npane=w1:p1\nworker=self\n");
writeFileSync(join(state, "self.status"), "working: activation\n");
symlinkSync(join(root, "AGENTS.md"), join(home, "AGENTS.md"));
mkdirSync(join(home, ".omp", "extensions"), { recursive: true });
for (const entry of ["bridge", "fm-identity"]) symlinkSync(join(root, ".omp", "extensions", entry), join(home, ".omp", "extensions", entry), "dir");
for (const entry of ["fm-supervisor.ts", "dispatch-guard.ts"]) symlinkSync(join(root, ".omp", "extensions", entry), join(home, ".omp", "extensions", entry));
const panesPath = join(home, "panes.json");
writeFileSync(panesPath, JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", cwd: home, agent_status: "working", agent_session_id: "session-activation-1", agent: "omp" }] } }));
const sourceLink = join(home, "source-link");
symlinkSync(root, sourceLink, "dir");

process.env.FM_HOME = home;
process.env.FM_STATE_OVERRIDE = state;
process.env.FM_ROOT_OVERRIDE = sourceLink;
process.env.FM_FLEET_SOURCE_HOME = home;
process.env.FM_FLEET_SOURCE_REVISION = "0000000000000000000000000000000000000000";
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
if (!/^[0-9a-f]{40}$/.test(receipt.source_revision)) throw new Error("source revision missing from receipt");
if (receipt.required_probe_result?.activation !== "ok") throw new Error("required probe result missing from receipt");
if (!Array.isArray(receipt.manifest) || receipt.manifest.length === 0) throw new Error("receipt manifest missing");
if (!receipt.manifest.some((entry) => entry.path === ".omp/extensions/bridge/index.ts")) throw new Error("recursive extension manifest missing");
if (receipt.charter_path !== undefined || receipt.charter_digest !== undefined) {
  throw new Error("receipt claimed charter injection without launcher markers");
}
const { collectSnapshot } = await import(pathToFileURL(join(root, ".omp/extensions/bridge/collect.ts")).href);
const snapshot = await collectSnapshot("2026-07-14T00:00:00Z");
if (snapshot.activation?.state !== "fresh" || snapshot.activation.fresh !== 1) throw new Error("collector did not accept override receipt");
if (existsSync(join(defaultState, "activation-receipt.json"))) throw new Error("receipt was written outside FM_STATE_OVERRIDE");
await handlers.get("session_shutdown")();
if (existsSync(receiptPath)) throw new Error("matching shutdown did not remove activation receipt");

// Secondmate with valid launcher markers records both charter fields.
const { createHash } = await import("node:crypto");
writeFileSync(join(home, ".fm-secondmate-home"), "riggs\n");
const charterBody = "# Charter\nRiggs domain\n";
writeFileSync(join(home, "data", "charter.md"), charterBody);
const charterDigest = createHash("sha256").update(charterBody).digest("hex");
process.env.FM_INJECTED_CHARTER_PATH = "data/charter.md";
process.env.FM_INJECTED_CHARTER_SHA256 = charterDigest;
await handlers.get("session_start")({}, ctx);
const claimed = JSON.parse(readFileSync(receiptPath, "utf8"));
if (claimed.charter_path !== "data/charter.md") throw new Error("marked launch omitted charter_path");
if (claimed.charter_digest !== charterDigest) throw new Error("marked launch omitted matching charter_digest");
await handlers.get("session_shutdown")();

// Invalid marker digest omits both fields.
process.env.FM_INJECTED_CHARTER_SHA256 = "0".repeat(64);
await handlers.get("session_start")({}, ctx);
const omitted = JSON.parse(readFileSync(receiptPath, "utf8"));
if (omitted.charter_path !== undefined || omitted.charter_digest !== undefined) {
  throw new Error("invalid marker still claimed charter injection");
}
await handlers.get("session_shutdown")();

for (const key of [
  "FM_HOME",
  "FM_STATE_OVERRIDE",
  "FM_ROOT_OVERRIDE",
  "FM_FLEET_SOURCE_HOME",
  "FM_FLEET_SOURCE_REVISION",
  "HERDR_SOCKET_PATH",
  "FM_FLEET_PANES_FILE",
  "FM_INJECTED_CHARTER_PATH",
  "FM_INJECTED_CHARTER_SHA256",
]) {
  delete process.env[key];
}
rmSync(home, { recursive: true, force: true });
console.log("supervisor activation receipt lifecycle passed");
