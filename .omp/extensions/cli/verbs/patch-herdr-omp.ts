// fm verb: patch-herdr-omp - patch the herdr-managed omp status integration to
// self-heal a stuck agent_status.
// Ported behavior-preserving from the former sbin/fm-patch-herdr-omp.sh.
//
// ROOT CAUSE: extension reload replaces module-local rootSession state. Recovering
// it from ctx.hasUI or inherited HERDR_* environment variables is unsafe because
// nested task/ACP sessions share the pane and inherit those values. A child can
// therefore seize lifecycle publication, while a resumed interactive root can
// remain unbound long enough for Herdr to report false Idle.
//
// The fix stores the interactive root identity {session id, optional session
// file} on globalThis under a process-wide symbol. An explicit lifecycle
// handoff may use the stable ID to preserve authority when a session file moves,
// while stale heartbeats and publish validation require exact identity. The
// claim also supports interactive in-memory sessions that have no file and
// survives extension module reloads but dies with the OMP process. A fresh
// process may reacquire an absent claim only through a top-level interactive
// startup event, which OMP emits for --resume with an exact session tuple.
// Only interactive startup/new/resume/fork/handoff events can establish or
// replace it; reload, session_init, agentKind=sub, and headless contexts
// cannot mint or overwrite authority.
//
// LEASE (v5): ownership alone proved too strict. An fm-reload replaces this
// extension module WITHOUT emitting any session lifecycle event, so the fresh
// module never gets an owner-transfer opportunity: the heartbeat requires
// ownership, ownership requires the module-local token, and the token died with
// the old module. The pane's agent label then goes permanently stale in Herdr
// (agent=None/status=unknown) while omp runs fine. The claim therefore carries
// a liveness lease: every successful owner validation re-stamps a timestamp on
// globalThis, and a non-owner module may seize the claim only when its exact
// session tuple matches the claim AND the lease has expired - the previous
// owner is provably dead. A live owner refreshes the lease every heartbeat
// tick and can never be usurped; children, headless, and moved-session stale
// modules remain vetoed because they fail the exact-tuple match or the child
// markers.
//
// herdr owns this file ("reinstalling or updating overwrites this file"), so we
// cannot fix it upstream and cannot expect edits to survive an update. This
// patch is self-contained and version-shape checked; run it after any herdr
// update to re-apply it.
//
// REGRESSION FIXED HERE: the recovery heartbeat used to re-sample
// ctx.isIdle() on every tick even after rootSession was already true and the
// agent_start/agent_end lifecycle already owned agentActive. During an
// active whiteboard-driven turn ctx.isIdle() can read true, so the heartbeat
// overwrote a correct Working state with false Idle every RESYNC_MS despite
// healthy pane binding and socket. Invariant enforced now: ctx.isIdle() is
// consulted ONLY while recovering a newly reloaded runtime (rootSession
// still false); once activated, the heartbeat force-publishes the retained
// lifecycle state and never re-derives it from ctx.
//
// Idempotent: a second run validates the full patch and no-ops. Safe at bootstrap.
// The actual patch logic (version-shape check, marker regexes, and the
// insertion/upgrade transforms) is executed by the identical Python script the
// former shell script embedded; that logic is data, not shell mechanics, and
// is kept byte-for-byte so the patch it produces is unchanged.
//
// Applying a source patch cannot change an already-loaded OMP extension. The
// default therefore refuses when the capture extension's live marker proves an
// OMP process is running; --restart-required is the explicit, operator-visible
// fallback.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MARKER = "fm-resync-heartbeat";
const PATCH_MARKER = "fm-resync-heartbeat-lifecycle-invariant";
const ROOT_CLAIM_MARKER = "fm-exact-root-session-claim-v5";
const SESSION_SHUTDOWN_RELEASE_MARKER = "fm-session-shutdown-release-all";

