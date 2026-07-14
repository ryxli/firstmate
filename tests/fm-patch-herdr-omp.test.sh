#!/usr/bin/env bash
# Behavior tests for fm-patch-herdr-omp.sh's recovery-heartbeat invariant.
#
# ROOT CAUSE (fixed): the injected 15s recovery heartbeat used to call
# restoreAgentActiveFromCtx() (re-sampling ctx.isIdle()) on every tick, even
# once rootSession was already true and agent_start/agent_end already owned
# agentActive. During an active whiteboard-driven turn ctx.isIdle() can read
# true, so the heartbeat overwrote a correct Working state with false Idle -
# a fleetwide false-idle regression despite healthy pane binding and socket.
#
# These tests pin the invariant: ctx.isIdle() is sampled ONLY while
# recovering a newly reloaded runtime (rootSession still false); once
# activated, the heartbeat force-publishes retained lifecycle state and
# never re-derives it from ctx.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHER="$ROOT/sbin/fm-patch-herdr-omp.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-patch-herdr-omp.XXXXXX")
export HOME="$TMP_ROOT/home"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# A minimal but structurally faithful stand-in for herdr's unpatched
# herdr-omp-agent-state.ts: it reproduces every anchor the patcher's `_old`
# shapes match against (rootSession decl, activateRootSession's hasUI gate,
# session_start/session_switch/agent_start, and the four tool hooks).
write_pristine_fixture() {
  cat >"$1" <<'TS'
interface HeartbeatCtx {
  hasUI?: boolean;
  isIdle?: () => boolean;
}

interface PublishRecord {
  force: boolean;
  agentActive: boolean;
}

interface TestBackchannel {
  getAgentActive: () => boolean;
  getLog: () => PublishRecord[];
}

interface PiHandle {
  on: (event: string, handler: (event: unknown, ctx: HeartbeatCtx) => void) => void;
  __test?: TestBackchannel;
}

export default function register(pi: PiHandle): void {
  let agentActive = false;
  const publishLog: PublishRecord[] = [];
  const calls: string[] = [];

  // Mock lifecycle plumbing: the patched code below invokes each of these
  // by the literal names herdr's real integration uses. They record the
  // call instead of doing real session/timer work - a test seam for the
  // heartbeat invariant, not a reimplementation of herdr.
  function publishState(force = false): void {
    publishLog.push({ force, agentActive });
  }
  function enabled(): boolean {
    return true;
  }
  function updateSessionRef(_ctx: HeartbeatCtx): void {
    calls.push("updateSessionRef");
  }
  function reportSession(reason?: string): Promise<void> {
    calls.push(`reportSession:${reason ?? ""}`);
    return Promise.resolve();
  }
  function resetSessionState(): void {
    calls.push("resetSessionState");
  }
  function clearPendingTimers(): void {
    calls.push("clearPendingTimers");
  }
  function clearFailureState(): void {
    calls.push("clearFailureState");
  }

  pi.__test = { getAgentActive: () => agentActive, getLog: () => publishLog };

  let rootSession = false;

  // ctx: any (not HeartbeatCtx) is mandatory here: sbin/fm-patch-herdr-omp.sh
  // matches this signature byte-exact against herdr's real, un-typed
  // (`@ts-nocheck`) integration source. Narrowing it breaks the patcher's
  // anchor match on the genuine target file.
  function activateRootSession(ctx: any, sessionStartSource = "startup"): boolean {
    if (ctx?.hasUI !== true) {
      return false;
    }
    rootSession = true;
    updateSessionRef(ctx);
    void reportSession(sessionStartSource);
    return true;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!activateRootSession(ctx)) {
      return;
    }
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("session_switch", (event, ctx) => {
    if (!activateRootSession(ctx, event?.reason || "resume")) {
      return;
    }
    resetSessionState();
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession();
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });

  pi.on("agent_end", (_event, ctx) => {
    agentActive = false;
    publishState();
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) {
      return;
    }
  });

  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) {
      return;
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName !== "ask") {
      return;
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName !== "ask") {
      return;
    }
  });
}
TS
}

test_pristine_check_reports_unpatched() {
  local f="$TMP_ROOT/pristine.ts"
  write_pristine_fixture "$f"
  "$PATCHER" --check --file "$f"
  local rc=$?
  [ "$rc" -eq 1 ] || fail "--check on a pristine file must exit 1, got $rc"
  pass "--check exits 1 on a pristine (never-patched) file"
}

