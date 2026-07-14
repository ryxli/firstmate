#!/usr/bin/env bash
# fm-patch-herdr-omp.sh - patch the herdr-managed omp status integration to
# self-heal a stuck agent_status.
#
# ROOT CAUSE: extension reload replaces module-local rootSession state. Recovering
# it from ctx.hasUI or inherited HERDR_* environment variables is unsafe because
# nested task/ACP sessions share the pane and inherit those values. A child can
# therefore seize lifecycle publication, while a resumed interactive root can
# remain unbound long enough for Herdr to report false Idle.
#
# The fix stores the exact interactive root {session file, session id} tuple on
# globalThis under a process-wide symbol. That claim survives extension module
# reloads but dies with the OMP process. Every lifecycle publication validates
# the live tuple against the claim. Only interactive startup/new/resume/fork
# events can establish or replace it; reload, session_init, agentKind=sub, and
# headless contexts cannot mint or overwrite authority.
#
# herdr owns this file ("reinstalling or updating overwrites this file"), so we
# cannot fix it upstream and cannot expect edits to survive an update. This
# patch is self-contained and version-shape checked; run it after any herdr
# update to re-apply it.
#
# REGRESSION FIXED HERE: the recovery heartbeat used to re-sample
# ctx.isIdle() on every tick even after rootSession was already true and the
# agent_start/agent_end lifecycle already owned agentActive. During an
# active whiteboard-driven turn ctx.isIdle() can read true, so the heartbeat
# overwrote a correct Working state with false Idle every RESYNC_MS despite
# healthy pane binding and socket. Invariant enforced now: ctx.isIdle() is
# consulted ONLY while recovering a newly reloaded runtime (rootSession
# still false); once activated, the heartbeat force-publishes the retained
# lifecycle state and never re-derives it from ctx.
#
# Idempotent: a second run validates the full patch and no-ops. Safe at bootstrap.
# Usage:
#   fm-patch-herdr-omp.sh           apply if absent (default)
#   fm-patch-herdr-omp.sh --check   exit 0 if applied, 1 if not (no write)
#
#   fm-patch-herdr-omp.sh --restart-required
#       apply despite a loaded OMP marker, then restart every affected OMP pane
#       before relying on the new reporter source.
#   fm-patch-herdr-omp.sh --file <path>   patch a specific integration file
#
# Applying a source patch cannot change an already-loaded OMP extension. The
# default therefore refuses when the capture extension's live marker proves an
# OMP process is running; --restart-required is the explicit, operator-visible
# fallback.
set -u

MARKER="fm-resync-heartbeat"
PATCH_MARKER="fm-resync-heartbeat-lifecycle-invariant"
ROOT_CLAIM_MARKER="fm-exact-root-session-claim-v1"
RESYNC_MS="${FM_HERDR_RESYNC_MS:-15000}"

TARGET="$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts"
MODE=apply
RESTART_REQUIRED=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --restart-required) RESTART_REQUIRED=1 ;;
    --file) shift; TARGET="${1:-}" ;;
    --file=*) TARGET="${1#*=}" ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = apply ] && [ "$RESTART_REQUIRED" -eq 0 ]; then
  LOADED_MARKER="${FM_OMP_LOADED_MARKER:-${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/capture/loaded.json}"
  if [ -f "$LOADED_MARKER" ] && marker_pid=$(python3 - "$LOADED_MARKER" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get("pid")
    print(value if value else "")
except Exception:
    print("")
PY
  ) && [ -n "$marker_pid" ] && kill -0 "$marker_pid" 2>/dev/null; then
    echo "REFUSED: OMP is already loaded (marker pid=$marker_pid); restart OMP panes before applying, or pass --restart-required" >&2
    exit 4
  fi
fi

[ -n "$TARGET" ] || { echo "error: no integration file" >&2; exit 2; }
if [ ! -f "$TARGET" ]; then
  # No integration installed: nothing to patch. Not an error at bootstrap.
  echo "SKIP: no herdr omp integration at $TARGET" >&2
  exit 0
