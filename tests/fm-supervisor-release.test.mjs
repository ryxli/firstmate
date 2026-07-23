import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const extension = join(root, ".omp/extensions/fm-supervisor.ts");
const response = (stdout = "", code = 0, killed = false) => ({ stdout, stderr: "", code, killed });
const absent = "w1:absent";
const live = "w1:live";
const refreshed = "w1:refreshed";
const notFound = JSON.stringify({ error: { code: "agent_not_found" } });

const sleep = (ms) => Bun.sleep(ms);
const includesPane = (request, pane) => request.params.subscriptions.some((entry) => entry.pane_id === pane);

async function verify(mode) {
  const home = mkdtempSync(join(tmpdir(), `fm-supervisor-release-${mode}-`));
  const state = join(home, "state");
  const socketPath = join(home, "herdr.sock");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "absent.meta"), `pane=${absent}\nkind=ship\n`);
  writeFileSync(join(state, "live.meta"), `pane=${live}\nkind=ship\n`);
  const previousEnv = new Map();
  for (const [key, value] of Object.entries({ FM_HOME: home, FM_STATE_OVERRIDE: state, HERDR_SOCKET_PATH: socketPath, FM_CAP_OS_NOTIFY: "0", FM_SIGNAL_GRACE: "0.05" })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  const subscriptions = [];
  let client;
  let acked = false;
  let absenceProbeStarts = 0;
  let releaseHeldProbe;
  let outageWorking = false;
  let attentionEdges = 0;
  let holdRecoveryRefresh = false;
  let releaseRefresh;
  const server = createServer((socket) => {
    client = socket;
    socket.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        const request = JSON.parse(line);
        const initialSubscription = subscriptions.length === 0;
        subscriptions.push(request);
        if (initialSubscription && absenceProbeStarts !== 0) throw new Error("absence probe started before subscription acknowledgement");
        acked = true;
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  const handlers = new Map();
  const pi = {
    setLabel() {},
    on(event, handler) { handlers.set(event, handler); },
    sendMessage() { attentionEdges += 1; },
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const pane = args[2];
        if (pane === live) return response(JSON.stringify({ result: { agent_status: "working" } }));
        if (pane !== absent) return response();
        if (!acked) return response(JSON.stringify({ result: { agent_status: "unknown" } }));
        absenceProbeStarts += 1;
        if (mode === "confirmed") return response(notFound, 1);
        if (mode === "malformed") return response("not-json", 1);
        if (mode === "wrong-code") return response(notFound, 0);
        if (mode === "killed") return response(notFound, 1, true);
        if (mode === "reconnect-gap" && outageWorking) return response(JSON.stringify({ result: { agent_status: "working" } }));
        if (mode === "transport") throw new Error("transport failed");
        if (mode === "gone-recovery" && holdRecoveryRefresh) {
          holdRecoveryRefresh = false;
          return await new Promise((resolve) => { releaseRefresh = () => resolve(response(notFound, 1)); });
        }
        if ((mode === "held-status" || mode === "gone-recovery") && absenceProbeStarts === 1) {
          return await new Promise((resolve) => { releaseHeldProbe = () => resolve(response(notFound, 1)); });
        }
        return response(notFound, 1);
      }
      if (command === "bash") return response("");
      return response();
    },
    logger: { warn() {} },
  };

  try {
    const module = await import(`${pathToFileURL(extension).href}?${mode}-${Math.random()}`);
    module.default(pi);
    await handlers.get("session_start")({}, { cwd: home });
    await sleep(100);
    if (subscriptions.length === 0 || !includesPane(subscriptions[0], absent) || !includesPane(subscriptions[0], live)) {
      throw new Error("initial subscription did not include absent and live panes before cleanup");
    }
    if (absenceProbeStarts === 0) throw new Error("acknowledged subscription did not start confirmed absence probes");
    await sleep(200);
    const subscriptionsBeforeIdleRefresh = subscriptions.length;
    const probesBeforeIdleRefresh = absenceProbeStarts;
    await sleep(600);
    if (subscriptions.length !== subscriptionsBeforeIdleRefresh || absenceProbeStarts !== probesBeforeIdleRefresh) {
      throw new Error(`unchanged fleet refresh emitted a subscription or absence probe: subscriptions ${subscriptionsBeforeIdleRefresh}->${subscriptions.length}, probes ${probesBeforeIdleRefresh}->${absenceProbeStarts}`);
    }

    if (mode === "held-status" || mode === "gone-recovery") {
      client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: absent, agent_status: "unknown" } })}\n`);
      await sleep(20);
      if (mode === "gone-recovery") holdRecoveryRefresh = true;
      client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: absent, agent_status: "working" } })}\n`);
      await sleep(100);
      if (mode === "gone-recovery") {
        client.write(`${JSON.stringify({ event: "pane.closed", data: { pane_id: absent } })}\n`);
        await sleep(20);
        releaseRefresh?.();
      }
      releaseHeldProbe?.();
      await sleep(650);
      client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: absent, agent_status: "blocked" } })}\n`);
      await sleep(650);
      const expectedAttentionEdges = mode === "gone-recovery" ? 0 : 1;
      if (attentionEdges !== expectedAttentionEdges) throw new Error(`${mode} recovery fence emitted ${attentionEdges} attention edge(s)`);
    }
    const probesBeforeFleetChange = absenceProbeStarts;
    writeFileSync(join(state, "refreshed.meta"), `pane=${refreshed}\nkind=ship\n`);
    await sleep(650);
    const latest = subscriptions.at(-1);
    if (!latest || !includesPane(latest, absent) || !includesPane(latest, live) || !includesPane(latest, refreshed)) {
      throw new Error(`${mode} did not resubscribe with its retained-pane status boundary`);
    }
    if ((mode === "confirmed" || mode === "reconnect-gap") && absenceProbeStarts !== probesBeforeFleetChange + 1) {
      throw new Error("current subscription acknowledgement did not reconcile the retained absent pane exactly once");
    }
    if (mode === "confirmed") {
      client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: absent, agent_status: "working" } })}\n`);
      await sleep(650);
      const reattached = subscriptions.at(-1);
      if (!reattached || !includesPane(reattached, absent) || !includesPane(reattached, live) || !includesPane(reattached, refreshed)) {
        throw new Error("fresh working status did not restore confirmed-absent pane supervision");
      }
      const subscriptionsBeforeRestoredIdle = subscriptions.length;
      const probesBeforeRestoredIdle = absenceProbeStarts;
      await sleep(600);
      if (subscriptions.length !== subscriptionsBeforeRestoredIdle || absenceProbeStarts !== probesBeforeRestoredIdle) {
        throw new Error("restored unchanged pane emitted a polling subscription or absence probe");
      }
      client.destroy();
      await sleep(2_200);
      const reconnect = subscriptions.at(-1);
      if (!reconnect || !includesPane(reconnect, absent) || !includesPane(reconnect, live) || !includesPane(reconnect, refreshed)) {
        throw new Error("reconnect subscription did not retain the restored pane");
      }
    }
    if (mode === "reconnect-gap") {
      outageWorking = true;
      client.destroy();
      await sleep(2_850);
      const restored = subscriptions.at(-1);
      if (!restored || !includesPane(restored, absent)) throw new Error("reconnect current-status recovery did not restore the retained pane");
      client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: absent, agent_status: "blocked" } })}\n`);
      await sleep(650);
      if (attentionEdges !== 1) throw new Error(`reconnect gap did not restore a real blocked attention edge: ${attentionEdges}`);
    }
    await handlers.get("session_shutdown")();
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

for (const mode of ["confirmed", "held-status", "gone-recovery", "reconnect-gap", "malformed", "wrong-code", "killed", "timeout", "transport"]) {
  await verify(mode);
}
console.log("supervisor gates confirmed absence on current subscription acknowledgements, atomically recovers races and reconnect gaps, avoids unchanged refresh polling, and retains ambiguous results");

async function verifyTimerAba() {
  const home = mkdtempSync(join(tmpdir(), "fm-supervisor-timer-aba-"));
  const state = join(home, "state");
  const socketPath = join(home, "herdr.sock");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "timer.meta"), "pane=w1:timer\nkind=ship\n");
  const previousEnv = new Map();
  for (const [key, value] of Object.entries({ FM_HOME: home, FM_STATE_OVERRIDE: state, HERDR_SOCKET_PATH: socketPath, FM_CAP_OS_NOTIFY: "0", FM_SIGNAL_GRACE: "0.05", FM_STALE_ESCALATE_SECS: "0.02", FM_SECONDMATE_IDLE_SECS: "0.02" })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  let client;
  let releaseReachable;
  let attentionEdges = 0;
  const server = createServer((socket) => {
    client = socket;
    socket.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        const request = JSON.parse(line);
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  const handlers = new Map();
  const pi = {
    setLabel() {},
    on(event, handler) { handlers.set(event, handler); },
    sendMessage() { attentionEdges += 1; },
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") return response(JSON.stringify({ result: { agent_status: "working" } }));
      if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
        return await new Promise((resolve) => { releaseReachable = () => resolve(response(JSON.stringify({ pane_id: "w1:timer" }))); });
      }
      if (command === "bash") return response("");
      return response();
    },
    logger: { warn() {} },
  };
  try {
    const module = await import(`${pathToFileURL(extension).href}?timer-aba-${Math.random()}`);
    module.default(pi);
    await handlers.get("session_start")({}, { cwd: home });
    await sleep(100);
    client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:timer", agent_status: "working" } })}\n`);
    await sleep(20);
    client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:timer", agent_status: "idle" } })}\n`);
    await sleep(100);
    rmSync(join(state, "timer.meta"));
    await sleep(650);
    writeFileSync(join(state, "timer.meta"), "pane=w1:timer\nkind=ship\n");
    await sleep(650);
    if (!releaseReachable) throw new Error("ABA completion timer did not invoke its pane reachability callback");
    releaseReachable();
    await sleep(150);
    if (attentionEdges !== 0) throw new Error(`stale incarnation woke after drop/readd ABA: ${attentionEdges}`);
    await handlers.get("session_shutdown")();
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

