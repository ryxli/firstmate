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
Bounded work defaults to OMP background subagents through the `task` tool.
For project writes: create the brief, run pane-free `fm spawn` to prepare the isolated worktree and lifecycle metadata, then immediately dispatch the task agent into the printed worktree.
Persistent secondmates retain domain routing and exceptional stateful work and remain visible; use `fm spawn --visible` for disposable workers only when the cap requests visibility or durable interactive recovery.
Task completion is not acceptance or landing: preserve the existing `fm accept` then `fm finish` gates.
When a visible FM worker is required, changes use ship tasks and read-only work uses scout tasks (report at `data/<id>/report.md`).
`trunk` never routes to a secondmate; only `pr` projects do.
Serialize overlapping repo areas; otherwise parallelize.
Once the cap freezes scope, every active and queued thread must trace to that set; newly observed symptoms are evidence within an existing thread until a verified causal chain proves otherwise.

## Registries

`data/projects.md`: `- <name> [<mode>] - <description> (added <date>)` with `pr` (default) or `trunk`, optional `+yolo`.
`data/secondmates.md` solely owns secondmate identity/scope; projections via `fm brief --regen|--check`.
Mate-home directory structure is enforced by `fm home check` / `fm home repair` (not enumerated here).
Project-intrinsic knowledge → project `AGENTS.md` through worktree delivery; fleet-private → `data/`.
Secondmate charters stay ~40 lines: domain, escalation path, and definition of done only.

## Shared-template push scrub

Before pushing this reusable firstmate repository: confirm no personal-name/path/hostname leaks in tracked material, confirm untracked-local files are not staged, and confirm the push is fast-forward (or standing harness-layer `--force-with-lease` when cap policy authorizes it). Never bare `--force`. After an authorized harness-layer rewrite, the other laptop recovers with `fm update --adopt-remote`.

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
