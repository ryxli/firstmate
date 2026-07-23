// fm verb: patch-herdr-omp - apply the v6 OMP terminal-lifecycle fence.
//
// Herdr v6 needs a process-local exact-session owner and terminal tombstone so
// shutdown releases once, late hooks cannot republish, and a fresh process can
// register anew. Herdr v7+ must own that lifecycle natively.
// The patch is version-shape checked and idempotent.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const LEGACY_HEARTBEAT_MARKER = "fm-resync-heartbeat";
const PATCH_MARKER = "fm-terminal-lifecycle-fence-v1";
const ROOT_CLAIM_MARKER = "fm-exact-root-session-claim-v6";
const SESSION_SHUTDOWN_RELEASE_MARKER = "fm-session-shutdown-release-all";

const HELP = `# patch-herdr-omp
#
# Fences Herdr v6 OMP lifecycle publication at session shutdown.
# Herdr v7+ is a healthy no-op only with a native terminal lifecycle shape.
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

path, marker, patch_marker, root_claim_marker, session_shutdown_release_marker, mode = sys.argv[1:7]
src = io.open(path, encoding="utf-8").read()

# Herdr v6 is the last Firstmate-managed integration. Older integrations lack
# the supported wire shape, while v7+ must prove it owns terminal lifecycle
# natively before Firstmate treats it as a no-op.
def skip_literal(text: str, index: int, quote: str) -> int:
    index += 1
    while index < len(text):
        if text[index] == "\\\\":
            index += 2
        elif text[index] == quote:
            return index + 1
        elif quote == "\`" and text.startswith("\${", index):
            index = skip_expression(text, index + 2)
        else:
            index += 1
    return index

def skip_expression(text: str, index: int) -> int:
    depth = 1
    while index < len(text) and depth:
        if text.startswith("//", index):
            end = text.find("\\n", index + 2)
            index = len(text) if end == -1 else end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = len(text) if end == -1 else end + 2
        elif text[index] in "'\\\"\`":
            index = skip_literal(text, index, text[index])
        elif text[index] == "{":
            depth += 1
            index += 1
        elif text[index] == "}":
            depth -= 1
            index += 1
        else:
            index += 1
    return index

def managed_version_declarations(text: str) -> list[str]:
    versions: list[str] = []
    depth = index = 0
    while index < len(text):
        if text.startswith("//", index):
            end = text.find("\\n", index + 2)
            end = len(text) if end == -1 else end
            match = re.fullmatch(r'\\s*//\\s*HERDR_INTEGRATION_VERSION=(\\d+)\\s*', text[index:end])
            if depth == 0 and match:
                versions.append(match.group(1))
            index = end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = len(text) if end == -1 else end + 2
        elif text[index] in "'\\\"\`":
            index = skip_literal(text, index, text[index])
        else:
            depth += text[index] == "{"
            depth -= text[index] == "}"
            index += 1
    return versions

managed_versions = managed_version_declarations(src)
if len(managed_versions) == 0:
    sys.stderr.write(f"unsupported Herdr OMP integration version: missing declaration: {path}\\n")
    sys.exit(3)
if len(managed_versions) != 1:
    sys.stderr.write(f"unsupported Herdr OMP integration version: declaration must appear exactly once: {path}\\n")
    sys.exit(3)
managed_version_number = int(managed_versions[0])
if managed_version_number < 6:
    sys.stderr.write(f"unsupported Herdr OMP integration version: v{managed_version_number}: {path}\\n")
    sys.exit(3)
def lexical_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
        elif text.startswith("//", index):
            end = text.find("\\n", index + 2)
            index = len(text) if end == -1 else end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = len(text) if end == -1 else end + 2
        elif char == "\`":
            index = skip_literal(text, index, char)
            tokens.append('""')
        elif char in "'\\\"":
            quote = char
            index += 1
            value = ""
            while index < len(text) and text[index] != quote:
                if text[index] == "\\\\":
                    index += 2
                else:
                    value += text[index]
                    index += 1
            index += index < len(text)
            tokens.append('"' + value + '"')
        elif char == "/" and (not tokens or tokens[-1] in ("(", "[", "{", "=", ",", ":", ";", "!", "&&", "||", "return", "case")):
            index += 1
            escaped = False
            in_class = False
            while index < len(text):
                if escaped:
                    escaped = False
                elif text[index] == "\\\\":
                    escaped = True
                elif text[index] == "[":
                    in_class = True
                elif text[index] == "]":
                    in_class = False
                elif text[index] == "/" and not in_class:
                    index += 1
                    while index < len(text) and text[index].isalpha():
                        index += 1
                    break
                index += 1
        elif char.isalpha() or char in "_$":
            start = index
            index += 1
            while index < len(text) and (text[index].isalnum() or text[index] in "_$"):
                index += 1
            tokens.append(text[start:index])
        else:
            tokens.append("=>" if text.startswith("=>", index) else char)
            index += len(tokens[-1])
    return tokens

def matching(tokens: list[str], opener: int, open: str, close: str) -> int | None:
    depth = 0
    for index in range(opener, len(tokens)):
        if tokens[index] == open:
            depth += 1
        elif tokens[index] == close:
            depth -= 1
            if depth == 0:
                return index
    return None

def direct_children(tokens: list[str], body: int) -> list[list[str]]:
    end = matching(tokens, body, "{", "}")
    if end is None:
        return []
    children: list[list[str]] = []
    cursor = body + 1
    while cursor < end:
        if tokens[cursor] == ";":
            cursor += 1
            continue
        start = cursor
        if tokens[cursor] == "function" and cursor + 2 < end and tokens[cursor + 2] == "(":
            params_end = matching(tokens, cursor + 2, "(", ")")
            brace = next((i for i in range((params_end or end) + 1, end) if tokens[i] == "{"), None)
            close = matching(tokens, brace, "{", "}") if brace is not None else None
            if close is None:
                return children
            children.append(tokens[start:close + 1])
            cursor = close + 1
            continue
        parens = brackets = braces = 0
        while cursor < end:
            value = tokens[cursor]
            if value == "(":
                parens += 1
            elif value == ")":
                parens -= 1
            elif value == "[":
                brackets += 1
            elif value == "]":
                brackets -= 1
            elif value == "{":
                braces += 1
            elif value == "}":
                braces -= 1
            elif value == ";" and parens == 0 and brackets == 0 and braces == 0:
                children.append(tokens[start:cursor])
                cursor += 1
                break
            cursor += 1
        else:
            break
    return children

def native_terminal_lifecycle(text: str) -> bool:
    if patch_marker in text or root_claim_marker in text:
        return False
    tokens = lexical_tokens(text)
    try:
        export = next(i for i in range(len(tokens) - 2) if tokens[i:i + 3] == ["export", "default", "function"])
    except StopIteration:
        return False
    params = export + 3 + (tokens[export + 3] != "(")
    if params >= len(tokens) or tokens[params] != "(":
        return False
    params_end = matching(tokens, params, "(", ")")
    body = next((i for i in range((params_end or len(tokens)) + 1, len(tokens)) if tokens[i] == "{"), None)
    if body is None:
        return False
    fence = next((child for child in direct_children(tokens, body) if len(child) > 3 and child[:2] == ["function", "fenceShutdown"] and "(" in child), None)
    handler = next((child for child in direct_children(tokens, body) if child[:5] == ["pi", ".", "on", "(", '"session_shutdown"']), None)
    if fence is None or handler is None or "=>" not in handler:
        return False
    fence_body = fence.index("{")
    handler_body = handler.index("=>") + 1
    if handler_body >= len(handler) or handler[handler_body] != "{":
        return False
    fence_statements = direct_children(fence, fence_body)
    handler_statements = direct_children(handler, handler_body)
    return (
        ["shutdownFenced", "=", "true"] in fence_statements and
        any(statement in (["return", "releaseAgent", "(", ")"], ["return", "await", "releaseAgent", "(", ")"]) for statement in fence_statements) and
        ["await", "fenceShutdown", "(", ")"] in handler_statements
    )

if managed_version_number >= 7:
    if not native_terminal_lifecycle(src):
        sys.stderr.write(f"unsupported native terminal lifecycle shape: {path}\\n")
        sys.exit(3)
    sys.stderr.write(f"native terminal lifecycle: {path}\\n")
    sys.exit(0)


# OMP's current SessionShutdownEvent has only a type field; it does not include a
def session_shutdown_helper_declaration_count(text: str) -> int:
    tokens = lexical_tokens(text)
    depth = count = 0
    for index, token in enumerate(tokens):
        if token == "{":
            depth += 1
        elif token == "}":
            depth -= 1
        elif (
            depth == 0 and
            token == "function" and
            tokens[index + 1:index + 3] == ["shouldReleaseOnSessionShutdown", "("] and
            (index == 0 or tokens[index - 1] in (";", "}"))
        ):
            count += 1
    return count

session_shutdown_helper_re = re.compile(
    r'(?P<signature>(?P<indent>[ \\t]*)function shouldReleaseOnSessionShutdown\\([^)]*\\)'
    r'(?:\\s*:\\s*[^{\\n]+)?\\s*\\{\\n)'
    r'(?P<body>[^{}]*?)'
    r'(?P<close>\\n(?P=indent)\\})',
)

def has_session_shutdown_release_invariant(text: str) -> bool:
    if session_shutdown_helper_declaration_count(text) != 1:
        return False
    matches = list(session_shutdown_helper_re.finditer(text))
    if len(matches) != 1:
        return False
    body = matches[0].group("body")
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
        'Symbol.for("herdr:omp:root-session-dispatch:v1")',
        "function rootSessionDispatchState(): RootSessionDispatch",
        "function nextRootSessionSeq(): number",
        "function canDispatchRootSession(generation: number): boolean",
        "let moduleRootGeneration = 0;",
        "terminalGeneration?: number;",
        "function rootSessionIsTerminal(ctx: any): boolean",
        "function fenceRootSession(claim: RootSessionClaim): void",
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
        "function handoffRootSession(event: any, ctx: any): boolean",
        "shutdownFenced || rootSessionIsTerminal(ctx)",
        "function fenceShutdown(): Promise<void>",
        "let shutdownFenced = false;",
        "queuedState = undefined;",
        "function canPublishRootSession(): boolean",
        "if (!canPublishRootSession()) return Promise.resolve();",
        "if (!canPublishRootSession()) return;",
        "if (!canPublishRootSession()) { queuedState = undefined; return; }",
        'pi.on?.("before_agent_start"',
        "handoffRootSession(event, ctx)",
        "if (!validateRootSession(event, ctx))",
    ]
    is_patched.missing = [item for item in required if item not in text]
    for unique in [
        "let latestCtx: any | undefined;",
        "function stashLatestCtx(ctx: any): void",
        "function ctxActiveState(ctx: any): boolean | undefined",
        "function restoreAgentActiveFromCtx(ctx: any = latestCtx): void",
    ]:
        if text.count(unique) != 1:
            is_patched.missing.append(f"exactly one {unique}")
    if not has_publish_guard(text):
        is_patched.missing.append("publishState guard")
    if not has_session_shutdown_release_invariant(text):
        is_patched.missing.append("session_shutdown release invariant")
    if "rootSessionLease" in text or "staleOwnerTakeover" in text:
        is_patched.missing.append("obsolete ownership lease")
    if marker in text:
        is_patched.missing.append("obsolete heartbeat")
    return not is_patched.missing
if mode == "check":
    sys.exit(0 if is_patched(src) else 1)

if is_patched(src):
    sys.stderr.write(f"already patched: {path}\\n")
    sys.exit(0)
# A session_shutdown event alone never proves process teardown or ownership.
# The handler below validates the exact owner/session tuple before release.
session_shutdown_signature_count = session_shutdown_helper_declaration_count(src)
session_shutdown_matches = list(session_shutdown_helper_re.finditer(src))
if session_shutdown_signature_count != 1 or len(session_shutdown_matches) != 1:
    sys.stderr.write("error: shouldReleaseOnSessionShutdown helper not found exactly once; integration shape changed\\n")
    sys.exit(3)
session_shutdown_match = session_shutdown_matches[0]
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

# Serialize report dispatch across extension module reloads. The vendor-local
# requestQueue still owns its transport implementation, while this outer queue
# owns process-wide ordering and claim-generation dispatch eligibility.
next_report_re = re.compile(r'function nextReportSeq\\([^)]*\\)(?:: [^{]+)? \\{[^{}]*\\}')
src, next_report_count = next_report_re.subn(
    'function nextReportSeq(): number {\\n  return nextRootSessionSeq();\\n}',
    src,
    count=1,
)
if next_report_count != 1:
    sys.stderr.write("error: nextReportSeq handler not found; integration shape changed\\n")
    sys.exit(3)
send_request_new = '''function sendRequest(request: any): Promise<void> {
  const generation = moduleRootGeneration;
  const dispatch = rootSessionDispatchState();
  const terminal = request?.method === "pane.release_agent";
  const run = () => {
    if (terminal
      ? dispatch.terminalGeneration === generation
      : canDispatchRootSession(generation)) {
      return sendRequestQueued(request);
    }
    return undefined;
  };
  dispatch.queue = dispatch.queue.then(run, run);
  return dispatch.queue;
}'''
send_request_queued_re = re.compile(
    r'function sendRequestQueued\\((?P<args>[^)]*)\\)(?P<return>\\s*:\\s*[^\\{]+)?\\s*\\{.*?^\\}',
    re.S | re.M,
)
if send_request_new in src and send_request_queued_re.search(src) is not None:
    pass
else:
    send_request_re = re.compile(r'function sendRequest\\((?P<args>[^)]*)\\)(?P<return>\\s*:\\s*[^\\{]+)?\\s*\\{.*?^\\}', re.S | re.M)
    send_request_match = send_request_re.search(src)
    if send_request_match is None:
        sys.stderr.write("error: sendRequest handler not found; integration shape changed\\n")
        sys.exit(3)
    send_request_queued = send_request_match.group(0).replace("function sendRequest(", "function sendRequestQueued(", 1)
    src = src[:send_request_match.start()] + send_request_queued + "\\n" + send_request_new + src[send_request_match.end():]

# A terminal fence must cover direct reports and already-scheduled queue drains,
# not only lifecycle hooks. The global fence survives an extension module reload.
report_session_header = 'function reportSession(sessionStartSource = "startup"): Promise<void> {\\n'
report_session_guard = "  if (!canPublishRootSession()) return Promise.resolve();\\n"
send_state_header = 'function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {\\n'
send_state_guard = "  if (!canPublishRootSession()) return Promise.resolve();\\n"
queue_state_header = 'function queueState(state: AgentState, message?: string): void {\\n'
queue_state_guard = "  if (!canPublishRootSession()) return;\\n"
drain_state_header = "async function drainStateQueue(): Promise<void> {\\n"
drain_state_guard = "  if (!canPublishRootSession()) { queuedState = undefined; return; }\\n"
for name, fallback in [
    ("reportSession", report_session_header),
    ("sendState", send_state_header),
    ("queueState", queue_state_header),
]:
    match = re.search(rf'function {name}\\([^)]*\\)(?:: [^{{]+)? \\{{\\n', src)
    if match is not None:
        if name == "reportSession":
            report_session_header = match.group(0)
        elif name == "sendState":
            send_state_header = match.group(0)
        else:
            queue_state_header = match.group(0)
for header, guard, label in [
    (report_session_header, report_session_guard, "reportSession"),
    (send_state_header, send_state_guard, "sendState"),
    (queue_state_header, queue_state_guard, "queueState"),
    (drain_state_header, drain_state_guard, "drainStateQueue"),
]:
    if header + guard not in src:
        if header not in src:
            sys.stderr.write(f"error: {label} handler not found; integration shape changed\\n")
            sys.exit(3)
        src = src.replace(header, header + guard, 1)

# Persist the root identity outside the extension module. OMP reloads extension
# modules inside one process, while in-process child sessions load the same
# integration. A Symbol.for key gives reload continuity without crossing a
# process boundary.
root_helper_re = re.compile(
    r'// fm-exact-root-session-claim-v6: process-local exact root authority\\.\\n'
    r'.*?(?=export default function)',
    re.S,
)
src = root_helper_re.sub("", src)

# Replace the currently installable v6 module-local helper before reinserting
# the terminal helper. Older helper layouts are intentionally unsupported.
module_helper_re = re.compile(
    r'  let rootSession = false;\\n'
    r'  let shutdownFenced = false;\\n'
    r'.*?'
    r'  function fenceShutdown\\(\\): Promise<void> \\{.*?^  \\}\\n',
    re.S | re.M,
)
src = module_helper_re.sub("", src)
if root_claim_marker not in src:
    global_anchor = "export default function"
    if global_anchor not in src:
        sys.stderr.write("error: extension factory not found; integration shape changed\\n")
        sys.exit(3)
    global_helper = f'''// {root_claim_marker}: process-local exact root authority.
// {patch_marker}: terminal fences prohibit lifecycle resurrection.
type RootSessionClaim = {{
  rootSessionFile?: string;
  rootSessionId: string;
  generation?: number;
}};

type RootSessionDispatch = {{
  queue: Promise<void>;
  seq: number;
  nextGeneration: number;
  terminalGeneration?: number;
}};

const rootSessionClaimKey = Symbol.for("herdr:omp:root-session-claim:v1");
const rootSessionClaimOwnerKey = Symbol.for("herdr:omp:root-session-claim-owner:v1");
const rootSessionTerminalFencesKey = Symbol.for("herdr:omp:root-session-terminal-fences:v1");
const rootSessionDispatchKey = Symbol.for("herdr:omp:root-session-dispatch:v1");
const rootSessionReporterToken = {{}};
const allowedRootStartReasons = new Set(["startup", "new", "resume", "fork", "handoff"]);
let moduleRootGeneration = 0;

function rootSessionDispatchState(): RootSessionDispatch {{
  const baseline = typeof reportSeq === "number" ? reportSeq : Date.now() * 1000;
  const existing = (globalThis as any)[rootSessionDispatchKey];
  if (
    existing?.queue &&
    typeof existing.seq === "number" &&
    typeof existing.nextGeneration === "number"
  ) {{
    existing.seq = Math.max(existing.seq, baseline);
    return existing;
  }}
  const dispatch: RootSessionDispatch = {{
    queue: Promise.resolve(),
    seq: baseline,
    nextGeneration: 0,
  }};
  (globalThis as any)[rootSessionDispatchKey] = dispatch;
  return dispatch;
}}

function nextRootSessionSeq(): number {{
  const dispatch = rootSessionDispatchState();
  dispatch.seq += 1;
  return dispatch.seq;
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
        claim.rootSessionFile.length === 0)) ||
    (claim.generation !== undefined &&
      (!Number.isInteger(claim.generation) || claim.generation < 1))
  ) {{
    return undefined;
  }}
  return claim;
}}

function ownsRootSessionClaim(): boolean {{
  return (globalThis as any)[rootSessionClaimOwnerKey] === rootSessionReporterToken;
}}

function setRootSessionClaim(claim: RootSessionClaim): void {{
  const dispatch = rootSessionDispatchState();
  const current = processRootSessionClaim();
  const generation =
    ownsRootSessionClaim() &&
    typeof current?.generation === "number" &&
    sameRootSessionClaim(current, claim)
      ? current.generation
      : ++dispatch.nextGeneration;
  dispatch.nextGeneration = Math.max(dispatch.nextGeneration, generation);
  moduleRootGeneration = generation;
  (globalThis as any)[rootSessionClaimKey] = {{ ...claim, generation }};
  (globalThis as any)[rootSessionClaimOwnerKey] = rootSessionReporterToken;
}}

function rootSessionTerminalFences(): RootSessionClaim[] {{
  const fences = (globalThis as any)[rootSessionTerminalFencesKey];
  return Array.isArray(fences) ? fences.filter((claim: any) =>
    typeof claim?.rootSessionId === "string" &&
    claim.rootSessionId.length > 0 &&
    (claim.rootSessionFile === undefined || typeof claim.rootSessionFile === "string"),
  ) : [];
}}

function rootSessionIsTerminal(ctx: any): boolean {{
  const tuple = exactRootSessionTuple(ctx);
  return rootSessionTerminalFences().some((fence) => sameRootSessionClaim(fence, tuple, true));
}}

function fenceRootSession(claim: RootSessionClaim): void {{
  const fences = rootSessionTerminalFences();
  if (!fences.some((fence) => sameRootSessionClaim(fence, claim))) {{
    fences.push(claim);
  }}
  (globalThis as any)[rootSessionTerminalFencesKey] = fences;
}}

function currentRootSessionIsTerminal(): boolean {{
  const current: RootSessionClaim | undefined = currentAgentSessionPath
    ? {{ rootSessionFile: currentAgentSessionPath, rootSessionId: currentAgentSessionId ?? "" }}
    : currentAgentSessionId
      ? {{ rootSessionId: currentAgentSessionId }}
      : undefined;
  return rootSessionTerminalFences().some((fence) => sameRootSessionClaim(fence, current, true));
}}

function canDispatchRootSession(generation: number): boolean {{
  const claim = processRootSessionClaim();
  return (
    ownsRootSessionClaim() &&
    claim?.generation === generation &&
    !currentRootSessionIsTerminal()
  );
}}

function canPublishRootSession(): boolean {{
  return ownsRootSessionClaim() && !currentRootSessionIsTerminal();
}}

function clearRootSessionClaim(): void {{
  if (!ownsRootSessionClaim()) return;
  delete (globalThis as any)[rootSessionClaimKey];
  delete (globalThis as any)[rootSessionClaimOwnerKey];
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
    "  let shutdownFenced = false;\\n"
    "  let finalRelease: Promise<void> | undefined;\\n"
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
    "    if (shutdownFenced || rootSessionIsTerminal(ctx)) return;\\n"
    "    stashLatestCtx(ctx);\\n"
    "    const active = ctxActiveState(ctx);\\n"
    "    if (active !== undefined) {\\n"
    "      agentActive = active;\\n"
    "    }\\n"
    "  }\\n"
    "\\n"
    "  function fenceShutdown(): Promise<void> {\\n"
    "    if (finalRelease) return finalRelease;\\n"
    "    const tuple = exactRootSessionTuple(latestCtx);\\n"
    "    const claim = processRootSessionClaim();\\n"
    "    if (!claim || !ownsRootSessionClaim() || !sameRootSessionClaim(claim, tuple)) {\\n"
    "      return Promise.resolve();\\n"
    "    }\\n"
    "    shutdownFenced = true;\\n"
    "    clearPendingTimers();\\n"
    "    queuedState = undefined;\\n"
    "    rootSessionDispatchState().terminalGeneration = claim.generation;\\n"
    "    fenceRootSession(claim);\\n"
    "    rootSession = false;\\n"
    "    clearRootSessionClaim();\\n"
    "    finalRelease = releaseAgent();\\n"
    "    return finalRelease;\\n"
    "  }\\n"
)
if "let shutdownFenced = false;" not in src:
    if helper_anchor in src:
        src = src.replace(helper_anchor, helper, 1)
    else:
        activation_anchor = "  function validateRootSession("
        if activation_anchor not in src:
            sys.stderr.write("error: root lifecycle helper anchor not found; integration shape changed\\n")
            sys.exit(3)
        src = src.replace(activation_anchor, helper + activation_anchor, 1)

activation_re = re.compile(
    r'  function activateRootSession\\(.*?^  \\}',
    re.S | re.M,
)
activation = '''  function validateRootSession(
    event: any,
    ctx: any,
    allowOwnerTransfer = false,
  ): boolean {
    if (shutdownFenced || rootSessionIsTerminal(ctx)) {
      rootSession = false;
      return false;
    }
    stashLatestCtx(ctx);
    const tuple = exactRootSessionTuple(ctx);
    const claim = processRootSessionClaim();
    const claimOwned = ownsRootSessionClaim();
    const valid =
      !hasRootChildMarker(event, ctx) &&
      sameRootSessionClaim(claim, tuple) &&
      (claimOwned || allowOwnerTransfer);
    rootSession = valid;
    if (valid && tuple) {
      setRootSessionClaim(tuple);
      updateSessionRef(ctx);
    }
    return valid;
  }

  function handoffRootSession(event: any, ctx: any): boolean {
    if (shutdownFenced || rootSessionIsTerminal(ctx) || hasRootChildMarker(event, ctx)) {
      return false;
    }
    const tuple = exactRootSessionTuple(ctx);
    return tuple !== undefined &&
      sameRootSessionClaim(processRootSessionClaim(), tuple) &&
      validateRootSession(event, ctx, true);
  }

  function activateRootSession(
    event: any,
    ctx: any,
    sessionStartSource = "startup",
    mayClaim = false,
  ): boolean {
    const effectiveSessionStartSource = sessionStartSource;
    if (validateRootSession(event, ctx)) {
      void reportSession(effectiveSessionStartSource);
      return true;
    }

    const tuple = exactRootSessionTuple(ctx);
    const claim = processRootSessionClaim();
    const mayUpdateOwnedRoot =
      mayClaim &&
      allowedRootStartReasons.has(effectiveSessionStartSource) &&
      ctx?.hasUI === true &&
      !hasRootChildMarker(event, ctx) &&
      !shutdownFenced &&
      !rootSessionIsTerminal(ctx) &&
      ownsRootSessionClaim() &&
      tuple !== undefined &&
      claim !== undefined;
    if (mayUpdateOwnedRoot) {
      setRootSessionClaim(tuple);
      rootSession = true;
      updateSessionRef(ctx);
      void reportSession(effectiveSessionStartSource);
      return true;
    }
    const hasMatchingClaimedPreviousSessionFile =
      typeof event?.previousSessionFile === "string" &&
      event.previousSessionFile.length > 0 &&
      event.previousSessionFile === claim?.rootSessionFile;
    const maySupersedeReloadedRoot =
      mayClaim &&
      allowedRootStartReasons.has(effectiveSessionStartSource) &&
      ctx?.hasUI === true &&
      !hasRootChildMarker(event, ctx) &&
      !shutdownFenced &&
      !rootSessionIsTerminal(ctx) &&
      !ownsRootSessionClaim() &&
      tuple !== undefined &&
      claim !== undefined &&
      hasMatchingClaimedPreviousSessionFile;
    if (maySupersedeReloadedRoot) {
      setRootSessionClaim(tuple);
      rootSession = true;
      updateSessionRef(ctx);
      void reportSession(effectiveSessionStartSource);
      return true;
    }
    const isFreshSameSessionResume =
      effectiveSessionStartSource === "resume" &&
      claim === undefined &&
      hasMatchingClaimedPreviousSessionFile;
    const lacksFreshResumeProof =
      effectiveSessionStartSource === "resume" &&
      claim === undefined &&
      !isFreshSameSessionResume;
    if (
      shutdownFenced ||
      rootSessionIsTerminal(ctx) ||
      !mayClaim ||
      claim !== undefined ||
      !tuple ||
      hasRootChildMarker(event, ctx) ||
      !allowedRootStartReasons.has(effectiveSessionStartSource) ||
      ctx?.hasUI !== true ||
      lacksFreshResumeProof
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
    // Lifecycle events own recovery; no periodic state publication is installed.
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
before_agent_start = '''  pi.on?.("before_agent_start", (event, ctx) => {
    stashLatestCtx(ctx);
    if (!rootSession) {
      handoffRootSession(event, ctx);
    }
  });

'''
before_agent_start_re = re.compile(
    r'  pi\\.on\\?\\.\\("before_agent_start", \\([^)]*\\) => \\{.*?^  \\}\\);\\n\\n',
    re.S | re.M,
)
if before_agent_start_re.search(src):
    src = before_agent_start_re.sub(before_agent_start, src, count=1)
else:
    agent_start_anchor = '  pi.on("agent_start", '
    if agent_start_anchor not in src:
        sys.stderr.write("error: agent_start handler not found; integration shape changed\\n")
        sys.exit(3)
    src = src.replace(agent_start_anchor, before_agent_start + agent_start_anchor, 1)

agent_start_re = re.compile(
    r'  pi\\.on\\("agent_start", \\([^)]*\\) => \\{\\n'
    r'(?:    stashLatestCtx\\(ctx\\);\\n)?'
    r'(?:'
    r'    if \\(!rootSession && !activateRootSession\\(ctx\\)\\) return;\\n'
    r'|'
    r'    if \\(!rootSession && !handoffRootSession\\(event, ctx\\)\\) return;\\n'
    r'    if \\(!validateRootSession\\(event, ctx\\)\\) \\{\\n'
    r'      return;\\n'
    r'    \\}\\n'
    r'|'
    r'    if \\(!validateRootSession\\(undefined, ctx\\)\\) \\{\\n'
    r'      return;\\n'
    r'    \\}\\n'
    r')',
)
agent_start_new = '''  pi.on("agent_start", (event, ctx) => {
    stashLatestCtx(ctx);
    if (!rootSession && !handoffRootSession(event, ctx)) return;
    if (!validateRootSession(event, ctx)) {
      return;
    }
'''
src, agent_start_count = agent_start_re.subn(agent_start_new, src, count=1)
if agent_start_count != 1:
    sys.stderr.write("error: agent_start lifecycle gate not found; integration shape changed\\n")
    sys.exit(3)

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
if legacy_activation_gate in src:
    src = src.replace(
        legacy_activation_gate,
        "if (!rootSession && !handoffRootSession(event, ctx)) return;\\n    if (!validateRootSession(event, ctx))",
    )

if not has_publish_guard(src):
    src, publish_count = publish_state_re.subn(
        lambda match: match.group(0) + publish_guard,
        src,
        count=1,
    )
    if publish_count != 1:
        sys.stderr.write("error: publishState handler not found; integration shape changed\\n")
        sys.exit(3)

# A late agent_end must not re-arm retry or idle scheduling after final release.
agent_end_re = re.compile(r'  pi\\.on\\("agent_end", \\([^)]*\\) => \\{\\n')
agent_end_guard = "    if (shutdownFenced) return;\\n"
agent_end_match = agent_end_re.search(src)
if agent_end_match is None:
    sys.stderr.write("error: agent_end handler not found; integration shape changed\\n")
    sys.exit(3)
if not src.startswith(agent_end_guard, agent_end_match.end()):
    src = src[:agent_end_match.end()] + agent_end_guard + src[agent_end_match.end():]

session_shutdown_re = re.compile(
    r'  pi\\.on\\("session_shutdown", (?:async )?\\([^)]*\\) => \\{.*?^  \\}\\);',
    re.S | re.M,
)
session_shutdown_new = '''  pi.on("session_shutdown", async (event, ctx) => {
    stashLatestCtx(ctx);
    if (!rootSession) handoffRootSession(event, ctx);
    const tuple = exactRootSessionTuple(latestCtx);
    if (
      !shouldReleaseOnSessionShutdown(event) ||
      !rootSession ||
      !ownsRootSessionClaim() ||
      !sameRootSessionClaim(processRootSessionClaim(), tuple)
    ) {
      return;
    }
    await fenceShutdown();
  });'''
src, session_shutdown_count = session_shutdown_re.subn(session_shutdown_new, src, count=1)
if session_shutdown_count != 1:
    sys.stderr.write("error: session_shutdown handler not found; integration shape changed\\n")
    sys.exit(3)


if not is_patched(src):
    sys.stderr.write(f"error: patched integration failed self-check; missing {is_patched.missing!r}\\n")
    sys.exit(3)
io.open(path, "w", encoding="utf-8").write(src)
sys.stderr.write(f"patched: {path} (terminal lifecycle fence)\\n")
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
function skipLiteral(source: string, index: number, quote: string): number {
	for (index += 1; index < source.length;) {
		if (source[index] === "\\") index += 2;
		else if (source[index] === quote) return index + 1;
		else if (quote === "`" && source.startsWith("${", index)) index = skipExpression(source, index + 2);
		else index += 1;
	}
	return index;
}

