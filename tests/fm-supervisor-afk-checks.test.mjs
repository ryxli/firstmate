import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const ext = join(root, ".omp/extensions/fm-supervisor.ts");
const home = mkdtempSync(join(tmpdir(), "fm-supervisor-afk-checks-"));
const state = join(home, "state");
const tasks = [
  { id: "checked-a", pane: "w1:p1" },
  { id: "live-b", pane: "w1:p2" },
];
const metaPath = (task) => join(state, `${task.id}.meta`);
const checkPath = (task) => join(state, `${task.id}.check.sh`);

mkdirSync(state, { recursive: true });
writeFileSync(join(state, ".afk"), "");
for (const task of tasks) {
  writeFileSync(metaPath(task), `pane=${task.pane}\nkind=ship\npr=https://github.com/example/repo/pull/42\n`);
  writeFileSync(checkPath(task), "#!/usr/bin/env bash\nprintf 'merged\\n'\n");
  chmodSync(checkPath(task), 0o755);
}

const env = {
  FM_HOME: home,
  FM_STATE_OVERRIDE: state,
  HERDR_SOCKET_PATH: join(home, "missing-herdr.sock"),
  FM_ESCALATE_BATCH_SECS: "0.1",
  FM_CHECK_INTERVAL: "0.3",
  FM_CHECK_TIMEOUT: "1",
  FM_CAPTAIN_OS_NOTIFY: "0",
};
const previousEnv = new Map();
for (const [key, value] of Object.entries(env)) {
  previousEnv.set(key, process.env[key]);
  process.env[key] = value;
}

const handlers = new Map();
const sent = [];
let checkCalls = 0;
const afkFlushRan = Promise.withResolvers();
const response = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
const originalSetTimeout = globalThis.setTimeout;
let afkFlushCount = 0;
globalThis.setTimeout = (handler, timeout, ...args) => {
  if (timeout === 100) {
    const currentFlush = ++afkFlushCount;
    return originalSetTimeout((...callbackArgs) => {
      if (currentFlush === 1) afkFlushRan.resolve();
      return handler(...callbackArgs);
    }, timeout, ...args);
  }
  return originalSetTimeout(handler, timeout, ...args);
};

const pi = {
  setLabel() {},
  on(name, handler) {
    handlers.set(name, handler);
  },
  exec(command, args) {
    if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
      const task = tasks.find((candidate) => candidate.id === args[2]);
      return response(JSON.stringify({ pane_id: task?.pane ?? args[2], agent_status: "working" }));
    }
    if (command === "bash" && tasks.some((task) => args[0] === checkPath(task))) {
      checkCalls++;
      return response("merged\n");
    }
    return response();
  },
  sendMessage(message, options) {
    sent.push({ message, options });
  },
  logger: { warn() {} },
};

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
};

try {
  const module = await import(pathToFileURL(ext).href);
  module.default(pi);
  await handlers.get("session_start")({}, { cwd: home });
  handlers.get("agent_start")?.({}, {});

  await waitFor(() => checkCalls >= 2, "cross-task merge checks");
  // The first 100ms timer is scheduled only after both checks enter pendingEvents.
  await afkFlushRan.promise;
  rmSync(metaPath(tasks[0]));
  if (existsSync(metaPath(tasks[0]))) throw new Error("orphan task metadata still exists");
  if (sent.length !== 0) throw new Error("AFK batch escaped active-turn deferral before teardown");

  handlers.get("agent_end")?.({}, {});
  await waitFor(() => sent.length === 1, "filtered AFK batch delivery");
  const content = String(sent[0].message.content);
  if (!content.includes("[wake x1 ") || !content.includes("1 relevant event(s)")) {
    throw new Error(`filtered AFK batch kept the wrong count: ${content}`);
  }
  if (content.includes("checked-a") || !content.includes("live-b")) {
    throw new Error(`filtered AFK batch did not preserve the live entry: ${content}`);
  }

  await handlers.get("session_shutdown")();
  console.log("supervisor AFK cross-task merge checks passed");
} finally {
  globalThis.setTimeout = originalSetTimeout;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
