---
name: firstmate-task-lifecycle
description: Use when adding or routing a project, creating or retiring a secondmate, dispatching or supervising project work, handling briefs, delivery, reviews, merges, teardown, or backlog state.
---

# Firstmate project and task lifecycle

This is the cold procedure reference extracted from the shared firstmate manual.
Read it before project registration, secondmate lifecycle work, task intake, dispatch, spawn, validation, merge, promotion, teardown, backlog mutation, or brief generation.
References to sections 6, 7, 10, and 11 below refer to the preserved headings in this skill.

## Prime-directive exceptions and push audit

**Sanctioned project-write exceptions (AGENTS.md hard rule #1).** The fleet sync exception (`sbin/fm fleet-sync`) advances only the checked-out local default branch (never forcing it, creating merge commits, or stashing) and otherwise deletes only local branches whose upstream tracking branch is gone and that have no worktree; it never removes or changes a herdr-managed worktree, so it cannot discard unlanded work.
The self-update exception (`sbin/fm update`) is likewise fast-forward only, skips dirty/diverged/off-default targets, never stashes or forces, and touches only this firstmate repo plus seeded secondmate homes, never anything under `projects/`.

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
Regenerate both with `sbin/fm brief --regen <id>` after editing the registry, and verify them with `sbin/fm brief --check <id>`, which exits nonzero and names any projection that has drifted from what the registry would generate.
Each projection carries exactly one mate-owned free-form section, delimited by marker comments, that a live secondmate may edit and that survives regeneration verbatim; hand-edit a charter or brief only inside that section, never elsewhere.
Use `sbin/fm home-seed <id> <home|-> <project>...` after scaffolding the charter to provision the persistent home and registry entry; `-` creates a herdr-managed git worktree of the firstmate repo at `<parent-of-repo>/fm-sm-<id>` and records the herdr workspace ID in the registry.
The workspace ID is the durable handle for the home: teardown calls `herdr worktree remove --workspace <id>` to release the slot cleanly; a home without a workspace ID in the registry is a plain clone and is removed with `rm -rf`.
The home persists with no live process and is never recycled by herdr until explicitly released; that release happens only on explicit retirement or seed rollback, never on a routine restart or recovery.
The charter must be filled before seeding; direct seed without a preexisting brief requires `FM_SECONDMATE_CHARTER`.
Seeding is transactional: if validation, cloning, or registry update fails, generated briefs, new homes, new project clones, and registry edits are rolled back.
`sbin/fm home-seed validate` refuses duplicate ids, duplicate homes, and nested or overlapping homes.
Secondmate project lists may include `direct-PR` projects only; `local-only` projects stay with the main firstmate.

A secondmate is idle by default: it acts only on work the main firstmate routes to it.
On startup and restart it runs bootstrap and recovery solely to reconcile work that is already its own - in-flight crewmates, tracked backlog items, and durable watches in its home - and then waits silently for routed work.
It must never spawn a survey, audit, or self-directed "find improvements" task on its own initiative; an empty queue is a healthy resting state, not a cue to invent work.
This idle contract is encoded in the charter brief (section 11), so it travels with the live secondmate as well as living here.

**Hand off in-scope backlog on creation.**
When a secondmate is created for a domain, the existing main-backlog items that fall under its scope should become its work instead of staying stranded in the main backlog.
Scope-matching is firstmate's judgment against the secondmate's natural-language scope, not a keyword rule: read `data/backlog.md`, pick the queued items that fit the new scope, and move them with `sbin/fm backlog-handoff <secondmate-id> <item-key>...`.
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

**Fleet and cap-private knowledge** belongs to firstmate.
Delivery mode, `+yolo` posture, in-flight work, cap product strategy, and go-live state live in firstmate's `data/`, including the `data/projects.md` registry line and any planning docs.
Do not put that knowledge in the project.
It is not the project's business, and it must stay where firstmate can write it directly.

This does not relax prime directive #1.
Firstmate does not hand-write project `AGENTS.md` files into clones, because that would dirty the clone and bypass the gate.
Project `AGENTS.md` files are created and updated by crewmates inside their worktrees, committed through the project's delivery pipeline, exactly like any other project change.
Firstmate ensures this through the brief contract and `sbin/fm ensure-agents-md`; firstmate does not perform the write itself.
Firstmate's own not-yet-committed project knowledge lives in `data/` until a crewmate folds it into the project's `AGENTS.md`.

Create a project's `AGENTS.md` lazily on first need.
The first ship task that touches a project lacking one and has durable project-intrinsic knowledge to record should run `sbin/fm ensure-agents-md`, add that knowledge, and commit both through the normal project delivery pipeline.
Do not eagerly backfill every project.

**Delivery mode (choose at add).** `<mode>` is how a finished change reaches `main`, picked per project when you add it and recorded in the registry line (`fm project-mode` parses it; `fm-spawn` records it into each task's meta):

- `direct-PR` (default; `[...]` may be omitted) - push + open a PR via `gh-axi`, backed by focused review and tests, with no separate pipeline -> cap merge.
- `local-only` - local branch, no remote, no PR; firstmate reviews the diff, the cap approves, firstmate merges to local `main` (section 7).
- `no-mistakes` - legacy alias retained so old registry lines still parse; treated as `direct-PR`, and the no-mistakes pipeline is no longer invoked.

Orthogonal to mode is an optional `+yolo` flag (`[direct-PR +yolo]`), default off and **not recommended**: with `yolo` on, firstmate makes the approval decisions itself instead of asking the cap (section 7).
When the cap adds a project without saying, default to `direct-PR` with yolo off; only set `local-only` or `+yolo` on the cap's explicit say-so.

**Clone existing:** `git clone <url> projects/<name>`, then add its registry line with the chosen mode.

**Create new:** a `direct-PR` project needs a GitHub repo first (it pushes to an `origin` remote); a `local-only` project needs no remote at all - a purely local git repo is fine.
Creating a GitHub repo is outward-facing, so get the cap's consent before touching GitHub: propose the repo name, owner/org, visibility (default private), and delivery mode, and create with `gh-axi` only after the cap confirms.
Then clone it into `projects/<name>`.
For `local-only`, create the local repo under `projects/<name>` and skip GitHub entirely.

There is no separate validation pipeline to install or run: a change reaches `main` through focused review and tests plus the cap's merge.

### Promotion path (mate knowledge to canonical home)

A mate flags promotion-worthy knowledge by dropping the file (or a pointer note) into its home's `data/promote/` directory; that directory is the single promotion inbox, and a `promote:` status line only announces that something landed there.
Firstmate reviews each flagged item and classifies it with the disposition vocabulary owned by AGENTS.md section 1 (keep/merge/relocate/compile/quarantine/drop).
A promoted fact lands in exactly one canonical home per the layer contract: tracked template surface (sbin/, skills, benchmarks, AGENTS.md) for domain-generic material, the owning mate's home for domain knowledge, local data/ for fleet records.
After landing, regenerate any projections (`sbin/fm brief --regen <id>`) and record the disposition in the mate's promote inbox (move the flagged file to `data/promote/done/` with a one-line verdict header) so the mate sees the outcome.
Tracked landings ride the normal main-only commit flow and reach the other laptop on sync; nothing is promoted by copying a file to a second home without a recorded disposition.

## 7. Task lifecycle

### Intake

**Resolve the project first.**
The cap will rarely name the project explicitly, and may juggle several projects across messages.
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
If a secondmate's scope fits, steer that secondmate with one concise instruction via `sbin/fm send fm-<id> '<work request>'` and let it run the normal lifecycle inside its own home.
The bare `fm-<id>` target resolves through this home's `state/<id>.meta`; pass a pane id directly only when intentionally targeting a pane outside this firstmate home.
Do not spawn a direct crewmate for work that belongs to a secondmate scope unless the secondmate is blocked or the cap explicitly redirects it.
If no secondmate scope fits, proceed in the main firstmate or create a new secondmate with the cap when that domain should become persistent.
When you create a new secondmate, hand its in-scope queued items off from the main backlog into its home with `sbin/fm backlog-handoff` so it owns its domain's queue from day one (section 6).

Then classify the shape:

- **Ship** (the default): the deliverable is a change to the project. It ships through the project's delivery mode: `direct-PR` or `local-only`.
- **Scout:** the deliverable is knowledge - an investigation, a plan, a bug reproduction, an audit. It ends in a report at `data/<id>/report.md`, never a PR. When the cap asks "what's wrong", "how would we", or "find out why" about a project, that is a scout task; dispatch it instead of doing the digging yourself.

Then classify readiness:

- **Dispatchable:** no overlap with in-flight tasks. Dispatch immediately. There is no concurrency cap.
- **Blocked:** touches the same files or subsystem as an in-flight task, or explicitly depends on an unmerged PR. Record it in `data/backlog.md` with `blocked-by: <id>` and tell the cap what work is waiting and why. Scout tasks are read-mostly and almost never block on anything.

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
sbin/fm spawn <id> projects/<repo>             # uses the active crewmate harness
sbin/fm spawn <id> projects/<repo> codex       # per-task harness override
sbin/fm spawn <id> projects/<repo> --scout     # scout task; records kind=scout in meta
sbin/fm spawn <id> --secondmate                 # launch a registered persistent secondmate in its home
sbin/fm spawn <id> <firstmate-home> --secondmate   # launch or recover an explicit secondmate home
sbin/fm spawn <id1>=projects/<repo1> <id2>=projects/<repo2> [--scout]   # batch: one call, several tasks
```

Dispatch several tasks in one call by passing `id=repo` pairs instead of a single `<id> <project>`; each pair is spawned through the same single-task path, a shared `--scout` applies to all, and the looping happens inside the script so you never hand-write a multi-task shell loop.
If one pair fails, the rest still run and the batch exits non-zero.

The script resolves the harness (`fm harness crew`), owns the verified launch templates, resolves the project's delivery mode (`fm project-mode`) for ship/scout tasks, and records `harness=`, `kind=`, `mode=`, `yolo=`, and `pane=` in the task's meta; a non-flag third argument containing whitespace is treated as a raw launch command (only for verifying new adapters).
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
Steer a crewmate only with short single lines via `sbin/fm send`; anything long belongs in a file the crewmate can read.
Steer a secondmate the same way.
Its charter escalates per the peer bus discipline in the lane-governance section below: cap-relevant outcomes only, routine internal churn never touches the supervisor channel.
A successful steer send proves only queued delivery, not that the target consumed or acted on it.
For time-sensitive steers, peek promptly and distinguish sent, queued, observed, and acted-on; nudge once or use the existing stuck-crewmate ladder only when the queued instruction is urgent, rather than duplicating steers or interrupting productive work.

### Delivery modes and yolo

A ship task's path from `done` to landed on `main` is set by the project's `mode` (recorded in meta; section 6); `yolo` decides who approves. The PR ready / Ship teardown stages below apply per mode:

- **direct-PR** (default) - the crewmate does focused review and tests, pushes, and opens the PR itself (its brief says so) and reports `done: PR <url>`. Firstmate runs `fm-pr-check` and relays the PR. Teardown uses the normal pushed-branch check.
- **local-only** - no remote, no PR. The crewmate stops at `done: ready in branch fm/<id>`. Review the diff with `sbin/fm review-diff <id>`, relay a one-paragraph summary to the cap, and on approval run `sbin/fm merge-local <id>` to fast-forward local `main` (it refuses anything but a clean fast-forward - if it does, have the crewmate rebase). No `fm-pr-check`. Then teardown, whose safety check requires the branch already merged into local `main`, OR the work pushed to any remote (a fork counts - relevant for upstream-contribution PRs on a local-only-registered project).
- **no-mistakes** - legacy alias; treated exactly as **direct-PR** (no pipeline is run).

When reviewing any crewmate branch diff, use `sbin/fm review-diff <id>` rather than `git diff <default>...branch` directly.
Pooled clones keep their local default refs frozen at clone time and can lag `origin`; the helper always compares against the authoritative base.

**yolo (orthogonal).** With `yolo=off` (default) every approval is the cap's: ask-user findings, PR merges, the local-only merge. With `yolo=on`, firstmate makes those calls itself without asking - resolve ask-user findings on your judgment, and run `gh-axi pr merge` / `sbin/fm merge-local` once the work is green/approved - EXCEPT anything destructive, irreversible, or security-sensitive, which still escalates to the cap. Never merge a red PR even under yolo. After any merge you perform without asking the cap, post a one-line "merged <full PR URL or local main> after checks passed" FYI so the cap keeps a trail.

### Validate

There is no separate firstmate-triggered validation pipeline.
A ship crewmate runs the project's own focused checks (the tests and lints it already uses) and reviews its own diff before it reports `done` - for `direct-PR` before opening the PR, for `local-only` before reporting `ready in branch`.
Firstmate's validation is review, not a pipeline: for `direct-PR`, read the opened PR and its CI if the project runs CI; for `local-only`, read the branch diff with `sbin/fm review-diff <id>`.
Relay anything that needs a decision to the cap unless `yolo=on` permits routine approval on your judgment.
Use chat for yes/no decisions; use lavish-axi when there are multiple findings or options to triage.

**Repeated-miss completion gate.** When a change has missed the same semantic target more than once, normal focused checks are not enough to call it finished.
Freeze the contract into a semantic matrix before the next implementation attempt: each row states the input or event, expected behavior, acceptable exceptions, and observable proof.
The finished report must include the approved matrix, a representative live fleet scenario, and attribution for whether each observed session was unchanged since the miss or freshly restarted.
If live evidence contradicts the matrix, roll the change back or keep the task open; contradictory live evidence beats a passing isolated check.

**Boundary, verdict, and review contracts.**
Review and evidence safeguards are owned by AGENTS.md; before parallel lane work, publish a machine-checkable edge table (producer, consumer, artifact path, allowed trigger, machine check) and attach verdict authority to the evidence producer, never the consumer.

### PR ready

For PR-based ship tasks (`direct-PR`), the crewmate reports `done: PR <url>` after opening the PR, adding `checks green` once the project's CI (if any) is green.
Run `sbin/fm pr-check <id> <PR url>` - it records `pr=` in the task's meta and registers a merge check for the supervision extension's poll timer.
Tell the cap: the PR's full URL (always the complete `https://...` link, never a bare `#number` - the cap's terminal makes a full URL clickable) and a one-paragraph summary.
(The check contract, for any custom `state/<id>.check.sh` you write yourself: print one line only when firstmate should wake, print nothing otherwise, and finish before `FM_CHECK_TIMEOUT`.)

If the cap says "merge it", run `gh-axi pr merge` yourself; that instruction is the explicit approval. If `yolo=on`, merge a green/approved PR yourself and post the required FYI.

### Ship teardown (only after merge is confirmed)

```sh
sbin/fm teardown <id>
```

The script refuses if the worktree holds unpushed work; treat a refusal as a stop-and-investigate, not an obstacle.
Known benign case: after an external-PR task, a squash merge leaves the branch commits reachable only on the contributor's fork; add the fork as a remote and fetch (`git remote add fork <fork url> && git fetch fork`), then retry - never reach for `--force`.
After a successful PR-based teardown, it also runs `sbin/fm fleet-sync` for that project, best-effort, so the clone's local default catches up to the merge and the just-merged branch, now gone on the remote and free of its worktree, is pruned immediately.
Then update the backlog using the teardown reminder: run `tasks-axi done` when the compatible tool is available, otherwise move the task to Done in `data/backlog.md` manually with the full `https://...` PR URL or local merge note and date and keep Done to the 10 most recent.
Re-evaluate the queue and dispatch only queued work whose blockers are gone and whose time/date gate, if any, has arrived.

### Secondmate teardown (explicit only)

A secondmate is persistent by default.
An empty queue is healthy and does not trigger teardown.
Run `sbin/fm teardown <id>` for `kind=secondmate` only when the cap or main firstmate explicitly decides to retire that persistent supervisor.
The safety check is the secondmate's own home: teardown refuses while its `state/*.meta` contains in-flight work.
When it is safe, teardown closes the direct herdr pane, removes the `data/secondmates.md` route, clears the main home metadata, and removes the retired secondmate home.
For herdr-managed homes (those with a `workspace:` field in `data/secondmates.md`), teardown calls `herdr worktree remove --workspace <id>` to remove the worktree and release the slot; a plain-clone home with no workspace field is removed directly with `rm -rf`.
If `herdr worktree remove` fails, teardown stops with state intact rather than raw-removing the directory and hiding a still-live workspace.
With `--force`, teardown is the explicit discard path: it closes child herdr panes, discards child work and state inside the secondmate home, removes the route, removes the workspace, and removes the retired secondmate home.

### Scout tasks (report instead of PR)

A scout task follows Intake, Spawn, and Supervise exactly as above - scaffold the brief with `sbin/fm brief <id> <repo> --scout`, spawn with `--scout` - then diverges after the work:

- There is no Validate or PR-ready stage. When the crewmate's status says `done`, read `data/<id>/report.md`.
- Relay the findings to the cap: plain chat for a focused answer, lavish-axi when the report has structure worth a visual (multiple findings, options, a plan).
- Tear down immediately - no merge gate. `sbin/fm teardown` allows a scout worktree's scratch commits and dirty files once the report exists; if the report is missing, it refuses, because the findings are the work product.
- Record it in Done with the report path instead of a PR link using `tasks-axi done` when compatible tasks-axi is available, otherwise hand-edit `data/backlog.md` and keep Done to the 10 most recent, then re-evaluate the queue and dispatch only queued work whose blockers are gone and whose time/date gate, if any, has arrived.

**Promotion.** When a scout's findings reveal shippable work (a reproduced bug with a clear fix) and the cap wants it shipped, promote the task in place instead of respawning: run `sbin/fm promote <id>` (flips `kind=` to ship in meta, restoring teardown's full protection), then send the crewmate its ship instructions - inventory scratch state, reset to a clean default-branch base, carry over only intended fix changes, create branch `fm/<id>`, implement, and report `done` according to the project's delivery mode.
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
- Hand a task off to a secondmate home: keep using `sbin/fm backlog-handoff <secondmate-id> <item-key>...`; do not call bare `tasks-axi mv` for this path, because the helper resolves and validates the secondmate home before moving anything.
- Normalize the file: `tasks-axi render` rewrites every id'd task in canonical form and leaves free-form lines untouched.

`tasks-axi done` auto-prunes Done to `done_keep = 10` and archives the pruned entries to `data/done-archive.md`, which supersedes the manual "keep Done to the 10 most recent" pruning above: when compatible `tasks-axi` is present you do not hand-prune Done, and nothing is lost because pruned entries are archived rather than deleted.
When `tasks-axi` is absent or fails the compatibility probe, every firstmate home (main and each secondmate) hand-edits `data/backlog.md` exactly as this section describes, including the manual Done pruning.
Secondmates inherit this automatically: each secondmate home carries the same `AGENTS.md` and its own `.tasks.toml`, so the same present-or-absent rule applies in every home with no separate setup.

**Productivity log.** Firstmate maintains a weekly productivity log at `data/productivity-log.md` (local, gitignored, temporary - may migrate to an external system).
Update it on task teardown with cycle time and escalation count; close each week's entry at the first session of the following Monday.
Secondmates contribute their segment on firstmate's request or at week close; format and schema are defined in the file header.

## 11. Crewmate briefs

Scaffold with `sbin/fm brief <id> <repo-name>` - it writes `data/<id>/brief.md` with the standard contract (branch setup, status-reporting protocol, push/merge rules, definition of done) and all paths filled in.
For a ship task the definition of done is shaped by the project's delivery mode (section 6): `direct-PR` has the crewmate do focused review and tests, then push and open the PR itself, while `local-only` has it stop at "ready in branch" for firstmate to review and merge locally.
The scaffold reads the mode via `fm project-mode`, so you do not pass it.
Ship briefs also include the project-memory contract: run `sbin/fm ensure-agents-md` when the project already has agent-memory files or when the task produced durable project-intrinsic knowledge, then record proportionate learnings in `AGENTS.md`.
For scout tasks add `--scout`: the scaffold swaps the definition of done for the report contract (findings to `data/<id>/report.md`, no branch, no push, no PR) and declares the worktree scratch; scout is mode-agnostic.
Scout briefs do not include the project-memory step, because their deliverable is a report rather than a committed project change.
For secondmates use `sbin/fm brief <id> --secondmate <project>...`.
The scaffold writes a charter brief instead of a task brief.
Set `FM_SECONDMATE_CHARTER='<charter>'` to fill the charter text and `FM_SECONDMATE_SCOPE='<scope>'` when the routing scope differs.
If you scaffold without `FM_SECONDMATE_CHARTER`, replace the `{TASK}` placeholder before seeding.
Keep each charter to about 40 lines or fewer and focused only on the persistent responsibility, available project clones, escalation path, and definition of done; fleet-wide discipline belongs here once, not in every charter.
The scaffold's definition of done encodes the idle-by-default contract (section 6): on startup the secondmate reconciles only its own in-flight work and then waits for routed tasks, never self-initiating a survey or audit; preserve that wording when filling the charter.
`sbin/fm home-seed` copies the charter into the secondmate home as `data/charter.md`; `sbin/fm spawn --secondmate` launches it through the same launch-template path.
After seeding, hand the new secondmate's in-scope queued items off from the main backlog with `sbin/fm backlog-handoff` (section 6).
`sbin/fm home-seed` refuses to copy a missing or placeholder charter.
Once seeded, `data/secondmates.md` becomes the source of truth for that secondmate's identity and scope: do not hand-edit `data/<id>/brief.md` or `<home>/data/charter.md` again except inside their one mate-owned section.
Update the registry line instead, then run `sbin/fm brief --regen <id>` to regenerate both projections and `sbin/fm brief --check <id>` to confirm they match what the registry generates.
The status-reporting protocol is intentionally sparse: crewmates append status only for supervisor-actionable phase changes or `needs-decision`/`blocked`/`done`/`failed`, because every append wakes firstmate.
For any generated brief that still contains `{TASK}`, replace it with a clear task description, acceptance criteria, and any constraints or context the crewmate needs before spawning or seeding.
When the task hands the crewmate a compiled action (an exact command or procedure), always pair it with an explicit return-shape contract - what the final report/output must literally contain - or the crewmate may act and report "done" without the data (measured: data/research/fm-panes-ab).
Adjust the other sections only when the task genuinely deviates from the standard ship-a-new-PR shape (e.g. fixing an existing external PR); the scaffold is the contract, not a suggestion.
**OMP status writes.** Do not instruct an omp agent to append status or logs with top-level shell redirection, because the harness blocks it.
Generated briefs and charters MUST invoke `sbin/fm report` with quoted paths, and any changed reporting mechanism requires a live-agent proof plus a refresh of already-seeded charters.

## Lane governance: whiteboard, peer bus, turn sections, and review safeguards

Relocated verbatim from AGENTS.md. This binds every spawned lane (crewmate, secondmate, tan) and firstmate's own turn structure.

### Whiteboard operator-view contract

Every whiteboard begins with a cap-first band, before any agent detail; the board is not compliant without it.

```
## OPERATOR VIEW
🟢|🟡|🔴|🔵 <one plain-language line per active lane>   (hard cap: 8 lines)
⚠ Needs cap: <decision or "nothing">
→ For supervisor: <handoff/ask or "nothing">
```

Rules for the operator view: plain language a non-reader can skim in ten seconds; one status glyph per line (🟢 healthy, 🟡 degraded/waiting, 🔴 broken/blocked, 🔵 in progress); no commit SHAs, file paths, or links unless a pending decision needs one; the "Needs cap" and "For supervisor" lines are mandatory even when the answer is "nothing".
Everything below the operator view (Working / Evidence / Preserved / Reply sections, SHAs, evidence chains, exclusion rules) remains unconstrained agent detail - move precision down there, never delete it.
The operator view is a verified deliverable: supervisors check it for presence, currency, and the line cap on their ticks and steer when it degrades, the same way artifact claims are verified.
It is still self-report - supervisors read it as "what the agent believes" and keep trust-but-verify checks on anything load-bearing.

Failure: board safety claims outlived their evidence.
Root cause: the board recorded a conclusion without the contemporaneous command that produced it.
Prevention: every board claim that says reconcile clean, no divergence, armed safe, restored, or equivalent must name a timestamped evidence line below the operator view with the exact read-only command that produced it, for example `curl -fsS "$STATUS_URL" | jq '{reconcile_seq,divergences,halt_causes}'`.


### Peer bus discipline

This extends the secondmate charter's fleet-peer-bus escalation rule above.
`done`, `blocked`, `needs-decision`, `failed`, and a material phase change are cap-relevant outcomes; the whiteboard records their state for the fleet.
The fleet peer bus is not a second state channel.
It carries only the action needed when a board update cannot itself cause the recipient to act.

Send only:

1. A handoff naming the artifact and the action required from the recipient.
2. A blocking question that the recipient alone can answer.
3. A safety interrupt requiring immediate intervention.

`peer_send`/`peer_pull` are canonical for mate-to-mate and secondmate escalation; `sbin/fm send` stays canonical for pane-local steering, interrupts, startup nudges, and explicit composer delivery; never substitute IRC for fleet peer-bus messages.
Do not send acknowledgements, delivery receipts, routine status echoes, or FYI progress.
The recipient's next board update is the receipt.
Before every send, ask: **does this change what the peer does in their next step?**
If no, put the fact on the whiteboard or drop it.
Never resend a fact already sent or already recorded on the board.

### Turn decision sections

A crew agent's turn is a finite sequence of decision sections.
Every section has an explicit legal-move set.
No section has a silent or null move: when no listed move obviously applies, the named fallback move for that section is still the legal move to take.

1. **Wake** - what triggered this turn: a steer, a scheduled tick, a subagent return, or nothing?
   Name the trigger before acting on it.
   An unnamed trigger is not a legal starting state.
2. **Read state** - read the board, the Working list, and every in-flight lane.
   Note what changed since the last turn before deciding anything.
   Acting on stale memory instead of a fresh read is not a legal move.
   After a compaction or interruption, take ONE aggregated state snapshot, reconcile it once, and refill all free slots before reading any additional context.
   Iterative re-reading to rebuild context while slots sit empty is not a legal move.
3. **Consume** - process every queued message before anything else.
   Legal moves are: act on a message now, or explicitly defer it with a reason recorded on the board.
   Waiting instead of draining the queue first is not a legal move.
   That default caused a real deadlock: an agent parked in a wait-loop never drains the very message it is waiting for.
4. **Select** - given the Working list, the blocked set, and the operator-view AMBERs, choose what to act on now.
   There is always a legal move: execute the next unblocked item, convert a blocked item's unblock condition into a task, refill from AMBERs, or emit an explicit "queue empty, requesting work" board state.
   Silent parking with unblocked work still on the list is never a legal move.
   After every tool result, subagent message, or job completion, consume all settled results and immediately execute the next safe calculated unblocked action; a settled job invalidates any wait that depended on it.
   `I can`, `we could`, `next action`, and `while waiting` are not legal stopping points while authorized work remains.
   A pending peer review verdict on a submitted deliverable blocks only that deliverable's item; it never blocks the rest of the queue.
   While any verdict is pending, treat it as a Schedule wake condition and select the next file-disjoint unblocked item as usual.
   Before declaring the queue empty, re-test each blocked item's unblock condition against current reality (e.g. the awaited commit may already exist on main); a stale "blocked" label is not evidence.
5. **Execute vs delegate** - decide inline execution versus spawning a lane by cost and blast radius, not by default habit.
   A high-blast-radius step (money path, state corruption risk) delegates to a named lane or reviewer.
   A small, low-cost, low-risk step executes inline.
   Before any multi-command diagnostic sequence, name the exact predicate and choose the highest-level command that directly returns it.
   Decompose only when that command is unavailable or insufficient; stop once the predicate and required artifact contract are satisfied.
   Before presenting options, identify which uncertainty is empirically testable; run the smallest reversible isolated experiment that can collapse it, then present only the surviving tradeoffs.
   Delegation carries no callback guarantee: a crewmate lane can die or park silently, so every delegated lane gets a named deadline at spawn time.
   Each bounded self-recheck in the Schedule step below must verify delegated-lane LIVENESS (evidence of progress: output growth, artifact delta, lane status), not just unblock conditions.
   A lane silent past its deadline is not "still working": restart it, reclaim the work inline, or report the stall on the board - waiting longer is not a legal move.
   Deferring a spawn to "next turn" is illegal when nothing is named to cause that turn: spawn accepted-handoff lanes in the SAME turn as the acceptance, or name the exact wake that will perform the spawn.
   Maximize wall-clock throughput: when independent critical-path items exist and worker slots are free, spawn them in parallel in the same turn - design acceptance, test coverage, breaker repair, push/deploy, and live verification parallelize wherever dependencies permit.
   Review dispatches against the LOCAL commit the moment it exists; waiting for push, deployment, or an author-assembled evidence bundle before dispatching review is not a legal move (evidence folds into the open review asynchronously).
   Expand capacity through `/tan` before queueing: whenever an independent, dispatch-ready slice exists and your attention - not executable work - is the bottleneck, request a `/tan` for it instead of serializing it behind current work.
   Mechanics: `/tan` is a pane command that only the supervisor (or cap) can type and submit into your pane - you cannot self-spawn one; publish a "tan requested: <bounded slice>" board line and the supervisor executes the spawn.
   Every tan directive carries a bounded board slice, exact file ownership, dependencies, prohibited files/surfaces, validation requirements, and a terminal-report format; tans announce file claims before editing, report terminal deltas to their parent only, and never rescan or claim the full backlog.
6. **Report** - every turn ends with a board delta and a named artifact path, always.
   A claim with no named artifact is this section's failure mode.
   Lane reports are terminal events, not polling narration: one report per lane completion carrying commit SHA, tests run, verdict, and blocker.
   Repeated progress polling and unscoped "different perspective" re-reads of settled work are not legal reporting moves.
   Before handing any deliverable to a review gate, self-check it row by row against the gate's published criteria (the reviewer's frozen matrix or correction contract) and attach that self-check to the handoff.
   A deliverable submitted without the self-check wastes a full review round on gaps the author could have caught.
   The board write is a turn-exit guard, not a judgment call: EVERY turn exit writes the whiteboard before ending - including wait-entry, parking, empty polls, race-lost peer pulls, trivial acknowledgements, system-notice handling, and tool-error/retry exits.
   "No new state" is itself state: when nothing changed, update a single "Last turn" line (timestamp, wake cause, one-word outcome, what you are waiting on) rather than skipping the write.
   `whiteboard_checkpoint` never substitutes for the write; write the board first, checkpoint after.
   The checkable invariant is that the board mtime advances on every turn; a pane turn that ends without a board write is a section-6 incident by definition.
   Board writes are monotonic: append or supersede with timestamped current state, preserve prior accepted decisions and evidence references, and never delete a missed or failed state without a superseding line.
   See "Whiteboard operator-view contract" and "Peer bus discipline" above for the artifact and handoff shape this must take.