function skipExpression(source: string, index: number): number {
	let depth = 1;
	while (index < source.length && depth > 0) {
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end;
		} else if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
		} else if (source[index] === "'" || source[index] === '"' || source[index] === "`") {
			index = skipLiteral(source, index, source[index]);
		} else if (source[index] === "{") {
			depth += 1;
			index += 1;
		} else if (source[index] === "}") {
			depth -= 1;
			index += 1;
		} else {
			index += 1;
		}
	}
	return index;
}

function managedVersions(source: string): string[] {
	const versions: string[] = [];
	let depth = 0;
	for (let index = 0; index < source.length;) {
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index + 2);
			const line = source.slice(index, end < 0 ? source.length : end);
			const match = /^\s*\/\/\s*HERDR_INTEGRATION_VERSION=(\d+)\s*$/.exec(line);
			if (depth === 0 && match) versions.push(match[1]);
			index = end < 0 ? source.length : end;
		} else if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
		} else if (source[index] === "'" || source[index] === '"' || source[index] === "`") {
			index = skipLiteral(source, index, source[index]);
		} else {
			if (source[index] === "{") depth += 1;
			else if (source[index] === "}") depth -= 1;
			index += 1;
		}
	}
	return versions;
}
const MANAGED_VERSION_RE = /^\s*\/\/\s*HERDR_INTEGRATION_VERSION=(\d+)\s*$/gm;
const NATIVE_FENCE_RE = /^[ \t]*function fenceShutdown\([^)]*\)(?:\s*:\s*[^{\n]+)?\s*\{/m;
const NATIVE_SHUTDOWN_HANDLER_RE =
	/^[ \t]*pi\.on\("session_shutdown",\s*async\s*\(event, ctx\)\s*=>\s*\{/m;

function blockBody(source: string, opener: number): string | undefined {
	let depth = 0;
	for (let index = opener; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}" && --depth === 0) return source.slice(opener + 1, index);
	}
	return undefined;
}

function codeOnly(source: string): string {
	const chars = source.split("");
	let index = 0;
	const blank = (start: number, end: number): void => {
		for (let i = start; i < end; i += 1) {
			if (chars[i] !== "\n") chars[i] = " ";
		}
	};
	while (index < source.length) {
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index);
			blank(index, end < 0 ? source.length : end);
			index = end < 0 ? source.length : end;
		} else if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			const next = end < 0 ? source.length : end + 2;
			blank(index, next);
			index = next;
		} else if (source[index] === "'" || source[index] === '"' || source[index] === "`") {
			const start = index;
			const quote = source[index];
			index = skipLiteral(source, index, quote);
			const literal = source.slice(start, index);
			if (literal !== '"session_shutdown"' && literal !== "'session_shutdown'") blank(start, index);
		} else {
			index += 1;
		}
	}
	return chars.join("");
}

