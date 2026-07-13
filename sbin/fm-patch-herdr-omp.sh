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
# cannot fix it upstream and cannot expect edits to survive an update. Fix: on an
# interval, if reporting is enabled() (HERDR_ENV + pane id + socket all present -
# the same fact hasUI proxied for) but rootSession was lost across a reload,
# re-establish rootSession, re-report the session ref so herdr rebinds the source,
# and force-publish the true state. Self-contained, needs no ctx, version-agnostic;
# run after any herdr update to re-apply it.
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
    f"  // {marker}: injected by sbin/fm-patch-herdr-omp.sh.\n"
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
    "  // proxy for. So on an interval, if reporting is enabled but rootSession was\n"
    "  // lost across a reload, re-establish it and force-publish the true state.\n"
    "  try {\n"
    f"    const __fmResyncMs = {int(resync_ms)};\n"
    "    const __fmResync = setInterval(() => {\n"
    "      try {\n"
    "        if (!enabled()) return;\n"
    "        if (!rootSession) {\n"
    "          // Reload dropped activation; re-establish it. Report the session\n"
    "          // ref so herdr rebinds this source, then resume publishing.\n"
    "          rootSession = true;\n"
    "          void reportSession(\"fm-reload-resync\");\n"
    "        }\n"
    "        publishState(true);\n"
    "      } catch (_e) {}\n"
    "    }, __fmResyncMs);\n"
    "    __fmResync.unref?.();\n"
    "  } catch (_e) {}\n"
)

patched = src[:insert_at] + block + src[insert_at:]
io.open(path, "w", encoding="utf-8").write(patched)
sys.stderr.write(f"patched: {path} (resync every {resync_ms}ms)\n")
PY
