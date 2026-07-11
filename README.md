<h1 align="center">firstmate</h1>
<p align="center">
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">Talk to one agent. Ship with a crew.</h3>

<p align="center">
  <img alt="firstmate - talk to one agent, ship with a crew" src="assets/banner.jpg" width="100%" />
</p>

You can run one coding agent easily.
But the moment you want three project tasks done in parallel - fixes, investigations, plans, audits - you become a tab-juggler: babysitting sessions, copy-pasting context between repos, forgetting which terminal had the failing test.

firstmate flips the model.
You talk to a single agent - the first mate - and it runs the crew for you: spawning autonomous agents in herdr panes, giving each a clean git worktree, supervising them to completion, and handing you finished PRs, approved local merges, or standalone investigation reports.
For larger fleets, you can opt in to persistent secondmates: domain supervisors that are still ordinary direct reports, but run from their own isolated firstmate homes.
There is no app to install; the whole orchestrator is an `AGENTS.md` file that any terminal coding agent can follow.

- **One liaison** - you never talk to a worker agent.
  The first mate dispatches, supervises, escalates only real decisions, and reports plain outcomes about work that is ready, blocked, or needs your call.
- **A visible crew** - every crewmate lives in a herdr pane.
  Watch any of them work, or type into their pane to intervene; the first mate reconciles.
- **Persistent domain supervisors** - route natural-language scopes through `data/secondmates.md` when a domain deserves its own long-lived supervisor.
  Each secondmate has a separate `FM_HOME`, local state, local projects, and its own session lock, while the main first mate still supervises it like any other direct report.
- **Guarded by construction** - the first mate is read-only over your projects except for clean local default-branch refreshes, safe pruning of local branches whose remote is gone, and approved `local-only` fast-forward merges; crewmates work in disposable herdr-managed git worktrees.
  Ship tasks follow each project's delivery mode, and scout tasks produce local reports without pushing anything.

This is not an agent harness. This is not a skill. This is not a CLI.

This is.. a directory that turns any agent into your firstmate, and you the captain.

## Quick Start

```sh
$ git clone https://github.com/kunchenguid/firstmate && cd firstmate
$ claude   # launch your agent harness here; AGENTS.md takes over

> ahoy! look at my github project xyz, then fix the flaky login test and add dark mode

# firstmate checks its toolchain (asking your consent before installing anything),
# clones the project under projects/, and spawns two crewmates in herdr panes
# fm-fix-login-k3 and fm-dark-mode-p7.
# Minutes later:

  PR ready for review, captain: https://github.com/you/xyz/pull/42
  (fix flaky login test - risk: low - CI green)

> alright merge it
```

## Install

**Prerequisites** (the first mate detects everything else and offers to install it):

```sh
# 1. a verified agent harness - omp, claude, codex, opencode, or pi
# 2. git + GitHub auth
# 3. herdr - the terminal and agent substrate (firstmate offers to install it if missing)
gh auth login
```

**Get firstmate:**

```sh
git clone https://github.com/kunchenguid/firstmate
cd firstmate && claude
```

That is the whole install.
On first launch the first mate detects missing required tooling (herdr, node, gh, gh-axi, chrome-devtools-axi, lavish-axi), lists it with the exact install commands, and installs only after you say go.
If compatible `tasks-axi` is already on `PATH`, bootstrap records it as an optional capability fact and firstmate uses its verbs for routine backlog mutations; when it is absent or incompatible, firstmate keeps hand-editing `data/backlog.md` exactly as before.

**View crew work in herdr panes.**
firstmate works from any terminal, and each crewmate runs in a herdr pane where you can inspect work in real time or intervene directly.

## How It Works

```
            you (the captain)
                  │  chat: requests, decisions, "merge it"
                  ▼
 ┌─────────────────────────────────────┐
 │ firstmate            (this repo)    │
 │ reads projects/ + firstmate routes  │
 │ writes guarded backlog/briefs/state │
 └──┬──────────────┬───────────────┬───┘
    │ herdr pane input / status files │
    ▼              ▼               ▼
 ┌────────┐   ┌────────┐      ┌────────┐
 │fm-task1│   │fm-task2│  ... │fm-taskN│   herdr panes you can watch
 │crewmate│   │crewmate│      │crewmate│   one autonomous agent each
 └───┬────┘   └───┬────┘      └───┬────┘
     ▼            ▼               ▼
  herdr workspace or isolated secondmate home
     │
     ├─ ship: project mode ► PR/local merge ► teardown
     │
     └─ scout: report at data/<id>/report.md ► relay findings ► teardown
```

- **Event-driven supervision** - an in-process omp extension subscribes to herdr events, status writes, and registered PR checks, then wakes the first mate only when captain action is needed.
  Routine progress and unchanged checks stay silent.
  During `/afk`, relevant events are batched into one digest without changing who approves work.
