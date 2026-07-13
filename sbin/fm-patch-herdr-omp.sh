#!/usr/bin/env bash
# fm-patch-herdr-omp.sh - patch the herdr-managed omp status integration to
# self-heal a stuck agent_status.
#
# ROOT CAUSE: the reporter enables ALL status reporting only after
# activateRootSession() sees ctx.hasUI === true (it sets rootSession=true; every
# working/idle publish and the turn/tool hooks are gated on rootSession). A
# long-lived omp session auto-compacts and reloads constantly (measured: one mate
# had 477 compact + 380 reload events in a single session). A reload REPLACES this
# extension runtime, and the re-fired session_start/session_switch does not
# reliably carry hasUI, so activateRootSession() returns early, rootSession stays
# false, and the fresh runtime NEVER reports again. herdr then falls back to idle
# (agent explain: default_known_agent_idle_fallback) for the rest of the session
# while the agent is actively working. A fresh pane works only because it has not
# compacted yet - which is why the bug never reproduces on short test panes.
#
# herdr owns this file ("reinstalling or updating overwrites this file"), so we
# cannot fix it upstream and cannot expect edits to survive an update. Fix: when
# enabled() proves this is a real herdr-managed pane (HERDR_ENV + pane id + socket
# all present), re-establish rootSession, re-report the session ref so herdr
# rebinds the source, and force-publish the true state.
# The patch also stashes the latest ctx from lifecycle/tool hooks so a heartbeat
# or session_switch can recover agentActive from ctx.isIdle() instead of
# publishing a false idle. Self-contained, version-agnostic; run after any herdr
# update to re-apply it.
#
# Idempotent: a second run validates the full patch and no-ops. Safe at bootstrap.
#
# Usage:
#   fm-patch-herdr-omp.sh           apply if absent (default)
#   fm-patch-herdr-omp.sh --check   exit 0 if applied, 1 if not (no write)
#   fm-patch-herdr-omp.sh --file <path>   patch a specific integration file
set -u

MARKER="fm-resync-heartbeat"
PATCH_MARKER="fm-resync-heartbeat-ctx-resync"
RESYNC_MS="${FM_HERDR_RESYNC_MS:-15000}"

TARGET="$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts"
MODE=apply
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --file) shift; TARGET="${1:-}" ;;
    --file=*) TARGET="${1#*=}" ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$TARGET" ] || { echo "error: no integration file" >&2; exit 2; }
if [ ! -f "$TARGET" ]; then
  # No integration installed: nothing to patch. Not an error at bootstrap.
  echo "SKIP: no herdr omp integration at $TARGET" >&2
  exit 0
fi

python3 - "$TARGET" "$RESYNC_MS" "$MARKER" "$PATCH_MARKER" "$MODE" <<'PY'
import io, re, sys

path, resync_ms, marker, patch_marker, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
src = io.open(path, encoding="utf-8").read()

def is_patched(text: str) -> bool:
    required = [
        patch_marker,
        "ctx?.hasUI !== true && !enabled()",
        "let latestCtx: any | undefined;",
        "function stashLatestCtx(ctx: any): void",
        "function restoreAgentActiveFromCtx(ctx: any = latestCtx): void",
        'pi.on?.("before_agent_start"',
        "resetSessionState();\n    restoreAgentActiveFromCtx(ctx);\n    publishState(true);",
        "if (latestCtx) updateSessionRef(latestCtx);",
        "restoreAgentActiveFromCtx();\n        publishState(true);",
        "stashLatestCtx(ctx);\n    if (!rootSession && !activateRootSession(ctx))",
    ]
    return all(item in text for item in required)

if mode == "check":
    sys.exit(0 if is_patched(src) else 1)

if is_patched(src):
    sys.stderr.write(f"already patched: {path}\n")
    sys.exit(0)

# Remove any prior heartbeat block from an older patcher version before inserting
# the current block. This lets the patcher upgrade an already-patched live file.
heartbeat_re = re.compile(
    r'\n\n  // ' + re.escape(marker) + r': injected by sbin/fm-patch-herdr-omp\.sh\.\n'
    r'.*?'
    r'^  \} catch \(_e\) \{\}\n',
    re.S | re.M,
)
src = heartbeat_re.sub("", src)

# Root fix: on a reload the re-fired session_start does not reliably carry
# hasUI. A real herdr-managed pane is proven by enabled() (HERDR_ENV + pane id +
# socket), so recover on enabled() too.
gate_old = ('function activateRootSession(ctx: any, sessionStartSource = "startup"): boolean {\n'
            '    if (ctx?.hasUI !== true) {')