fi

python3 - "$TARGET" "$RESYNC_MS" "$MARKER" "$PATCH_MARKER" "$ROOT_CLAIM_MARKER" "$MODE" <<'PY'
import io, re, sys

path, resync_ms, marker, patch_marker, root_claim_marker, mode = sys.argv[1:7]
src = io.open(path, encoding="utf-8").read()

def is_patched(text: str) -> bool:
    required = [
        patch_marker,
        root_claim_marker,
        'Symbol.for("herdr:omp:root-session-claim:v1")',
        'Symbol.for("herdr:omp:root-session-reporter-loaded:v1")',
        "function exactRootSessionTuple(ctx: any): RootSessionClaim | undefined",
        "function hasRootChildMarker(event: any, ctx: any): boolean",
        "function validateRootSession(event: any, ctx: any): boolean",
        "allowedRootStartReasons.has(effectiveSessionStartSource)",
        "ctx?.hasUI !== true ||",
        "let latestCtx: any | undefined;",
        "function restoreAgentActiveFromCtx(ctx: any = latestCtx): void",
        'pi.on?.("before_agent_start"',
        'activateRootSession(event, ctx, event?.reason || "startup", true)',
        'activateRootSession(event, ctx, event?.reason || "resume", true)',
        "if (!validateRootSession(undefined, ctx))",
        "if (!validateRootSession(undefined, latestCtx)) return;",
        "restoreAgentActiveFromCtx();\n        }\n        publishState(true);",
    ]
    is_patched.missing = [item for item in required if item not in text]
    return not is_patched.missing

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

# Persist the root identity outside the extension module. OMP reloads extension
# modules inside one process, while in-process child sessions load the same
# integration. A Symbol.for key gives reload continuity without crossing a
# process boundary.
if root_claim_marker not in src:
    global_anchor = "export default function"
    if global_anchor not in src:
        sys.stderr.write("error: extension factory not found; integration shape changed\n")
        sys.exit(3)
    global_helper = f'''// {root_claim_marker}: process-local exact root authority.
type RootSessionClaim = {{
  rootSessionFile: string;
  rootSessionId: string;
}};

const rootSessionClaimKey = Symbol.for("herdr:omp:root-session-claim:v1");
const rootSessionReporterLoadKey = Symbol.for("herdr:omp:root-session-reporter-loaded:v1");
const rootSessionModuleReload =
  (globalThis as any)[rootSessionReporterLoadKey] === true;
(globalThis as any)[rootSessionReporterLoadKey] = true;
const allowedRootStartReasons = new Set(["startup", "new", "resume", "fork"]);

function exactRootSessionTuple(ctx: any): RootSessionClaim | undefined {{
  try {{
    const rootSessionFile = ctx?.sessionManager?.getSessionFile?.();
    const rootSessionId = ctx?.sessionManager?.getSessionId?.();
    if (
      typeof rootSessionFile !== "string" ||
      rootSessionFile.length === 0 ||
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0
    ) {{
      return undefined;
    }}
    return {{ rootSessionFile, rootSessionId }};
  }} catch {{
    return undefined;
  }}
}}

function hasRootChildMarker(event: any, ctx: any): boolean {{
  if (event?.agentKind === "sub" || ctx?.agentKind === "sub") {{
    return true;
  }}
  try {{
    const branch = ctx?.sessionManager?.getBranch?.();
    return !Array.isArray(branch) || branch.some((entry: any) => entry?.type === "session_init");
  }} catch {{
    return true;
  }}
}}

function processRootSessionClaim(): RootSessionClaim | undefined {{
  const claim = (globalThis as any)[rootSessionClaimKey];
  if (
    typeof claim?.rootSessionFile !== "string" ||
    typeof claim?.rootSessionId !== "string"
  ) {{
    return undefined;
  }}
  return claim;
}}

function sameRootSessionClaim(
  left: RootSessionClaim | undefined,
  right: RootSessionClaim | undefined,
): boolean {{
  return (
    left !== undefined &&
    right !== undefined &&
    left.rootSessionFile === right.rootSessionFile &&
    left.rootSessionId === right.rootSessionId
  );
}}

'''
    src = src.replace(global_anchor, global_helper + global_anchor, 1)

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

