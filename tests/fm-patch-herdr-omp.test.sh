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
test_patch_check_requires_publish_guard_at_publish_state() {
  local fixture="$TMP_ROOT/missing-publish-guard.ts"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" >/dev/null || fail "initial apply failed"

  python3 - "$fixture" <<'PY' || fail "could not remove the real publishState guard"
import io, re, sys

path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()
guard = "    if (!rootSession || !validateRootSession(undefined, latestCtx)) return;\n"
publish_re = re.compile(
    r'(  function publishState\(force = false\)(?:: [^{]+)? \{\n)'
    + re.escape(guard),
)
src, count = publish_re.subn(r"\1", src, count=1)
if count != 1:
    raise SystemExit(f"expected one publishState guard, removed {count}")
io.open(path, "w", encoding="utf-8").write(src)
PY

  "$PATCHER" --check --file "$fixture" \
    && fail "--check accepted a partially patched file with its publishState guard removed"
  "$PATCHER" --file "$fixture" >/dev/null \
    || fail "apply did not restore a missing publishState guard"
  "$PATCHER" --check --file "$fixture" \
    || fail "--check rejected the repaired publishState guard"

  python3 - "$fixture" <<'PY' || fail "publishState guard was not restored at its actual location"
import io, re, sys

src = io.open(sys.argv[1], encoding="utf-8").read()
guard = "    if (!rootSession || !validateRootSession(undefined, latestCtx)) return;\n"
publish_re = re.compile(
    r'  function publishState\(force = false\)(?:: [^{]+)? \{\n'
    + re.escape(guard),
)
if len(publish_re.findall(src)) != 1:
    raise SystemExit("publishState is not immediately guarded")
PY

  pass "patch integrity check requires the publishState guard instead of heartbeat-only text"
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

test_upgrade_from_actual_parent_7a20f3d() {
  command -v bun >/dev/null 2>&1 \
    || fail "bun is required for the parent patch upgrade regression"

  local fixture="$TMP_ROOT/parent-7a20f3d.ts"
  local harness="$TMP_ROOT/parent-7a20f3d-harness.mjs"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" >/dev/null || fail "current patch apply failed"

  # Replace the current helper with the exact helper emitted by parent
  # commit 7a20f3d. This is the reviewed parent output, not a hand-trimmed
  # approximation, and leaves the rest of the patched integration intact.
  python3 - "$fixture" <<'PY' || fail "could not install the actual parent helper"
import io, re, sys

path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()
parent_helper = '''// fm-exact-root-session-claim-v1: process-local exact root authority.
type RootSessionClaim = {
  rootSessionFile: string;
  rootSessionId: string;
};

const rootSessionClaimKey = Symbol.for("herdr:omp:root-session-claim:v1");
const rootSessionReporterLoadKey = Symbol.for("herdr:omp:root-session-reporter-loaded:v1");
const rootSessionModuleReload =
  (globalThis as any)[rootSessionReporterLoadKey] === true;
(globalThis as any)[rootSessionReporterLoadKey] = true;
const allowedRootStartReasons = new Set(["startup", "new", "resume", "fork"]);

function exactRootSessionTuple(ctx: any): RootSessionClaim | undefined {
  try {
    const rootSessionFile = ctx?.sessionManager?.getSessionFile?.();
    const rootSessionId = ctx?.sessionManager?.getSessionId?.();
    if (
      typeof rootSessionFile !== "string" ||
      rootSessionFile.length === 0 ||
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0
    ) {
      return undefined;
    }
    return { rootSessionFile, rootSessionId };
  } catch {
    return undefined;
  }
}

function hasRootChildMarker(event: any, ctx: any): boolean {
  if (event?.agentKind === "sub" || ctx?.agentKind === "sub") {
    return true;
  }
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    return !Array.isArray(branch) || branch.some((entry: any) => entry?.type === "session_init");
  } catch {
    return true;
  }
}

function processRootSessionClaim(): RootSessionClaim | undefined {
  const claim = (globalThis as any)[rootSessionClaimKey];
  if (
    typeof claim?.rootSessionFile !== "string" ||
    typeof claim?.rootSessionId !== "string"
  ) {
    return undefined;
  }
  return claim;
}

function sameRootSessionClaim(
  left: RootSessionClaim | undefined,
  right: RootSessionClaim | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.rootSessionFile === right.rootSessionFile &&
    left.rootSessionId === right.rootSessionId
  );
}

'''
helper_re = re.compile(
    r'// fm-exact-root-session-claim-v2: process-local exact root authority\.\n'
    r'.*?(?=export default function)',
    re.S,
)
src, count = helper_re.subn(parent_helper, src, count=1)
if count != 1:
    raise SystemExit(f"expected one current helper, replaced {count}")
io.open(path, "w", encoding="utf-8").write(src)
PY

  "$PATCHER" --check --file "$fixture" \
    && fail "--check accepted actual parent 7a20f3d output as current"
  "$PATCHER" --file "$fixture" >/dev/null \
    || fail "upgrade from actual parent 7a20f3d output failed"
  "$PATCHER" --check --file "$fixture" \
    || fail "--check rejected the upgraded parent output"

  grep -q "fm-exact-root-session-claim-v2" "$fixture" \
    || fail "upgrade did not version the root helper marker"
  grep -q "rootSessionFile?: string;" "$fixture" \
    || fail "upgrade did not install the ID-only root helper"

  cat >"$harness" <<'MJS'
const fixturePath = process.argv[2];
const claimKey = Symbol.for("herdr:omp:root-session-claim:v1");
const reporterLoadKey = Symbol.for("herdr:omp:root-session-reporter-loaded:v1");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function ctx(file, id, hasUI = true) {
  return {
    hasUI,
    agentKind: "main",
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => id,
      getBranch: () => [],
    },
  };
}

let serial = 0;
async function loadRuntime() {
  const handlers = new Map();
  const pi = {
    on(event, fn) {
      handlers.set(event, fn);
      return pi;
    },
  };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  const mod = await import(`${fixturePath}?parent-upgrade=${++serial}`);
  mod.default(pi);
  globalThis.setInterval = originalSetInterval;
  return { handlers, pi };
}

const oldFile = "/sessions/parent-before-move.jsonl";
const newFile = "/sessions/parent-after-move.jsonl";
const stableId = "parent-stable-id";
delete globalThis[claimKey];
delete globalThis[reporterLoadKey];

const root = await loadRuntime();
root.handlers.get("session_start")?.({ reason: "startup" }, ctx(oldFile, stableId));
const moved = await loadRuntime();
moved.handlers.get("session_switch")?.(
  { reason: "resume", previousSessionFile: oldFile },
  ctx(newFile, stableId, false),
);
assert(moved.pi.__test.getLog().length > 0, "upgraded parent output lost moved-root publication");
assert(
  globalThis[claimKey]?.rootSessionFile === newFile &&
    globalThis[claimKey]?.rootSessionId === stableId,
  `upgraded parent output kept the wrong moved-root claim: ${JSON.stringify(globalThis[claimKey])}`,
);

delete globalThis[claimKey];
delete globalThis[reporterLoadKey];
const memory = await loadRuntime();
const memoryId = "parent-memory-id";
memory.handlers.get("session_start")?.({ reason: "startup" }, ctx(undefined, memoryId));
assert(memory.pi.__test.getLog().length > 0, "upgraded parent output rejected an ID-only root");
assert(
  globalThis[claimKey]?.rootSessionId === memoryId &&
    globalThis[claimKey]?.rootSessionFile === undefined,
  `upgraded parent output did not retain an ID-only claim: ${JSON.stringify(globalThis[claimKey])}`,
);

console.log("PASS: actual 7a20f3d helper upgraded to stable-ID and ID-only root authority");
MJS

  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "actual parent upgrade runtime regression: $out"
  printf '%s' "$out" | grep -q "^PASS" || fail "actual parent upgrade harness did not report PASS: $out"
  pass "actual 7a20f3d output is detected, upgraded, and runtime-safe"
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
  if (reloadIndex === 1) {
    const oldOwnerPublishCount = root.pi.__test.getLog().length;
    root.heartbeat?.();
    assert(
      root.pi.__test.getLog().length === oldOwnerPublishCount,
      "old reporter heartbeat published after reload ownership transfer",
    );
    assert(
      exactClaim().rootSessionFile === "/sessions/root.jsonl" &&
        exactClaim().rootSessionId === "root-id",
      "old reporter heartbeat changed the claim after reload ownership transfer",
    );
  }
}