const HELP = `# fm-patch-herdr-omp.sh - patch the herdr-managed omp status integration to
# self-heal a stuck agent_status.
#
# ROOT CAUSE: extension reload replaces module-local rootSession state. Recovering
# it from ctx.hasUI or inherited HERDR_* environment variables is unsafe because
# nested task/ACP sessions share the pane and inherit those values. A child can
# therefore seize lifecycle publication, while a resumed interactive root can
# remain unbound long enough for Herdr to report false Idle.
#
# The fix stores the interactive root identity {session id, optional session
# file} on globalThis under a process-wide symbol. An explicit lifecycle
# handoff may use the stable ID to preserve authority when a session file moves,
# while stale heartbeats and publish validation require exact identity. The
# claim also supports interactive in-memory sessions that have no file and
# survives extension module reloads but dies with the OMP process. A fresh
# process may reacquire an absent claim only through a top-level interactive
# startup event, which OMP emits for --resume with an exact session tuple.
# Only interactive startup/new/resume/fork/handoff events can establish or
# replace it; reload, session_init, agentKind=sub, and headless contexts
# cannot mint or overwrite authority.
#
# LEASE (v5): ownership alone proved too strict. An fm-reload replaces this
# extension module WITHOUT emitting any session lifecycle event, so the fresh
# module never gets an owner-transfer opportunity: the heartbeat requires
# ownership, ownership requires the module-local token, and the token died with
# the old module. The pane's agent label then goes permanently stale in Herdr
# (agent=None/status=unknown) while omp runs fine. The claim therefore carries
# a liveness lease: every successful owner validation re-stamps a timestamp on
# globalThis, and a non-owner module may seize the claim only when its exact
# session tuple matches the claim AND the lease has expired - the previous
`;

