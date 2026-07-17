---
name: firstmate-bootstrap
description: Use at every session start, before anything else, to detect missing tools or auth, get captain consent, and run bootstrap's fleet sync and capability checks.
---

# Firstmate bootstrap

This is the cold procedure reference extracted from the shared firstmate manual.
Read it at every session start, before any other decision.

## 3. Bootstrap procedure

Bootstrap is detect, then consent, then install.
Never install anything the captain has not approved in this session.

Run `sbin/fm-bootstrap.sh`.
Bootstrap also refreshes the fleet via `sbin/fm-fleet-sync.sh`: it fetches each remote-backed clone, clean-fast-forwards its local default branch when safe, and prunes local branches whose upstream is gone and that no worktree still needs, best-effort and non-fatal.
Set `FM_FLEET_PRUNE=0` to temporarily disable that branch pruning.
Silence means all good: say nothing and move on.
Otherwise it prints one line per problem or capability fact; handle each:

- `MISSING: <tool> (install: <command>)` - list the missing tools to the captain with a one-line purpose each plus the printed install commands, wait for consent (one approval may cover the list), then run `sbin/fm-bootstrap.sh install <approved tools...>`.
- `NEEDS_GH_AUTH` - ask the captain to run `! gh auth login` (interactive; you cannot run it for them).
- `CREW_HARNESS_OVERRIDE: <name>` - record and use the override silently; surface a harness fact only if it actually blocks work or the captain asks.
- `FLEET_SYNC: <repo>: skipped: <reason>` - bootstrap continued; investigate only if the dirty, diverged, or offline clone blocks work.
- `TASKS_AXI: available` - an optional capability fact, not a problem; record it silently and never surface it to the captain.
  Bootstrap prints this only after the `tasks-axi` compatibility probe passes for version 0.1.1 or newer.
  When a compatible `tasks-axi` is on PATH, firstmate routes routine `data/backlog.md` mutations through its verbs instead of hand-editing the file, exactly as `skill://firstmate-task-lifecycle` describes.
  When `tasks-axi` is absent or fails the compatibility probe, firstmate hand-edits `data/backlog.md` exactly as before, so the silent guarantee that backlog bookkeeping keeps working holds either way.
  It is never a missing tool to install: its absence or incompatibility only falls back to hand-editing and never blocks work.

Bootstrap's fleet refresh is bounded by `FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT` seconds, default 20; a timeout is reported as a `FLEET_SYNC` skip and does not block startup.

After bootstrap, run `sbin/fm identity-migrate check` and resolve any `UNRESOLVED` named-home identity before routing work.
Run `sbin/fm home-link <home> --check` for every registered home, including nested secondmate registries; use `--repair` only for an observed link drift.
Run `sbin/fm fleet` for the compact overview, then `sbin/fm fleet --check` when a gate needs a nonzero result; activation, health, topology, and attention remain visible in the TOON output, and non-fresh or incomplete state fails the check.
When a load-once source changed, restart affected OMP sessions before trusting the new extension or instructions.
If bootstrap reports that the Herdr reporter patch needs a restart, restart OMP panes first, then rerun bootstrap to verify activation.

Then read `data/projects.md`, the fleet registry, to load what each project is.
If it is missing or disagrees with what is actually under `projects/`, rebuild it from the clones (a README skim per project is enough) before taking on work.
Then read `data/secondmates.md` if present so intake can route work by registered secondmate scope (see `skill://firstmate-task-lifecycle`).
Then read `data/captain.md` if present, to load this captain's curated preferences and working style.
If it is absent, use this template's defaults with no special preferences.
Treat any harness memory of these preferences as a recall cache only; `data/captain.md` is the canonical, harness-portable home.

Do not dispatch any work until the tools that work needs are present and GitHub auth is good.
Use `gh-axi` for all GitHub operations, `chrome-devtools-axi` for all browser operations, and `lavish-axi` when a decision or report is complex enough to deserve a rich review surface.
Do not memorize their flags; their session hooks and `--help` are the source of truth.
If the captain names a different crewmate harness at bootstrap or later, write it to `config/crew-harness` (local, gitignored); that is the whole switch.
