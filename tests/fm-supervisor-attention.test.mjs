// Representative runtime callback fixture for the silent fleet-attention reducer.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";

const root = resolve(import.meta.dir, "..");
const extension = join(root, ".omp/extensions/fm-supervisor.ts");
const home = mkdtempSync(join(tmpdir(), "fm-supervisor-attention-"));
const state = join(home, "state");
const socketPath = join(home, "herdr.sock");
const producer = { task: "producer", pane: "w1:p1" };
const peer = { task: "peer", pane: "w1:p2" };
const consumer = { task: "consumer", pane: "w1:p3" };
const artifact = join(home, "artifact.json");
const artifactBytes = Buffer.from("{\"ready\":true}\n");
const artifactSha = createHash("sha256").update(artifactBytes).digest("hex");

mkdirSync(state, { recursive: true });
writeFileSync(artifact, artifactBytes);
writeFileSync(join(state, `${producer.task}.meta`), [
  `pane=${producer.pane}`,
  "kind=ship",
  `dependency.producer=${producer.task}`,
  `dependency.consumers=${consumer.task}`,
  `dependency.artifact=${artifact}`,
  `dependency.sha=${artifactSha}`,
  "dependency.wake=consume artifact",
].join("\n") + "\n");
for (const crew of [peer, consumer]) writeFileSync(join(state, `${crew.task}.meta`), `pane=${crew.pane}\nkind=ship\n`);
for (const crew of [producer, peer, consumer]) writeFileSync(join(state, `${crew.task}.status`), "working: initial\n");
writeFileSync(join(state, `${peer.task}.check.sh`), "#!/usr/bin/env bash\n# mocked by the extension fixture\n");

const env = {
  FM_HOME: home,
  FM_STATE_OVERRIDE: state,
  HERDR_SOCKET_PATH: socketPath,
  FM_SIGNAL_GRACE: "0.05",
  FM_CHECK_INTERVAL: "0.05",
  FM_CHECK_TIMEOUT: "1",
  FM_BUSY_REGEX: "(?!)",
};
const previousEnv = new Map();
for (const [key, value] of Object.entries(env)) {
  previousEnv.set(key, process.env[key]);
  process.env[key] = value;
}

const handlers = new Map();
const sent = [];
const consumerHandoffs = [];
const osNotifications = [];
const warnings = [];
let checkEnabled = false;
let client;
const subscribed = Promise.withResolvers();
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
      if (JSON.parse(line).method === "events.subscribe") subscribed.resolve();
    }
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });

const response = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
const pi = {
  setLabel() {},
  on(name, handler) { handlers.set(name, handler); },
  async exec(command, args) {
    if (command === "osascript") { osNotifications.push(args); return response(); }
    if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
      const task = args[2];
      const crew = [producer, peer, consumer].find((candidate) => candidate.task === task);
      return response(JSON.stringify({ pane_id: crew?.pane ?? task, agent_status: "idle" }));
    }
    if (command === "herdr" && args[0] === "pane" && args[1] === "get") return response(JSON.stringify({ pane_id: args[2] }));
    if (command === "bash" && args[0].endsWith("fm-send.sh")) { consumerHandoffs.push(args); return response(); }
    if (command === "bash" && args[0] === join(state, `${peer.task}.check.sh`)) return response(checkEnabled ? "check attention\n" : "");
    return response();
  },
  sendMessage(message, options) { sent.push({ message, options }); },
  logger: { warn(message) { warnings.push(String(message)); } },
};

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; warnings=${warnings.join(" | ")}`);
    await Bun.sleep(10);
  }
};
const emitHerdr = (pane, agent_status) => client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status } })}\n`);
const assertNudge = (entry) => {
  if (entry.message.customType !== "fleet-attention-changed") throw new Error(`wrong attention type: ${entry.message.customType}`);
  if (entry.message.content !== "fleet-attention-changed: Read \`fm fleet\` once.") throw new Error(`attention content carried payload: ${entry.message.content}`);
  if (entry.message.display !== false) throw new Error("attention nudge was visible");
  if (JSON.stringify(entry.options) !== JSON.stringify({ triggerTurn: true })) throw new Error(`attention delivery options changed: ${JSON.stringify(entry.options)}`);
};

try {
  const module = await import(pathToFileURL(extension).href);
  module.default(pi);
  await handlers.get("session_start")({}, { cwd: home });
  await subscribed.promise;
  await Bun.sleep(120); // status watchers are installed before the burst.

  // One idle burst combines status, Herdr, and check sources.
  checkEnabled = true;
  appendFileSync(join(state, `${producer.task}.status`), "done: artifact ready\n");
  emitHerdr(peer.pane, "working");
  emitHerdr(peer.pane, "blocked");
  await waitFor(() => sent.length === 1 && consumerHandoffs.length === 1, "coalesced idle burst and dependency handoff");
  checkEnabled = false;
  assertNudge(sent[0]);
  if (consumerHandoffs[0].at(-2) !== "fm-consumer" || !String(consumerHandoffs[0].at(-1)).includes("dependency producer completed")) {
    throw new Error("direct dependency consumer handoff was not preserved");
  }
  const { collectSnapshot } = await import(pathToFileURL(join(root, ".omp/extensions/bridge/collect.ts")).href);
  const snapshot = await collectSnapshot("2026-07-19T00:00:00Z", home);
  if (!snapshot.attention.some((item) => item.id === producer.task && item.clsRank >= 3)) {
    throw new Error("fm fleet's authoritative attention snapshot lost the producer status");
  }
  if (osNotifications.length !== 0) throw new Error("routine fleet attention issued an OS notification");

  // Consume the first edge. Events during an unrelated active turn create one post-turn edge.
  handlers.get("agent_start")?.({}, {});
  handlers.get("agent_end")?.({}, {});
  handlers.get("agent_start")?.({}, {});
  appendFileSync(join(state, `${peer.task}.status`), "blocked: active turn status\n");
  emitHerdr(peer.pane, "working");
  emitHerdr(peer.pane, "done");
  await Bun.sleep(180);
  if (sent.length !== 1) throw new Error("active-turn events injected a deferred per-event nudge");
  handlers.get("agent_end")?.({}, {});
  await waitFor(() => sent.length === 2, "one post-turn attention edge");
  assertNudge(sent[1]);

  // Events during the model turn triggered by that edge get exactly one follow-up.
  handlers.get("agent_start")?.({}, {});
  appendFileSync(join(state, `${producer.task}.status`), "done: later fleet change\n");
  await Bun.sleep(120);
  if (sent.length !== 2) throw new Error("resulting model turn received an event payload or duplicate nudge");
  handlers.get("agent_end")?.({}, {});
  await waitFor(() => sent.length === 3, "one follow-up edge for resulting turn");
  assertNudge(sent[2]);
  handlers.get("agent_start")?.({}, {});
  handlers.get("agent_end")?.({}, {});

  // Working noise stays out of the model interface.
  appendFileSync(join(state, `${consumer.task}.status`), "working: routine progress\n");
  await Bun.sleep(180);
  if (sent.length !== 3) throw new Error("non-relevant status noise created attention");
  if (osNotifications.length !== 0) throw new Error("routine fleet attention issued an OS notification");

  await handlers.get("session_shutdown")();
  client?.destroy();
  await new Promise((resolve) => server.close(resolve));
  console.log("silent fleet-attention reducer runtime callbacks passed");
} finally {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  client?.destroy();
  server.close();
  rmSync(home, { recursive: true, force: true });
}
