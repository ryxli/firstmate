#!/usr/bin/env bash
# Focused contract tests for the atomic OMP-to-Herdr lifecycle fence.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHER=("$ROOT/sbin/fm" patch-herdr-omp)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-patch-herdr-omp.XXXXXX")
export HOME="$TMP_ROOT/home"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

write_pristine_fixture() {
  cat >"$1" <<'TS'
// HERDR_INTEGRATION_VERSION=6
// @ts-nocheck
let requestQueue = Promise.resolve();
let reportSeq = globalThis.__reportSeq ?? 0;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;
function nextReportSeq() { return ++reportSeq; }
function updateSessionRef(ctx: any) {
  currentAgentSessionPath = ctx?.sessionManager?.getSessionFile?.();
  currentAgentSessionId = ctx?.sessionManager?.getSessionId?.();
}
function currentSessionRef() {
  return currentAgentSessionPath ? { agent_session_path: currentAgentSessionPath } : currentAgentSessionId ? { agent_session_id: currentAgentSessionId } : undefined;
}
async function sendRequestAttempt(request: any, _timeoutMs: number): Promise<boolean> {
  if (globalThis.__holdRequest) await globalThis.__holdRequest;
  globalThis.__calls.push(request);
  return true;
}
async function sendRequestNow(request: any): Promise<void> {
  if (await sendRequestAttempt(request, 500)) return;
  await sendRequestAttempt(request, 1500);
}
function sendRequest(request: any): Promise<void> {
  requestQueue = requestQueue.then(() => sendRequestNow(request), () => sendRequestNow(request));
  return requestQueue;
}
type AgentState = "working" | "blocked" | "idle";
type QueuedState = { state: AgentState; message?: string; seq: number };
function reportSession(sessionStartSource = "startup"): Promise<void> {
  return sendRequest({ id: `herdr:omp:session:${Date.now()}`, method: "pane.report_agent_session", params: { pane_id: "fixture", source: "herdr:omp", agent: "omp", seq: nextReportSeq(), session_start_source: sessionStartSource, ...currentSessionRef() } });
}
function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  return sendRequest({ id: `herdr:omp:${Date.now()}`, method: "pane.report_agent", params: { pane_id: "fixture", source: "herdr:omp", agent: "omp", state, message, seq, ...currentSessionRef() } });
}
function releaseAgent(): Promise<void> {
  return sendRequest({ id: `herdr:omp:release:${Date.now()}`, method: "pane.release_agent", params: { pane_id: "fixture", source: "herdr:omp", agent: "omp", seq: nextReportSeq() } });
}
function shouldReleaseOnSessionShutdown(event: any): boolean {
  return event.reason === "quit";
}
let sendInFlight = false;
let queuedState: QueuedState | undefined;
function queueState(state: AgentState, message?: string): void {
  queuedState = { state, message, seq: nextReportSeq() };
  if (!sendInFlight) void drainStateQueue();
}
async function drainStateQueue(): Promise<void> {
  if (sendInFlight) return;
  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) void drainStateQueue();
  }
}
export default function register(pi: any) {
  let agentActive = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let rootSession = false;
  function enabled() { return true; }
  function clearPendingTimers() { if (idleTimer) clearTimeout(idleTimer); if (retryTimer) clearTimeout(retryTimer); idleTimer = undefined; retryTimer = undefined; }
  function clearFailureState() {}
  function publishState(force = false) {
    queueState(agentActive ? "working" : "idle");
  }
  function resetSessionState() { clearPendingTimers(); agentActive = false; }
  function activateRootSession(ctx: any, sessionStartSource = "startup"): boolean {
    if (ctx?.hasUI !== true) return false;
    rootSession = true;
    updateSessionRef(ctx);
    void reportSession(sessionStartSource);
    return true;
  }
  pi.__test = { queueLate: () => queueState("working"), calls: () => globalThis.__calls };
  pi.on("session_start", (_event, ctx) => {
    if (!activateRootSession(ctx)) return;
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });
  pi.on("session_switch", (event, ctx) => {
    if (!activateRootSession(ctx, event?.reason || "resume")) return;
    resetSessionState();
    publishState(true);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
    updateSessionRef(ctx);
    void reportSession();
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });
  pi.on("agent_end", (event) => {
    if (!rootSession) return;
    agentActive = false;
    idleTimer = setTimeout(() => publishState(), 1);
  });
  pi.on("session_shutdown", async (event) => {
    if (shouldReleaseOnSessionShutdown(event)) await releaseAgent();
  });
  pi.on("tool_approval_requested", (event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
  });
  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) return;
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName !== "ask") return;
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName !== "ask") return;
  });
}
TS
}

