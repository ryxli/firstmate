---
name: fm-supervise-lanes
description: >-
  Supervises OMP subagents, persistent mates, and visible FM workers. Use when
  coordinating parallel lanes, whiteboards, peer bus, or review disposition.
---

# fm-supervise-lanes

Judgment for OMP subagents, persistent secondmates, and visible FM workers.
Demand-load from `skill://fm-manage-project-work` or when supervising parallel lanes.
Authoritative live state is the fresh `fm fleet` view derived from Herdr inventory and the current backlog, artifacts, status/meta records, and registered homes; the whiteboard is a derived operator view, never pane memory.

## Whiteboard write gate

Write the board only when lane state, evidence, disposition, decision, or wake condition changes.

- Duplicate reviewer completion → no write
- No-op system notice → no write
- New rejection → one write with the new disposition
- Worker working → ready → one write
- Changed wake condition only → one write
- Cap decision → one write
- After a real transition, prior accepted state remains (monotonic)

## Operator view

Every board begins with a cap-first band; without it the board is non-compliant.

```
## OPERATOR VIEW
🟢|🟡|🔴|🔵 <one plain-language line per active lane>   (hard cap: 8 lines)
⚠ Needs cap: <decision or "nothing">
→ For supervisor: <handoff/ask or "nothing">
```

Plain language only in the operator view.
Load-bearing safety claims need a timestamped evidence line naming the exact read-only command that produced them.

## Communication channels

Use OMP subagent return artifacts and `hub` only for bounded `task` workers.
Use `peer_send`/`peer_pull` for an actionable handoff, blocking question, or safety escalation between persistent firstmate and secondmate roles.
Use `fm send` only for explicit visible-pane steering or harness control, not routine mate-to-mate communication.
Disposable FM workers report through their task status/report artifacts.
No conversational acknowledgements or FYI progress; durable lifecycle artifacts and receipts remain required.

## Ownership and dispatch

Read active lanes before dispatch.
Deconfliction needs confirmed stand-down.
Serialize overlapping write surfaces; otherwise parallelize file-disjoint work.
High-blast-radius steps get a named fresh-context reviewer; REJECT relays the minimum fix and re-reviews that finding only.

## Terminal events

A terminal event (`done`, `blocked`, `needs-decision`, `failed`, material phase change) is a same-turn obligation: read the named artifact, take the lifecycle action, write the resulting board state when it changed.
A claim with no named artifact is invalid.

## Escalation

Escalate only at the agreed bar: destructive, irreversible, security-sensitive, genuine equal tradeoff, or exhausted stuck-playbook with evidence.
Idle with unblocked Working items is a failure; idle with an all-blocked list is legitimate.
