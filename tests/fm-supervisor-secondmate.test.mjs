// Integration test: real socket and filesystem callbacks require platform turns.
// Delays are only bounded event waits, not timing assertions.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";

const root = resolve(import.meta.dir, "..");
const ext = join(root, ".omp/extensions/fm-supervisor.ts");
const home = mkdtempSync(join(tmpdir(), "fm-supervisor-secondmate-"));
const state = join(home, "state");
const socketPath = join(home, "herdr.sock");
const ship = { task: "ship", recordedPane: "w1:p-old", pane: "w1:p-live" };
const crew = { task: "crew", pane: "w3:p1" };
const secondmate = { task: "secondmate", pane: "w2:p1" };

mkdirSync(state, { recursive: true });
writeFileSync(join(state, `${ship.task}.meta`), `pane=${ship.recordedPane}\nkind=ship\n`);
writeFileSync(join(state, `${secondmate.task}.meta`), `pane=${secondmate.pane}\nkind=secondmate\n`);
writeFileSync(join(state, `${crew.task}.meta`), `pane=${crew.pane}\nkind=ship\n`);
writeFileSync(join(state, `${ship.task}.status`), "");
writeFileSync(join(state, `${secondmate.task}.status`), "");
writeFileSync(join(state, `${crew.task}.status`), "");

process.env.FM_HOME = home;
process.env.FM_STATE_OVERRIDE = state;
process.env.HERDR_SOCKET_PATH = socketPath;
process.env.FM_SIGNAL_GRACE = "0";
process.env.FM_SECONDMATE_IDLE_SECS = "0";
process.env.FM_BLOCKED_DEBOUNCE_SECS = "3600";
process.env.FM_CHECK_INTERVAL = "3600";
process.env.FM_BUSY_REGEX = "(?!)";

const subscribed = Promise.withResolvers();
let observedStatusEvents = 0;
let client;
const server = net.createServer((connection) => {
  client = connection;
  connection.setEncoding("utf8");
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (JSON.parse(line).method === "events.subscribe") {
        subscribed.resolve();
        // Replay the already-idle startup observation as soon as subscribed.
        // The startup baseline must already be established, so this is quiet.
        observedStatusEvents++;
        client?.write(`${JSON.stringify({
          event: "pane.agent_status_changed",
          data: { pane_id: secondmate.pane, agent_status: "idle" },
        })}\n`);
      }
    }
  });
});
const listening = Promise.withResolvers();
server.once("error", listening.reject);
server.listen(socketPath, () => listening.resolve());
await listening.promise;

const warnings = [];
const osNotifications = [];
const sent = [];
const handlers = new Map();
const response = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
function assertAttention(entry) {
  if (entry.message.customType !== "fleet-attention-changed") throw new Error("attention type changed");
  if (entry.message.content !== "fleet-attention-changed: Read `fm fleet` once.") throw new Error("attention message carried event payload");
  if (entry.message.display !== false) throw new Error("attention message was visible");
  if (JSON.stringify(entry.options) !== JSON.stringify({ triggerTurn: true })) throw new Error("attention delivery options changed");
}
const pi = {
  setLabel() {},
  on(name, handler) { handlers.set(name, handler); },
  async exec(command, args) {
    if (command === "osascript") {
      osNotifications.push(args);
      return response();
    }
    if (command !== "herdr") return response();
    if (args[0] === "agent" && args[1] === "get") {
      const target = args[2];
      const pane = target === ship.task ? ship.pane : target === secondmate.task ? secondmate.pane : target === crew.task ? crew.pane : target;
      return response(JSON.stringify({ pane_id: pane, agent_status: "idle" }));
    }
    if (args[0] === "pane" && args[1] === "get") return response(JSON.stringify({ pane_id: args[2] }));
    return response();
  },
  sendMessage(message, options) { sent.push({ message, options }); },
  logger: { warn(message) { warnings.push(String(message)); } },
};

