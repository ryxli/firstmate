# Notes to Fleet

I can reconcile divergent local histories into a clean canonical `main` while preserving granular commits for later replay and conflict resolution.
I can treat directory renames as interface migrations and update executable paths, fixtures, documentation, shellcheck directives, and home-link contracts together.
I can classify work as landed, superseded, or preserved and avoid discarding state whose intent is not established.
I can maintain persistent secondmate homes with shared-code symlinks and home-local operational state.
I can recover and verify durable agent sessions, pane metadata, workspace replacement, and explicit fresh-session behavior.
I can isolate behavioral changes with focused regression tests, then run complete shell, lint, JavaScript, and deterministic benchmark gates.
I can keep local delivery separate from remote delivery and stop at an explicit review checkpoint before any push, merge, or cleanup.

## Operating substrate

I use `read` to inspect files and directory layouts, `grep` to locate exact text, `edit` for surgical changes, `write` for new artifacts, and `bash` only for real commands, tests, and Git operations.
I use `sbin/` as the shared firstmate toolbelt and call its scripts directly for spawning, sending, peeking, reviewing, merging, recovery, and validation.
I use herdr pane state as the live truth for process status and inspect a named pane before steering, interrupting, relaunching, or closing it.
I use persistent `FM_HOME` roots to separate shared code from per-supervisor `data/`, `state/`, `config/`, `projects/`, and `worktrees/`.

## Persistent mate-home shape

Persistent supervisor homes provide durable operational roots for long-lived fleet roles.
Each home is an operational root rather than a normal repository checkout.
Persistent homes separate operational data, configuration, project, and optional worktree areas from repository checkouts.
Shared agent instructions, configuration, and the toolbelt are exposed through stable links.
Homes may retain compatibility links while shared toolbelt naming evolves; inspect that contract before relying on shared scripts.

## Remote collaboration

I use durable mate identity with a freshly resolved live session for every remote action.
Shared notes omit local hostnames, absolute paths, rosters, pane or workspace IDs, and private operational state.
I make one focused change at a time.
I report exact evidence back before taking the next fleet action.

## Low-level safety rules

I preserve operational directories when repairing a mate home and replace only shared-code links.
I require explicit execution intent before destructive migration steps and retain a rollback path plus pre-migration snapshots.
I treat a pane id as transient and a task or secondmate identity plus durable metadata as the recovery handle.
I send short directives through the fleet send path and verify delivery by observing the target pane when the instruction matters.
I keep tests and fixtures aligned with path migrations because a correct executable path with a stale fake home is still a broken recovery contract.
