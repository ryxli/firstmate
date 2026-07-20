---
name: firstmate-task-lifecycle
description: Use when adding or routing a project, creating or retiring a secondmate, dispatching or supervising project work, handling briefs, delivery, reviews, merges, teardown, or backlog state.
---

# Firstmate project and task lifecycle

Cold procedure for project registration, secondmate lifecycle, intake, dispatch, spawn, finish, and backlog mutation.
Lane whiteboard / peer bus / turn OS: `skill://lane-governance`.
Backlog command details: `fm tasks --help` (do not restate here).

## Prime-directive exceptions and push audit

**Project-write exceptions (AGENTS.md #1).** `fm fleet-sync` FF-only on the checked-out local default and prunes gone upstreams with no worktree; never touches herdr worktrees. `fm update` FF-only on this repo and seeded secondmate homes; never `projects/`. Cap-approved `fm finish <id>` (trunk) or guarded push when a trunk remote exists.

**Shared-template push audit.** Before pushing this repo, scrub personal names/paths/hostnames, confirm local dirs untracked, and state FF vs force-with-lease (harness-layer only).

## Project management

Projects live under `projects/`. Registry `data/projects.md`:

```markdown
- <name> [<mode>] - <one-line description> (added <date>)
```

Modes: `pr` (default) or `trunk`; optional `+yolo`. Only `trunk|pr` are valid - stale names warn and fall back to `pr` off. Do not dump knowledge here; project-intrinsic facts go in the project's `AGENTS.md` via crewmate delivery.

Secondmates: `data/secondmates.md` solely owns identity/scope. Projections: `data/mates/<id>/brief.md` and `<home>/data/charter.md`; manage with `fm brief --regen|--check <id>`. Seed via `fm home-seed`. Only `pr` projects route to secondmates; `trunk` stays with main. Idle-by-default. On create, move eligible queued work with `fm tasks mv ... --to <id>`.

**Project memory.** Project-intrinsic → project `AGENTS.md` through worktree delivery (`fm ensure-agents-md` when needed). Fleet/cap-private → `data/`. Firstmate never hand-writes project clones.

## Intake and spawn

Resolve project independently every request, then secondmate scope from `data/secondmates.md`. `trunk` never routes to a secondmate. Classify ship (default) vs scout (report at `data/<id>/report.md`). Serialize overlapping repo areas; otherwise parallelize.

```sh
sbin/fm spawn <id> projects/<repo> [--scout]
sbin/fm spawn <id> --secondmate
sbin/fm spawn id1=projects/r1 id2=projects/r2
```

Spawn records `mode`/`yolo`/`harness`/`kind` in meta and creates `fm/<id>` worktree for ship/scout. Fill brief `{TASK}` before spawn (acceptance criteria + literal return shape). Steer with short `fm send` lines only.

## Finish (operator surface)

Internals: `data/artifacts/<id>.json`. Diagnostics only: `fm artifact show <id> [--full]`.

| Verb | Role |
|---|---|
| `fm accept <id>` | Judgment: derive candidate from git, freeze verdict, close pane, queue integrate |
| `fm revise <id> --reason ...` | Pre-accept correction only (never reopens accepted) |
| `fm finish <id>` | Resumable drain: integrate → land → backlog close → cleanup |

```text
worker ready → fm accept <id> → fm finish <id> → closed
                 ↘ fm revise <id> (pre-accept)
```

- **trunk:** `finish` refuses if `fm/<id>` moved past the frozen accepted SHA; otherwise FF-merges that SHA, lands, closes backlog, cleans up. Running `finish` is the authorize step.
- **pr:** worker must push, open a PR, and report `done: PR <url>` (URL recorded on meta). `fm accept` refuses without that URL, and requires PR head SHA == candidate SHA and PR repo == project origin. `finish` observes the PR - not merged → `waiting <id>: PR not merged`; merged → land at remote merge SHA without updating local trunk.
- Compact receipts by default. `fm send` refused after accept. Dispose needs landed or explicit discard.

Scout: report then teardown. Secondmate retire: explicit `fm teardown <id>` only.

## Briefs

`fm brief <id> <repo>`: fill `{TASK}`, acceptance, return shape. Scout `--scout`; secondmate `--secondmate`. Status via `fm report` (quoted paths).

## Backlog

Mutate only via `fm tasks`. `fm finish` closes the backlog row when it lands. `fm tasks ready` schedules. Fleet default actionable-only; `--full` / `--state done` for history.

Promotion: `data/promote/` candidates; AGENTS.md disposition verbs; one owning home.
