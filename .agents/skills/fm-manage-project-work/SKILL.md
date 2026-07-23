---
name: fm-manage-project-work
description: Manage Firstmate project lifecycle.
---

# fm-manage-project-work

## Route and land

Resolve project every request; resolve secondmate scope only from `data/secondmates.md`; `data/projects.md` owns `pr`, `trunk`, and `+yolo`.
`trunk` never routes to a secondmate; `pr` may.
Use OMP subagents: scout for read-only and task for writes, review, and implementation.
For writes, write the brief, run pane-free `fm spawn` for isolated worktree metadata, then dispatch into the printed worktree.
Use visible FM workers only for cap-requested visibility or durable interactive recovery; persistent secondmates keep domain and stateful exceptions.
Serialize overlaps, parallelize otherwise, and keep all active or queued work traced to cap-frozen scope.
Ready is not landed: `fm accept` freezes candidate, `fm finish` lands, `fm revise` is pre-accept, and `fm tasks` alone mutates backlog.
Never merge a team/project PR without cap word unless `+yolo` grants routine approval; destructive, irreversible, and security-sensitive actions still escalate.
`trunk` finish authorizes local integrate; `pr` finish needs recorded PR URL and matching head SHA.

## Safety

Before pushing reusable firstmate repo, scrub tracked name, path, and host leaks; keep untracked-local files unstaged; push fast-forward unless harness policy authorizes `--force-with-lease`; never bare `--force`.
After authorized harness rewrite, the other laptop uses `fm update --adopt-remote`.
Never tear down a worktree unless HEAD reaches a remote-tracking branch, fork remotes count, except scout with report or cap-explicit discard.