test_apply_and_idempotence() {
  local fixture="$TMP_ROOT/fixture.ts"
  write_pristine_fixture "$fixture"
  "${PATCHER[@]}" --check --file "$fixture"
  [ "$?" -eq 1 ] || fail "--check accepted an unpatched integration"
  "${PATCHER[@]}" --file "$fixture" || fail "patch apply failed"
  "${PATCHER[@]}" --check --file "$fixture" || fail "--check rejected terminal-fenced integration"
  grep -q 'fm-terminal-lifecycle-fence-v1' "$fixture" || fail "terminal fence marker missing"
  ! grep -q 'fm-resync-heartbeat: injected' "$fixture" || fail "15-second heartbeat remained"
  local before out
  before=$(cat "$fixture")
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 0 ] || fail "repeat apply failed"
  printf '%s' "$out" | grep -q 'already patched' || fail "repeat apply was not a no-op"
  [ "$(cat "$fixture")" = "$before" ] || fail "repeat apply changed terminal-fenced integration"
  pass "patch is idempotent and removes periodic state publication"
}

test_unsupported_versions_and_shapes_fail_closed() {
  local fixture before out version
  for version in 5 4; do
    fixture="$TMP_ROOT/v${version}.ts"
    write_pristine_fixture "$fixture"
    python3 - "$fixture" "$version" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(path.read_text().replace("HERDR_INTEGRATION_VERSION=6", f"HERDR_INTEGRATION_VERSION={sys.argv[2]}", 1))
PY
    before="$TMP_ROOT/v${version}.before"
    cp "$fixture" "$before"
    out=$("${PATCHER[@]}" --check --file "$fixture" 2>&1)
    [ "$?" -eq 3 ] || fail "v${version} --check did not fail closed: $out"
    printf '%s' "$out" | grep -q "unsupported Herdr OMP integration version: v${version}" || fail "v${version} --check did not name unsupported version: $out"
    cmp -s "$fixture" "$before" || fail "v${version} --check mutated the integration"
    out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
    [ "$?" -eq 3 ] || fail "v${version} apply did not fail closed: $out"
    printf '%s' "$out" | grep -q "unsupported Herdr OMP integration version: v${version}" || fail "v${version} apply did not name unsupported version: $out"
    cmp -s "$fixture" "$before" || fail "v${version} apply mutated the integration"
  done

  fixture="$TMP_ROOT/duplicate-version.ts"
  write_pristine_fixture "$fixture"
  printf '// HERDR_INTEGRATION_VERSION=7\n' >>"$fixture"
  before="$TMP_ROOT/duplicate-version.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --check --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "duplicate version --check did not fail closed: $out"
  printf '%s' "$out" | grep -q 'declaration must appear exactly once' || fail "duplicate version --check did not identify contradictory declarations: $out"
  cmp -s "$fixture" "$before" || fail "duplicate version --check mutated the integration"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "duplicate version apply did not fail closed: $out"
  printf '%s' "$out" | grep -q 'declaration must appear exactly once' || fail "duplicate version apply did not identify contradictory declarations: $out"
  cmp -s "$fixture" "$before" || fail "duplicate version apply mutated the integration"

  fixture="$TMP_ROOT/missing-version.ts"
  write_pristine_fixture "$fixture"
  python3 - "$fixture" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(path.read_text().replace("// HERDR_INTEGRATION_VERSION=6\n", "", 1))
PY
  before="$TMP_ROOT/missing-version.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "missing version apply did not fail closed: $out"
  printf '%s' "$out" | grep -q 'unsupported Herdr OMP integration version: missing declaration' || fail "missing version did not report its unsupported shape: $out"
  cmp -s "$fixture" "$before" || fail "missing version apply mutated the integration"
  fixture="$TMP_ROOT/template-only-version.ts"
  write_pristine_fixture "$fixture"
  python3 - "$fixture" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
src = path.read_text().replace("// HERDR_INTEGRATION_VERSION=6\n", "", 1)
path.write_text('const fakeVersion = `\\n// HERDR_INTEGRATION_VERSION=6\\n`;\\n' + src)
PY
  before="$TMP_ROOT/template-only-version.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --check --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "template-only version declaration passed --check: $out"
  printf '%s' "$out" | grep -q 'missing declaration' || fail "template-only version declaration did not report missing declaration: $out"
  cmp -s "$fixture" "$before" || fail "template-only version declaration --check mutated the integration"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "template-only version declaration apply did not fail closed: $out"
  cmp -s "$fixture" "$before" || fail "template-only version declaration apply mutated the integration"

  fixture="$TMP_ROOT/malformed-v6.ts"
  printf '// HERDR_INTEGRATION_VERSION=6\nexport default function register(pi: any) {}\n' >"$fixture"
  before="$TMP_ROOT/malformed-v6.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "malformed v6 apply did not fail closed: $out"
  printf '%s' "$out" | grep -q 'integration shape changed' || fail "malformed v6 did not report its invalid shape: $out"
  cmp -s "$fixture" "$before" || fail "malformed v6 apply mutated the integration"

  fixture="$TMP_ROOT/v6-without-shutdown-helper.ts"
  write_pristine_fixture "$fixture"
  python3 - "$fixture" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
src, count = re.subn(
    r'function shouldReleaseOnSessionShutdown\(event: any\): boolean \{\n  return event\.reason === "quit";\n\}\n',
    '',
    path.read_text(),
    count=1,
)
if count != 1:
    raise SystemExit("could not remove v6 session shutdown helper")
path.write_text(src)
PY
  before="$TMP_ROOT/v6-without-shutdown-helper.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "v6 without shutdown helper did not fail closed: $out"
  printf '%s' "$out" | grep -q 'shouldReleaseOnSessionShutdown helper not found exactly once' || fail "v6 without shutdown helper did not report its invalid shape: $out"
  cmp -s "$fixture" "$before" || fail "v6 without shutdown helper was mutated"

  fixture="$TMP_ROOT/v6-duplicate-shutdown-helper.ts"
  write_pristine_fixture "$fixture"
  printf '\nfunction shouldReleaseOnSessionShutdown(\n' >>"$fixture"
  before="$TMP_ROOT/v6-duplicate-shutdown-helper.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "v6 with duplicate shutdown helper signature did not fail closed: $out"
  printf '%s' "$out" | grep -q 'shouldReleaseOnSessionShutdown helper not found exactly once' || fail "v6 with duplicate shutdown helper did not report its invalid shape: $out"
  cmp -s "$fixture" "$before" || fail "v6 with duplicate shutdown helper was mutated"

  fixture="$TMP_ROOT/patched-v6-duplicate-shutdown-helper.ts"
  write_pristine_fixture "$fixture"
  "${PATCHER[@]}" --file "$fixture" >/dev/null || fail "baseline v6 patch failed before duplicate-helper check"
  printf '\nfunction shouldReleaseOnSessionShutdown(\n' >>"$fixture"
  before="$TMP_ROOT/patched-v6-duplicate-shutdown-helper.before"
  cp "$fixture" "$before"
  out=$("${PATCHER[@]}" --check --file "$fixture" 2>&1)
  [ "$?" -eq 1 ] || fail "patched v6 with duplicate shutdown helper passed --check: $out"
  cmp -s "$fixture" "$before" || fail "patched v6 duplicate helper --check mutated the integration"
  out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
  [ "$?" -eq 3 ] || fail "patched v6 duplicate shutdown helper apply did not fail closed: $out"
  printf '%s' "$out" | grep -q 'shouldReleaseOnSessionShutdown helper not found exactly once' || fail "patched v6 duplicate helper did not report its invalid shape: $out"
  cmp -s "$fixture" "$before" || fail "patched v6 duplicate helper apply mutated the integration"
  local duplicate_style
  for duplicate_style in spaces newlines no-space-comments; do
    fixture="$TMP_ROOT/v6-duplicate-${duplicate_style}.ts"
    write_pristine_fixture "$fixture"
    python3 - "$fixture" "$duplicate_style" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
style = sys.argv[2]
suffix = {
    "spaces": "\nfunction  shouldReleaseOnSessionShutdown (event: any): boolean { return false; }\n",
    "newlines": "\nfunction\nshouldReleaseOnSessionShutdown\n(\nevent: any\n): boolean { return false; }\n",
    "no-space-comments": "\nfunction/**/shouldReleaseOnSessionShutdown/**/(event: any): boolean { return false; }\n",
}[style]
path.write_text(path.read_text() + suffix)
PY
    before="$TMP_ROOT/v6-duplicate-${duplicate_style}.before"
    cp "$fixture" "$before"
    out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
    [ "$?" -eq 3 ] || fail "unpatched v6 ${duplicate_style} duplicate helper did not fail closed: $out"
    printf '%s' "$out" | grep -q 'shouldReleaseOnSessionShutdown helper not found exactly once' || fail "unpatched v6 ${duplicate_style} duplicate helper did not report its invalid shape: $out"
    cmp -s "$fixture" "$before" || fail "unpatched v6 ${duplicate_style} duplicate helper was mutated"

    fixture="$TMP_ROOT/patched-v6-duplicate-${duplicate_style}.ts"
    write_pristine_fixture "$fixture"
    "${PATCHER[@]}" --file "$fixture" >/dev/null || fail "baseline v6 patch failed before ${duplicate_style} duplicate-helper check"
    python3 - "$fixture" "$duplicate_style" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
style = sys.argv[2]
suffix = {
    "spaces": "\nfunction  shouldReleaseOnSessionShutdown (event: any): boolean { return false; }\n",
    "newlines": "\nfunction\nshouldReleaseOnSessionShutdown\n(\nevent: any\n): boolean { return false; }\n",
    "no-space-comments": "\nfunction/**/shouldReleaseOnSessionShutdown/**/(event: any): boolean { return false; }\n",
}[style]
path.write_text(path.read_text() + suffix)
PY
    before="$TMP_ROOT/patched-v6-duplicate-${duplicate_style}.before"
    cp "$fixture" "$before"
    out=$("${PATCHER[@]}" --check --file "$fixture" 2>&1)
    [ "$?" -eq 1 ] || fail "patched v6 ${duplicate_style} duplicate helper passed --check: $out"
    cmp -s "$fixture" "$before" || fail "patched v6 ${duplicate_style} duplicate helper --check mutated the integration"
    out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
    [ "$?" -eq 3 ] || fail "patched v6 ${duplicate_style} duplicate helper apply did not fail closed: $out"
    printf '%s' "$out" | grep -q 'shouldReleaseOnSessionShutdown helper not found exactly once' || fail "patched v6 ${duplicate_style} duplicate helper did not report its invalid shape: $out"
    cmp -s "$fixture" "$before" || fail "patched v6 ${duplicate_style} duplicate helper apply mutated the integration"
  done
  for fixture_state in unpatched patched; do
    fixture="$TMP_ROOT/${fixture_state}-v6-nested-template-duplicate.ts"
    write_pristine_fixture "$fixture"
    if [ "$fixture_state" = patched ]; then
      "${PATCHER[@]}" --file "$fixture" >/dev/null || fail "baseline v6 patch failed before nested-template duplicate check"
    fi
    python3 - "$fixture" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
canonical = '''function shouldReleaseOnSessionShutdown(event: any): boolean {
  return event.reason === "quit";
}
'''
suffix = '''const outer = `${`{`}`;
function/**/shouldReleaseOnSessionShutdown/**/(event: any): boolean { return false; }
'''
src = path.read_text()
path.write_text(src.replace(canonical, canonical + suffix, 1) if canonical in src else src + suffix)
PY
    before="$TMP_ROOT/${fixture_state}-v6-nested-template-duplicate.before"
    cp "$fixture" "$before"
    if [ "$fixture_state" = unpatched ]; then
      out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
      [ "$?" -eq 3 ] || fail "unpatched nested-template duplicate helper did not fail closed: $out"
      printf '%s' "$out" | grep -q 'shouldReleaseOnSessionShutdown helper not found exactly once' || fail "unpatched nested-template duplicate helper did not report its invalid shape: $out"
      cmp -s "$fixture" "$before" || fail "unpatched nested-template duplicate helper was mutated"
    else
      out=$("${PATCHER[@]}" --check --file "$fixture" 2>&1)
      [ "$?" -eq 1 ] || fail "patched nested-template duplicate helper passed --check: $out"
      cmp -s "$fixture" "$before" || fail "patched nested-template duplicate helper --check mutated the integration"
      out=$("${PATCHER[@]}" --file "$fixture" 2>&1)
      [ "$?" -eq 3 ] || fail "patched nested-template duplicate helper apply did not fail closed: $out"
      cmp -s "$fixture" "$before" || fail "patched nested-template duplicate helper apply mutated the integration"
    fi
  done
  pass "v5 and older versions plus missing or malformed v6 shapes fail closed without mutation"
}