gate_new = ('function activateRootSession(ctx: any, sessionStartSource = "startup"): boolean {\n'
            '    stashLatestCtx(ctx);\n'
            '    // fm-resync-heartbeat: enabled() proves this is the real herdr pane, so a\n'
            '    // reload that re-fires session_start without hasUI still recovers turn state.\n'
            '    if (ctx?.hasUI !== true && !enabled()) {')
gate_old_with_comment = ('function activateRootSession(ctx: any, sessionStartSource = "startup"): boolean {\n'
                         '    // fm-resync-heartbeat: enabled() proves this is the real herdr pane, so a\n'
                         '    // reload that re-fires session_start without hasUI still recovers turn state.\n'
                         '    if (ctx?.hasUI !== true && !enabled()) {')
gate_new_with_comment = ('function activateRootSession(ctx: any, sessionStartSource = "startup"): boolean {\n'
                         '    stashLatestCtx(ctx);\n'
                         '    // fm-resync-heartbeat: enabled() proves this is the real herdr pane, so a\n'
                         '    // reload that re-fires session_start without hasUI still recovers turn state.\n'
                         '    if (ctx?.hasUI !== true && !enabled()) {')
if gate_old in src:
    src = src.replace(gate_old, gate_new, 1)
elif gate_old_with_comment in src:
    src = src.replace(gate_old_with_comment, gate_new_with_comment, 1)
elif "ctx?.hasUI !== true && !enabled()" not in src or "stashLatestCtx(ctx);" not in src:
    sys.stderr.write("error: activateRootSession hasUI gate not found; integration shape changed\n")
    sys.exit(3)

helper_anchor = "  let rootSession = false;\n"
helper = (
    "  let rootSession = false;\n"
    "  let latestCtx: any | undefined;\n"
    "\n"
    "  function stashLatestCtx(ctx: any): void {\n"
    "    if (ctx) latestCtx = ctx;\n"
    "  }\n"
    "\n"
    "  function ctxActiveState(ctx: any): boolean | undefined {\n"
    "    try {\n"
    "      const isIdle = ctx?.isIdle?.();\n"
    "      return typeof isIdle === \"boolean\" ? isIdle === false : undefined;\n"
    "    } catch {\n"
    "      return undefined;\n"
    "    }\n"
    "  }\n"
    "\n"
    "  function restoreAgentActiveFromCtx(ctx: any = latestCtx): void {\n"
    "    stashLatestCtx(ctx);\n"
    "    const active = ctxActiveState(ctx);\n"
    "    if (active !== undefined) {\n"
    "      agentActive = active;\n"
    "    }\n"
    "  }\n"
)
if "let latestCtx: any | undefined;" not in src:
    if helper_anchor not in src:
        sys.stderr.write("error: rootSession declaration not found; integration shape changed\n")
        sys.exit(3)
    src = src.replace(helper_anchor, helper, 1)

session_start_old = '''  pi.on("session_start", (_event, ctx) => {
    if (!activateRootSession(ctx)) {
      return;
    }
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });'''
session_start_new = '''  pi.on("session_start", (_event, ctx) => {
    stashLatestCtx(ctx);
    if (!activateRootSession(ctx)) {
      return;
    }
    // A reload can replace this extension mid-run without emitting another agent_start.
    restoreAgentActiveFromCtx(ctx);
    publishState(true);
  });'''
if session_start_old in src:
    src = src.replace(session_start_old, session_start_new, 1)
elif session_start_new not in src:
    sys.stderr.write("error: session_start handler not found; integration shape changed\n")
    sys.exit(3)

session_switch_old = '''  pi.on("session_switch", (event, ctx) => {
    if (!activateRootSession(ctx, event?.reason || "resume")) {
      return;
    }
    resetSessionState();
    publishState(true);
  });'''
session_switch_new = '''  pi.on("session_switch", (event, ctx) => {
    stashLatestCtx(ctx);
    if (!activateRootSession(ctx, event?.reason || "resume")) {
      return;
    }
    resetSessionState();
    restoreAgentActiveFromCtx(ctx);
    publishState(true);
  });'''
if session_switch_old in src:
    src = src.replace(session_switch_old, session_switch_new, 1)
elif session_switch_new not in src:
    sys.stderr.write("error: session_switch handler not found; integration shape changed\n")
    sys.exit(3)

