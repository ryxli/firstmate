---
name: firstmate-recovery
description: Use at every session start, after bootstrap, to reconcile reality with records after a possible mid-flight restart - session lock, in-flight fleet, pane liveness, secondmate respawn, afk/idle-digest resume, Lavish steward relaunch.
---

# Firstmate recovery

This is the cold procedure reference extracted from the shared firstmate manual.
Read it at every session start, after bootstrap.

## 5. Recovery procedure

You may have been restarted mid-flight.
Reconcile reality with your records before doing anything else:

1. Run `sbin/fm lock` to acquire the session lock (it records the harness process PID, which is session-stable).
   If it refuses because another live session holds the lock, tell the captain another active session is already managing the work and operate read-only until resolved.
2. The supervision extension reloads automatically when this session starts and re-resolves the in-flight fleet from `state/*.meta`; there is no wake-queue to drain.
3. Read `data/backlog.md`, `data/secondmates.md` if present, every `state/*.meta`, and every `state/*.status`.
4. Use the `pane=` values from this home's `state/*.meta` files as the live direct-report set, then check those herdr panes via `herdr pane get <pane_id>`.
   Do not sweep every `fm-*` herdr pane across all workspaces during recovery; another firstmate home's child panes may share that namespace and are not this home's orphans.
5. If a recorded direct-report pane is missing or unreachable, reconcile it through its meta as described below.
6. For meta with no pane, reconcile by kind.
   For ordinary crewmates, check whether the worktree still exists under `$FM_WORKTREE_BASE/<id>`, salvage or report.
   For `kind=secondmate`, treat the secondmate as a dead persistent direct report and respawn it with `sbin/fm-spawn.sh <id> --secondmate` against the recorded `home=`.
   If the meta is missing but `data/secondmates.md` still registers the secondmate, respawn from the registry entry and its persistent on-disk home.
7. Do not reconstruct a secondmate's whole tree from the main home.
   The main firstmate reconciles only direct reports.
   Each secondmate is a firstmate in its own home, so it runs this same recovery procedure on startup and reconciles its own crewmates.
   A secondmate's recovery reconciles only work that is already its own; on finding no assigned or in-flight work it goes idle and waits for the main firstmate to route it a task, never initiating a survey or audit of its own (see `skill://firstmate-task-lifecycle`).
8. If `state/.afk` is present (away-mode was active before the restart): stay in afk - the supervision extension reloads with this session and honors `state/.afk` to batch escalations; just keep the flag set and follow `skill://afk`.
   If `state/.idle-digest.md` is present, an idle-digest loop was in flight before the restart: resume it through `skill://afk`; the helper preserves the refinement window and folded updates across restart.
9. Surface only what needs the captain: pending decisions, PRs ready to merge, failures, or needed credentials.
   If there is nothing that needs them, say nothing and resume.
10. The supervision extension is already running (it loaded with this session); there is nothing to arm.
    If `state/.afk` is present, follow `skill://afk` so relevant events remain batched into one digest.
11. Run `sbin/fm-lavish-open.sh --recover` to relaunch a steward for every still-open Lavish session this home owns that has no live steward.
    A restart must not leave an open artifact unattended.
