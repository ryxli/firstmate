---
name: fm-supervise-lanes
description: "Supervise lanes."
---

# fm-supervise-lanes

Use for OMP subagents, persistent mates, and visible FM workers.
Start with fresh `fm fleet`; live state, task records, and named artifacts are authority.

## Rules

Lane shapes: tool/pipeline; warm specialist; fresh independent specialist; disposable worker; background wait/delegated worker.
Choose the cheapest reliable shape.
Warm specialists are manager-local: each manager owns roster, names, memory, and lifecycle; share definitions, never instances.
Refresh authority before relying on warm context.
Spawn fresh when domain or decision role changes.

Managers own synthesis, acceptance, helper contracts, adoption, and retirement.
Adopt only with expected efficiency delta; measure accepted-result cost, corrections, defects, and reacquisition avoided.
Helpers never self-grade.
Disposition is `keep`, `merge`, `compile`, or `drop`; compile stable residue.

Read active lanes before dispatch.
Serialize overlapping write surfaces until confirmed stand-down; otherwise parallelize disjoint work.
High-blast-radius steps need a named fresh-context reviewer; on REJECT, relay the minimum fix and re-review only that finding.

Channels: OMP artifacts and `hub` for bounded `task` workers; `peer_send`/`peer_pull` for persistent mate handoff, blocker, or safety escalation; `fm send` only for visible-pane steering or harness control; FM task/report artifacts for disposable workers.
FYI acknowledgements never replace durable artifacts or receipts.

Whiteboard is active only after explicit `/wb loop`, `/wb tick`, or `/wb tick!`.
When inactive, never call whiteboard tools.
When active, write only changed lane state, evidence, disposition, decision, or wake condition.
The board is derived, never authority.

Terminal events require same-turn read of the named artifact and lifecycle action.
Claims without named terminal artifacts are invalid.
Escalate only for destructive, irreversible, security-sensitive, equal-tradeoff, or exhausted stuck-playbook cases with evidence.
Idle with unblocked Working items is failure; all-blocked idle is legitimate.