test_native_v7_is_healthy_noop() {
  local incomplete="$TMP_ROOT/v7-incomplete.ts"
  local v7="$TMP_ROOT/v7.ts"
  write_pristine_fixture "$incomplete"
  python3 - "$incomplete" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(path.read_text().replace("HERDR_INTEGRATION_VERSION=6", "HERDR_INTEGRATION_VERSION=7", 1))
PY
  local incomplete_before="$TMP_ROOT/v7-incomplete.before"
  cp "$incomplete" "$incomplete_before"
  local out
  out=$("${PATCHER[@]}" --file "$incomplete" 2>&1)
  [ "$?" -eq 3 ] || fail "v7 without native lifecycle shape did not fail closed: $out"
  printf '%s' "$out" | grep -q 'unsupported native terminal lifecycle shape' || fail "v7 without native shape did not identify the missing lifecycle: $out"
  cmp -s "$incomplete" "$incomplete_before" || fail "v7 without native lifecycle shape was mutated"

  local near_shape="$TMP_ROOT/v7-near-shape.ts"
  write_pristine_fixture "$near_shape"
  python3 - "$near_shape" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
src = path.read_text().replace("HERDR_INTEGRATION_VERSION=6", "HERDR_INTEGRATION_VERSION=7", 1)
old = '''  pi.on("session_shutdown", async (event) => {
    if (shouldReleaseOnSessionShutdown(event)) await releaseAgent();
  });'''
near_shape = '''  let shutdownFenced = false;
  function fenceShutdown(): Promise<void> {
    // shutdownFenced = true; return releaseAgent();
    const fakeNativeFenceText = "shutdownFenced = true; return releaseAgent();";
    function fakeNestedFence(): Promise<void> {
      shutdownFenced = true;
      return releaseAgent();
    }
    if (shutdownFenced) return Promise.resolve();
    return Promise.resolve();
  }
  pi.on("session_shutdown", async (event, ctx) => {
    await fenceShutdown();
  });'''
if old not in src:
    raise SystemExit("could not build near-shape native v7 fixture")
path.write_text(src.replace(old, near_shape, 1))
PY
  local near_shape_before="$TMP_ROOT/v7-near-shape.before"
  cp "$near_shape" "$near_shape_before"
  out=$("${PATCHER[@]}" --file "$near_shape" 2>&1)
  [ "$?" -eq 3 ] || fail "fake v7 fence did not fail closed: $out"
  printf '%s' "$out" | grep -q 'unsupported native terminal lifecycle shape' || fail "fake v7 fence did not identify its invalid lifecycle: $out"
  cmp -s "$near_shape" "$near_shape_before" || fail "fake v7 fence was mutated"

  write_pristine_fixture "$v7"
  python3 - "$v7" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
src = path.read_text().replace("HERDR_INTEGRATION_VERSION=6", "HERDR_INTEGRATION_VERSION=7", 1)
old = '''  pi.on("session_shutdown", async (event) => {
    if (shouldReleaseOnSessionShutdown(event)) await releaseAgent();
  });'''
native = '''  let shutdownFenced = false;
  function fenceShutdown(): Promise<void> {
    if (shutdownFenced) return Promise.resolve();
    shutdownFenced = true;
    return releaseAgent();
  }
  pi.on("session_shutdown", async (event, ctx) => {
    await fenceShutdown();
  });'''
if old not in src:
    raise SystemExit("could not build native v7 lifecycle fixture")
path.write_text(src.replace(old, native, 1))
PY
  python3 - "$v7" "$TMP_ROOT" <<'PY'
import pathlib, sys
healthy = pathlib.Path(sys.argv[1]).read_text()
root = pathlib.Path(sys.argv[2])
native = '''  let shutdownFenced = false;
  function fenceShutdown(): Promise<void> {
    if (shutdownFenced) return Promise.resolve();
    shutdownFenced = true;
    return releaseAgent();
  }
  pi.on("session_shutdown", async (event, ctx) => {
    await fenceShutdown();
  });'''
unused = '''function unusedNativeTerminalLifecycle(pi: any) {
  let shutdownFenced = false;
  function fenceShutdown(): Promise<void> {
    shutdownFenced = true;
    return releaseAgent();
  }
  pi.on("session_shutdown", async (event, ctx) => {
    await fenceShutdown();
  });
}'''
template_only = '''  const nestedFake = `${`
  function fenceShutdown(): Promise<void> {
    shutdownFenced = true;
    return releaseAgent();
  }
  pi.on("session_shutdown", async (event, ctx) => {
    await fenceShutdown();
  });
`}`;'''
variants = {
    "module-unused-wrapper": healthy.replace(native, "  // native lifecycle exists only in the unused module wrapper", 1).replace("export default", unused + "\nexport default", 1),
    "labeled-false-fence": healthy.replace("shutdownFenced = true;", "notReached: if (false) shutdownFenced = true;", 1),
    "labeled-false-release": healthy.replace("return releaseAgent();", "notReached: if (false) return releaseAgent();", 1),
    "labeled-false-handler": healthy.replace("await fenceShutdown();", "notReached: if (false) await fenceShutdown();", 1),
    "unbraced-false-fence": healthy.replace("shutdownFenced = true;", "if (false) shutdownFenced = true;", 1),
    "unbraced-false-release": healthy.replace("return releaseAgent();", "if (false) return releaseAgent();", 1),
    "unbraced-false-handler": healthy.replace("await fenceShutdown();", "if (false) await fenceShutdown();", 1),
    "nested-template-fake": healthy.replace(native, template_only, 1),
}
for name, source in variants.items():
    (root / f"v7-{name}.ts").write_text(source)
PY
  local malformed_native before_variant
  for malformed_native in \
    module-unused-wrapper \
    labeled-false-fence labeled-false-release labeled-false-handler \
    unbraced-false-fence unbraced-false-release unbraced-false-handler \
    nested-template-fake; do
    before_variant="$TMP_ROOT/v7-${malformed_native}.before"
    cp "$TMP_ROOT/v7-${malformed_native}.ts" "$before_variant"
    out=$("${PATCHER[@]}" --file "$TMP_ROOT/v7-${malformed_native}.ts" 2>&1)
    [ "$?" -eq 3 ] || fail "v7 ${malformed_native} lifecycle lookalike did not fail closed: $out"
    printf '%s' "$out" | grep -q 'unsupported native terminal lifecycle shape' || fail "v7 ${malformed_native} did not identify the invalid lifecycle: $out"
    cmp -s "$TMP_ROOT/v7-${malformed_native}.ts" "$before_variant" || fail "v7 ${malformed_native} lifecycle lookalike was mutated"
  done
  local before out
  before="$TMP_ROOT/v7.before"
  cp "$v7" "$before"
  mkdir -p "$HOME/.omp/agent/capture"
  printf '{"pid":"%s"}\n' "$$" >"$HOME/.omp/agent/capture/loaded.json"
  "${PATCHER[@]}" --check --file "$v7" || fail "native v7 terminal lifecycle did not pass --check"
  "${PATCHER[@]}" --file "$v7" || fail "native v7 lifecycle refused because a live marker existed"
  cmp -s "$v7" "$before" || fail "patcher modified a native v7 lifecycle"
  pass "native v7 terminal lifecycle is healthy without firstmate patching"
}

