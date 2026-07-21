---
name: fm-supervise-lanes
description: >-
  Supervises OMP subagents, persistent mates, and visible FM workers. Use when
  coordinating parallel lanes, whiteboards, peer bus, or review disposition.
---

# fm-supervise-lanes

Judgment for OMP subagents, persistent secondmates, and visible FM workers.
Demand-load from `skill://fm-manage-project-work` or when supervising parallel lanes.
Authoritative live state is the fresh `fm fleet` view derived from Herdr inventory and durable task records.

## Whiteboard opt-in

A whiteboard is active only after the cap or operator explicitly invokes `/wb loop`, `/wb tick`, or `/wb tick!` in that session.
Tool registration or tool presence is never enablement.
When inactive, never call `whiteboard_read`, `whiteboard_write`, or `whiteboard_checkpoint`, and never maintain a board as a side effect of supervision.

When active, write only when lane state, evidence, disposition, decision, or wake condition changes.
Duplicate completion and no-op notices do not justify a write.
The board is a derived operator view, never the source of truth.

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

A terminal event (`done`, `blocked`, `needs-decision`, `failed`, material phase change) is a same-turn obligation: read the named artifact and take the lifecycle action; update a whiteboard only when that session explicitly enabled it.
A claim with no named artifact is invalid.

## Escalation

Escalate only at the agreed bar: destructive, irreversible, security-sensitive, genuine equal tradeoff, or exhausted stuck-playbook with evidence.
Idle with unblocked Working items is a failure; idle with an all-blocked list is legitimate.
