---
name: fm-update-firstmate
description: >-
  Updates firstmate, secondmate homes, and configured local infrastructure. Use
  when the cap asks to update, pull, rebase, or sync firstmate tooling.
user-invocable: true
---

# fm-update-firstmate

Deterministic synchronization, not a prose suggestion.
Never decide a repository is current from a pre-fetch status.
Never batch independent repositories into one opaque command.
Distinct from `fm fleet-sync`, which refreshes project clones.

## Firstmate fleet

Always run first:

```sh
sbin/fm update
```

Fast-forward-only on firstmate and registered secondmate homes.
Never stash, force, merge-commit, or touch project worktrees.
If it prints `reread-firstmate: yes`, re-read `AGENTS.md`.
Nudge updated secondmates to re-read and observe pane state.

## Optional local infrastructure

After the fleet update, read local `data/update-targets.md` when present.
Each bullet is one extra checkout; missing file means no optional targets.
Never touch `firstmate/projects/`.
Do not preload this file into always-on context.

For each optional checkout the script does not cover:

1. Observe before fetch (`git status --short --branch`, branch, remotes, cleanliness).
2. `git fetch <remote> --prune` for one authoritative remote.
3. Observe after fetch; pre-fetch status is stale.
4. Safe action only: clean default behind `origin/main` → `git merge --ff-only origin/main`; already current → leave; dirty/diverged/non-default/missing remote → leave and report.
5. Observe after action before the next repository.

Forks with `origin` and `upstream`: compare both; do not reset, silently rebase, or force-push without documented fork policy.

## Reporting

Relay one line per repository (`updated` / `already current` / `skipped: <reason>`).
Never report "already current" until after fetch and post-fetch observation.

## Safety

Fast-forward-only invariant is owned by AGENTS.md.
One repository per opaque command.
Escalate force, reset, or ambiguous fork decisions to the cap.