// An interactive replacement may move authority, but only for the approved
// startup/new/resume/fork/handoff reasons and only to its exact tuple.
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
// OMP's current root handoff arrives as session_switch(reason=handoff) with a
// new session ID. It must be an allowed lifecycle takeover.
const handoff = await loadRuntime();
const handoffFile = "/sessions/handoff.jsonl";
const handoffId = "handoff-id";
handoff.handlers.get("session_switch")?.(
  { reason: "handoff", previousSessionFile: previousFile },
  ctx(handoffFile, handoffId),
);
assert(
  exactClaim().rootSessionFile === handoffFile &&
    exactClaim().rootSessionId === handoffId,
  `handoff did not replace the root claim: ${JSON.stringify(exactClaim())}`,
);
assert(handoff.pi.__test.getLog().length > 0, "handoff lifecycle did not publish");
previousFile = handoffFile;

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

test_root_move_and_id_only_claims() {
  command -v bun >/dev/null 2>&1 \
    || fail "bun is required for root move and in-memory session regressions"

  local fixture="$TMP_ROOT/root-identity-runtime.ts"
  local harness="$TMP_ROOT/root-identity-harness.mjs"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" || fail "apply for root identity regression fixture failed"

  cat >"$harness" <<'MJS'
const fixturePath = process.argv[2];
const claimKey = Symbol.for("herdr:omp:root-session-claim:v1");
const reporterLoadKey = Symbol.for("herdr:omp:root-session-reporter-loaded:v1");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function ctx(file, id, { hasUI = true, agentKind = "main", sessionInit = false } = {}) {
  const getFile = typeof file === "function" ? file : () => file;
  return {
    hasUI,
    agentKind,
    isIdle: () => false,
    sessionManager: {
      getSessionFile: getFile,
      getSessionId: () => id,
      getBranch: () => sessionInit ? [{ type: "session_init" }] : [],
    },
  };
}

let serial = 0;
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
  const mod = await import(`${fixturePath}?identity=${++serial}`);
  mod.default(pi);
  globalThis.setInterval = originalSetInterval;
  return { handlers, pi, heartbeat };
}