7. **Schedule** - name what wakes you next: a tick, a specific message, or an unblock condition.
   Ending a turn with nothing named to wake it is not a legal move.
   Parking on external blocks is bounded, never open-ended: a parked turn names a self-recheck interval of at most 10 minutes, and each recheck re-tests every blocked item's unblock condition against current reality.
   If idleness persists past one recheck while any queue anywhere is non-empty (own queue, the cap's stated priorities, docs/PLAN.md backlog), the next turn MUST either pull new work from it or write an explicit escalating work request addressed to the cap on the board.
   When a named lane or self-recheck deadline is missed, the next board write says `missed <deadline>: <cause>; next <action/time>` before any further waiting.
   Waiting more than ~10 minutes with nothing in flight and no work request on the board is a section-7 incident.


#### Review and evidence safeguards

- **Cure-condition guard:** Every verdict delivery MUST check named cure conditions against authoritative current state.
  When every named cure condition holds, suppress the old event, return the item to an independent fresh review, and deliver only that review's event.
- **Terminal events:** A terminal event is a same-turn obligation: read its named artifact, take its lifecycle action, and write the resulting board state before any unrelated inspection.
  Check: a terminal report with a present artifact must produce a named disposition or explicit escalation in that same turn.
- **Evidence blockers:** Before recording an evidence blocker, enumerate and try every read-only authoritative path named by state, status, reports, session artifacts, source, and peer handoffs.
  Check: the blocker record names each attempted path and its observed result; otherwise it is not a legal blocker.
- **Large evidence:** Mirror large command output, reports, matrices, and browser captures to named artifacts at production time; consume them through bounded range reads and cite paths plus ranges in communications.
  Check: if a review needs bulk pasted output or a context recovery, stop, persist the artifact, and resume from that artifact rather than carrying the bulk forward.
- **Repeated criteria:** Every first rejection publishes criterion IDs, required proof, and named cures in a machine-checkable matrix.
  Check: every correction handoff attaches a row-by-row self-check against that exact matrix; a missing self-check is rejected before review.

#### Review practices to preserve

- Reject only concrete, evidenced defects rather than inventing a gate.
- Keep rejection reports narrow and procedural: name the failed criterion, the evidence, and the exact cure without expanding scope.
- Keep nonconforming verdict deliveries non-admitting. Producer, event, artifact, SHA, and consumer provenance are part of a verdict contract, not optional metadata.
