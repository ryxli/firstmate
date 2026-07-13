---
name: updatefirstmate
description: Synchronize the firstmate fleet and explicitly requested personal infrastructure repositories through an observed-state, fast-forward-only workflow. Use when the captain asks to update, pull, rebase, or sync firstmate, dotfiles, oh-my-pi, lavish, linear-axi, or related personal tooling.
user-invocable: true
---

# updatefirstmate

Use this skill as a deterministic synchronization procedure, not as a prose-only suggestion.
Never decide that a repository is current from a status captured before fetching its remote.
Never batch independent repositories into one opaque command.

## Sync set

When the captain asks to sync the personal infrastructure set, inspect these known checkouts one at a time:

```text
/Users/ryan/code/firstmate
/Users/ryan/.local/share/chezmoi
/Users/ryan/code/harness/oh-my-pi
/Users/ryan/code/harness/lavish-axi
/Users/ryan/code/harness/linear-axi
```

Also inspect explicitly named related checkouts.
Do not infer that an unrelated directory is part of the set.
Never touch anything under `firstmate/projects/`.

## Mechanical state machine

For every repository, complete and observe each state before taking the next action:

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

## Firstmate fleet

Run:

```sh
sbin/fm-update.sh
```

This fast-forwards firstmate and registered secondmate homes only.
It must remain fast-forward-only, never stash, force, create merge commits, or touch project worktrees.
Observe and report every target line.
If it prints `reread-firstmate: yes`, re-read `AGENTS.md` before further work.
If it prints updated secondmate targets, send each one a short re-read nudge and observe its resulting pane state.

## Personal infrastructure

For clean default branches in dotfiles, lavish-axi, or linear-axi, synchronize against `origin/main` using the state machine above.
After dotfiles advances, run `chezmoi apply` and then `chezmoi verify`; observe both results.

For oh-my-pi or any fork with both `origin` and `upstream`, treat the fork patch as protected work.
Fetch and compare both remotes first.
Do not reset to `origin/main`, rebase onto `upstream/main`, or force-push until the repository's explicit fork policy and the observed ancestry justify that action.
A diverged or ambiguous fork is a report, not an automatic repair.

Feature branches, scratch checkouts, local-only scaffolds, and dirty worktrees are not synced by this skill unless the captain names them and approves the branch-specific action.

## Reporting contract

Report one line per repository:

```text
<repo>: observed <state> -> action <action> -> observed <final state>
```

Separate:

- synchronized and verified
- already current
- skipped safely with an exact reason
- requires a captain decision

Never report “already current” until after the remote fetch and post-fetch observation.

## Safety

- Never force-push, reset, stash, create a merge commit, or discard unlanded work.
- Never operate on more than one repository in a single opaque command.
- Never treat a stale pre-fetch status as current truth.
- Personal dotfiles changes must be applied and verified after source synchronization.
- Firstmate and secondmate operational state remains local and untouched by tracked-file updates.
