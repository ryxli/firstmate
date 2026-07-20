import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const ext = join(root, ".omp/extensions/fm-supervisor.ts");
const home = mkdtempSync(join(tmpdir(), "fm-supervisor-checks-"));
const state = join(home, "state");
const task = "fleet-snapshot-axi-k4";
const pane = "w1:p1";
const metaPath = join(state, `${task}.meta`);
const checkPath = join(state, `${task}.check.sh`);

mkdirSync(state, { recursive: true });
writeFileSync(metaPath, `pane=${pane}\nkind=ship\npr=https://github.com/example/repo/pull/42\n`);
writeFileSync(checkPath, "#!/usr/bin/env bash\nprintf 'merged\\n'\n");
chmodSync(checkPath, 0o755);

const env = {
  FM_HOME: home,
  FM_STATE_OVERRIDE: state,
  HERDR_SOCKET_PATH: join(home, "missing-herdr.sock"),
  FM_SIGNAL_GRACE: "0.1",
  FM_CHECK_INTERVAL: "0.3",
  FM_CHECK_TIMEOUT: "1",
  FM_CAP_OS_NOTIFY: "0",
};
const previousEnv = new Map();
for (const [key, value] of Object.entries(env)) {
  previousEnv.set(key, process.env[key]);
  process.env[key] = value;
}

const handlers = new Map();
const sent = [];
let checkCalls = 0;
const metaRemoved = Promise.withResolvers();
const secondFlushRan = Promise.withResolvers();
const response = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
const originalSetTimeout = globalThis.setTimeout;
let flushCount = 0;
globalThis.setTimeout = (handler, timeout, ...args) => {
  if (timeout === 100) {
    const currentFlush = ++flushCount;
    return originalSetTimeout((...callbackArgs) => {
      if (currentFlush === 2) secondFlushRan.resolve();
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
      return response(JSON.stringify({ pane_id: pane, agent_status: "working" }));
    }
    if (command === "bash" && args[0] === checkPath) {
      checkCalls++;
      if (checkCalls === 2) {
        // Resolve first; runChecks must enqueue and schedule the second grace flush.
        // The wrapper runs flush before this callback removes task metadata.
        return new Promise((resolve) => {
          resolve(response("merged\n"));
          void secondFlushRan.promise.then(() => {
            if (sent.length !== 1) {
              metaRemoved.reject(new Error("merge check delivered before active-turn deferral"));
              return;
            }
            rmSync(metaPath);
            metaRemoved.resolve();
          });
        });
      }
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

  await waitFor(() => sent.length === 1, "live PR merge check wake");
  const firstWake = sent[0].message;
  if (firstWake.customType !== "fleet-attention-changed" || firstWake.content !== "fleet-attention-changed: Read `fm fleet` once." || firstWake.display !== false) {
    throw new Error("live merge check did not emit the silent fleet attention edge");
  }
  if (JSON.stringify(sent[0].options) !== JSON.stringify({ triggerTurn: true })) throw new Error("attention delivery options changed");

  handlers.get("agent_start")?.({}, {});
  await waitFor(() => checkCalls >= 2, "second merge check");
  await metaRemoved.promise;
  if (existsSync(metaPath)) throw new Error("grace-window regression did not remove task metadata");
  if (!readFileSync(checkPath, "utf8").includes("merged")) throw new Error("regression did not preserve the scheduled check file");
  if (sent.length !== 1) throw new Error("queued merge check escaped active-turn deferral before teardown");
  const callsAfterRemoval = checkCalls;
  handlers.get("agent_end")?.({}, {});
  await Bun.sleep(50);
  if (sent.length !== 1) throw new Error("deferred merge check survived teardown and delivered at agent end");
  await Bun.sleep(360);
  if (checkCalls !== callsAfterRemoval) throw new Error("orphaned merge check still executed after task meta removal");

  await handlers.get("session_shutdown")();
  console.log("supervisor merge-check lifecycle passed");
} finally {
  globalThis.setTimeout = originalSetTimeout;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