test_apply_enforces_invariant() {
  local f="$TMP_ROOT/apply.ts"
  write_pristine_fixture "$f"
  "$PATCHER" --file "$f" || fail "apply on a pristine file must exit 0"
  "$PATCHER" --check --file "$f" || fail "--check must report patched after a successful apply"

  python3 - "$f" <<'PY' || fail "restoreAgentActiveFromCtx() must be scoped inside the rootSession recovery branch, closed before publishState(true)"
import sys
src = open(sys.argv[1], encoding="utf-8").read()
sys.exit(0 if "restoreAgentActiveFromCtx();\n        }\n        publishState(true);" in src else 1)
PY

  python3 - "$f" <<'PY' && fail "restoreAgentActiveFromCtx() must never sit directly adjacent to publishState(true) (that re-samples ctx.isIdle() on every tick)"
import sys
src = open(sys.argv[1], encoding="utf-8").read()
sys.exit(0 if "restoreAgentActiveFromCtx();\n        publishState(true);" in src else 1)
PY

  pass "applied heartbeat scopes ctx.isIdle() recovery to the rootSession-false branch only"
}

test_apply_is_idempotent() {
  local f="$TMP_ROOT/idempotent.ts"
  write_pristine_fixture "$f"
  "$PATCHER" --file "$f" >/dev/null || fail "first apply failed"
  local before
  before=$(cat "$f")
  local out
  out=$("$PATCHER" --file "$f" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "second apply must exit 0, got $rc"
  printf '%s' "$out" | grep -q "already patched" || fail "second apply must report already patched, got: $out"
  [ "$(cat "$f")" = "$before" ] || fail "second apply must not modify an already-patched file"
  pass "re-applying to an already-patched file is a no-op"
}

test_upgrade_from_prior_buggy_heartbeat_converges() {
  local fresh="$TMP_ROOT/fresh.ts"
  local buggy="$TMP_ROOT/buggy.ts"
  write_pristine_fixture "$fresh"
  write_pristine_fixture "$buggy"
  "$PATCHER" --file "$fresh" >/dev/null || fail "fresh apply failed"

  # Rewrite $buggy into the shape the prior (buggy) patcher version produced:
  # every hook migration identical, but the heartbeat block unconditionally
  # re-samples ctx.isIdle() via restoreAgentActiveFromCtx() every tick.
  "$PATCHER" --file "$buggy" >/dev/null || fail "buggy-precursor apply failed"
  python3 - "$buggy" <<'PY'
import io, re, sys
path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()
new_block_re = re.compile(
    r'  // fm-resync-heartbeat-lifecycle-invariant:.*?\n  \} catch \(_e\) \{\}\n',
    re.S,
)
old_block = '''  // fm-resync-heartbeat-ctx-resync: heartbeat also restores agentActive from the latest ctx.
  // ROOT CAUSE this fixes: the reporter enables state reporting only after
  // activateRootSession() sees ctx.hasUI === true. A long-lived omp session
  // auto-compacts / reloads many times (observed hundreds of times per mate),
  // and a reload replaces this extension runtime; the re-fired session event
  // does not reliably carry hasUI, so rootSession stays false and the reporter
  // goes permanently silent - herdr then falls back to idle for the rest of
  // the session even while the agent is actively working. A fresh session
  // works only because it has not compacted yet.
  // Fix: enabled() already proves this is a real herdr-managed pane (HERDR_ENV
  // + pane id + socket are all present), which is the same fact hasUI was a
  // proxy for. The latest ctx lets reload/session_switch/heartbeat recover
  // agentActive from ctx.isIdle(), not from stale local defaults.
  try {
    const __fmResyncMs = 15000;
    const __fmResync = setInterval(() => {
      try {
        if (!enabled()) return;
        if (!rootSession) {
          // Reload dropped activation; re-establish it. Report the session
          // ref so herdr rebinds this source, then resume publishing.
          rootSession = true;
          if (latestCtx) updateSessionRef(latestCtx);
          void reportSession("fm-reload-resync");
        }
        restoreAgentActiveFromCtx();
        publishState(true);
      } catch (_e) {}
    }, __fmResyncMs);
    __fmResync.unref?.();
  } catch (_e) {}
'''
assert new_block_re.search(src), "fresh-patched fixture missing expected heartbeat block"
src = new_block_re.sub(old_block, src, count=1)
io.open(path, "w", encoding="utf-8").write(src)
PY

  "$PATCHER" --check --file "$buggy"
  local rc=$?
  [ "$rc" -eq 1 ] || fail "--check on the prior buggy heartbeat shape must exit 1 (needs re-patch), got $rc"

  "$PATCHER" --file "$buggy" || fail "upgrade apply over the prior buggy heartbeat must succeed"
  "$PATCHER" --check --file "$buggy" || fail "--check must report patched after the upgrade apply"

  diff -u "$fresh" "$buggy" \
    || fail "upgrading a prior-buggy-patched file must converge to the same content as a fresh apply"

  pass "a file carrying the prior buggy heartbeat is detected as unpatched and upgrades to the corrected shape"
}

test_missing_target_skips_cleanly() {
  local f="$TMP_ROOT/does-not-exist.ts"
  local out
  out=$("$PATCHER" --file "$f" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "a missing integration file must not be an error (bootstrap-safe), got $rc"
  printf '%s' "$out" | grep -q "SKIP" || fail "a missing integration file must report SKIP, got: $out"
  pass "a missing integration file skips cleanly instead of failing bootstrap"
}

# Captain-reported live failure case: the agent is inside an active
# whiteboard-driven turn, waiting on one background watcher job (a curl
# poll loop) - agent_start has fired and agent_end has not, so the turn is
# still open - while Herdr/omp's own ctx.isIdle() reads true because the
# runtime is between explicit actions. This drives the patched heartbeat
# through 2 ticks (>15s of simulated elapsed time) and asserts agentActive
# (Working) survives, proving the invariant against the exact reported
# regression rather than only against the source text shape.
test_active_turn_survives_background_job_wait_across_heartbeat() {
  command -v bun >/dev/null 2>&1 \
    || fail "bun is required for the heartbeat runtime regression (CI installs it via oven-sh/setup-bun)"

  local fixture="$TMP_ROOT/heartbeat-runtime.ts"
  local harness="$TMP_ROOT/heartbeat-harness.mjs"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" || fail "apply for the runtime regression fixture failed"

  cat >"$harness" <<'MJS'
const fixturePath = process.argv[2];

const handlers = new Map();
const mockPi = { on(event, fn) { handlers.set(event, fn); return mockPi; } };

// Capture the heartbeat's setInterval(fn, 15000) without waiting real time.
let heartbeatFn = null;
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  if (ms === 15000) heartbeatFn = fn;
  return { unref: () => {} };
};

const mod = await import(fixturePath);
const register = mod.default;
register(mockPi);
globalThis.setInterval = origSetInterval;

if (!heartbeatFn) {
  console.error("FAIL: heartbeat setInterval(ms=15000) was never registered");
  process.exit(1);
}

let idle = false;
const rootSessionFile = "/tmp/root-session.jsonl";
const rootSessionId = "root-session-id";
const ctx = {
  hasUI: true,
  isIdle: () => idle,
  sessionManager: {
    getSessionFile: () => rootSessionFile,
    getSessionId: () => rootSessionId,
    getBranch: () => [],
  },
};

// Establish a genuinely active turn: session_start then agent_start, ctx
// currently NOT idle (actively processing).
handlers.get("session_start")?.({}, ctx);
handlers.get("agent_start")?.({}, ctx);

if (mockPi.__test.getAgentActive() !== true) {
  console.error("FAIL: agentActive must be true immediately after agent_start");
  process.exit(1);
}

// The captain-reported case: the turn is still open (no agent_end fired)
// but the agent is waiting on a background watcher job (curl loop);
// ctx.isIdle() reads true while waiting even though the turn is active.
idle = true;

// Two heartbeat ticks: simulated >15s of elapsed wall time while waiting.
for (let tick = 1; tick <= 2; tick++) {
  heartbeatFn();
  if (mockPi.__test.getAgentActive() !== true) {
    console.error(`FAIL: agentActive flipped to false on heartbeat tick ${tick} while the turn was still open and waiting on a background job`);
    process.exit(1);
  }
  const log = mockPi.__test.getLog();
  const last = log[log.length - 1];
  if (!last || last.force !== true || last.agentActive !== true) {
    console.error(`FAIL: heartbeat tick ${tick} did not force-publish a Working state; got ${JSON.stringify(last)}`);
    process.exit(1);
  }
}

console.log("PASS: agentActive stayed true (Working) across 2 heartbeat ticks while ctx.isIdle() read true during an open turn's background-job wait");
process.exit(0);
MJS

  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "active turn waiting on a background job across the 15s heartbeat regressed: $out"
  printf '%s' "$out" | grep -q "^PASS" || fail "runtime harness did not report PASS: $out"
  pass "an active turn waiting on a background job stays Working across 2 heartbeat ticks (>15s) even though ctx.isIdle() reads true"
}

test_exact_session_root_claim_lifecycle() {
  command -v bun >/dev/null 2>&1 \
    || fail "bun is required for the exact-session root-claim regression"

  local fixture="$TMP_ROOT/root-claim-runtime.ts"
  local harness="$TMP_ROOT/root-claim-harness.mjs"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" || fail "apply for the exact-session root-claim fixture failed"

  cat >"$TMP_ROOT/root-claim-headless-only.mjs" <<'MJS'
const fixturePath = process.argv[2];
const handlers = new Map();
const pi = { on(event, fn) { handlers.set(event, fn); return pi; } };
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => ({ unref() {} });
const mod = await import(`${fixturePath}?headless-only`);
mod.default(pi);
globalThis.setInterval = originalSetInterval;
const ctx = {
  hasUI: false,
  agentKind: "main",
  isIdle: () => false,
  sessionManager: {
    getSessionFile: () => "/sessions/headless-only.jsonl",
    getSessionId: () => "headless-only",
    getBranch: () => [],
  },
};
handlers.get("session_start")?.({ reason: "startup" }, ctx);
const claim = globalThis[Symbol.for("herdr:omp:root-session-claim:v1")];
if (claim !== undefined || pi.__test.getLog().length !== 0) {
  console.error(`FAIL: fresh headless process claimed or published root state: ${JSON.stringify(claim)}`);
  process.exit(1);
}
console.log("PASS: fresh top-level headless process cannot claim root authority");
MJS
  local headless_out
  headless_out=$(bun run "$TMP_ROOT/root-claim-headless-only.mjs" "$fixture" 2>&1)
  local headless_rc=$?
  [ "$headless_rc" -eq 0 ] || fail "fresh headless root-claim veto regressed: $headless_out"
  printf '%s' "$headless_out" | grep -q "^PASS" || fail "fresh headless harness did not report PASS: $headless_out"

  cat >"$harness" <<'MJS'
const fixturePath = process.argv[2];
const claimKey = Symbol.for("herdr:omp:root-session-claim:v1");

function exactClaim() {
  return globalThis[claimKey];
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function ctx(file, id, { hasUI = true, agentKind = "main", sessionInit = false, idle = false } = {}) {
  return {
    hasUI,
    agentKind,
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => id,
      getBranch: () => sessionInit ? [{ type: "session_init" }] : [],
    },
  };
}

let runtimeSerial = 0;
async function loadRuntime() {
  const handlers = new Map();
  let heartbeat = null;
  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
      return pi;
    },
  };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    if (ms === 15000) heartbeat = fn;
    return { unref() {} };
  };
  const mod = await import(`${fixturePath}?runtime=${++runtimeSerial}`);
  mod.default(pi);
  globalThis.setInterval = originalSetInterval;
  return { handlers, pi, heartbeat };
}