await verifyTimerAba();
console.log("supervisor stale callback epoch fences drop/readd ABA");

async function verifyCompletionTimerCase(name, idleSeconds, intervene) {
  const home = mkdtempSync(join(tmpdir(), `fm-supervisor-completion-${name}-`));
  const state = join(home, "state");
  const socketPath = join(home, "herdr.sock");
  const pane = `w1:${name}`;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "timer.meta"), `pane=${pane}\nkind=secondmate\n`);
  const previousEnv = new Map();
  for (const [key, value] of Object.entries({ FM_HOME: home, FM_STATE_OVERRIDE: state, HERDR_SOCKET_PATH: socketPath, FM_CAP_OS_NOTIFY: "0", FM_SECONDMATE_IDLE_SECS: String(idleSeconds) })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  let client;
  let connections = 0;
  const subscriptions = [];
  let completionProbes = 0;
  const server = createServer((socket) => {
    connections += 1;
    client = socket;
    socket.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        const request = JSON.parse(line);
        subscriptions.push(request);
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  const handlers = new Map();
  const pi = {
    setLabel() {},
    on(event, handler) { handlers.set(event, handler); },
    sendMessage() {},
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") return response(JSON.stringify({ result: { agent_status: "working" } }));
      if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
        completionProbes += 1;
        return response(JSON.stringify({ pane_id: pane }));
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "read") return response("");
      if (command === "bash") return response("");
      return response();
    },
    logger: { warn() {} },
  };
  try {
    const module = await import(`${pathToFileURL(extension).href}?completion-${name}-${Math.random()}`);
    module.default(pi);
    await handlers.get("session_start")({}, { cwd: home });
    await sleep(100);
    if (!client || subscriptions.length !== 1) throw new Error(`${name} did not establish the initial acknowledged subscription`);
    client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: "working" } })}\n`);
    await sleep(20);
    client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: "idle" } })}\n`);
    await intervene({ state, pane, subscriptions, connections: () => connections, client: () => client });
    await sleep(idleSeconds * 1_000 + 500);
    if (completionProbes !== 1) throw new Error(`${name} did not preserve one armed completion callback: ${completionProbes}`);
    await handlers.get("session_shutdown")();
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