// The upstream integration's version-shape-checked patch transform, ported
// verbatim from the body of sbin/fm-patch-herdr-omp.sh's embedded `python3 -
// ... <<'PY'` heredoc. This is the behavioral ground truth: the regex anchors,
// marker lists, and inserted TypeScript blocks are data specific to herdr's
// upstream file shape, not shell mechanics, so they are kept unchanged and
// run through the same interpreter (python3) the original script used -
// guaranteeing byte-identical patched output rather than a hand-translated
// approximation of Python's regex semantics.
const PATCH_PY = `import io, re, sys

path, resync_ms, marker, patch_marker, root_claim_marker, session_shutdown_release_marker, mode = sys.argv[1:8]
src = io.open(path, encoding="utf-8").read()


# OMP's current SessionShutdownEvent has only a type field; it does not include a
# reason. Keep this intentionally narrow to the vendor helper so older source
# fixtures that predate the helper remain patchable.
session_shutdown_helper_signature_re = re.compile(
    r'function shouldReleaseOnSessionShutdown\\(',
)
session_shutdown_helper_re = re.compile(
    r'(?P<signature>(?P<indent>[ \\t]*)function shouldReleaseOnSessionShutdown\\([^)]*\\)'
    r'(?:\\s*:\\s*[^{\\n]+)?\\s*\\{\\n)'
    r'(?P<body>[^{}]*?)'
    r'(?P<close>\\n(?P=indent)\\})',
)

def has_session_shutdown_release_invariant(text: str) -> bool:
    if session_shutdown_helper_signature_re.search(text) is None:
        return True
    match = session_shutdown_helper_re.search(text)
    if match is None:
        return False
    body = match.group("body")
    return (
        session_shutdown_release_marker in body and
        re.search(r'\\breturn\\s+true\\s*;', body) is not None
    )
publish_state_re = re.compile(
    r'  function publishState\\(force = false\\)(?:: [^{]+)? \\{\\n'
)
publish_guard = "    if (!rootSession || !validateRootSession(undefined, latestCtx)) return;\\n"

def has_publish_guard(text: str) -> bool:
    match = publish_state_re.search(text)
    return match is not None and text.startswith(publish_guard, match.end())

def is_patched(text: str) -> bool:
    required = [
        patch_marker,
        root_claim_marker,
        'Symbol.for("herdr:omp:root-session-claim:v1")',
        'Symbol.for("herdr:omp:root-session-claim-owner:v1")',
        'Symbol.for("herdr:omp:root-session-claim-lease:v1")',
        "function rootSessionLeaseLive(): boolean",
        "const staleOwnerTakeover =",
        "const rootSessionReporterToken = {};",
        "function ownsRootSessionClaim(): boolean",
        "function setRootSessionClaim(claim: RootSessionClaim): void",
        "const effectiveSessionStartSource = sessionStartSource;",
        "function exactRootSessionTuple(ctx: any): RootSessionClaim | undefined",
        "rootSessionFile?: string;",
        "const tuple: RootSessionClaim =",
        "left.rootSessionId === right.rootSessionId",
        "function hasRootChildMarker(event: any, ctx: any): boolean",
        "function validateRootSession(",
        "allowOwnerTransfer = false",
        "sameRootSessionClaim(claim, tuple, allowStableId || claimOwned)",
        'allowedRootStartReasons = new Set(["startup", "new", "resume", "fork", "handoff"])',
        "claimOwned || allowOwnerTransfer || staleOwnerTakeover",
        "ctx?.hasUI !== true ||",
        "let latestCtx: any | undefined;",
        "function restoreAgentActiveFromCtx(ctx: any = latestCtx): void",
        'pi.on?.("before_agent_start"',
        'activateRootSession(event, ctx, event?.reason || "startup", true)',
        'activateRootSession(event, ctx, event?.reason || "resume", true)',
        "if (!validateRootSession(undefined, ctx))",
        "restoreAgentActiveFromCtx();\\n        }\\n        publishState(true);",
    ]
    is_patched.missing = [item for item in required if item not in text]
    if not has_publish_guard(text):
        is_patched.missing.append("publishState guard")
    if not has_session_shutdown_release_invariant(text):
        is_patched.missing.append("session_shutdown release invariant")
    return not is_patched.missing
if mode == "check":
    sys.exit(0 if is_patched(src) else 1)

if is_patched(src):
    sys.stderr.write(f"already patched: {path}\\n")
    sys.exit(0)

# Current OMP session_shutdown events carry no reason and AgentSession.dispose
# emits them only during final process teardown. Release Herdr authority on all
# such events instead of retaining the obsolete reason-equals-quit gate.
if session_shutdown_helper_signature_re.search(src) is not None:
    session_shutdown_match = session_shutdown_helper_re.search(src)
    if session_shutdown_match is None:
        sys.stderr.write("error: shouldReleaseOnSessionShutdown helper shape changed\\n")
        sys.exit(3)
    session_shutdown_indent = session_shutdown_match.group("indent")
    session_shutdown_replacement = (
        session_shutdown_match.group("signature")
        + f"{session_shutdown_indent}  // {session_shutdown_release_marker}: current OMP session_shutdown events carry no reason and are emitted only by final AgentSession.dispose.\\n"
        + f"{session_shutdown_indent}  return true;"
        + session_shutdown_match.group("close")
    )
    src = (
        src[:session_shutdown_match.start()]
        + session_shutdown_replacement
        + src[session_shutdown_match.end():]
    )

# Remove any prior heartbeat block from an older patcher version before inserting
# the current block. This lets the patcher upgrade an already-patched live file.
heartbeat_re = re.compile(
    r'\\n\\n  // ' + re.escape(marker) + r': injected by sbin/fm-patch-herdr-omp\\.sh\\.\\n'
    r'.*?'
    r'^  \\} catch \\(_e\\) \\{\\}\\n',
    re.S | re.M,
)
src = heartbeat_re.sub("", src)

# Persist the root identity outside the extension module. OMP reloads extension
# modules inside one process, while in-process child sessions load the same
# integration. A Symbol.for key gives reload continuity without crossing a
# process boundary.
root_helper_re = re.compile(
    r'// fm-exact-root-session-claim-v(?:1|2|3|4|5): process-local exact root authority\\.\\n'
    r'.*?(?=export default function)',
    re.S,
)
src = root_helper_re.sub("", src)
if root_claim_marker not in src:
    global_anchor = "export default function"
    if global_anchor not in src:
        sys.stderr.write("error: extension factory not found; integration shape changed\\n")
        sys.exit(3)
    global_helper = f'''// {root_claim_marker}: process-local exact root authority.
type RootSessionClaim = {{
  rootSessionFile?: string;
  rootSessionId: string;
}};

const rootSessionClaimKey = Symbol.for("herdr:omp:root-session-claim:v1");
const rootSessionClaimOwnerKey = Symbol.for("herdr:omp:root-session-claim-owner:v1");
const rootSessionClaimLeaseKey = Symbol.for("herdr:omp:root-session-claim-lease:v1");
const rootSessionReporterToken = {{}};
// Three missed owner heartbeats (plus margin) prove the owning module is dead.
const rootSessionLeaseTtlMs = {int(resync_ms) * 3 + 1000};
const allowedRootStartReasons = new Set(["startup", "new", "resume", "fork", "handoff"]);

function rootSessionLeaseLive(): boolean {{
  const stamp = (globalThis as any)[rootSessionClaimLeaseKey];
  return typeof stamp === "number" && Date.now() - stamp < rootSessionLeaseTtlMs;
}}

function exactRootSessionTuple(ctx: any): RootSessionClaim | undefined {{
  try {{
    const rootSessionFile = ctx?.sessionManager?.getSessionFile?.();
    const rootSessionId = ctx?.sessionManager?.getSessionId?.();
    if (
      typeof rootSessionId !== "string" ||
      rootSessionId.length === 0
    ) {{
      return undefined;
    }}
    const tuple: RootSessionClaim =
      typeof rootSessionFile === "string" && rootSessionFile.length > 0
        ? {{ rootSessionFile, rootSessionId }}
        : {{ rootSessionId }};
    return tuple;
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
    typeof claim?.rootSessionId !== "string" ||
    claim.rootSessionId.length === 0 ||
    (claim.rootSessionFile !== undefined &&
      (typeof claim.rootSessionFile !== "string" ||
        claim.rootSessionFile.length === 0))
  ) {{
    return undefined;
  }}
  return claim;
}}

function ownsRootSessionClaim(): boolean {{
  return (globalThis as any)[rootSessionClaimOwnerKey] === rootSessionReporterToken;
}}

function setRootSessionClaim(claim: RootSessionClaim): void {{
  (globalThis as any)[rootSessionClaimKey] = claim;
  (globalThis as any)[rootSessionClaimOwnerKey] = rootSessionReporterToken;
  (globalThis as any)[rootSessionClaimLeaseKey] = Date.now();
}}

function sameRootSessionClaim(
  left: RootSessionClaim | undefined,
  right: RootSessionClaim | undefined,
  allowStableId = false,
): boolean {{
  if (left === undefined || right === undefined) {{
    return false;
  }}
  const exact =
    left.rootSessionId === right.rootSessionId &&
    left.rootSessionFile === right.rootSessionFile;
  return exact || (allowStableId && left.rootSessionId === right.rootSessionId);
}}

'''
    src = src.replace(global_anchor, global_helper + global_anchor, 1)

helper_anchor = "  let rootSession = false;\\n"
helper = (
    "  let rootSession = false;\\n"
    "  let latestCtx: any | undefined;\\n"
    "\\n"
    "  function stashLatestCtx(ctx: any): void {\\n"
    "    if (ctx) latestCtx = ctx;\\n"
    "  }\\n"
    "\\n"
    "  function ctxActiveState(ctx: any): boolean | undefined {\\n"
    "    try {\\n"
    "      const isIdle = ctx?.isIdle?.();\\n"
    "      return typeof isIdle === \\"boolean\\" ? isIdle === false : undefined;\\n"
    "    } catch {\\n"
    "      return undefined;\\n"
    "    }\\n"
    "  }\\n"
    "\\n"
    "  function restoreAgentActiveFromCtx(ctx: any = latestCtx): void {\\n"
    "    stashLatestCtx(ctx);\\n"
    "    const active = ctxActiveState(ctx);\\n"
    "    if (active !== undefined) {\\n"
    "      agentActive = active;\\n"
    "    }\\n"
    "  }\\n"
)
if "let latestCtx: any | undefined;" not in src:
    if helper_anchor not in src:
        sys.stderr.write("error: rootSession declaration not found; integration shape changed\\n")
        sys.exit(3)
    src = src.replace(helper_anchor, helper, 1)

activation_re = re.compile(
    r'  function activateRootSession\\(.*?^  \\}',
    re.S | re.M,
)
activation = '''  function validateRootSession(
    event: any,
    ctx: any,
    allowStableId = false,
    allowOwnerTransfer = false,
  ): boolean {
    stashLatestCtx(ctx);
    const tuple = exactRootSessionTuple(ctx);
    const claim = processRootSessionClaim();
    const claimOwned = ownsRootSessionClaim();
    // A dead owner (expired lease) may be succeeded, but only by the exact
    // same session tuple - never via stable-ID matching or child contexts.
    const staleOwnerTakeover =
      !claimOwned &&
      !rootSessionLeaseLive() &&
      sameRootSessionClaim(claim, tuple, false);
    const valid =
      !hasRootChildMarker(event, ctx) &&
      sameRootSessionClaim(claim, tuple, allowStableId || claimOwned) &&
      (claimOwned || allowOwnerTransfer || staleOwnerTakeover);
    rootSession = valid;
    if (valid) {
      setRootSessionClaim(tuple);
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
    const effectiveSessionStartSource = sessionStartSource;
    const allowStableId =
      mayClaim &&
      allowedRootStartReasons.has(effectiveSessionStartSource);
    const allowOwnerTransfer = mayClaim;
    if (
      validateRootSession(
        event,
        ctx,
        allowStableId,
        allowOwnerTransfer,
      )
    ) {
      void reportSession(effectiveSessionStartSource);
      return true;
    }

    const tuple = exactRootSessionTuple(ctx);
    const claim = processRootSessionClaim();
    const hasMatchingPreviousSessionFile =
      typeof event?.previousSessionFile === "string" &&
      event.previousSessionFile.length > 0 &&
      event.previousSessionFile === tuple?.rootSessionFile;
    // A same-file resume with an existing process claim is a stale reload.
    // A fresh process may mint authority only for an explicit same-file resume.
    const isFreshSameSessionResume =
      effectiveSessionStartSource === "resume" &&
      claim === undefined &&
      hasMatchingPreviousSessionFile;
    const isStaleSameSessionReload =
      effectiveSessionStartSource === "reload" ||
      (effectiveSessionStartSource === "resume" &&
        hasMatchingPreviousSessionFile &&
        claim !== undefined);
    const lacksFreshResumeProof =
      effectiveSessionStartSource === "resume" &&
      claim === undefined &&
      !isFreshSameSessionResume;
    if (
      !mayClaim ||
      !tuple ||
      hasRootChildMarker(event, ctx) ||
      !allowedRootStartReasons.has(effectiveSessionStartSource) ||
      ctx?.hasUI !== true ||
      lacksFreshResumeProof ||
      isStaleSameSessionReload
    ) {
      return false;
    }

    setRootSessionClaim(tuple);
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
    sys.stderr.write("error: activateRootSession function not found; integration shape changed\\n")
    sys.exit(3)
src = src[:activation_start] + activation + src[activation_match.end():]

session_start_re = re.compile(
    r'  pi\\.on\\("session_start", .*?^  \\}\\);',
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
    sys.stderr.write("error: session_start handler not found; integration shape changed\\n")
    sys.exit(3)

session_switch_re = re.compile(
    r'  pi\\.on\\("session_switch", .*?^  \\}\\);',
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
    sys.stderr.write("error: session_switch handler not found; integration shape changed\\n")
    sys.exit(3)

before_agent_start = '''  pi.on?.("before_agent_start", (_event, ctx) => {
    stashLatestCtx(ctx);
  });

'''
if 'pi.on?.("before_agent_start"' not in src:
    agent_start_anchor = '  pi.on("agent_start", (_event, ctx) => {\\n'
    if agent_start_anchor not in src:
        sys.stderr.write("error: agent_start handler not found; integration shape changed\\n")
        sys.exit(3)
    src = src.replace(agent_start_anchor, before_agent_start + agent_start_anchor, 1)

agent_start_header = '  pi.on("agent_start", (_event, ctx) => {\\n'
agent_start_stashed = agent_start_header + "    stashLatestCtx(ctx);\\n"
if agent_start_stashed not in src:
    if agent_start_header not in src:
        sys.stderr.write("error: agent_start handler not found; integration shape changed\\n")
        sys.exit(3)
    src = src.replace(agent_start_header, agent_start_stashed, 1)

tool_headers = [
    '  pi.on("tool_approval_requested", (event, ctx) => {\\n',
    '  pi.on("tool_approval_resolved", (_event, ctx) => {\\n',
    '  pi.on("tool_execution_start", (event, ctx) => {\\n',
    '  pi.on("tool_execution_end", (event, ctx) => {\\n',
]
for header in tool_headers:
    stashed = header + "    stashLatestCtx(ctx);\\n"
    if stashed in src:
        continue
    if header not in src:
        sys.stderr.write("error: tool hook not found; integration shape changed\\n")
        sys.exit(3)
    src = src.replace(header, stashed, 1)

legacy_activation_gate = "if (!rootSession && !activateRootSession(ctx))"
if legacy_activation_gate not in src and "if (!validateRootSession(undefined, ctx))" not in src:
    sys.stderr.write("error: lifecycle root activation gates not found; integration shape changed\\n")
    sys.exit(3)
src = src.replace(legacy_activation_gate, "if (!validateRootSession(undefined, ctx))")

if not has_publish_guard(src):
    src, publish_count = publish_state_re.subn(
        lambda match: match.group(0) + publish_guard,
        src,
        count=1,
    )
    if publish_count != 1:
        sys.stderr.write("error: publishState handler not found; integration shape changed\\n")
        sys.exit(3)

# Find the agent_start handler and the end of its registration call.
start = src.find('pi.on("agent_start"')
if start == -1:
    sys.stderr.write("error: could not locate agent_start handler; integration shape changed\\n")
    sys.exit(3)

# Walk to the matching close of the pi.on(...) call: find "});" after start.
end = src.find("});", start)
if end == -1:
    sys.stderr.write("error: could not locate agent_start handler end\\n")
    sys.exit(3)
insert_at = end + len("});")

block = (
    "\\n\\n"
    f"  // {marker}: injected by sbin/fm-patch-herdr-omp.sh.\\n"
    f"  // {patch_marker}: exact-claim heartbeat force-publishes retained lifecycle state;\\n"
    "  // ctx.isIdle() is consulted only when an already-claimed root runtime reloads.\\n"
    "  // The inherited HERDR_* environment and ctx.hasUI are not root identity.\\n"
    "  // Stable-ID matching is allowed only during an explicit lifecycle handoff.\\n"
    "  // Heartbeats and publish validation require exact identity, so an old\\n"
    "  // module cannot reclaim a moved session's former file. This lets a\\n"
    "  // lifecycle handoff refresh the optional file without stale intervals\\n"
    "  // claiming or overwriting pane authority.\\n"
    "  // A claim whose liveness lease expired (owner module dead, e.g. after\\n"
    "  // an eventless extension reload) may be seized here by the exact same\\n"
    "  // session tuple, restoring publication without any lifecycle event.\\n"
    "  // ctx.isIdle() is sampled only when this module-local runtime first recovers\\n"
    "  // the persisted claim; lifecycle hooks own agentActive after that.\\n"
    "  try {\\n"
    f"    const __fmResyncMs = {int(resync_ms)};\\n"
    "    const __fmResync = setInterval(() => {\\n"
    "      try {\\n"
    "        if (!enabled()) return;\\n"
    "        const __fmWasRootSession = rootSession;\\n"
    "        if (!validateRootSession(undefined, latestCtx)) return;\\n"
    "        if (!__fmWasRootSession) {\\n"
    "          void reportSession(\\"fm-reload-resync\\");\\n"
    "          restoreAgentActiveFromCtx();\\n"
    "        }\\n"
    "        publishState(true);\\n"
    "      } catch (_e) {}\\n"
    "    }, __fmResyncMs);\\n"
    "    __fmResync.unref?.();\\n"
    "  } catch (_e) {}\\n"
)

patched = src[:insert_at] + block + src[insert_at:]
if not is_patched(patched):
    sys.stderr.write(f"error: patched integration failed self-check; missing {is_patched.missing!r}\\n")
    sys.exit(3)
io.open(path, "w", encoding="utf-8").write(patched)
sys.stderr.write(f"patched: {path} (resync every {resync_ms}ms)\\n")
`;