delete globalThis[claimKey];

// A fresh interactive root establishes the exact file+id tuple.
const root = await loadRuntime();
const rootCtx = ctx("/sessions/root.jsonl", "root-id");
root.handlers.get("session_start")?.({ reason: "startup" }, rootCtx);
assert(
  JSON.stringify(exactClaim()) === JSON.stringify({
    rootSessionFile: "/sessions/root.jsonl",
    rootSessionId: "root-id",
  }),
  `fresh interactive root did not claim the exact tuple: ${JSON.stringify(exactClaim())}`,
);
assert(root.pi.__test.getLog().length > 0, "fresh interactive root did not publish");

// A top-level but headless session has no exact authority to claim the pane.
const headless = await loadRuntime();
headless.handlers.get("session_start")?.(
  { reason: "startup" },
  ctx("/sessions/headless.jsonl", "headless", { hasUI: false }),
);
assert(exactClaim().rootSessionId === "root-id", "headless session overwrote the root claim");
assert(headless.pi.__test.getLog().length === 0, "headless session published without an exact claim");

// Reloaded extension modules share only the process-global exact claim. Missing
// or explicitly false hasUI must not matter when the live tuple still matches.
let reloadIndex = 0;
for (const hasUI of [undefined, false, undefined, false]) {
  const reloaded = await loadRuntime();
  const reloadCtx = ctx("/sessions/root.jsonl", "root-id", { hasUI });
  if (reloadIndex < 2) {
    reloaded.handlers.get("session_start")?.({ reason: "reload" }, reloadCtx);
  } else {
    reloaded.handlers.get("session_switch")?.(
      { reason: "resume", previousSessionFile: "/sessions/root.jsonl" },
      reloadCtx,
    );
  }
  reloadIndex += 1;
  assert(reloaded.pi.__test.getLog().length > 0, `same-session reload with hasUI=${hasUI} lost root publication`);
  assert(exactClaim().rootSessionId === "root-id", "same-session reload mutated the claim");
  reloaded.heartbeat?.();
  assert(reloaded.pi.__test.getLog().length > 1, "reloaded heartbeat did not preserve publication");
}

