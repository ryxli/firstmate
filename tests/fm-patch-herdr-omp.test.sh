#!/usr/bin/env bash
# Behavior tests for fm-patch-herdr-omp.sh's aggregate reporter state.
#
# The reporter must preserve two independent invariants:
# 1. A heartbeat may sample ctx.isIdle() only while recovering a freshly
#    reloaded root runtime. Once root lifecycle events own agentActive, every
#    heartbeat republishes retained state without re-deriving it.
# 2. A root agent_end does not make the pane Idle while detached task
#    subagents remain pending or running. Authoritative task lifecycle and
#    progress events maintain an idempotent active-child Set, including
#    progress-based reconstruction after a reporter reload.
#
# The behavioral cases below exercise the generated TypeScript with Bun.
# Source-shape checks separately pin patcher idempotence, prior-patch upgrade,
# and --check behavior.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHER="$ROOT/sbin/fm-patch-herdr-omp.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-patch-herdr-omp.XXXXXX")
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
  sessionRef?: string;
}

type ReporterState = "working" | "idle";

interface PublishRecord {
  force: boolean;
  state: ReporterState;
}

interface TestBackchannel {
  getState: () => ReporterState;
  getLog: () => PublishRecord[];
  getSessionRef: () => string | undefined;
  getSessionReports: () => Array<string | undefined>;
}

interface PiHandle {
  on: (event: string, handler: (event: any, ctx: HeartbeatCtx) => void) => void;
  events: {
    on: (event: string, handler: (event: any) => void) => void;
  };
  __test?: TestBackchannel;
}