- **Worktrees, not branches in your checkout** - crewmates never touch your clone; herdr creates isolated git worktrees so parallel tasks on one repo cannot collide.
- **Two task shapes** - ship tasks change projects and use a project delivery mode (`direct-PR` or `local-only`); scout tasks investigate, plan, reproduce bugs, or audit, then leave a report at `data/<id>/report.md` and never push.
- **Optional secondmates** - `data/secondmates.md` records persistent domain supervisors with natural-language scopes, project clone lists, and home paths.
  `fm-home-seed.sh` provisions the isolated home, clones the listed PR-based projects into it, copies the charter to `data/charter.md`, and `fm-spawn.sh --secondmate` launches it through the same herdr and status-file path as any direct report.
  When seeded with `-`, the home is a herdr-managed git worktree; the herdr workspace ID is stored in the registry so teardown can call `herdr worktree remove` cleanly.
  The home persists until explicit retirement or seed rollback removes it; normal restarts keep it in place.
  If `herdr worktree remove` fails during teardown, firstmate leaves the route and home intact instead of hiding a still-live workspace.
  Seeding is transactional: if validation, cloning, or registry update fails, generated briefs, new homes, new project clones, and registry edits are rolled back.
  `local-only` projects stay with the main first mate because they merge into the main local checkout instead of a remote-backed PR path.
  The same project may appear in multiple secondmate homes when their scopes differ, such as issue triage versus feature development.
  Secondmates are idle by default: after startup recovery reconciles only work already in their own home, an empty queue waits silently for routed tasks, and they never self-initiate surveys or audits.
  After seeding a secondmate, `fm-backlog-handoff.sh` moves already-judged in-scope queued items from the main backlog into that secondmate home so the domain queue starts in the right place.
  Idle secondmate panes are healthy; teardown is explicit and refuses while the secondmate home has in-flight work unless the captain has approved discard with `--force`.
- **Project modes are explicit** - `data/projects.md` records each project's delivery mode and optional `+yolo` autonomy flag.
  `direct-PR` projects run focused review and tests, then open a PR for captain approval, while `local-only` projects stay local until firstmate performs an approved fast-forward merge.
- **Project memory belongs to projects** - durable project-intrinsic agent knowledge lives in each project's committed `AGENTS.md`, with `CLAUDE.md` as a symlink.
  Ship briefs prompt crewmates to create or update those files through the normal delivery path; `data/projects.md` stays a thin private registry.
- **Local clones stay fresh** - bootstrap and PR-based teardown refresh remote-backed project clones with clean default-branch fast-forwards when the clone is on the default branch and has no local work, and prune local branches whose remote is gone and that no worktree still needs.
- **Self-updates stay safe** - `/updatefirstmate` fast-forwards the running firstmate repo and registered secondmate homes from `origin`, then re-reads updated instructions and nudges updated secondmates without touching project clones.
  The update is fast-forward only: dirty, diverged, offline, and off-default targets are reported and left untouched.
- **Restart-proof** - all state lives in herdr, status files, local markdown under `data/`, `data/secondmates.md`, and persistent secondmate homes.
  Kill the first mate session anytime; the next one reconciles and carries on.

## The sbin/ toolbelt

The first mate drives these; you rarely need to, but they work by hand too.

| Script                   | Description                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `fm-bootstrap.sh`        | Detect required toolchain problems and optional capability facts; refresh clones best-effort; install tools only after consent |
| `fm-fleet-sync.sh`       | Fetch clones, clean-fast-forward their checked-out default branches, and safely prune branches whose remote is gone |
| `fm-update.sh`           | Self-update the running firstmate repo and registered secondmate homes with fast-forward-only pulls from origin     |
| `fm-backlog-handoff.sh`  | Move already-judged in-scope queued backlog items from the main home into a seeded secondmate home                 |
| `fm-brief.sh`            | Scaffold a ship brief, a report-only scout brief with `--scout`, or a secondmate charter with `--secondmate`      |
| `fm-ensure-agents-md.sh` | Ensure project `AGENTS.md` is the real memory file and `CLAUDE.md` symlinks to it                                   |
| `fm-home-seed.sh`        | Lease/provision a secondmate home transactionally, clone projects, and maintain `data/secondmates.md`              |
| `fm-spawn.sh`            | Spawn one task, several `id=repo` pairs, or a persistent secondmate with `--secondmate`                            |
| `fm-project-mode.sh`     | Resolve a project's delivery mode and `+yolo` flag from `data/projects.md`                                          |
| `fm-merge-local.sh`      | Fast-forward a `local-only` project's local default branch after approval                                           |
| `fm-review-diff.sh`      | Review a crewmate branch against the authoritative base, with optional `--stat` output                              |
| `fm-send.sh`             | Send one verified literal line (or `--key Escape`) to a crewmate window; exits non-zero when Enter is positively swallowed |
| `fm-herdr-lib.sh`        | Shared herdr pane primitives for busy detection, dim-ghost-aware and border-aware composer detection, and verified submit retry |
| `fm-peek.sh`             | Print a bounded tail of a crewmate pane                                                                             |
| `fm-pr-check.sh`         | Record a PR-ready task and register its merge check                                                                |
| `fm-promote.sh`          | Promote a scout task in place so it becomes a protected ship task                                                   |
| `fm-teardown.sh`         | Return the worktree or retire/release a secondmate home; protects ship work, requires scout reports, checks child work, and prints the backlog reminder |
| `fm-harness.sh`          | Detect the running harness; resolve the effective crewmate harness                                                  |
| `fm-lock.sh`             | Per-home firstmate session lock                                                                                     |

