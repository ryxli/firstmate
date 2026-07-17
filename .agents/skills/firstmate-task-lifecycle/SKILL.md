---
name: firstmate-task-lifecycle
description: Use when adding or routing a project, creating or retiring a secondmate, dispatching or supervising project work, handling briefs, delivery, reviews, merges, teardown, or backlog state.
---

# Firstmate project and task lifecycle

This is the cold procedure reference extracted from the shared firstmate manual.
Read it before project registration, secondmate lifecycle work, task intake, dispatch, spawn, validation, merge, promotion, teardown, backlog mutation, or brief generation.
References to sections 6, 7, 10, and 11 below refer to the preserved headings in this skill.

## Prime-directive exceptions and push audit

**Sanctioned project-write exceptions (AGENTS.md hard rule #1).** The fleet sync exception (`sbin/fm-fleet-sync.sh`) advances only the checked-out local default branch (never forcing it, creating merge commits, or stashing) and otherwise deletes only local branches whose upstream tracking branch is gone and that have no worktree; it never removes or changes a herdr-managed worktree, so it cannot discard unlanded work.
The self-update exception (`sbin/fm-update.sh`) is likewise fast-forward only, skips dirty/diverged/off-default targets, never stashes or forces, and touches only this firstmate repo plus seeded secondmate homes, never anything under `projects/`.

**Shared-template push audit (AGENTS.md hard rule #2 / repo stewardship).** Before pushing this reusable firstmate repository, inspect the tracked change set for personal names, fleet identities, absolute home paths, hostnames, and tracked operational directories.
Scrub genuine leaks to the repository's generic default, confirm local `config/`, `data/`, `state/`, `projects/`, `.no-mistakes/`, and `.lavish/` material is untracked, and state whether the remote update is fast-forward or would require a force.

## 6. Project management

All projects live flat under `projects/`.

`data/projects.md` is firstmate's thin navigation registry.
Every project in the fleet has one line:

```markdown
- <name> [<mode>] - <one-line description> (added <date>)
```

The registry line records the project name, delivery mode, optional `+yolo` posture, and one-line description.
Add the line when you clone or create a project, keep the description useful for identifying the project, and drop the line if a project is ever removed from `projects/`.
Do not turn the registry into a knowledge dump.
Durable descriptive detail belongs in the project's own `AGENTS.md`.

`data/secondmates.md` is the secondmate routing table.
Every persistent secondmate has one line:

```markdown
- <id> - <charter summary> (home: <absolute-home-path>[; workspace: <herdr-workspace-id>]; scope: <natural-language responsibility>; projects: <project-a>, <project-b>; added <date>)
```

The `scope:` field is used during intake; the `projects:` field is a non-exclusive clone list, not ownership.
`data/secondmates.md` is the only hand-edited home for a secondmate's identity and scope.
`data/<id>/brief.md` and `<home>/data/charter.md` are generated projections of this registry line plus a tracked template, not separate sources of truth.
Regenerate both with `sbin/fm-brief.sh --regen <id>` after editing the registry, and verify them with `sbin/fm-brief.sh --check <id>`, which exits nonzero and names any projection that has drifted from what the registry would generate.
Each projection carries exactly one mate-owned free-form section, delimited by marker comments, that a live secondmate may edit and that survives regeneration verbatim; hand-edit a charter or brief only inside that section, never elsewhere.
Use `sbin/fm-home-seed.sh <id> <home|-> <project>...` after scaffolding the charter to provision the persistent home and registry entry; `-` creates a herdr-managed git worktree of the firstmate repo at `<parent-of-repo>/fm-sm-<id>` and records the herdr workspace ID in the registry.
The workspace ID is the durable handle for the home: teardown calls `herdr worktree remove --workspace <id>` to release the slot cleanly; a home without a workspace ID in the registry is a plain clone and is removed with `rm -rf`.
The home persists with no live process and is never recycled by herdr until explicitly released; that release happens only on explicit retirement or seed rollback, never on a routine restart or recovery.
The charter must be filled before seeding; direct seed without a preexisting brief requires `FM_SECONDMATE_CHARTER`.
Seeding is transactional: if validation, cloning, or registry update fails, generated briefs, new homes, new project clones, and registry edits are rolled back.
`sbin/fm-home-seed.sh validate` refuses duplicate ids, duplicate homes, and nested or overlapping homes.
Secondmate project lists may include `direct-PR` projects only; `local-only` projects stay with the main firstmate.

A secondmate is idle by default: it acts only on work the main firstmate routes to it.
On startup and restart it runs bootstrap and recovery solely to reconcile work that is already its own - in-flight crewmates, tracked backlog items, and durable watches in its home - and then waits silently for routed work.
It must never spawn a survey, audit, or self-directed "find improvements" task on its own initiative; an empty queue is a healthy resting state, not a cue to invent work.
This idle contract is encoded in the charter brief (section 11), so it travels with the live secondmate as well as living here.

**Hand off in-scope backlog on creation.**
When a secondmate is created for a domain, the existing main-backlog items that fall under its scope should become its work instead of staying stranded in the main backlog.
Scope-matching is firstmate's judgment against the secondmate's natural-language scope, not a keyword rule: read `data/backlog.md`, pick the queued items that fit the new scope, and move them with `sbin/fm-backlog-handoff.sh <secondmate-id> <item-key>...`.
The helper resolves the secondmate home from `data/secondmates.md` and mechanically moves each named item from the main `data/backlog.md` into the secondmate home's `data/backlog.md`, preserving the line and its section, so the item is neither duplicated nor lost.
It refuses `## In flight` entries because active task ownership also lives in herdr and `state/`.
It is idempotent (an item already in the secondmate backlog is skipped) and refuses any destination that is not a genuine seeded firstmate home with safe operational directories and a matching `.fm-secondmate-home` marker, so a move can never land in a project.
Do not hand off `local-only` items: that work stays with the main firstmate (section 7).

### Project memory ownership

Firstmate keeps project knowledge split by ownership.

**Project-intrinsic knowledge** belongs to the project.
These are facts that help any agent working in the repo and should travel with the code: build, test, release mechanics, architecture conventions, and sharp edges such as "needs Xcode 26 to compile" or "releases via release-please with `homemux-v*` tags".
This knowledge lives in the project's committed `AGENTS.md`.
A project's `AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it.

**Fleet and captain-private knowledge** belongs to firstmate.
Delivery mode, `+yolo` posture, in-flight work, captain product strategy, and go-live state live in firstmate's `data/`, including the `data/projects.md` registry line and any planning docs.
Do not put that knowledge in the project.
It is not the project's business, and it must stay where firstmate can write it directly.

This does not relax prime directive #1.
Firstmate does not hand-write project `AGENTS.md` files into clones, because that would dirty the clone and bypass the gate.
Project `AGENTS.md` files are created and updated by crewmates inside their worktrees, committed through the project's delivery pipeline, exactly like any other project change.
Firstmate ensures this through the brief contract and `sbin/fm-ensure-agents-md.sh`; firstmate does not perform the write itself.
Firstmate's own not-yet-committed project knowledge lives in `data/` until a crewmate folds it into the project's `AGENTS.md`.

Create a project's `AGENTS.md` lazily on first need.
The first ship task that touches a project lacking one and has durable project-intrinsic knowledge to record should run `sbin/fm-ensure-agents-md.sh`, add that knowledge, and commit both through the normal project delivery pipeline.
Do not eagerly backfill every project.

**Delivery mode (choose at add).** `<mode>` is how a finished change reaches `main`, picked per project when you add it and recorded in the registry line (`fm-project-mode.sh` parses it; `fm-spawn` records it into each task's meta):

- `direct-PR` (default; `[...]` may be omitted) - push + open a PR via `gh-axi`, backed by focused review and tests, with no separate pipeline -> captain merge.
- `local-only` - local branch, no remote, no PR; firstmate reviews the diff, the captain approves, firstmate merges to local `main` (section 7).
- `no-mistakes` - legacy alias retained so old registry lines still parse; treated as `direct-PR`, and the no-mistakes pipeline is no longer invoked.

Orthogonal to mode is an optional `+yolo` flag (`[direct-PR +yolo]`), default off and **not recommended**: with `yolo` on, firstmate makes the approval decisions itself instead of asking the captain (section 7).
When the captain adds a project without saying, default to `direct-PR` with yolo off; only set `local-only` or `+yolo` on the captain's explicit say-so.

**Clone existing:** `git clone <url> projects/<name>`, then add its registry line with the chosen mode.

**Create new:** a `direct-PR` project needs a GitHub repo first (it pushes to an `origin` remote); a `local-only` project needs no remote at all - a purely local git repo is fine.
Creating a GitHub repo is outward-facing, so get the captain's consent before touching GitHub: propose the repo name, owner/org, visibility (default private), and delivery mode, and create with `gh-axi` only after the captain confirms.
Then clone it into `projects/<name>`.
For `local-only`, create the local repo under `projects/<name>` and skip GitHub entirely.

There is no separate validation pipeline to install or run: a change reaches `main` through focused review and tests plus the captain's merge.

### Promotion path (mate knowledge to canonical home)

A mate flags promotion-worthy knowledge by dropping the file (or a pointer note) into its home's `data/promote/` directory; that directory is the single promotion inbox, and a `promote:` status line only announces that something landed there.
Firstmate reviews each flagged item and classifies it with the disposition vocabulary owned by AGENTS.md section 1 (keep/merge/relocate/compile/quarantine/drop).
A promoted fact lands in exactly one canonical home per the layer contract: tracked template surface (sbin/, skills, benchmarks, AGENTS.md) for domain-generic material, the owning mate's home for domain knowledge, local data/ for fleet records.
After landing, regenerate any projections (`sbin/fm-brief.sh --regen <id>`) and record the disposition in the mate's promote inbox (move the flagged file to `data/promote/done/` with a one-line verdict header) so the mate sees the outcome.
Tracked landings ride the normal main-only commit flow and reach the other laptop on sync; nothing is promoted by copying a file to a second home without a recorded disposition.

## 7. Task lifecycle

### Intake

**Resolve the project first.**
The captain will rarely name the project explicitly, and may juggle several projects across messages.
Resolve each message independently; never assume the last-discussed project out of habit.
Use these signals in order:

1. An explicit project name in the message wins.
2. A clear follow-up ("also add tests for that", a reply to a PR you reported) inherits the project of the thing it refers to.
3. Otherwise, match the message content against what you know: project names under `projects/`, in-flight tasks in `data/backlog.md`, and the projects' own code and READMEs (read them; that is what your read access is for). A mentioned feature, file, stack trace, or technology usually points at exactly one project.
4. One confident match: proceed, but state the project in plain outcome language in your reply ("I'll work on this in `yourapp`") so a wrong guess costs one correction instead of wasted work.
5. More than one plausible match, or none: ask a one-line question. A misdirected dispatch is recoverable because crewmates work in isolated worktrees, but it is expensive; a question is cheap.

Then resolve the secondmate scope.
Read `data/secondmates.md` before dispatching and compare the work request to each registered `scope:`.
Route by the nature of the task, not just the project name.
A project may appear in several `projects:` clone lists, so choose the secondmate whose natural-language scope actually fits the work, such as triage versus feature development.
If the resolved project is `local-only`, keep the work with the main firstmate even when a secondmate scope sounds relevant.
If a secondmate's scope fits, steer that secondmate with one concise instruction via `sbin/fm-send.sh fm-<id> '<work request>'` and let it run the normal lifecycle inside its own home.
The bare `fm-<id>` target resolves through this home's `state/<id>.meta`; pass a pane id directly only when intentionally targeting a pane outside this firstmate home.
Do not spawn a direct crewmate for work that belongs to a secondmate scope unless the secondmate is blocked or the captain explicitly redirects it.
If no secondmate scope fits, proceed in the main firstmate or create a new secondmate with the captain when that domain should become persistent.
When you create a new secondmate, hand its in-scope queued items off from the main backlog into its home with `sbin/fm-backlog-handoff.sh` so it owns its domain's queue from day one (section 6).

Then classify the shape:

- **Ship** (the default): the deliverable is a change to the project. It ships through the project's delivery mode: `direct-PR` or `local-only`.
- **Scout:** the deliverable is knowledge - an investigation, a plan, a bug reproduction, an audit. It ends in a report at `data/<id>/report.md`, never a PR. When the captain asks "what's wrong", "how would we", or "find out why" about a project, that is a scout task; dispatch it instead of doing the digging yourself.

Then classify readiness:

- **Dispatchable:** no overlap with in-flight tasks. Dispatch immediately. There is no concurrency cap.
- **Blocked:** touches the same files or subsystem as an in-flight task, or explicitly depends on an unmerged PR. Record it in `data/backlog.md` with `blocked-by: <id>` and tell the captain what work is waiting and why. Scout tasks are read-mostly and almost never block on anything.

Keep dependency judgment coarse: same repo plus overlapping area means serialize; everything else runs parallel.
If work overlaps, have the crewmate rebase before review or merge.

### Throughput discipline

Wall-clock throughput, terminal-event reporting, and post-compaction snapshot discipline are owned by AGENTS.md's turn decision sections; apply them here.
Write the brief per section 11.
**Parallel fanout safety.** Freeze shared contracts before implementation fanout, assign exclusive file ownership including an owner for every overlap, and give each lane a focused check plus a salvage-patch path.
Use cheap or capped capacity only for bounded, one-file mechanical work or read-only collection; implementation that spans files, tests, coordination, live safety, uncertain interfaces, or uncommitted state requires a strong tier.
After a cap death, save the partial diff only as untrusted reference, reset the owned files clean, and relaunch on a suitable tier; after a second death in the same wave, correct the tier for the entire wave rather than retrying cheap capacity.

### Spawn

```sh
sbin/fm-spawn.sh <id> projects/<repo>             # uses the active crewmate harness
sbin/fm-spawn.sh <id> projects/<repo> codex       # per-task harness override
sbin/fm-spawn.sh <id> projects/<repo> --scout     # scout task; records kind=scout in meta
sbin/fm-spawn.sh <id> --secondmate                 # launch a registered persistent secondmate in its home
sbin/fm-spawn.sh <id> <firstmate-home> --secondmate   # launch or recover an explicit secondmate home
sbin/fm-spawn.sh <id1>=projects/<repo1> <id2>=projects/<repo2> [--scout]   # batch: one call, several tasks
```

Dispatch several tasks in one call by passing `id=repo` pairs instead of a single `<id> <project>`; each pair is spawned through the same single-task path, a shared `--scout` applies to all, and the looping happens inside the script so you never hand-write a multi-task shell loop.
If one pair fails, the rest still run and the batch exits non-zero.

The script resolves the harness (`fm-harness.sh crew`), owns the verified launch templates, resolves the project's delivery mode (`fm-project-mode.sh`) for ship/scout tasks, and records `harness=`, `kind=`, `mode=`, `yolo=`, and `pane=` in the task's meta; a non-flag third argument containing whitespace is treated as a raw launch command (only for verifying new adapters).
For `kind=secondmate`, the same script launches in the registered or explicit firstmate home instead of creating a project worktree, records `home=` and `projects=`, and uses the charter brief as the launch prompt.

For ship and scout tasks, the script creates a git worktree via `git worktree add -b "fm/<id>" "$FM_WORKTREE_BASE/<id>" HEAD`, launches the agent with `herdr agent start "fm-<id>" --cwd <worktree>`, parses the returned `pane_id`, records `state/<id>.meta`, and submits the brief.
For `kind=secondmate`, the script launches directly in the persistent home instead.
Project worktrees start on a fresh branch off the default; ship briefs tell the crewmate to use that branch, while scout briefs keep the worktree scratch.
After spawning, peek the pane to confirm the crewmate is processing the brief (and handle any trust dialog per section 4).
Add the task to `data/backlog.md` under In flight.
For omp, the `herdr agent start` slot must be globally unique per task, while the integration-reported identity remains `omp`; use `herdr pane rename` only for the display label and NEVER `herdr agent rename`, which breaks status binding.
Before raw typing into a human shell pane, read its prompt for a pending draft; “type” means text only and never implies Enter.

### Supervise

Covered by section 8.
Steer a crewmate only with short single lines via `sbin/fm-send.sh`; anything long belongs in a file the crewmate can read.
Steer a secondmate the same way.
Its charter escalates per the peer bus discipline owned by AGENTS.md: captain-relevant outcomes only, routine internal churn never touches the supervisor channel.
A successful steer send proves only queued delivery, not that the target consumed or acted on it.
For time-sensitive steers, peek promptly and distinguish sent, queued, observed, and acted-on; nudge once or use the existing stuck-crewmate ladder only when the queued instruction is urgent, rather than duplicating steers or interrupting productive work.

### Delivery modes and yolo

A ship task's path from `done` to landed on `main` is set by the project's `mode` (recorded in meta; section 6); `yolo` decides who approves. The PR ready / Ship teardown stages below apply per mode:

- **direct-PR** (default) - the crewmate does focused review and tests, pushes, and opens the PR itself (its brief says so) and reports `done: PR <url>`. Firstmate runs `fm-pr-check` and relays the PR. Teardown uses the normal pushed-branch check.
- **local-only** - no remote, no PR. The crewmate stops at `done: ready in branch fm/<id>`. Review the diff with `sbin/fm-review-diff.sh <id>`, relay a one-paragraph summary to the captain, and on approval run `sbin/fm-merge-local.sh <id>` to fast-forward local `main` (it refuses anything but a clean fast-forward - if it does, have the crewmate rebase). No `fm-pr-check`. Then teardown, whose safety check requires the branch already merged into local `main`, OR the work pushed to any remote (a fork counts - relevant for upstream-contribution PRs on a local-only-registered project).
- **no-mistakes** - legacy alias; treated exactly as **direct-PR** (no pipeline is run).

When reviewing any crewmate branch diff, use `sbin/fm-review-diff.sh <id>` rather than `git diff <default>...branch` directly.
Pooled clones keep their local default refs frozen at clone time and can lag `origin`; the helper always compares against the authoritative base.

**yolo (orthogonal).** With `yolo=off` (default) every approval is the captain's: ask-user findings, PR merges, the local-only merge. With `yolo=on`, firstmate makes those calls itself without asking - resolve ask-user findings on your judgment, and run `gh-axi pr merge` / `sbin/fm-merge-local.sh` once the work is green/approved - EXCEPT anything destructive, irreversible, or security-sensitive, which still escalates to the captain. Never merge a red PR even under yolo. After any merge you perform without asking the captain, post a one-line "merged <full PR URL or local main> after checks passed" FYI so the captain keeps a trail.

### Validate

There is no separate firstmate-triggered validation pipeline.
A ship crewmate runs the project's own focused checks (the tests and lints it already uses) and reviews its own diff before it reports `done` - for `direct-PR` before opening the PR, for `local-only` before reporting `ready in branch`.
Firstmate's validation is review, not a pipeline: for `direct-PR`, read the opened PR and its CI if the project runs CI; for `local-only`, read the branch diff with `sbin/fm-review-diff.sh <id>`.
Relay anything that needs a decision to the captain unless `yolo=on` permits routine approval on your judgment.
Use chat for yes/no decisions; use lavish-axi when there are multiple findings or options to triage.

**Repeated-miss completion gate.** When a change has missed the same semantic target more than once, normal focused checks are not enough to call it finished.
Freeze the contract into a semantic matrix before the next implementation attempt: each row states the input or event, expected behavior, acceptable exceptions, and observable proof.
The finished report must include the approved matrix, a representative live fleet scenario, and attribution for whether each observed session was unchanged since the miss or freshly restarted.
If live evidence contradicts the matrix, roll the change back or keep the task open; contradictory live evidence beats a passing isolated check.

**Boundary, verdict, and review contracts.**
Review and evidence safeguards are owned by AGENTS.md; before parallel lane work, publish a machine-checkable edge table (producer, consumer, artifact path, allowed trigger, machine check) and attach verdict authority to the evidence producer, never the consumer.

### PR ready

For PR-based ship tasks (`direct-PR`), the crewmate reports `done: PR <url>` after opening the PR, adding `checks green` once the project's CI (if any) is green.
Run `sbin/fm-pr-check.sh <id> <PR url>` - it records `pr=` in the task's meta and registers a merge check for the supervision extension's poll timer.
Tell the captain: the PR's full URL (always the complete `https://...` link, never a bare `#number` - the captain's terminal makes a full URL clickable) and a one-paragraph summary.
(The check contract, for any custom `state/<id>.check.sh` you write yourself: print one line only when firstmate should wake, print nothing otherwise, and finish before `FM_CHECK_TIMEOUT`.)

If the captain says "merge it", run `gh-axi pr merge` yourself; that instruction is the explicit approval. If `yolo=on`, merge a green/approved PR yourself and post the required FYI.

### Ship teardown (only after merge is confirmed)

```sh
sbin/fm-teardown.sh <id>
```

The script refuses if the worktree holds unpushed work; treat a refusal as a stop-and-investigate, not an obstacle.
Known benign case: after an external-PR task, a squash merge leaves the branch commits reachable only on the contributor's fork; add the fork as a remote and fetch (`git remote add fork <fork url> && git fetch fork`), then retry - never reach for `--force`.
After a successful PR-based teardown, it also runs `sbin/fm-fleet-sync.sh` for that project, best-effort, so the clone's local default catches up to the merge and the just-merged branch, now gone on the remote and free of its worktree, is pruned immediately.
Then update the backlog using the teardown reminder: run `tasks-axi done` when the compatible tool is available, otherwise move the task to Done in `data/backlog.md` manually with the full `https://...` PR URL or local merge note and date and keep Done to the 10 most recent.
Re-evaluate the queue and dispatch only queued work whose blockers are gone and whose time/date gate, if any, has arrived.

### Secondmate teardown (explicit only)

A secondmate is persistent by default.
An empty queue is healthy and does not trigger teardown.
Run `sbin/fm-teardown.sh <id>` for `kind=secondmate` only when the captain or main firstmate explicitly decides to retire that persistent supervisor.
The safety check is the secondmate's own home: teardown refuses while its `state/*.meta` contains in-flight work.
When it is safe, teardown closes the direct herdr pane, removes the `data/secondmates.md` route, clears the main home metadata, and removes the retired secondmate home.
For herdr-managed homes (those with a `workspace:` field in `data/secondmates.md`), teardown calls `herdr worktree remove --workspace <id>` to remove the worktree and release the slot; a plain-clone home with no workspace field is removed directly with `rm -rf`.
If `herdr worktree remove` fails, teardown stops with state intact rather than raw-removing the directory and hiding a still-live workspace.
With `--force`, teardown is the explicit discard path: it closes child herdr panes, discards child work and state inside the secondmate home, removes the route, removes the workspace, and removes the retired secondmate home.

### Scout tasks (report instead of PR)

A scout task follows Intake, Spawn, and Supervise exactly as above - scaffold the brief with `sbin/fm-brief.sh <id> <repo> --scout`, spawn with `--scout` - then diverges after the work:

- There is no Validate or PR-ready stage. When the crewmate's status says `done`, read `data/<id>/report.md`.
- Relay the findings to the captain: plain chat for a focused answer, lavish-axi when the report has structure worth a visual (multiple findings, options, a plan).
- Tear down immediately - no merge gate. `sbin/fm-teardown.sh` allows a scout worktree's scratch commits and dirty files once the report exists; if the report is missing, it refuses, because the findings are the work product.
- Record it in Done with the report path instead of a PR link using `tasks-axi done` when compatible tasks-axi is available, otherwise hand-edit `data/backlog.md` and keep Done to the 10 most recent, then re-evaluate the queue and dispatch only queued work whose blockers are gone and whose time/date gate, if any, has arrived.

**Promotion.** When a scout's findings reveal shippable work (a reproduced bug with a clear fix) and the captain wants it shipped, promote the task in place instead of respawning: run `sbin/fm-promote.sh <id>` (flips `kind=` to ship in meta, restoring teardown's full protection), then send the crewmate its ship instructions - inventory scratch state, reset to a clean default-branch base, carry over only intended fix changes, create branch `fm/<id>`, implement, and report `done` according to the project's delivery mode.
The crewmate keeps its worktree, loaded context, and repro, but the ship branch must start from a clean base with only intended changes; scratch commits and debug edits from the scout phase never ride along.
The repro becomes the regression test.
From there the task is an ordinary ship task through its mode-specific validation, PR or local merge, and Teardown.

## 10. Backlog format

`data/backlog.md` is the durable queue.
Update it on every dispatch, completion, and decision.

```markdown
## In flight
- [ ] <id> - <one line> (repo: <name>, since <date>)

## Queued
- [ ] <id> - <one line> (repo: <name>) blocked-by: <id> - <reason>

## Done
- [x] <id> - <one line> - <https://github.com/owner/repo/pull/number> (merged <date>)
- [x] <id> - <one line> - local main (merged <date>)
- [x] <id> - <one line> - data/<id>/report.md (reported <date>)
```

Re-evaluate Queued on every teardown and every heartbeat: anything whose blocker is gone and whose time/date gate, if any, has arrived gets dispatched.

Keep Done to the 10 most recent entries; prune older ones whenever you add to the section.
Every finished PR-based ship task lives on as its GitHub PR, every local-only ship task lives on in local `main`, and every scout task lives on as its report file, so pruning loses nothing; the retained tail exists only as cheap recent context for recovery and heartbeats.

A tracked `.tasks.toml` at this repo root pins the `tasks-axi` markdown backend to `data/backlog.md`, with `done_keep = 10` and an archive at `data/done-archive.md`.
When a compatible `tasks-axi` is on PATH, firstmate mutates the backlog through its verbs instead of hand-editing, with secondmate handoffs still going through the validated helper described in section 6.
Compatible means the shared bootstrap probe accepts `tasks-axi --version` as 0.1.1 or newer.
The `## In flight` / `## Queued` / `## Done` format above stays the contract: the verbs edit `data/backlog.md` in place, byte-exact, preserving whatever item forms the file already uses - the bold in-flight `- **<id>**` form, the `- [ ]`/`- [x]` queued and done forms, and `blocked-by: <id> - <reason>` - rather than reformatting them.
Map firstmate's real backlog operations to the approved commands:

- File an item: `tasks-axi add <id> "<one line>" --kind <ship|scout> --repo <name>`, plus `--start` for immediate dispatch (In flight) or the default queue placement, and `--blocked-by <id>` (repeatable) when it waits on another task.
- Start an existing queued item: `tasks-axi start <id>` before dispatching work from Queued, after checking that blockers are gone and any time/date gate has arrived.
- Move a finished task to Done: `tasks-axi done <id> --pr <url>` for a PR-based ship, `--report <path>` for a scout, or `--note "local main"` for a local-only merge.
- Append a status note: `tasks-axi update <id> --append "<note>"`; replace fields with `--title`, `--body`, or `--body-file <path>`.
- Manage dependencies: `tasks-axi block <id> --by <other>` and `tasks-axi unblock <id> --by <other>`, then `tasks-axi ready` to list queued work with no unresolved blockers.
  This is a dependency check only; future-dated items still stay queued until their date arrives.
- Read an item's full notes: `tasks-axi show <id> --full`.
- Hand a task off to a secondmate home: keep using `sbin/fm-backlog-handoff.sh <secondmate-id> <item-key>...`; do not call bare `tasks-axi mv` for this path, because the helper resolves and validates the secondmate home before moving anything.
- Normalize the file: `tasks-axi render` rewrites every id'd task in canonical form and leaves free-form lines untouched.

`tasks-axi done` auto-prunes Done to `done_keep = 10` and archives the pruned entries to `data/done-archive.md`, which supersedes the manual "keep Done to the 10 most recent" pruning above: when compatible `tasks-axi` is present you do not hand-prune Done, and nothing is lost because pruned entries are archived rather than deleted.
When `tasks-axi` is absent or fails the compatibility probe, every firstmate home (main and each secondmate) hand-edits `data/backlog.md` exactly as this section describes, including the manual Done pruning.
Secondmates inherit this automatically: each secondmate home carries the same `AGENTS.md` and its own `.tasks.toml`, so the same present-or-absent rule applies in every home with no separate setup.

**Productivity log.** Firstmate maintains a weekly productivity log at `data/productivity-log.md` (local, gitignored, temporary - may migrate to an external system).
Update it on task teardown with cycle time and escalation count; close each week's entry at the first session of the following Monday.
Secondmates contribute their segment on firstmate's request or at week close; format and schema are defined in the file header.

## 11. Crewmate briefs

Scaffold with `sbin/fm-brief.sh <id> <repo-name>` - it writes `data/<id>/brief.md` with the standard contract (branch setup, status-reporting protocol, push/merge rules, definition of done) and all paths filled in.
For a ship task the definition of done is shaped by the project's delivery mode (section 6): `direct-PR` has the crewmate do focused review and tests, then push and open the PR itself, while `local-only` has it stop at "ready in branch" for firstmate to review and merge locally.
The scaffold reads the mode via `fm-project-mode.sh`, so you do not pass it.
Ship briefs also include the project-memory contract: run `sbin/fm-ensure-agents-md.sh` when the project already has agent-memory files or when the task produced durable project-intrinsic knowledge, then record proportionate learnings in `AGENTS.md`.
For scout tasks add `--scout`: the scaffold swaps the definition of done for the report contract (findings to `data/<id>/report.md`, no branch, no push, no PR) and declares the worktree scratch; scout is mode-agnostic.
Scout briefs do not include the project-memory step, because their deliverable is a report rather than a committed project change.
For secondmates use `sbin/fm-brief.sh <id> --secondmate <project>...`.
The scaffold writes a charter brief instead of a task brief.
Set `FM_SECONDMATE_CHARTER='<charter>'` to fill the charter text and `FM_SECONDMATE_SCOPE='<scope>'` when the routing scope differs.
If you scaffold without `FM_SECONDMATE_CHARTER`, replace the `{TASK}` placeholder before seeding.
Keep each charter to about 40 lines or fewer and focused only on the persistent responsibility, available project clones, escalation path, and definition of done; fleet-wide discipline belongs here once, not in every charter.
The scaffold's definition of done encodes the idle-by-default contract (section 6): on startup the secondmate reconciles only its own in-flight work and then waits for routed tasks, never self-initiating a survey or audit; preserve that wording when filling the charter.
`sbin/fm-home-seed.sh` copies the charter into the secondmate home as `data/charter.md`; `sbin/fm-spawn.sh --secondmate` launches it through the same launch-template path.
After seeding, hand the new secondmate's in-scope queued items off from the main backlog with `sbin/fm-backlog-handoff.sh` (section 6).
`sbin/fm-home-seed.sh` refuses to copy a missing or placeholder charter.
Once seeded, `data/secondmates.md` becomes the source of truth for that secondmate's identity and scope: do not hand-edit `data/<id>/brief.md` or `<home>/data/charter.md` again except inside their one mate-owned section.
Update the registry line instead, then run `sbin/fm-brief.sh --regen <id>` to regenerate both projections and `sbin/fm-brief.sh --check <id>` to confirm they match what the registry generates.
The status-reporting protocol is intentionally sparse: crewmates append status only for supervisor-actionable phase changes or `needs-decision`/`blocked`/`done`/`failed`, because every append wakes firstmate.
For any generated brief that still contains `{TASK}`, replace it with a clear task description, acceptance criteria, and any constraints or context the crewmate needs before spawning or seeding.
When the task hands the crewmate a compiled action (an exact command or procedure), always pair it with an explicit return-shape contract - what the final report/output must literally contain - or the crewmate may act and report "done" without the data (measured: data/research/fm-panes-ab).
Adjust the other sections only when the task genuinely deviates from the standard ship-a-new-PR shape (e.g. fixing an existing external PR); the scaffold is the contract, not a suggestion.
**OMP status writes.** Do not instruct an omp agent to append status or logs with top-level shell redirection, because the harness blocks it.
Generated briefs and charters MUST invoke `sbin/fm-report.sh` with quoted paths, and any changed reporting mechanism requires a live-agent proof plus a refresh of already-seeded charters.
