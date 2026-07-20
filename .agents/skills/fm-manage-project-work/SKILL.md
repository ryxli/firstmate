---
name: fm-manage-project-work
description: >-
  Manages project work across registration, routing, spawn, acceptance, finish,
  and teardown. Use when adding projects, secondmates, briefs, or advancing
  lifecycle state.
---

# fm-manage-project-work

Lane supervision: `skill://fm-supervise-lanes`.
Backlog command details: `fm tasks --help` (do not restate here).

## Classification and routing

Resolve the project independently every request, then secondmate scope from `data/secondmates.md`.
Ship (default change) vs scout (investigation/plan/audit; report at `data/<id>/report.md`).
`trunk` never routes to a secondmate; only `pr` projects do.
Serialize overlapping repo areas; otherwise parallelize.

## Registries

`data/projects.md`: `- <name> [<mode>] - <description> (added <date>)` with `pr` (default) or `trunk`, optional `+yolo`.
`data/secondmates.md` solely owns secondmate identity/scope; projections via `fm brief --regen|--check`.
Project-intrinsic knowledge → project `AGENTS.md` through worktree delivery; fleet-private → `data/`.

## Which verb advances state

| Verb | Advances |
|---|---|
| `fm spawn` | Creates pane/worktree; records mode/yolo/harness/kind |
| `fm accept` | Freezes candidate SHA, closes pane, queues integrate |
| `fm revise` | Pre-accept correction only |
| `fm finish` | Integrate → land → backlog close → cleanup |
| `fm teardown` | Disposes landed (or scout-reported) work; never unlanded without cap discard |
| `fm tasks` | Sole backlog mutation surface |

Flow: `worker ready → fm accept → fm finish → closed` (or `fm revise` pre-accept).

## Acceptance authority

Never merge a team/project PR without cap word unless project `+yolo` grants routine approval.
Destructive, irreversible, and security-sensitive still escalate.
`trunk` finish is the authorize step for local integrate; `pr` requires recorded PR URL and matching head SHA.

## Unlanded-work protection

Never tear down a worktree whose HEAD is not reachable from a remote-tracking branch (fork remotes count), except scout after report exists, or cap-explicit discard.
Scout worktrees are scratch once the report exists.