test_terminal_fence_runtime() {
  command -v bun >/dev/null 2>&1 || fail "bun is required"
  local fixture="$TMP_ROOT/runtime.ts"
  local harness="$TMP_ROOT/runtime.mjs"
  write_pristine_fixture "$fixture"
  "${PATCHER[@]}" --file "$fixture" >/dev/null || fail "runtime fixture patch failed"
  cat >"$harness" <<'MJS'
const fixturePath = process.argv[2];
globalThis.__calls = [];
const register = async (suffix) => {
  const handlers = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); return pi; } };
  const mod = await import(`${fixturePath}?${suffix}`);
  mod.default(pi);
  return { pi, handlers };
};
let intervals = 0;
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { intervals += 1; return originalSetInterval(...args); };
const owner = await register("owner");
globalThis.setInterval = originalSetInterval;
const ctx = (id, kind = "main", file = id) => ({
  hasUI: true,
  isIdle: () => false,
  agentKind: kind,
  sessionManager: {
    getSessionFile: () => `/sessions/${file}.jsonl`,
    getSessionId: () => id,
    getBranch: () => kind === "sub" ? [{ type: "session_init" }] : [],
  },
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let releaseHeld;
globalThis.__holdRequest = new Promise((resolve) => { releaseHeld = resolve; });
const terminal = ctx("terminal");
owner.handlers.get("session_start")?.({ reason: "startup" }, terminal);
owner.pi.__test.queueLate();
await flush();
const beforeHandoff = globalThis.__calls.length;
const replacement = await register("replacement");
replacement.handlers.get("before_agent_start")?.({ reason: "handoff" }, terminal);
replacement.handlers.get("agent_start")?.({ reason: "handoff" }, terminal);
const movedTerminal = ctx("terminal", "main", "terminal-moved");
replacement.handlers.get("session_switch")?.({ reason: "resume" }, movedTerminal);
await flush();
await owner.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, terminal);
if (globalThis.__calls.some((call) => call.method === "pane.release_agent")) throw new Error(`stale owner released after handoff: ${JSON.stringify(globalThis.__calls)}`);
const child = await register("child");
child.handlers.get("session_start")?.({ reason: "startup", agentKind: "sub" }, ctx("event-child"));
const branchChild = ctx("branch-child");
branchChild.sessionManager.getBranch = () => [{ type: "session_init" }];
child.handlers.get("session_start")?.({ reason: "startup" }, branchChild);
await child.handlers.get("session_shutdown")?.({ type: "session_shutdown", agentKind: "sub" }, ctx("event-child"));
if (globalThis.__calls.some((call) => call.method === "pane.release_agent")) throw new Error(`independent child marker released: ${JSON.stringify(globalThis.__calls)}`);
const direct = await register("direct-shutdown-handoff");
const terminalShutdown = direct.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, movedTerminal);
releaseHeld();
globalThis.__holdRequest = undefined;
await terminalShutdown;
await flush();
if (intervals !== 0) throw new Error(`periodic publication installed ${intervals} interval(s)`);
const releases = globalThis.__calls.filter((call) => call.method === "pane.release_agent");
if (releases.length !== 1 || globalThis.__calls.at(-1) !== releases[0]) throw new Error(`release was not final and unique: ${JSON.stringify(globalThis.__calls)}`);
const dispatch = globalThis[Symbol.for("herdr:omp:root-session-dispatch:v1")];
const maxSeq = Math.max(...globalThis.__calls.map((call) => call.seq ?? call.params?.seq));
if (
  releases[0].params.seq !== maxSeq ||
  releases[0].params.seq !== dispatch.seq ||
  globalThis.__calls.length <= beforeHandoff
) throw new Error(`held queue did not end in the maximal terminal release: ${JSON.stringify(globalThis.__calls)}`);
const afterRelease = globalThis.__calls.length;
const postTerminal = await register("post-terminal");
postTerminal.handlers.get("session_start")?.({ reason: "resume", previousSessionFile: "/sessions/terminal-moved.jsonl" }, movedTerminal);
postTerminal.handlers.get("agent_start")?.({}, movedTerminal);
postTerminal.pi.__test.queueLate();
const thirdTerminal = ctx("terminal", "main", "terminal-third");
postTerminal.handlers.get("session_switch")?.({ reason: "resume", previousSessionFile: "/sessions/terminal-moved.jsonl" }, thirdTerminal);
postTerminal.handlers.get("agent_start")?.({}, thirdTerminal);
await Bun.sleep(20);
await flush();
if (globalThis.__calls.length !== afterRelease) throw new Error(`fresh import or late hook resurrected registration: ${JSON.stringify(globalThis.__calls)}`);
console.log(`PASS: held old queue, direct shutdown handoff, stable-ID path transition and third-path terminal rejection, child vetoes, unique maximal terminal release, zero late publication, zero periodic reports`);
MJS
  cat >"$TMP_ROOT/fresh-child.mjs" <<'MJS'
