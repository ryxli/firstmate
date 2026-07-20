# ab-lab extractor: thinking-tag leak metric.
# analyze(session_dir) -> dict of numbers, aggregated across an arm's sessions.
# Counts assistant turns and "pure leak" visible text blocks (a {type:text} block
# that is nothing but <thinking>/</thinking> tags + whitespace).
import json, glob, os


def analyze(session_dir):
    turns = 0
    leak_blocks = 0
    leaked_turns = 0
    for f in sorted(glob.glob(os.path.join(session_dir, "**", "*.jsonl"), recursive=True)):
        for line in open(f, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") != "message":
                continue
            m = e.get("message", {})
            if m.get("role") != "assistant":
                continue
            turns += 1
            hit = 0
            for b in m.get("content", []):
                if b.get("type") == "text":
                    t = (b.get("text") or "").strip()
                    residue = t.replace("<thinking>", "").replace("</thinking>", "").strip()
                    if ("<thinking>" in t or "</thinking>" in t) and residue == "":
                        hit += 1
            if hit:
                leak_blocks += hit
                leaked_turns += 1
    rate = round(leaked_turns / turns, 4) if turns else 0.0
    return {"assistant_turns": turns, "leak_blocks": leak_blocks,
            "leaked_turns": leaked_turns, "leak_turn_rate": rate}