delete globalThis[claimKey];
delete globalThis[reporterLoadKey];

// The root remains the same session when its persisted file moves. The
// resumed context deliberately lacks hasUI, so only the retained session ID
// can preserve authority.
const root = await loadRuntime();
const oldFile = "/sessions/root-before-move.jsonl";
const stableId = "stable-root-id";
const rootCtx = ctx(oldFile, stableId);
root.handlers.get("session_start")?.({ reason: "startup" }, rootCtx);
assert(root.pi.__test.getLog().length > 0, "root did not publish before its file moved");

const moved = await loadRuntime();
const newFile = "/sessions/root-after-move.jsonl";
let movedFile = newFile;
const movedCtx = ctx(() => movedFile, stableId, { hasUI: false });
moved.handlers.get("session_switch")?.(
  { reason: "resume", previousSessionFile: oldFile },
  movedCtx,
);
assert(moved.pi.__test.getLog().length > 0, "moved root lost publication with stable session ID");
assert(
  globalThis[claimKey]?.rootSessionFile === newFile &&
    globalThis[claimKey]?.rootSessionId === stableId,
  `moved root did not refresh the claimed session file: ${JSON.stringify(globalThis[claimKey])}`,
);

// SessionManager.moveTo mutates the live session file without a lifecycle
// event. The current module owns the process claim, so its heartbeat may
// perform the stable-ID transition.
const movedToFile = "/sessions/root-after-moveto.jsonl";
movedFile = movedToFile;
moved.heartbeat?.();
assert(
  globalThis[claimKey]?.rootSessionFile === movedToFile &&
    globalThis[claimKey]?.rootSessionId === stableId,
  `same-module moveTo did not update the claim: ${JSON.stringify(globalThis[claimKey])}`,
);

// The old module still owns an interval and its latest context points at the
// old file. Stable-ID matching is forbidden here, so it cannot reclaim the
// moved root or pass publishState's validation guard.
const oldHeartbeatPublishCount = root.pi.__test.getLog().length;
root.heartbeat?.();
assert(
  globalThis[claimKey]?.rootSessionFile === movedToFile &&
    globalThis[claimKey]?.rootSessionId === stableId,
  `stale old heartbeat reclaimed the moved root: ${JSON.stringify(globalThis[claimKey])}`,
);
assert(
  root.pi.__test.getLog().length === oldHeartbeatPublishCount,
  "stale old heartbeat published after the root file moved",
);

// `omp --no-session` is an interactive in-memory session with an ID but no
// persisted file. It must establish authority and retain it across reload.
delete globalThis[claimKey];
delete globalThis[reporterLoadKey];
const memory = await loadRuntime();
const memoryId = "in-memory-root-id";
const memoryCtx = ctx(undefined, memoryId);
memory.handlers.get("session_start")?.({ reason: "startup" }, memoryCtx);
assert(memory.pi.__test.getLog().length > 0, "id-only interactive session did not publish");
assert(
  globalThis[claimKey]?.rootSessionId === memoryId &&
    globalThis[claimKey]?.rootSessionFile === undefined,
  `id-only session did not establish an ID-only claim: ${JSON.stringify(globalThis[claimKey])}`,
);

const memoryReload = await loadRuntime();
memoryReload.handlers.get("session_start")?.(
  { reason: "resume" },
  ctx(undefined, memoryId, { hasUI: false }),
);
assert(memoryReload.pi.__test.getLog().length > 0, "id-only root lost authority after reload");
assert(
  globalThis[claimKey]?.rootSessionId === memoryId &&
    globalThis[claimKey]?.rootSessionFile === undefined,
  `id-only claim changed during reload: ${JSON.stringify(globalThis[claimKey])}`,
);

console.log("PASS: stable-ID handoff and same-module moveTo survived, while the old interval was blocked and an id-only claim was retained");
MJS

  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || fail "root move or id-only session regression: $out"
  printf '%s' "$out" | grep -q "^PASS" || fail "root identity harness did not report PASS: $out"
  pass "stable-ID handoff and same-module moveTo survive, stale intervals are blocked, and --no-session claims are retained"
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
test_patch_check_requires_publish_guard_at_publish_state
test_apply_is_idempotent
test_upgrade_from_prior_buggy_heartbeat_converges
test_upgrade_from_actual_parent_7a20f3d
test_missing_target_skips_cleanly
test_active_turn_survives_background_job_wait_across_heartbeat
test_exact_session_root_claim_lifecycle
test_live_resumed_root_heartbeat_proof
test_root_move_and_id_only_claims