const module = await import(pathToFileURL(ext).href);
module.default(pi);
await handlers.get("session_start")({}, { cwd: home });
await subscribed.promise;
await waitFor(() => observedStatusEvents >= 1, "startup idle replay");
if (sent.length !== 0) throw new Error("already-idle startup replay produced a completion wake");
function emit(pane, agent_status) {
  observedStatusEvents++;
  client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status } })}\n`);
}

// Integration synchronization: resolve only when the observable output arrives.
async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; warnings=${warnings.join(" | ")}`);
    await Bun.sleep(10);
  }
}

await Bun.sleep(50);
// A wake discovered during an active firstmate turn is deferred until turn end.
handlers.get("agent_start")?.({}, {});
writeFileSync(join(state, `${ship.task}.status`), "done: PR https://github.com/o/r/pull/1 checks green\n");
await Bun.sleep(80);
if (sent.length !== 0) throw new Error("status wake injected into an active firstmate turn");
handlers.get("agent_end")?.({}, {});
await waitFor(() => sent.length === 1, "cap-relevant status file attention");
assertAttention(sent[0]);
handlers.get("agent_start")?.({}, {});
handlers.get("agent_end")?.({}, {});

emit(ship.pane, "working");
emit(ship.pane, "blocked");
await waitFor(() => sent.length === 2, "first ship blocked wake");
assertAttention(sent[1]);
if (!readFileSync(join(state, `${ship.task}.meta`), "utf8").includes(`pane=${ship.pane}`)) throw new Error("live pane identity did not refresh meta");
if (osNotifications.length !== 0) throw new Error("routine fleet attention issued an OS notification");
handlers.get("agent_start")?.({}, {});
handlers.get("agent_end")?.({}, {});

emit(ship.pane, "working");
emit(ship.pane, "blocked");
await Bun.sleep(50);
if (sent.length !== 2) throw new Error("rapid ship blocked transition was not debounced");

emit(secondmate.pane, "working");
emit(secondmate.pane, "blocked");
await Bun.sleep(50);
if (sent.length !== 2) throw new Error("secondmate blocked transition woke main supervisor");

emit(secondmate.pane, "working");
emit(secondmate.pane, "done");
await waitFor(() => sent.length === 3, "secondmate routed completion wake");
assertAttention(sent[2]);
if (osNotifications.length !== 0) throw new Error("secondmate completion issued an OS notification");
handlers.get("agent_start")?.({}, {});
handlers.get("agent_end")?.({}, {});
const beforeReplayCount = observedStatusEvents;
emit(secondmate.pane, "idle");
emit(secondmate.pane, "idle");
await waitFor(() => observedStatusEvents >= beforeReplayCount + 2, "replayed idle events");
await Bun.sleep(20);
if (sent.length !== 3) throw new Error("replayed idle after completion produced a duplicate wake");

// An ordinary crewmate with no terminal status must wake its supervisor once
// after a real working-to-idle edge. A repeated idle replay is not an edge.
emit(crew.pane, "working");
emit(crew.pane, "idle");
await waitFor(() => sent.length === 4, "ordinary crewmate completion wake");
assertAttention(sent[3]);
handlers.get("agent_start")?.({}, {});
handlers.get("agent_end")?.({}, {});
emit(crew.pane, "idle");
await Bun.sleep(20);
if (sent.length !== 4) throw new Error("ordinary crewmate idle replay produced a duplicate completion wake");

// A terminal status remains the primary path. The completion backstop must not
// double-wake when the crewmate already emitted one.
emit(ship.pane, "working");
emit(ship.pane, "idle");
await Bun.sleep(20);
if (sent.length !== 4) throw new Error("cap-relevant crewmate status produced a duplicate completion wake");
await handlers.get("session_shutdown")();
client?.destroy();
const closed = Promise.withResolvers();
server.close(() => closed.resolve());
await closed.promise;
rmSync(home, { recursive: true, force: true });
console.log("supervisor secondmate and blocked-wake checks passed");
