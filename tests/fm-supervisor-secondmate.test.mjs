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
const secondmate = { task: "secondmate", pane: "w2:p1" };

mkdirSync(state, { recursive: true });
writeFileSync(join(state, `${ship.task}.meta`), `pane=${ship.recordedPane}\nkind=ship\n`);
writeFileSync(join(state, `${secondmate.task}.meta`), `pane=${secondmate.pane}\nkind=secondmate\n`);
writeFileSync(join(state, `${ship.task}.status`), "");
writeFileSync(join(state, `${secondmate.task}.status`), "");

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
      const pane = target === ship.task ? ship.pane : target === secondmate.task ? secondmate.pane : target;
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

// fs.watch registration reaches the kernel asynchronously. This platform-level
// integration probe waits once for that registration before changing the file.
await Bun.sleep(50);
writeFileSync(join(state, `${ship.task}.status`), "done: PR https://github.com/o/r/pull/1 checks green\n");
await waitFor(() => sent.length === 1, "captain-relevant status file wake");
if (!String(sent[0].message.content).includes("done: PR")) throw new Error("status-file wake lost the terminal status");
if (!/^\[wake \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /.test(String(sent[0].message.content))) throw new Error("status wake missing compact UTC timestamp prefix");

emit(ship.pane, "working");
emit(ship.pane, "blocked");
await waitFor(() => sent.length === 2, "first ship blocked wake");
if (!String(sent[1].message.content).includes("ship") || !/blocked/i.test(sent[1].message.content)) throw new Error("ship blocked wake lost task or state");
if (!readFileSync(join(state, `${ship.task}.meta`), "utf8").includes(`pane=${ship.pane}`)) throw new Error("live pane identity did not refresh meta");
if (osNotifications.length !== 2 || !osNotifications[0].join(" ").includes("firstmate")) throw new Error("captain-actionable wakes did not issue main-home OS notifications");

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
if (!/^\[wake \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] /.test(String(sent[2].message.content))) throw new Error("completion wake missing compact UTC timestamp prefix");
if (sent[2].options.deliverAs !== "nextTurn" || sent[2].options.triggerTurn !== true) throw new Error("wake delivery options changed");
if (osNotifications.length !== 2) throw new Error("secondmate completion sent an OS notification instead of escalating through supervision");
const beforeReplayCount = observedStatusEvents;
emit(secondmate.pane, "idle");
emit(secondmate.pane, "idle");
await waitFor(() => observedStatusEvents >= beforeReplayCount + 2, "replayed idle events");
await Bun.sleep(20);
if (sent.length !== 3) throw new Error("replayed idle after completion produced a duplicate wake");
await handlers.get("session_shutdown")();
client?.destroy();
const closed = Promise.withResolvers();
server.close(() => closed.resolve());
await closed.promise;
rmSync(home, { recursive: true, force: true });
console.log("supervisor secondmate and blocked-wake checks passed");