// An interactive replacement may move authority, but only for the approved
// startup/new/resume/fork reasons and only to its exact tuple.
let previousFile = "/sessions/root.jsonl";
for (const reason of ["fork", "new", "resume"]) {
  const replacement = await loadRuntime();
  const replacementFile = `/sessions/${reason}.jsonl`;
  const replacementId = `${reason}-id`;
  replacement.handlers.get("session_start")?.(
    { reason, previousSessionFile: previousFile },
    ctx(replacementFile, replacementId),
  );
  assert(
    exactClaim().rootSessionFile === replacementFile && exactClaim().rootSessionId === replacementId,
    `interactive ${reason} did not replace the exact root claim`,
  );
  previousFile = replacementFile;
}

const established = { ...exactClaim() };

// Both child signals are independent hard vetoes. Neither an in-process task
// session nor an ACP/subagent session may publish or overwrite pane authority.
const sessionInitChild = await loadRuntime();
sessionInitChild.handlers.get("session_start")?.(
  { reason: "startup" },
  ctx("/sessions/task-child.jsonl", "task-child", { sessionInit: true }),
);
assert(JSON.stringify(exactClaim()) === JSON.stringify(established), "session_init child overwrote the root claim");
assert(sessionInitChild.pi.__test.getLog().length === 0, "session_init child published root state");