function hasTopLevelFenceStatement(body: string, pattern: RegExp): boolean {
	let depth = 0;
	let statement = "";
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] === "{") depth += 1;
		else if (body[index] === "}") depth -= 1;
		else if (depth === 0) {
			statement += body[index];
			if (body[index] === ";") {
				if (pattern.test(statement)) return true;
				statement = "";
			}
		}
	}
	return false;
}

function hasNativeTerminalLifecycle(source: string): boolean {
	if (source.includes(PATCH_MARKER) || source.includes(ROOT_CLAIM_MARKER)) return false;
	const code = codeOnly(source);
	const register = code.indexOf("export default function");
	const registerOpener = register < 0 ? -1 : code.indexOf("{", register);
	const registerBody = registerOpener < 0 ? undefined : blockBody(code, registerOpener);
	if (registerBody === undefined) return false;
	const fence = NATIVE_FENCE_RE.exec(registerBody);
	const handler = NATIVE_SHUTDOWN_HANDLER_RE.exec(registerBody);
	if (!fence || !handler) return false;
	const depthAt = (position: number): number =>
		registerBody.slice(0, position).split("{").length - registerBody.slice(0, position).split("}").length;
	if (depthAt(fence.index) !== 0 || depthAt(handler.index) !== 0) return false;
	const fenceBody = blockBody(registerBody, fence.index + fence[0].lastIndexOf("{"));
	const handlerBody = blockBody(registerBody, handler.index + handler[0].lastIndexOf("{"));
	return (
		fenceBody !== undefined &&
		handlerBody !== undefined &&
		hasTopLevelFenceStatement(fenceBody, /^\s*shutdownFenced\s*=\s*true\s*;$/) &&
		hasTopLevelFenceStatement(fenceBody, /^\s*return\s+(?:await\s+)?releaseAgent\s*\([^)]*\)\s*;$/) &&
		hasTopLevelFenceStatement(handlerBody, /^\s*await\s+fenceShutdown\s*\(\s*\)\s*;$/)
	);
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

	if (!target) {
		process.stderr.write("error: no integration file\n");
		return 2;
	}
	if (!existsSync(target)) {
		process.stderr.write(`SKIP: no herdr omp integration at ${target}\n`);
		return 0;
	}
	const source = readFileSync(target, "utf8");
	const versionDeclarations = managedVersions(source);
	if (versionDeclarations.length === 0) {
		process.stderr.write(`unsupported Herdr OMP integration version: missing declaration: ${target}\n`);
		return 3;
	}
	if (versionDeclarations.length !== 1) {
		process.stderr.write(`unsupported Herdr OMP integration version: declaration must appear exactly once: ${target}\n`);
		return 3;
	}
	const version = Number(versionDeclarations[0]);
	if (version < 6) {
		process.stderr.write(`unsupported Herdr OMP integration version: v${version}: ${target}\n`);
		return 3;
	}
	if (version >= 7) {
		if (!hasNativeTerminalLifecycle(source)) {
			process.stderr.write(`unsupported native terminal lifecycle shape: ${target}\n`);
			return 3;
		}
		process.stderr.write(`native terminal lifecycle: ${target}\n`);
		return 0;
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

	const res = spawnSync(
		"python3",
		[
			"-",
			target,
			LEGACY_HEARTBEAT_MARKER,
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
	describe: "Migrate legacy Herdr OMP lifecycle reporting to atomic terminal release semantics.",
	run,
};