const fixturePath = process.argv[2];
globalThis.__reportSeq = 1_700_000_000_000_000;
globalThis.__calls = [];
const handlers = new Map();
const pi = { on(event, handler) { handlers.set(event, handler); return pi; } };
const mod = await import(fixturePath);
mod.default(pi);
const ctx = {
  hasUI: true,
  isIdle: () => false,
  agentKind: "main",
  sessionManager: { getSessionFile: () => "/sessions/fresh.jsonl", getSessionId: () => "fresh", getBranch: () => [] },
};
handlers.get("session_start")?.({ reason: "startup" }, ctx);
await Promise.resolve();
await Promise.resolve();
if (!globalThis.__calls.some((call) => call.method === "pane.report_agent_session" && call.params?.seq > 1_700_000_000_000_000)) throw new Error(`fresh child process did not register with a timestamp-scale seq: ${JSON.stringify(globalThis.__calls)}`);
console.log("PASS: fresh Bun child process registers");
MJS
  cat >"$TMP_ROOT/owned-switches.mjs" <<'MJS'
const fixturePath = process.argv[2];
globalThis.__calls = [];
const handlers = new Map();
const pi = { on(event, handler) { handlers.set(event, handler); return pi; } };
const mod = await import(fixturePath);
mod.default(pi);
const ctx = (id) => ({
  hasUI: true,
  isIdle: () => false,
  agentKind: "main",
  sessionManager: { getSessionFile: () => `/sessions/${id}.jsonl`, getSessionId: () => id, getBranch: () => [] },
});
handlers.get("session_start")?.({ reason: "startup" }, ctx("old"));
await Bun.sleep(100);
let previousId = "old";
for (const reason of ["new", "fork", "handoff", "resume"]) {
  const before = globalThis.__calls.length;
  let releaseHeld;
  globalThis.__holdRequest = new Promise((resolve) => { releaseHeld = resolve; });
  pi.__test.queueLate();
  await Promise.resolve();
  handlers.get("agent_start")?.({ reason: "resume" }, ctx(previousId));
  const nextId = `switch-${reason}`;
  handlers.get("session_switch")?.({ reason }, ctx(nextId));
  releaseHeld();
  globalThis.__holdRequest = undefined;
  await Bun.sleep(30);
  const dispatched = globalThis.__calls.slice(before);
  if (dispatched.filter((call) => call.method === "pane.report_agent_session" && call.params?.session_start_source === reason).length !== 1) {
    throw new Error(`owned ${reason} switch did not emit exactly one session report: ${JSON.stringify(dispatched)}`);
  }
  const oldGeneration = dispatched.filter((call) => call.params?.agent_session_path === `/sessions/${previousId}.jsonl`);
  if (oldGeneration.some((call) => call.method === "pane.report_agent_session" && call.params?.session_start_source === "startup")) {
    throw new Error(`queued ${previousId} agent-start report dispatched after ${reason}: ${JSON.stringify(dispatched)}`);
  }
  previousId = nextId;
}
console.log("PASS: owned new/fork/handoff/resume switches supersede IDs and suppress old queued generation");
MJS
  cat >"$TMP_ROOT/eventless-reload-switches.mjs" <<'MJS'