const agentKindChild = await loadRuntime();
agentKindChild.handlers.get("session_start")?.(
  { reason: "startup", agentKind: "sub" },
  ctx("/sessions/acp-child.jsonl", "acp-child", { agentKind: "sub" }),
);
assert(JSON.stringify(exactClaim()) === JSON.stringify(established), "agentKind=sub child overwrote the root claim");
assert(agentKindChild.pi.__test.getLog().length === 0, "agentKind=sub child published root state");

// A reload with a different tuple has no authority even when hasUI is true.
const unclaimedReload = await loadRuntime();
unclaimedReload.handlers.get("session_start")?.(
  { reason: "reload" },
  ctx("/sessions/unclaimed-reload.jsonl", "unclaimed-reload"),
);
assert(JSON.stringify(exactClaim()) === JSON.stringify(established), "reload minted a replacement claim");
assert(unclaimedReload.pi.__test.getLog().length === 0, "unclaimed reload published root state");

console.log("PASS: exact-session process-global root claim survived reloads, replaced only on approved interactive starts, and vetoed child/headless sessions");
MJS

  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "exact-session root-claim lifecycle regressed: $out"
  printf '%s' "$out" | grep -q "^PASS" || fail "exact-session runtime harness did not report PASS: $out"

  cat >"$TMP_ROOT/root-claim-fresh-process.mjs" <<'MJS'
const claim = globalThis[Symbol.for("herdr:omp:root-session-claim:v1")];
if (claim !== undefined) {
  console.error(`FAIL: process-global root claim survived process exit: ${JSON.stringify(claim)}`);
  process.exit(1);
}
console.log("PASS: root claim is absent in a fresh OMP-equivalent process");
MJS
  local fresh_out
  fresh_out=$(bun run "$TMP_ROOT/root-claim-fresh-process.mjs" 2>&1)
  local fresh_rc=$?
  [ "$fresh_rc" -eq 0 ] || fail "stale root claim survived process exit: $fresh_out"
  printf '%s' "$fresh_out" | grep -q "^PASS" || fail "fresh-process claim check did not report PASS: $fresh_out"
  pass "exact-session root claim is process-global, reload-safe, replaceable, and child-safe"
}