activation_re = re.compile(
    r'  function activateRootSession\(.*?^  \}',
    re.S | re.M,
)
activation = '''  function validateRootSession(event: any, ctx: any): boolean {
    stashLatestCtx(ctx);
    const tuple = exactRootSessionTuple(ctx);
    const valid =
      !hasRootChildMarker(event, ctx) &&
      sameRootSessionClaim(processRootSessionClaim(), tuple);
    rootSession = valid;
    if (valid) {
      updateSessionRef(ctx);
    }
    return valid;
  }

  function activateRootSession(
    event: any,
    ctx: any,
    sessionStartSource = "startup",
    mayClaim = false,
  ): boolean {
    const effectiveSessionStartSource =
      sessionStartSource === "startup" && rootSessionModuleReload
        ? "reload"
        : sessionStartSource;
    if (validateRootSession(event, ctx)) {
      void reportSession(effectiveSessionStartSource);
      return true;
    }

    const tuple = exactRootSessionTuple(ctx);
    const isSameSessionReload =
      effectiveSessionStartSource === "reload" ||
      (effectiveSessionStartSource === "resume" &&
        event?.previousSessionFile === tuple?.rootSessionFile);
    if (
      !mayClaim ||
      !tuple ||
      hasRootChildMarker(event, ctx) ||
      !allowedRootStartReasons.has(effectiveSessionStartSource) ||
      ctx?.hasUI !== true ||
      isSameSessionReload
    ) {
      return false;
    }

    (globalThis as any)[rootSessionClaimKey] = tuple;
    rootSession = true;
    updateSessionRef(ctx);
    void reportSession(effectiveSessionStartSource);
    return true;
  }'''
activation_start = src.find("  function validateRootSession(")
if activation_start == -1:
    activation_start = src.find("  function activateRootSession(")
activation_match = activation_re.search(src, max(activation_start, 0))
if activation_start == -1 or activation_match is None:
    sys.stderr.write("error: activateRootSession function not found; integration shape changed\n")
    sys.exit(3)
src = src[:activation_start] + activation + src[activation_match.end():]

session_start_re = re.compile(
    r'  pi\.on\("session_start", .*?^  \}\);',
    re.S | re.M,
)
session_start_new = '''  pi.on("session_start", (event, ctx) => {
    stashLatestCtx(ctx);
    if (!activateRootSession(event, ctx, event?.reason || "startup", true)) {
      return;
    }
    // A reload can replace this extension mid-run without emitting another agent_start.
    restoreAgentActiveFromCtx(ctx);
    publishState(true);
  });'''
src, session_start_count = session_start_re.subn(session_start_new, src, count=1)
if session_start_count != 1:
    sys.stderr.write("error: session_start handler not found; integration shape changed\n")
    sys.exit(3)

session_switch_re = re.compile(
    r'  pi\.on\("session_switch", .*?^  \}\);',
    re.S | re.M,
)
session_switch_new = '''  pi.on("session_switch", (event, ctx) => {
    stashLatestCtx(ctx);
    if (!activateRootSession(event, ctx, event?.reason || "resume", true)) {
      return;
    }
    resetSessionState();
    restoreAgentActiveFromCtx(ctx);
    publishState(true);
  });'''
src, session_switch_count = session_switch_re.subn(session_switch_new, src, count=1)
if session_switch_count != 1:
    sys.stderr.write("error: session_switch handler not found; integration shape changed\n")
    sys.exit(3)

