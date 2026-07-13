#!/usr/bin/env bash
# fm-patch-herdr-omp.sh - patch the herdr-managed omp status integration to
# self-heal a stuck agent_status.
#
# Why: ~/.omp/agent/extensions/herdr-omp-agent-state.ts reports working/idle to
# herdr over a socket. A failed send resolves as success (sendRequestNow treats
# socket "error" as done) and publishState commits lastState BEFORE the send, so
# a single dropped report poisons the dedup: the integration believes it already
# told herdr "working" and never resends, while herdr is stuck at "idle" for the
# whole turn. Result: a live mate reads idle, tripping false completion/stale
# wakes and making the fleet look done when it is working.
#
# herdr owns this file ("reinstalling or updating overwrites this file"), so we
# cannot fix it upstream and cannot expect edits to survive an update. Instead we
# inject a small, self-contained RESYNC HEARTBEAT: while the root session is
# active, re-publish the true desired state on an interval with force=true
# (bypassing the poisoned dedup), so herdr converges to reality within one
# interval even when individual reports drop. The insertion is isolated and
# version-agnostic; run this after any herdr update to re-apply it.
#
# Idempotent: a second run detects the marker and no-ops. Safe at bootstrap.
#
# Usage:
#   fm-patch-herdr-omp.sh           apply if absent (default)
#   fm-patch-herdr-omp.sh --check   exit 0 if applied, 1 if not (no write)
#   fm-patch-herdr-omp.sh --file <path>   patch a specific integration file
set -u

MARKER="fm-resync-heartbeat"
RESYNC_MS="${FM_HERDR_RESYNC_MS:-15000}"

TARGET="$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts"
MODE=apply
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --file) shift; TARGET="${1:-}" ;;
    --file=*) TARGET="${1#*=}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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

if grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  [ "$MODE" = check ] && exit 0
  echo "already patched: $TARGET" >&2
  exit 0
fi

if [ "$MODE" = check ]; then
  exit 1
fi

# Anchor: the agent_start handler ends with `publishState();` then `});`. We
# insert the heartbeat wiring immediately after that handler closes. To stay
# robust we instead insert just before the default-export function's final
# closing brace is too risky to find textually, so we hook the well-known
# `agent_start` registration and append a sibling interval registration right
# after its closing `});`.
python3 - "$TARGET" "$RESYNC_MS" "$MARKER" <<'PY'
import io, re, sys

path, resync_ms, marker = sys.argv[1], sys.argv[2], sys.argv[3]
src = io.open(path, encoding="utf-8").read()

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
    f"  // {marker}: injected by sbin/fm-patch-herdr-omp.sh. The socket status\n"
    "  // report can drop silently and poison publishState's dedup, leaving\n"
    "  // herdr stuck at a stale agent_status for the whole turn. Re-publish the\n"
    "  // true desired state on an interval with force=true so herdr converges to\n"
    "  // reality even when individual reports are lost.\n"
    "  try {\n"
    f"    const __fmResyncMs = {int(resync_ms)};\n"
    "    const __fmResync = setInterval(() => {\n"
    "      if (rootSession) {\n"
    "        try { publishState(true); } catch (_e) {}\n"
    "      }\n"
    "    }, __fmResyncMs);\n"
    "    __fmResync.unref?.();\n"
    "  } catch (_e) {}\n"
)

patched = src[:insert_at] + block + src[insert_at:]
io.open(path, "w", encoding="utf-8").write(patched)
sys.stderr.write(f"patched: {path} (resync every {resync_ms}ms)\n")
PY