test_live_resumed_root_heartbeat_proof() {
  command -v bun >/dev/null 2>&1 \
    || fail "bun is required for the live resumed-root heartbeat proof"

  local fixture="$TMP_ROOT/live-root-runtime.ts"
  local harness="$TMP_ROOT/live-root-harness.mjs"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" || fail "apply for the live resumed-root proof failed"

  cat >"$harness" <<'MJS'
const fixturePath = process.argv[2];
const rootSessionFile = "/sessions/live-resumed-root.jsonl";
const rootSessionId = "live-resumed-root-id";
const reason = "resume";
let idle = false;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function makeRuntime(label) {
  const handlers = new Map();
  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
      return pi;
    },
  };
  return import(`${fixturePath}?live=${label}`).then((mod) => {
    mod.default(pi);
    return { handlers, pi };
  });
}

function makeCtx(hasUI) {
  return {
    hasUI,
    agentKind: "main",
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => rootSessionFile,
      getSessionId: () => rootSessionId,
      getBranch: () => [],
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = await makeRuntime("root");
root.handlers.get("session_start")?.({ reason: "startup" }, makeCtx(true));

// Fresh module instance, same OMP process: only the exact process-global claim
// survives. The resumed session deliberately lacks hasUI authority.
const resumed = await makeRuntime("resumed");
const resumedCtx = makeCtx(false);
resumed.handlers.get("session_start")?.({ reason }, resumedCtx);
resumed.handlers.get("agent_start")?.({}, resumedCtx);
resumed.handlers.get("tool_execution_start")?.({ toolName: "bash" }, resumedCtx);
idle = true;

const proof = [];
function sample(label, elapsedSeconds) {
  const log = resumed.pi.__test.getLog();
  const latest = log[log.length - 1];
  const claim = globalThis[Symbol.for("herdr:omp:root-session-claim:v1")];
  const record = {
    sample: label,
    elapsed_seconds: elapsedSeconds,
    "session_start.reason": reason,
    rootSessionFile: claim?.rootSessionFile,
    rootSessionId: claim?.rootSessionId,
    agent_session: rootSessionFile,
    agent_status: latest?.agentActive ? "working" : "idle",
    focused: true,
    publish_count: log.length,
  };
  assert(record.agent_status !== "idle", `${label} reported Idle during foreground tool execution`);
  assert(record.rootSessionFile === rootSessionFile, `${label} lost the exact root session file`);
  assert(record.rootSessionId === rootSessionId, `${label} lost the exact root session id`);
  proof.push(record);
}

sample("within-one-heartbeat", 0);
let previousPublishCount = resumed.pi.__test.getLog().length;
for (let heartbeat = 1; heartbeat <= 3; heartbeat += 1) {
  await sleep(15050);
  sample(`heartbeat-${heartbeat}`, heartbeat * 15);
  const publishCount = resumed.pi.__test.getLog().length;
  assert(publishCount > previousPublishCount, `heartbeat-${heartbeat} did not force-publish`);
  previousPublishCount = publishCount;
}

console.log(`LIVE_PROOF ${JSON.stringify(proof)}`);
console.log("PASS: resumed root reached non-Idle within one heartbeat and remained non-Idle across three 15-second samples");
MJS

  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "live resumed-root heartbeat proof failed: $out"
  printf '%s\n' "$out"
  printf '%s' "$out" | grep -q "^LIVE_PROOF " || fail "live proof did not capture the required root/status/focus fields"
  printf '%s' "$out" | grep -q "^PASS" || fail "live resumed-root harness did not report PASS"
  pass "live resumed root stays non-Idle through three real 15-second heartbeat samples"
}

test_pristine_check_reports_unpatched
test_apply_enforces_invariant
test_apply_is_idempotent
test_upgrade_from_prior_buggy_heartbeat_converges
test_missing_target_skips_cleanly
test_active_turn_survives_background_job_wait_across_heartbeat
test_exact_session_root_claim_lifecycle
test_live_resumed_root_heartbeat_proof
