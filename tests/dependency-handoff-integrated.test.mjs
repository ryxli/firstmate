import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const ext = join(root, ".omp/extensions/fm-supervisor.ts");
const home = mkdtempSync(join(tmpdir(), "fm-dependency-integrated-"));
const state = join(home, "state");
const artifact = join(home, "artifact.json");
const bytes = Buffer.from("existing artifact\n");
const sha = createHash("sha256").update(bytes).digest("hex");
const edgeFor = (consumers, artifactSha = sha) => `dependency.producer=producer\ndependency.consumers=${consumers}\ndependency.artifact=${artifact}\ndependency.sha=${artifactSha}\ndependency.wake=consume artifact\ndependency.priority=critical\n`;
mkdirSync(state, { recursive: true });
writeFileSync(artifact, bytes);
const edge = edgeFor("consumer-a,consumer-b");
writeFileSync(join(state, "producer.meta"), `pane=w1:p1\nkind=ship\n${edge}`);
writeFileSync(join(state, "consumer-a.meta"), "pane=w1:p2\nkind=ship\n");
writeFileSync(join(state, "consumer-b.meta"), "pane=w1:p3\nkind=ship\n");
writeFileSync(join(state, "producer.status"), "done: artifact ready\n");
writeFileSync(join(state, "consumer-a.status"), "working\n");
const env = { FM_HOME: home, FM_STATE_OVERRIDE: state, HERDR_SOCKET_PATH: join(home, "missing.sock"), FM_SIGNAL_GRACE: "0.01", FM_CAPTAIN_OS_NOTIFY: "0" };
const previous = new Map();
for (const [key, value] of Object.entries(env)) { previous.set(key, process.env[key]); process.env[key] = value; }
const handlers = new Map();
const parentWakes = [];
const consumerWakes = [];
const pi = {
  setLabel() {},
  on(name, handler) { handlers.set(name, handler); },
  exec(command, args) {
    if (command === "herdr" && args[0] === "agent" && args[1] === "get") return Promise.resolve({ stdout: JSON.stringify({ pane_id: args.at(-1), agent_status: "idle" }), stderr: "", code: 0, killed: false });
    if (command === "bash" && args[0].endsWith("fm-send.sh")) { consumerWakes.push(args); return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false }); }
    return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
  },
  sendMessage(message, options) { parentWakes.push({ message, options }); },
  logger: { warn() {} },
};
try {
  const module = await import(pathToFileURL(ext).href);
  module.default(pi);
  const startAndStop = async () => {
    await handlers.get("session_start")({}, { cwd: home });
    await handlers.get("session_shutdown")();
  };
  await startAndStop();
  if (parentWakes.length !== 1) throw new Error(`expected one parent wake, got ${parentWakes.length}`);
  if (consumerWakes.length !== 2) throw new Error(`expected two consumer wakes, got ${consumerWakes.length}`);
  if (parentWakes[0].message.customType !== "fleet-attention-changed" || parentWakes[0].message.content !== "fleet-attention-changed: Read `fm fleet` once." || parentWakes[0].message.display !== false || JSON.stringify(parentWakes[0].options) !== JSON.stringify({ triggerTurn: true })) {
    throw new Error("producer-side dependency attention was not silent and payload-free");
  }
  if (!consumerWakes.every((args) => args.at(-2) === "fm-consumer-a" || args.at(-2) === "fm-consumer-b")) throw new Error("dependency wake routing lost consumer target");
  await startAndStop();
  if (parentWakes.length !== 1) throw new Error("duplicate startup reconciliation woke parent again");
  if (consumerWakes.length !== 2) throw new Error("duplicate startup reconciliation woke consumers again");
  writeFileSync(join(state, "producer.status"), "done: artifact ready with new terminal state\n");
  await startAndStop();
  if (parentWakes.length !== 2) throw new Error("changed terminal dependency state did not wake parent");
  if (consumerWakes.length !== 4) throw new Error("changed terminal dependency state did not wake consumers");
  writeFileSync(join(state, "consumer-c.meta"), "pane=w1:p4\nkind=ship\n");
  writeFileSync(join(state, "producer.meta"), `pane=w1:p1\nkind=ship\n${edgeFor("consumer-a,consumer-b,consumer-c")}`);
  await startAndStop();
  if (parentWakes.length !== 3) throw new Error("changed dependency consumer contract did not wake parent");
  if (consumerWakes.length !== 7) throw new Error("newly declared dependency consumer was not deliverable");
  const changedBytes = Buffer.from("changed artifact\n");
  const changedSha = createHash("sha256").update(changedBytes).digest("hex");
  writeFileSync(artifact, changedBytes);
  writeFileSync(join(state, "producer.meta"), `pane=w1:p1\nkind=ship\n${edgeFor("consumer-a,consumer-b,consumer-c", changedSha)}`);
  await startAndStop();
  if (parentWakes.length !== 4) throw new Error("changed dependency artifact identity did not wake parent");
  if (consumerWakes.length !== 10) throw new Error("changed dependency artifact identity did not wake consumers");
  rmSync(join(state, "producer.meta"));
  await startAndStop();
  if (parentWakes.length !== 4) throw new Error("absent producer pruning unexpectedly woke parent");
  if (consumerWakes.length !== 10) throw new Error("absent producer pruning unexpectedly woke consumers");
  writeFileSync(join(state, "producer.meta"), `pane=w1:p1\nkind=ship\n${edgeFor("consumer-a,consumer-b,consumer-c", changedSha)}`);
  await startAndStop();
  if (parentWakes.length !== 5) throw new Error("re-created producer was not eligible after receipt pruning");
  if (consumerWakes.length !== 13) throw new Error("re-created producer did not deliver to consumers after receipt pruning");
  await handlers.get("session_start")({}, { cwd: home });
  writeFileSync(join(state, "producer.status"), "blocked: waiting_on=producer\n");
  await Bun.sleep(150);
  if (parentWakes.length !== 5) throw new Error("malformed dependency BLOCKED report incorrectly woke parent");
  writeFileSync(join(state, "consumer-a.status"), "blocked: need credentials\n");
  await Bun.sleep(150);
  if (parentWakes.length !== 6) throw new Error("generic BLOCKED report without dependency did not wake parent");
  await handlers.get("session_shutdown")();
  console.log("integrated dependency startup reconciliation passed");
} finally {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(home, { recursive: true, force: true });
}