before_agent_start = '''  pi.on?.("before_agent_start", (_event, ctx) => {
    stashLatestCtx(ctx);
  });

'''
if 'pi.on?.("before_agent_start"' not in src:
    agent_start_anchor = '  pi.on("agent_start", (_event, ctx) => {\n'
    if agent_start_anchor not in src:
        sys.stderr.write("error: agent_start handler not found; integration shape changed\n")
        sys.exit(3)
    src = src.replace(agent_start_anchor, before_agent_start + agent_start_anchor, 1)

agent_start_header = '  pi.on("agent_start", (_event, ctx) => {\n'
agent_start_stashed = agent_start_header + "    stashLatestCtx(ctx);\n"
if agent_start_stashed not in src:
    if agent_start_header not in src:
        sys.stderr.write("error: agent_start handler not found; integration shape changed\n")
        sys.exit(3)
    src = src.replace(agent_start_header, agent_start_stashed, 1)

tool_headers = [
    '  pi.on("tool_approval_requested", (event, ctx) => {\n',
    '  pi.on("tool_approval_resolved", (_event, ctx) => {\n',
    '  pi.on("tool_execution_start", (event, ctx) => {\n',
    '  pi.on("tool_execution_end", (event, ctx) => {\n',
]
for header in tool_headers:
    stashed = header + "    stashLatestCtx(ctx);\n"
    if stashed in src:
        continue
    if header not in src:
        sys.stderr.write("error: tool hook not found; integration shape changed\n")
        sys.exit(3)
    src = src.replace(header, stashed, 1)

legacy_activation_gate = "if (!rootSession && !activateRootSession(ctx))"
if legacy_activation_gate not in src and "if (!validateRootSession(undefined, ctx))" not in src:
    sys.stderr.write("error: lifecycle root activation gates not found; integration shape changed\n")
    sys.exit(3)
src = src.replace(legacy_activation_gate, "if (!validateRootSession(undefined, ctx))")

publish_re = re.compile(
    r'(  function publishState\(force = false\)(?:: [^{]+)? \{\n)'
)
publish_guard = "    if (!rootSession || !validateRootSession(undefined, latestCtx)) return;\n"
if publish_guard not in src:
    src, publish_count = publish_re.subn(
        lambda match: match.group(1) + publish_guard,
        src,
        count=1,
    )
    if publish_count != 1:
        sys.stderr.write("error: publishState handler not found; integration shape changed\n")
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
    f"  // {patch_marker}: exact-claim heartbeat force-publishes retained lifecycle state;\n"
    "  // ctx.isIdle() is consulted only when an already-claimed root runtime reloads.\n"
    "  // The inherited HERDR_* environment and ctx.hasUI are not root identity.\n"
    "  // Every tick validates the live session file+id against the process-global\n"
    "  // claim before publishing. This lets a reloaded root resume while preventing\n"
    "  // in-process task/ACP children from claiming or overwriting pane authority.\n"
    "  // ctx.isIdle() is sampled only when this module-local runtime first recovers\n"
    "  // the exact persisted claim; lifecycle hooks own agentActive after that.\n"
    "  try {\n"
    f"    const __fmResyncMs = {int(resync_ms)};\n"
    "    const __fmResync = setInterval(() => {\n"
    "      try {\n"
    "        if (!enabled()) return;\n"
    "        const __fmWasRootSession = rootSession;\n"
    "        if (!validateRootSession(undefined, latestCtx)) return;\n"
    "        if (!__fmWasRootSession) {\n"
    "          void reportSession(\"fm-reload-resync\");\n"
    "          restoreAgentActiveFromCtx();\n"
    "        }\n"
    "        publishState(true);\n"
    "      } catch (_e) {}\n"
    "    }, __fmResyncMs);\n"
    "    __fmResync.unref?.();\n"
    "  } catch (_e) {}\n"
)

patched = src[:insert_at] + block + src[insert_at:]
if not is_patched(patched):
    sys.stderr.write(f"error: patched integration failed self-check; missing {is_patched.missing!r}\n")
    sys.exit(3)
io.open(path, "w", encoding="utf-8").write(patched)
sys.stderr.write(f"patched: {path} (resync every {resync_ms}ms)\n")
PY
