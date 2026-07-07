#!/usr/bin/env bash
# Show the last N capture events from the events journal in a clean card layout.
# Usage: fm-capture-demo.sh [N]   (default: 10)
#
# Cards look like:
#   ── supervisor correction  [2026-07-07 14:23:01]  session: abc12…  turn: 5
#      raw  │ "Here is the raw JSON output from the previous turn..."
#      →    │ "no, use aligned columns not a JSON dump"
#
#   ── fleet steer  [2026-07-07 14:24:30]
#      →    │ focus on the dispatcher first  →  fm-riggs
set -eu

EVENTS="${CAPTURE_EVENTS_PATH:-${HOME}/.omp/agent/capture/events.jsonl}"
N="${1:-10}"

if [ ! -f "$EVENTS" ]; then
  echo "No events yet. Correct Keel in chat or run: fm-send.sh <pane> --steer <text>"
  exit 0
fi

python3 - "$EVENTS" "$N" <<'PYEOF'
import json, sys, datetime, textwrap, os

events_path, n_str = sys.argv[1], sys.argv[2]
n = int(n_str)
WIDTH = int(os.get_terminal_size().columns) if hasattr(os, "get_terminal_size") else 100
MAX_TEXT = WIDTH - 14  # account for left margin + label

def fmt_ts(ts_ms):
    try:
        dt = datetime.datetime.fromtimestamp(ts_ms / 1000)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ts_ms)

def clip(text, maxlen=MAX_TEXT):
    text = str(text).replace("\n", " ").strip()
    return (text[:maxlen - 1] + "…") if len(text) > maxlen else text

def session_ref(ev):
    sid = ev.get("session_id", "")
    ref = ev.get("trace_ref", "")
    # Extract turn from trace_ref (format: "path/or/id:N")
    turn = ""
    if ":" in ref:
        turn = ref.rsplit(":", 1)[-1]
    short_sid = sid[:8] + "…" if len(sid) > 8 else sid
    parts = []
    if short_sid:
        parts.append(f"session: {short_sid}")
    if turn and turn.isdigit():
        parts.append(f"turn: {turn}")
    return "  ".join(parts)

lines = []
try:
    with open(events_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    lines.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
except OSError as e:
    print(f"cannot read {events_path}: {e}", file=sys.stderr)
    sys.exit(1)

recent = lines[-n:] if n > 0 else lines

if not recent:
    print("No events recorded yet.")
    sys.exit(0)

RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
GREEN  = "\033[32m"

for ev in recent:
    plane = ev.get("plane", "?")
    kind  = ev.get("kind", "?")
    ts    = fmt_ts(ev.get("ts", 0))
    raw   = ev.get("raw", "")
    corr  = ev.get("corrected", "")
    target= ev.get("target", "")
    ref   = session_ref(ev)

    color = CYAN if plane == "supervisor" else YELLOW
    header = f"{color}{BOLD}── {plane} {kind}{RESET}  {DIM}[{ts}]"
    if ref:
        header += f"  {ref}"
    header += RESET
    print(header)

    if plane == "supervisor":
        if raw:
            print(f"   {'raw':4s} │ {DIM}{clip(raw)}{RESET}")
        print(f"   {GREEN}{'→':4s}{RESET} │ {clip(corr)}")
    else:
        # Fleet steer: compact one-liner
        arrow = f"{clip(corr)}"
        if target:
            arrow += f"  {DIM}→ {target}{RESET}"
        print(f"   {GREEN}{'→':4s}{RESET} │ {arrow}")

    print()

print(f"{DIM}── {len(recent)} of {len(lines)} events  {events_path}{RESET}")
PYEOF