async function verifyCompletionTimerSurvivesUnrelatedResubscription() {
  await verifyCompletionTimerCase("unrelated-resubscription", 1.2, async ({ state, subscriptions }) => {
    writeFileSync(join(state, "other.meta"), "pane=w1:other\nkind=ship\n");
    await sleep(650);
    if (subscriptions.length < 2) throw new Error("unrelated fleet change did not resubscribe while completion timer was armed");
  });
}

async function verifyCompletionTimerSurvivesReconnect() {
  await verifyCompletionTimerCase("reconnect", 3, async ({ connections, client }) => {
    client().destroy();
    await sleep(2_300);
    if (connections() < 2) throw new Error("socket reconnect did not occur while completion timer was armed");
  });
}

async function verifyCompletionTimerSurvivesDuplicateIdle() {
  await verifyCompletionTimerCase("duplicate-idle", 0.2, async ({ pane, client }) => {
    await sleep(50);
    client().write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: "idle" } })}\n`);
  });
}

await verifyCompletionTimerSurvivesUnrelatedResubscription();
console.log("supervisor completion timer survives unrelated resubscription");
await verifyCompletionTimerSurvivesReconnect();
console.log("supervisor completion timer survives reconnect");
await verifyCompletionTimerSurvivesDuplicateIdle();
console.log("supervisor completion timer survives duplicate idle");

async function verifyAcknowledgementRecovery(mode) {
  const home = mkdtempSync(join(tmpdir(), `fm-supervisor-ack-${mode}-`));
  const state = join(home, "state");
  const socketPath = join(home, "herdr.sock");
  const pane = `w1:ack-${mode}`;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "ack.meta"), `pane=${pane}\nkind=secondmate\n`);
  const previousEnv = new Map();
  for (const [key, value] of Object.entries({ FM_HOME: home, FM_STATE_OVERRIDE: state, HERDR_SOCKET_PATH: socketPath, FM_CAP_OS_NOTIFY: "0", FM_SECONDMATE_IDLE_SECS: "0.02" })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  let client;
  let subscriptions = 0;
  let statusReads = 0;
  let completionProbes = 0;
  const originalWrite = Socket.prototype.write;
  let failedWrite = false;
  if (mode === "write-failure") {
    Socket.prototype.write = function (chunk, ...args) {
      if (!failedWrite && String(chunk).includes('"events.subscribe"')) {
        failedWrite = true;
        throw new Error("injected subscription write failure");
      }
      return originalWrite.call(this, chunk, ...args);
    };
  }
  const server = createServer((socket) => {
    client = socket;
    socket.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        const request = JSON.parse(line);
        subscriptions += 1;
        if (subscriptions === 1 && mode === "withheld-timeout") continue;
        if (subscriptions === 1 && mode === "wrong-id") {
          socket.write(`${JSON.stringify({ id: `${request.id}-wrong`, result: { type: "subscription_started" } })}\n`);
          continue;
        }
        if (subscriptions === 1 && mode === "json-rpc-error") {
          socket.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: "rejected" } })}\n`);
          continue;
        }
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  const handlers = new Map();
  const pi = {
    setLabel() {},
    on(event, handler) { handlers.set(event, handler); },
    sendMessage() {},
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        statusReads += 1;
        return response(JSON.stringify({ result: { agent_status: "working" } }));
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
        completionProbes += 1;
        return response(JSON.stringify({ pane_id: pane }));
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "read") return response("");
      if (command === "bash") return response("");
      return response();
    },
    logger: { warn() {} },
  };
  try {
    const module = await import(`${pathToFileURL(extension).href}?ack-${mode}-${Math.random()}`);
    module.default(pi);
    await handlers.get("session_start")({}, { cwd: home });
    await sleep(mode === "withheld-timeout" || mode === "wrong-id" ? 7_500 : 3_500);
    if (mode === "write-failure" && !failedWrite) throw new Error("write-failure regression did not inject the subscription write error");
    if ((mode === "write-failure" ? subscriptions < 1 : subscriptions < 2) || !client || statusReads === 0) throw new Error(`${mode} did not recover to an acknowledged subscription`);
    client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: "idle" } })}\n`);
    await sleep(120);
    if (completionProbes !== 1) throw new Error(`${mode} recovery did not restore the completion callback: ${completionProbes}`);
    await handlers.get("session_shutdown")();
  } finally {
    Socket.prototype.write = originalWrite;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

async function verifyAcknowledgementRecoveryAfterWithheldTimeout() {
  await verifyAcknowledgementRecovery("withheld-timeout");
}

async function verifyAcknowledgementRecoveryAfterWrongId() {
  await verifyAcknowledgementRecovery("wrong-id");
}

async function verifyAcknowledgementRecoveryAfterJsonRpcError() {
  await verifyAcknowledgementRecovery("json-rpc-error");
}

async function verifyAcknowledgementRecoveryAfterWriteFailure() {
  await verifyAcknowledgementRecovery("write-failure");
}

await verifyAcknowledgementRecoveryAfterWithheldTimeout();
console.log("supervisor acknowledgement recovery follows withheld timeout");
await verifyAcknowledgementRecoveryAfterWrongId();
console.log("supervisor acknowledgement recovery rejects wrong id");
await verifyAcknowledgementRecoveryAfterJsonRpcError();
console.log("supervisor acknowledgement recovery follows JSON-RPC error");
await verifyAcknowledgementRecoveryAfterWriteFailure();
console.log("supervisor acknowledgement recovery follows write failure");

async function verifyDelayedAcknowledgementSeedsWorkingStatus() {
  const home = mkdtempSync(join(tmpdir(), "fm-supervisor-delayed-ack-"));
  const state = join(home, "state");
  const socketPath = join(home, "herdr.sock");
  const pane = "w1:delayed";
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "delayed.meta"), `pane=${pane}\nkind=ship\n`);
  const previousEnv = new Map();
  for (const [key, value] of Object.entries({ FM_HOME: home, FM_STATE_OVERRIDE: state, HERDR_SOCKET_PATH: socketPath, FM_CAP_OS_NOTIFY: "0", FM_SECONDMATE_IDLE_SECS: "0.02" })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  let client;
  let subscription;
  let statusReads = 0;
  let completionProbes = 0;
  const server = createServer((socket) => {
    client = socket;
    socket.on("data", (data) => {
      for (const line of data.toString().split("\n")) {
        if (line) subscription = JSON.parse(line);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  const handlers = new Map();
  const pi = {
    setLabel() {},
    on(event, handler) { handlers.set(event, handler); },
    sendMessage() {},
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        statusReads += 1;
        return response(JSON.stringify({ result: { agent_status: "working" } }));
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
        completionProbes += 1;
        return response(JSON.stringify({ pane_id: pane }));
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "read") return response("");
      if (command === "bash") return response("");
      return response();
    },
    logger: { warn() {} },
  };
  try {
    const module = await import(`${pathToFileURL(extension).href}?delayed-ack-${Math.random()}`);
    module.default(pi);
    await handlers.get("session_start")({}, { cwd: home });
    await sleep(60);
    if (!subscription) throw new Error("subscription was not requested before delayed acknowledgement");
    const readsBeforeAck = statusReads;
    await sleep(40);
    if (statusReads !== readsBeforeAck) throw new Error("live status seeded before subscription acknowledgement");
    client.write(`${JSON.stringify({ id: subscription.id, result: { type: "subscription_started" } })}\n`);
    await sleep(60);
    if (statusReads !== readsBeforeAck + 2) throw new Error(`acknowledged subscription did not reconcile then seed the live working status: ${readsBeforeAck}->${statusReads}`);
    client.write(`${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: "idle" } })}\n`);
    await sleep(120);
    if (completionProbes === 0) throw new Error("delayed-ack working-to-idle transition did not retain its completion backstop");
    await handlers.get("session_shutdown")();
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

await verifyDelayedAcknowledgementSeedsWorkingStatus();
console.log("supervisor seeds live status only after subscription acknowledgement and retains delayed working-to-idle completion");