## Configuration

The shared orchestrator behavior lives in `AGENTS.md` - edit it like any prompt when the fleet is empty, or dispatch shared-repo edits to a crewmate while tasks are in flight.
The tracked `.tasks.toml` pins the optional `tasks-axi` markdown backend to `data/backlog.md`, with `done_keep = 10` and an archive at `data/done-archive.md`.
When compatible `tasks-axi` is on `PATH`, firstmate uses its verbs for routine backlog mutations and keeps secondmate transfers behind `fm-backlog-handoff.sh` validation; without it, backlog bookkeeping remains manual.
Compatible means the shared bootstrap probe accepts `tasks-axi --version` as 0.1.1 or newer.
Personal preferences for one captain's fleet live locally in `data/captain.md`; it is gitignored and read after `data/projects.md` and optional `data/secondmates.md` during bootstrap.
Persistent secondmate routes live locally in `data/secondmates.md`.
Each line records the secondmate id, charter summary, absolute home path, natural-language scope, project clone list, and added date; `fm-home-seed.sh validate` refuses duplicate ids, duplicate homes, and nested or overlapping homes.
The main first mate routes by reading those scopes with judgment; the project list is provisioning data, not exclusive ownership.
Use `fm-home-seed.sh <id> - <project>...` to create a herdr-managed git worktree as the secondmate home; the workspace ID is stored in the registry.
The home persists until explicit retirement or seed rollback removes it; normal restarts do not recycle it.
Teardown of a herdr-managed home calls `herdr worktree remove`; plain-clone homes with no workspace ID in the registry are removed directly with `rm -rf`.
If `herdr worktree remove` fails during teardown, firstmate leaves the route and home intact.
Secondmate routes cover `direct-PR` projects; `local-only` projects remain main-firstmate work.
After creating a secondmate, move existing main-backlog items that you have judged in-scope with `fm-backlog-handoff.sh <secondmate-id> <item-key>...`; it is idempotent and refuses in-flight items or non-secondmate homes.
Set `FM_SECONDMATE_CHARTER` to seed from inline charter text when no filled charter brief exists; set `FM_SECONDMATE_SCOPE` when the routing scope should differ from the charter text.
`FM_HOME` selects the operational home for one firstmate instance.
When it is unset, the repo root is the home; when it is set, scripts still run from this repo's `sbin/`, but `state/`, `data/`, `config/`, and `projects/` come from `$FM_HOME`.
Harness support is a table in section 4: omp, claude, codex, opencode, and pi are all empirically verified; new harnesses get verified through a supervised trial task before joining the table.

Runtime tuning via environment variables (defaults shown):

```sh
FM_HOME=                              # optional operational home; unset means this repo root
FM_CHECK_TIMEOUT=30                   # seconds allowed per registered slow check script
FM_SIGNAL_GRACE=30                    # seconds to coalesce nearby status and turn-end signals into one wake
FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT=20    # seconds allowed for bootstrap's best-effort clone refresh
FM_FLEET_PRUNE=1                      # set to 0 to skip pruning local branches whose upstream is gone
FM_COMPOSER_IDLE_RE=                   # optional empty-composer regex after border stripping
FM_STALE_ESCALATE_SECS=240             # idle seconds before a non-secondmate pane escalates as a possible wedge
FM_ESCALATE_BATCH_SECS=90              # `/afk` buffer window for relevant-event digests; 0 flushes immediately
```

## Development

Tracked changes to firstmate itself, including `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `.tasks.toml`, `.github/workflows/`, `sbin/`, and agent skill files, ship directly to `main`.
Maintainers commit durable shared changes on `main`, verify them proportionately, and push `origin main`.
This repository does not require a feature branch, PR, or separate validation pipeline for those maintainer changes.

```sh
bash -n sbin/*.sh                          # syntax-check the toolbelt
shellcheck sbin/*.sh tests/*.sh            # lint the toolbelt and behavior tests; CI enforces this
for test_script in tests/*.test.sh; do "$test_script"; done   # behavior tests, matching CI
tests/fm-bootstrap.test.sh                # bootstrap dependency and optional-capability behavior
tests/fm-update.test.sh                   # fast-forward-only self-update, reread, nudge, dedup, and skip safety
tests/fm-secondmate.test.sh               # persistent secondmate routing, seeding, idle charter, backlog handoff, spawn, recovery, teardown, and FM_HOME
tests/fm-teardown.test.sh                 # teardown safety and reminder checks
tests/fm-tooling-lint.test.sh             # shipped tool-invocation convention checks
[ "$(readlink CLAUDE.md)" = "AGENTS.md" ]
[ "$(readlink .claude/skills)" = "../.agents/skills" ]

```
