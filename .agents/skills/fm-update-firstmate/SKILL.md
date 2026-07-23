---
name: fm-update-firstmate
description: Update homes.
user-invocable: true
---

# fm-update-firstmate

Run `sbin/fm update` first; `fm fleet-sync` is only for project clones.
Invariant: fast-forward-only, no loss, no stash, force, reset, merge commit, or project worktree touch.
If `reread-firstmate: yes`, re-read named paths; load-once changes need fresh session.
Notify persistent secondmates by peer bus, observe `fm fleet`, and use `fm send` only for explicit reload or steering.
Optional targets live only in `$FM_HOME/data/update-targets.md` or fallback `data/update-targets.md`; missing means none, never preload.
For each uncovered checkout, inspect branch/remotes/cleanliness, fetch one authoritative remote with prune, inspect again, then only `--ff-only` merge a clean default branch behind resolved remote default.
Leave dirty/diverged/non-default/missing-remote/ambiguous forks unchanged; compare origin/upstream and escalate reset/rebase/force.
Report post-fetch `updated`, `already current`, or `skipped: <reason>`.
