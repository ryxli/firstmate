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
mkdirSync(state, { recursive: true });
writeFileSync(artifact, bytes);
const edge = `dependency.producer=producer\ndependency.consumers=consumer-a,consumer-b\ndependency.artifact=${artifact}\ndependency.sha=${sha}\ndependency.wake=consume artifact\ndependency.priority=critical\n`;
writeFileSync(join(state, "producer.meta"), `pane=w1:p1\nkind=ship\n${edge}`);
writeFileSync(join(state, "consumer-a.meta"), "pane=w1:p2\nkind=ship\n");
writeFileSync(join(state, "consumer-b.meta"), "pane=w1:p3\nkind=ship\n");
writeFileSync(join(state, "producer.status"), "done: artifact ready\n");
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
  sendMessage(message) { parentWakes.push(message.content); },
  logger: { warn() {} },
};
try {
  const module = await import(pathToFileURL(ext).href);
  module.default(pi);
  await handlers.get("session_start")({}, { cwd: home });
  if (parentWakes.length !== 1) throw new Error(`expected one parent wake, got ${parentWakes.length}`);
  if (consumerWakes.length !== 2) throw new Error(`expected two consumer wakes, got ${consumerWakes.length}`);
  if (!String(parentWakes[0]).includes("producer") || !consumerWakes.every((args) => args.at(-2) === "fm-consumer-a" || args.at(-2) === "fm-consumer-b")) throw new Error("dependency wake routing lost producer or consumer target");
  writeFileSync(join(state, "producer.status"), "blocked: waiting_on=producer\n");
  await Bun.sleep(150);
  if (parentWakes.length !== 1) throw new Error("malformed BLOCKED report incorrectly woke parent");
  await handlers.get("session_shutdown")();
  console.log("integrated dependency startup reconciliation passed");
} finally {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(home, { recursive: true, force: true });
}
