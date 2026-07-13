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

  diff "$fresh" "$buggy" >/dev/null \
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
const ctx = { hasUI: true, isIdle: () => idle };

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

test_pristine_check_reports_unpatched
test_apply_enforces_invariant
test_apply_is_idempotent
test_upgrade_from_prior_buggy_heartbeat_converges
test_missing_target_skips_cleanly
test_active_turn_survives_background_job_wait_across_heartbeat