export default function register(pi: PiHandle): void {
  let agentActive = false;
  let retryHoldActive = false;
  const publishLog: PublishRecord[] = [];
  let lastState: ReporterState | undefined;
  const calls: string[] = [];
  let sessionRef: string | undefined;
  const sessionReports: Array<string | undefined> = [];

  // Mock lifecycle plumbing: the patched code below invokes each of these
  // by the literal names herdr's real integration uses. They record the
  // call instead of doing real session/timer work - a test seam for the
  // heartbeat invariant, not a reimplementation of herdr.
  function desiredState(): ReporterState {
    if (agentActive || retryHoldActive) {
      return "working";
    }
    return "idle";
  }
  function publishState(force = false): void {
    const state = desiredState();
    if (!force && state === lastState) {
      return;
    }
    lastState = state;
    publishLog.push({ force, state });
  }
  function enabled(): boolean {
    return true;
  }
  function updateSessionRef(ctx: HeartbeatCtx): void {
    sessionRef = ctx?.sessionRef;
    calls.push("updateSessionRef");
  }
  function reportSession(reason?: string): Promise<void> {
    sessionReports.push(sessionRef);
    calls.push(`reportSession:${reason ?? ""}`);
    return Promise.resolve();
  }
  function resetSessionState(): void {
    calls.push("resetSessionState");
    clearPendingTimers();
    clearFailureState();
    agentActive = false;
  }
  function clearPendingTimers(): void {
    calls.push("clearPendingTimers");
  }
  function clearFailureState(): void {
    calls.push("clearFailureState");
  }

  pi.__test = {
    getState: () => desiredState(),
    getLog: () => publishLog,
    getSessionRef: () => sessionRef,
    getSessionReports: () => sessionReports,
  };

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

test_upgrade_from_prior_lifecycle_patch_converges() {
  local fresh="$TMP_ROOT/current-fresh.ts"
  local prior="$TMP_ROOT/prior-lifecycle.ts"
  local upgrade_diff
  write_pristine_fixture "$fresh"
  write_pristine_fixture "$prior"
  "$PATCHER" --file "$fresh" >/dev/null || fail "fresh current apply failed"
  "$PATCHER" --file "$prior" >/dev/null || fail "prior-patch precursor apply failed"

  # Reconstruct the immediately preceding patcher's output: reload/lifecycle
  # heartbeat protection is present, but child aggregation is absent.
  python3 - "$prior" <<'PY'
import io, sys
path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()
src = src.replace("  const activeChildIds = new Set<string>();\n", "", 1)
src = src.replace(
    "    if (agentActive || retryHoldActive || activeChildIds.size > 0) {",
    "    if (agentActive || retryHoldActive) {",
    1,
)
src = src.replace(
    "    clearFailureState();\n    agentActive = false;\n    activeChildIds.clear();\n",
    "    clearFailureState();\n    agentActive = false;\n",
    1,
)
start = src.index("  function setChildActive(id: unknown, active: boolean): void {")
end = src.index('  pi.on("session_start"', start)
src = src[:start] + src[end:]
src = src.replace(
    "fm-resync-heartbeat-child-root-guard-v3",
    "fm-resync-heartbeat-lifecycle-invariant",
    1,
)
io.open(path, "w", encoding="utf-8").write(src)
PY

  "$PATCHER" --check --file "$prior"
  local rc=$?
  [ "$rc" -eq 1 ] || fail "--check on the prior lifecycle-only patch must exit 1, got $rc"
  "$PATCHER" --file "$prior" || fail "upgrade over the prior lifecycle-only patch must succeed"
  "$PATCHER" --check --file "$prior" || fail "--check must pass after upgrading the prior lifecycle-only patch"

  upgrade_diff=$(diff -u "$fresh" "$prior")
  [ -z "$upgrade_diff" ] \
    || fail "upgrading the prior lifecycle-only patch must converge to a fresh apply: $upgrade_diff"
  pass "the prior lifecycle-only patch upgrades in place to child aggregation"
}

test_upgrade_from_unguarded_child_patch_converges() {
  local fresh="$TMP_ROOT/guarded-fresh.ts"
  local prior="$TMP_ROOT/prior-unguarded-child.ts"
  local upgrade_diff
  write_pristine_fixture "$fresh"
  write_pristine_fixture "$prior"
  "$PATCHER" --file "$fresh" >/dev/null || fail "fresh guarded apply failed"
  "$PATCHER" --file "$prior" >/dev/null || fail "unguarded-child precursor apply failed"

  # Reconstruct v2, which tracked children but allowed headless runtimes to
  # claim the pane and processed child events before root activation.
  python3 - "$prior" <<'PY'
import io, sys
path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()
src = src.replace(
    '''    // fm-resync-heartbeat: explicit hasUI=false is a headless child and
    // must never claim the pane; enabled() recovers only omitted hasUI.
    if (ctx?.hasUI === false || (ctx?.hasUI !== true && !enabled())) {''',
    '''    // fm-resync-heartbeat: enabled() proves this is the real herdr pane, so a
    // reload that re-fires session_start without hasUI still recovers turn state.
    if (ctx?.hasUI !== true && !enabled()) {''',
    1,
)
src = src.replace(
    '''  pi.events.on("task:subagent:lifecycle", (data) => {
    if (!rootSession) {
      return;
    }
    const status = data?.status;''',
    '''  pi.events.on("task:subagent:lifecycle", (data) => {
    const status = data?.status;''',
    1,
)
src = src.replace(
    '''  pi.events.on("task:subagent:progress", (data) => {
    if (!rootSession) {
      return;
    }
    const progress = data?.progress;''',
    '''  pi.events.on("task:subagent:progress", (data) => {
    const progress = data?.progress;''',
    1,
)
src = src.replace(
    '''        if (!rootSession) {
          // No observed context cannot identify a root; explicit false is a
          // headless child. Neither may bind or publish from this runtime.
          if (!latestCtx || latestCtx?.hasUI === false) return;
          // Reload dropped activation; re-establish it.''',
    '''        if (!rootSession) {
          // Reload dropped activation; re-establish it.''',
    1,
)
src = src.replace(
    "fm-resync-heartbeat-child-root-guard-v3",
    "fm-resync-heartbeat-child-lifecycle-v2",
    1,
)
io.open(path, "w", encoding="utf-8").write(src)
PY

  "$PATCHER" --check --file "$prior"
  local rc=$?
  [ "$rc" -eq 1 ] || fail "--check on the unguarded child patch must exit 1, got $rc"
  "$PATCHER" --file "$prior" || fail "upgrade over the unguarded child patch must succeed"
  "$PATCHER" --check --file "$prior" || fail "--check must pass after guarding the prior child patch"

  upgrade_diff=$(diff -u "$fresh" "$prior")
  [ -z "$upgrade_diff" ] \
    || fail "upgrading the unguarded child patch must converge to a fresh apply: $upgrade_diff"
  pass "the unguarded child patch upgrades in place to root-session guards"
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
    r'  // fm-resync-heartbeat-child-root-guard-v3:.*?\n  \} catch \(_e\) \{\}\n',
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

  local upgrade_diff
  upgrade_diff=$(diff -u "$fresh" "$buggy")
  [ -z "$upgrade_diff" ] \
    || fail "upgrading a prior-buggy-patched file must converge to a fresh apply: $upgrade_diff"

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

# Execute the generated reporter against a real EventBus-shaped mock. Each case
# gets a fresh module instance so reload reconstruction and Set state cannot
# leak between cases.
RUNTIME_HARNESS="$TMP_ROOT/runtime-harness.mjs"
cat >"$RUNTIME_HARNESS" <<'MJS'
const fixturePath = process.argv[2];
const scenario = process.argv[3];

const handlers = new Map();
const eventHandlers = new Map();
const mockPi = {
  on(event, fn) {
    handlers.set(event, fn);
    return mockPi;
  },
  events: {
    on(event, fn) {
      eventHandlers.set(event, fn);
    },
  },
};

// Capture the heartbeat's setInterval(fn, 15000) without waiting real time.
let heartbeatFn = null;
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  if (ms === 15000) heartbeatFn = fn;
  return { unref: () => {} };
};

const mod = await import(fixturePath);
mod.default(mockPi);
globalThis.setInterval = origSetInterval;

if (!heartbeatFn) {
  throw new Error("heartbeat setInterval(ms=15000) was never registered");
}

let idle = false;
const ctx = { hasUI: true, isIdle: () => idle, sessionRef: "parent-session" };
const state = () => mockPi.__test.getState();
const assertState = (expected, where) => {
  const actual = state();
  if (actual !== expected) {
    throw new Error(`${where}: expected ${expected}, got ${actual}`);
  }
};
const assertSessionRef = (expected, where) => {
  const actual = mockPi.__test.getSessionRef();
  if (actual !== expected) {
    throw new Error(`${where}: expected session ${expected}, got ${actual}`);
  }
};
const rootStart = () => {
  idle = false;
  handlers.get("session_start")?.({}, ctx);
  handlers.get("agent_start")?.({}, ctx);
  assertState("working", "root start");
};
const rootEnd = () => handlers.get("agent_end")?.({});
const lifecycle = (id, status) => {
  const handler = eventHandlers.get("task:subagent:lifecycle");
  if (!handler) throw new Error("task:subagent:lifecycle handler missing");
  handler({ id, status });
};
const progress = (id, status) => {
  const handler = eventHandlers.get("task:subagent:progress");
  if (!handler) throw new Error("task:subagent:progress handler missing");
  handler({ progress: { id, status } });
};
const heartbeat = (expected, tick) => {
  heartbeatFn();
  assertState(expected, `heartbeat ${tick}`);
  const log = mockPi.__test.getLog();
  const last = log[log.length - 1];
  if (!last || last.force !== true || last.state !== expected) {
    throw new Error(`heartbeat ${tick}: expected forced ${expected}, got ${JSON.stringify(last)}`);
  }
};

switch (scenario) {
  case "active-root-heartbeats": {
    rootStart();
    idle = true;
    heartbeat("working", 1);
    heartbeat("working", 2);
    break;
  }
  case "child-heartbeats": {
    rootStart();
    lifecycle("child-a", "started");
    rootEnd();
    assertState("working", "root end with child running");
    heartbeat("working", 1);
    heartbeat("working", 2);
    break;
  }
  case "last-child-idle": {
    rootStart();
    lifecycle("child-a", "started");
    rootEnd();
    lifecycle("child-a", "completed");
    assertState("idle", "last child completed");
    break;
  }
  case "two-child-partial": {
    rootStart();
    lifecycle("child-a", "started");
    lifecycle("child-b", "started");
    rootEnd();
    lifecycle("child-a", "completed");
    assertState("working", "one of two children completed");
    lifecycle("child-b", "completed");
    assertState("idle", "both children completed");
    break;
  }
  case "failed-aborted-cleanup": {
    rootStart();
    lifecycle("child-failed", "started");
    rootEnd();
    lifecycle("child-failed", "failed");
    assertState("idle", "failed child removed");
    lifecycle("child-aborted", "started");
    assertState("working", "aborted child started");
    lifecycle("child-aborted", "aborted");
    assertState("idle", "aborted child removed");
    break;
  }
  case "duplicate-idempotence": {
    rootStart();
    lifecycle("child-a", "started");
    lifecycle("child-a", "started");
    rootEnd();
    lifecycle("child-a", "completed");
    assertState("idle", "one completion clears a duplicate start");
    lifecycle("child-a", "completed");
    assertState("idle", "duplicate completion remains idle");
    break;
  }
  case "progress-reload": {
    idle = true;
    handlers.get("session_start")?.({}, ctx);
    assertState("idle", "reloaded root starts idle");
    progress("child-pending", "pending");
    assertState("working", "pending progress reconstructs child");
    progress("child-pending", "completed");
    assertState("idle", "completed progress removes child");
    progress("child-running", "running");
    assertState("working", "running progress reconstructs child");
    progress("child-running", "failed");
    assertState("idle", "terminal progress removes child");
    break;
  }
  case "no-child-idle": {
    rootStart();
    rootEnd();
    assertState("idle", "ordinary root end");
    heartbeat("idle", 1);
    heartbeat("idle", 2);
    break;
  }
  case "headless-events-ignored": {
    const headlessCtx = {
      hasUI: false,
      isIdle: () => false,
      sessionRef: "child-session",
    };
    lifecycle("child-a", "started");
    progress("child-a", "running");
    handlers.get("session_start")?.({}, headlessCtx);
    handlers.get("agent_start")?.({}, headlessCtx);
    lifecycle("child-b", "started");
    progress("child-b", "pending");
    heartbeatFn();
    if (mockPi.__test.getLog().length !== 0) {
      throw new Error(`headless events published state: ${JSON.stringify(mockPi.__test.getLog())}`);
    }
    assertSessionRef(undefined, "headless events");
    if (mockPi.__test.getSessionReports().length !== 0) {
      throw new Error(`headless events reported a session: ${JSON.stringify(mockPi.__test.getSessionReports())}`);
    }
    break;
  }
  case "parent-session-invariant": {
    rootStart();
    assertSessionRef("parent-session", "root start");
    lifecycle("child-a", "started");
    assertSessionRef("parent-session", "child start");
    rootEnd();
    assertState("working", "root end with child");
    assertSessionRef("parent-session", "root end");
    heartbeat("working", 1);
    assertSessionRef("parent-session", "heartbeat 1");
    heartbeat("working", 2);
    assertSessionRef("parent-session", "heartbeat 2");
    lifecycle("child-a", "completed");
    assertState("idle", "final child completion");
    assertSessionRef("parent-session", "final Idle");
    const reports = mockPi.__test.getSessionReports();
    if (reports.some((ref) => ref !== "parent-session")) {
      throw new Error(`child lifecycle changed reported session refs: ${JSON.stringify(reports)}`);
    }
    break;
  }
  default:
    throw new Error(`unknown scenario: ${scenario}`);
}

console.log(`PASS: ${scenario}`);
MJS

run_runtime_case() {
  local scenario=$1
  local description=$2
  local fixture="$TMP_ROOT/runtime-$scenario.ts"
  local out
  local rc

  command -v bun >/dev/null 2>&1 \
    || fail "bun is required for runtime regressions (CI installs it via oven-sh/setup-bun)"
  write_pristine_fixture "$fixture"
  "$PATCHER" --file "$fixture" >/dev/null \
    || fail "apply for runtime case $scenario failed"
  out=$(bun run "$RUNTIME_HARNESS" "$fixture" "$scenario" 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] || fail "$description: $out"
  printf '%s' "$out" | grep -q "^PASS" || fail "runtime case $scenario did not report PASS: $out"
  pass "$description"
}

test_active_turn_survives_background_job_wait_across_heartbeat() {
  run_runtime_case "active-root-heartbeats" \
    "an open root turn stays Working across 2 heartbeat ticks when ctx.isIdle() reads true"
}

test_child_survives_root_end_across_heartbeat() {
  run_runtime_case "child-heartbeats" \
    "a running child keeps the pane Working after root agent_end across 2 heartbeat ticks"
}

test_last_child_completion_becomes_idle() {
  run_runtime_case "last-child-idle" \
    "the last child completion transitions the aggregate reporter to Idle"
}

test_two_child_partial_completion_stays_working() {
  run_runtime_case "two-child-partial" \
    "one of two child completions keeps the aggregate reporter Working"
}

test_failed_and_aborted_children_are_removed() {
  run_runtime_case "failed-aborted-cleanup" \
    "failed and aborted child lifecycles both clean up aggregate activity"
}

test_duplicate_child_events_are_idempotent() {
  run_runtime_case "duplicate-idempotence" \
    "duplicate lifecycle events are idempotent by child ID"
}

test_progress_reconstructs_children_after_reload() {
  run_runtime_case "progress-reload" \
    "pending and running progress reconstruct child activity after reporter reload"
}

test_ordinary_no_child_path_becomes_idle() {
  run_runtime_case "no-child-idle" \
    "the ordinary no-child root end remains Idle across heartbeat ticks"
}

test_headless_child_events_are_ignored() {
  run_runtime_case "headless-events-ignored" \
    "headless lifecycle and progress events neither publish nor bind a session"
}

test_parent_session_ref_survives_child_lifecycle() {
  run_runtime_case "parent-session-invariant" \
    "the parent session ref survives child start, root end, heartbeats, and final Idle"
}

test_pristine_check_reports_unpatched
test_apply_enforces_invariant
test_apply_is_idempotent
test_upgrade_from_prior_lifecycle_patch_converges
test_upgrade_from_unguarded_child_patch_converges
test_upgrade_from_prior_buggy_heartbeat_converges
test_missing_target_skips_cleanly
test_active_turn_survives_background_job_wait_across_heartbeat
test_child_survives_root_end_across_heartbeat
test_last_child_completion_becomes_idle
test_two_child_partial_completion_stays_working
test_failed_and_aborted_children_are_removed
test_duplicate_child_events_are_idempotent
test_progress_reconstructs_children_after_reload
test_headless_child_events_are_ignored
test_parent_session_ref_survives_child_lifecycle
test_ordinary_no_child_path_becomes_idle
