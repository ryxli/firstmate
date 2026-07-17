---
name: updatefirstmate
description: Synchronize the firstmate fleet and optional captain-configured local infrastructure through an observed-state, fast-forward-only workflow. Use when the captain asks to update, pull, rebase, or sync firstmate or configured local tooling.
user-invocable: true
---

# updatefirstmate

Use this skill as a deterministic synchronization procedure, not as a prose-only suggestion.
Never decide that a repository is current from a status captured before fetching its remote.
Never batch independent repositories into one opaque command.

## Firstmate fleet

Always run the generic firstmate fleet update before reading optional local targets:

```sh
sbin/fm-update.sh
```

This fast-forwards firstmate and registered secondmate homes only.
It must remain fast-forward-only, never stash, force, create merge commits, or touch project worktrees.
Observe and report every target line.
If it prints `reread-firstmate: yes`, re-read `AGENTS.md` before further work.
If it prints updated secondmate targets, send each one a short re-read nudge and observe its resulting pane state.

## Personal infrastructure update set

After the generic firstmate fleet update, read the optional `## Personal infrastructure update set` section in local `data/captain.md`.
Each bullet in that section names one additional checkout to synchronize through this procedure.

```markdown
## Personal infrastructure update set
- /path/to/checkout
```

Add repository-specific policy beneath its checkout bullet when needed.
If the section is missing or has no entries, update no optional repositories.
Do not infer unrelated directories as optional targets.
Never touch anything under `firstmate/projects/`.

## Mechanical state machine

`sbin/fm-update.sh` implements this machine natively for the firstmate repo and secondmate homes; run it rather than hand-executing the steps there.
Apply the steps manually only to configured local infrastructure the script does not cover.
For every such repository, complete and observe each state before taking the next action:

1. **Observe before fetch.**
   Capture `git status --short --branch`, the current branch, configured remotes, and whether the worktree is clean.
2. **Fetch one remote.**
   Run `git fetch <remote> --prune` for the selected authoritative remote.
   Do not pass multiple remote names as one command.
3. **Observe after fetch.**
   Re-read branch status and compare the local tip with the selected remote tip.
   The pre-fetch observation is now stale and must not drive a decision.
4. **Choose one safe action.**
   - Clean default branch behind `origin/main`: fast-forward with `git merge --ff-only origin/main`.
   - Clean default branch already at `origin/main`: leave it unchanged.
   - Dirty, diverged, non-default branch, missing remote, or no commits: leave it untouched and report the reason.
   - A fork with a separate upstream and a local patch: do not reset, force-push, or silently rebase it. Compare `origin` and `upstream`, then apply that repository's explicit fork policy or report the decision needed.
5. **Observe after action.**
   Re-read branch status and worktree cleanliness immediately after every fast-forward or rebase.
   Do not proceed to the next repository until the current result is recorded.

## Optional local infrastructure

For every configured local target, use the state machine above.
Honor any repository-specific policy documented alongside that target in `data/captain.md`.
If a configured target is a protected fork or has both `origin` and `upstream`, fetch and compare both remotes first.
Do not reset, silently rebase, or force-push until its documented fork policy and observed ancestry justify that action.
A diverged or ambiguous fork is a report, not an automatic repair.

Feature branches, scratch checkouts, local-only scaffolds, and dirty worktrees are not synchronized unless the captain names them and approves the branch-specific action.
## Reporting contract

Relay `fm-update.sh`'s native one-line-per-repository output (`<label>: updated <a>..<b>` / `already current` / `skipped: <exact reason>`), and keep manually synced targets in the same format.
Separate synchronized, already current, safely skipped, and requires-a-captain-decision.
Never report "already current" until after the remote fetch and post-fetch observation.

## Safety

- The fast-forward-only invariant (never force-push, reset, stash, merge-commit, or discard unlanded work) is owned by AGENTS.md; it applies to every action here.
- Never operate on more than one repository in a single opaque command.
- Never treat a stale pre-fetch status as current truth.
- Configured local source changes that require a documented post-sync action must complete and verify that action after source synchronization.
- Firstmate and secondmate operational state remains local and untouched by tracked-file updates.

## Global tool replacement

Before repointing a global AXI CLI to a fork, stop every live consumer, build the fork, replace the global package path, and pin the global manifest to the link.
Verify both the bare and `bunx` entrypoints resolve to the intended path and run a real command.
Version text alone is not proof of the selected source.