function loadedMarkerPath(home: string): string {
	const explicit = process.env.FM_OMP_LOADED_MARKER;
	if (explicit) return explicit;
	const base = process.env.PI_CODING_AGENT_DIR || join(home, ".omp", "agent");
	return join(base, "capture", "loaded.json");
}

// readMarkerPid(path): the "pid" field of the loaded-marker JSON, coerced to a
// string, or "" on any parse error, missing key, or falsy value - mirroring
// the embedded `json.load(...).get("pid")` + Python truthiness check.
function readMarkerPid(path: string): string {
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
		const pid = data?.pid;
		if (pid === undefined || pid === null || pid === false || pid === 0 || pid === "") return "";
		return String(pid);
	} catch {
		return "";
	}
}

// pidAlive(pidText): true iff pidText parses as a pid and that process can be
// signaled, mirroring `kill -0 "$marker_pid" 2>/dev/null`.
function pidAlive(pidText: string): boolean {
	const pid = Number(pidText);
	if (!Number.isFinite(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const home = process.env.HOME ?? "";
	let target = join(home, ".omp", "agent", "extensions", "herdr-omp-agent-state.ts");
	let mode: "apply" | "check" = "apply";
	let restartRequired = false;

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--check") {
			mode = "check";
		} else if (arg === "--restart-required") {
			restartRequired = true;
		} else if (arg === "--file") {
			i += 1;
			target = args[i] ?? "";
		} else if (arg.startsWith("--file=")) {
			target = arg.slice("--file=".length);
		} else if (arg === "-h" || arg === "--help") {
			process.stdout.write(HELP);
			return 0;
		} else {
			process.stderr.write(`error: unknown argument: ${arg}\n`);
			return 2;
		}
		i += 1;
	}

	if (mode === "apply" && !restartRequired) {
		const markerPath = loadedMarkerPath(home);
		if (existsSync(markerPath)) {
			const markerPid = readMarkerPid(markerPath);
			if (markerPid && pidAlive(markerPid)) {
				process.stderr.write(
					`REFUSED: OMP is already loaded (marker pid=${markerPid}); restart OMP panes before applying, or pass --restart-required\n`,
				);
				return 4;
			}
		}
	}

	if (!target) {
		process.stderr.write("error: no integration file\n");
		return 2;
	}
	if (!existsSync(target)) {
		// No integration installed: nothing to patch. Not an error at bootstrap.
		process.stderr.write(`SKIP: no herdr omp integration at ${target}\n`);
		return 0;
	}

	const resyncMs = process.env.FM_HERDR_RESYNC_MS || "15000";
	const res = spawnSync(
		"python3",
		[
			"-",
			target,
			resyncMs,
			MARKER,
			PATCH_MARKER,
			ROOT_CLAIM_MARKER,
			SESSION_SHUTDOWN_RELEASE_MARKER,
			mode,
		],
		{ input: PATCH_PY, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] },
	);
	if (res.error) {
		process.stderr.write(`error: failed to run python3: ${res.error.message}\n`);
		return 3;
	}
	return res.status ?? 3;
}

export default {
	name: "patch-herdr-omp",
	describe: "Patch the herdr-managed omp status integration to self-heal a stuck agent_status.",
	run,
};