const fixturePath = process.argv[2];
globalThis.__calls = [];
const register = async (suffix) => {
  const handlers = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); return pi; } };
  const mod = await import(`${fixturePath}?eventless-${suffix}`);
  mod.default(pi);
  return { handlers };
};
const ctx = (id) => ({
  hasUI: true,
  isIdle: () => false,
  agentKind: "main",
  sessionManager: { getSessionFile: () => `/sessions/${id}.jsonl`, getSessionId: () => id, getBranch: () => [] },
});
let previousId = "eventless-old";
const owner = await register("owner");
owner.handlers.get("session_start")?.({ reason: "startup" }, ctx(previousId));
await Bun.sleep(30);
for (const reason of ["new", "fork", "handoff", "resume"]) {
  const replacement = await register(reason);
  const nextId = `eventless-${reason}`;
  const before = globalThis.__calls.length;
  replacement.handlers.get("session_switch")?.(
    { reason, previousSessionFile: `/sessions/${previousId}.jsonl` },
    ctx(nextId),
  );
  await Bun.sleep(30);
  const reports = globalThis.__calls.slice(before).filter(
    (call) =>
      call.method === "pane.report_agent_session" &&
      call.params?.session_start_source === reason &&
      call.params?.agent_session_path === `/sessions/${nextId}.jsonl`,
  );
  if (reports.length !== 1) {
    throw new Error(`eventless reload ${reason} did not supersede ${previousId}: ${JSON.stringify(globalThis.__calls)}`);
  }
  previousId = nextId;
}
console.log("PASS: eventless reloads supersede lineage-proven new/fork/handoff/resume session switches");
MJS
  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  [ "$?" -eq 0 ] || fail "terminal fence runtime failed: $out"
  printf '%s' "$out" | grep -q '^PASS:' || fail "terminal fence runtime did not report PASS: $out"
  out=$(bun run "$TMP_ROOT/fresh-child.mjs" "$fixture" 2>&1)
  [ "$?" -eq 0 ] || fail "fresh Bun child runtime failed: $out"
  printf '%s' "$out" | grep -q '^PASS: fresh Bun child process registers$' || fail "fresh Bun child did not report registration: $out"
  out=$(bun run "$TMP_ROOT/owned-switches.mjs" "$fixture" 2>&1)
  [ "$?" -eq 0 ] || fail "owned session switches runtime failed: $out"
  printf '%s' "$out" | grep -q '^PASS: owned new/fork/handoff/resume switches supersede IDs and suppress old queued generation$' || fail "owned session switches runtime did not report PASS: $out"
  out=$(bun run "$TMP_ROOT/eventless-reload-switches.mjs" "$fixture" 2>&1)
  [ "$?" -eq 0 ] || fail "eventless reload session switches runtime failed: $out"
  printf '%s' "$out" | grep -q '^PASS: eventless reloads supersede lineage-proven new/fork/handoff/resume session switches$' || fail "eventless reload session switches did not report PASS: $out"
  pass "session shutdown fences terminal tuples and queued work while current owners can switch to new, fork, handoff, or resume identities"
}
test_deployed_integration_copy() {
  command -v bun >/dev/null 2>&1 || fail "bun is required"
  local fixture="$TMP_ROOT/deployed-v6.ts"
  local harness="$TMP_ROOT/deployed-v6.mjs"
  write_pristine_fixture "$fixture"
  "${PATCHER[@]}" --check --file "$fixture"
  [ "$?" -eq 1 ] || fail "deployed v6 copy unexpectedly passed --check before patch"
  "${PATCHER[@]}" --file "$fixture" >/dev/null || fail "deployed v6 copy patch failed"
  "${PATCHER[@]}" --check --file "$fixture" || fail "deployed v6 copy failed --check after patch"
  local before
  before=$(cat "$fixture")
  "${PATCHER[@]}" --file "$fixture" >/dev/null || fail "deployed v6 copy repeat patch failed"
  [ "$(cat "$fixture")" = "$before" ] || fail "deployed v6 copy repeat patch changed output"
  cat >"$harness" <<'MJS'
const fixture = process.argv[2];
globalThis.__calls = [];
const handlers = new Map();
const pi = {
  on(name, handler) { handlers.set(name, handler); return pi; },
  events: { on() {} },
};
const mod = await import(`${fixture}?deployed-copy`);
mod.default(pi);
const ctx = {
  hasUI: true,
  isIdle: () => false,
  agentKind: "main",
  sessionManager: {
    getSessionFile: () => "/sessions/deployed.jsonl",
    getSessionId: () => "deployed",
    getBranch: () => [],
  },
};
handlers.get("session_start")?.({ reason: "startup" }, ctx);
await Bun.sleep(25);
await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
await Bun.sleep(25);
const requests = globalThis.__calls;
const methods = requests.map((request) => request.method);
if (!methods.includes("pane.report_agent_session") || !methods.includes("pane.report_agent") || !methods.includes("pane.release_agent")) {
  throw new Error(`compact deployed v6 fixture did not send real lifecycle methods: ${JSON.stringify(requests)}`);
}
const seqs = requests.map((request) => request.params?.seq);
if (!seqs.every(Number.isSafeInteger) || !seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])) {
  throw new Error(`compact deployed v6 fixture did not send monotonic params.seq: ${JSON.stringify(requests)}`);
}
console.log("PASS: compact deployed v6 fixture imports and sends real monotonic lifecycle methods");
MJS
  local out
  out=$(bun run "$harness" "$fixture" 2>&1)
  [ "$?" -eq 0 ] || fail "compact deployed v6 runtime failed: $out"
  printf '%s' "$out" | grep -q '^PASS: compact deployed v6 fixture imports and sends real monotonic lifecycle methods$' || fail "compact deployed v6 runtime did not report PASS: $out"
  pass "compact deployed v6 fixture patches, checks, imports, and sends real methods"
}


test_apply_and_idempotence
test_unsupported_versions_and_shapes_fail_closed
test_terminal_fence_runtime
test_deployed_integration_copy
test_native_v7_is_healthy_noop