agent_start_old = '''  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession();
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });'''
agent_start_new = '''  pi.on?.("before_agent_start", (_event, ctx) => {
    stashLatestCtx(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    stashLatestCtx(ctx);
    if (!rootSession && !activateRootSession(ctx)) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession();
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });'''
if agent_start_old in src:
    src = src.replace(agent_start_old, agent_start_new, 1)
elif agent_start_new not in src:
    sys.stderr.write("error: agent_start handler not found; integration shape changed\n")
    sys.exit(3)

tool_replacements = [
    ('''  pi.on("tool_approval_requested", (event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) {''',
     '''  pi.on("tool_approval_requested", (event, ctx) => {
    stashLatestCtx(ctx);
    if (!rootSession && !activateRootSession(ctx)) {'''),
    ('''  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (!rootSession && !activateRootSession(ctx)) {''',
     '''  pi.on("tool_approval_resolved", (_event, ctx) => {
    stashLatestCtx(ctx);
    if (!rootSession && !activateRootSession(ctx)) {'''),
    ('''  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName !== "ask") {''',
     '''  pi.on("tool_execution_start", (event, ctx) => {
    stashLatestCtx(ctx);
    if (event?.toolName !== "ask") {'''),
    ('''  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName !== "ask") {''',
     '''  pi.on("tool_execution_end", (event, ctx) => {
    stashLatestCtx(ctx);
    if (event?.toolName !== "ask") {'''),
]
for old, new in tool_replacements:
    if old in src:
        src = src.replace(old, new, 1)
    elif new not in src:
        sys.stderr.write("error: tool hook not found; integration shape changed\n")
        sys.exit(3)

# Find the agent_start handler and the end of its registration call.
start = src.find('pi.on("agent_start"')
if start == -1:
    sys.stderr.write("error: could not locate agent_start handler; integration shape changed\n")
    sys.exit(3)

# Walk to the matching close of the pi.on(...) call: find "});" after start.
end = src.find("});", start)
if end == -1:
    sys.stderr.write("error: could not locate agent_start handler end\n")
    sys.exit(3)
insert_at = end + len("});")

block = (
    "\n\n"
    f"  // {marker}: injected by sbin/fm-patch-herdr-omp.sh.\n"
    f"  // {patch_marker}: heartbeat also restores agentActive from the latest ctx.\n"
    "  // ROOT CAUSE this fixes: the reporter enables state reporting only after\n"
    "  // activateRootSession() sees ctx.hasUI === true. A long-lived omp session\n"
    "  // auto-compacts / reloads many times (observed hundreds of times per mate),\n"
    "  // and a reload replaces this extension runtime; the re-fired session event\n"
    "  // does not reliably carry hasUI, so rootSession stays false and the reporter\n"
    "  // goes permanently silent - herdr then falls back to idle for the rest of\n"
    "  // the session even while the agent is actively working. A fresh session\n"
    "  // works only because it has not compacted yet.\n"
    "  // Fix: enabled() already proves this is a real herdr-managed pane (HERDR_ENV\n"
    "  // + pane id + socket are all present), which is the same fact hasUI was a\n"
    "  // proxy for. The latest ctx lets reload/session_switch/heartbeat recover\n"
    "  // agentActive from ctx.isIdle(), not from stale local defaults.\n"
    "  try {\n"
    f"    const __fmResyncMs = {int(resync_ms)};\n"
    "    const __fmResync = setInterval(() => {\n"
    "      try {\n"
    "        if (!enabled()) return;\n"
    "        if (!rootSession) {\n"
    "          // Reload dropped activation; re-establish it. Report the session\n"
    "          // ref so herdr rebinds this source, then resume publishing.\n"
    "          rootSession = true;\n"
    "          if (latestCtx) updateSessionRef(latestCtx);\n"
    "          void reportSession(\"fm-reload-resync\");\n"
    "        }\n"
    "        restoreAgentActiveFromCtx();\n"
    "        publishState(true);\n"
    "      } catch (_e) {}\n"
    "    }, __fmResyncMs);\n"
    "    __fmResync.unref?.();\n"
    "  } catch (_e) {}\n"
)

patched = src[:insert_at] + block + src[insert_at:]
if not is_patched(patched):
    sys.stderr.write("error: patched integration failed self-check\n")
    sys.exit(3)
io.open(path, "w", encoding="utf-8").write(patched)
sys.stderr.write(f"patched: {path} (resync every {resync_ms}ms)\n")
PY
