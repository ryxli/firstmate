<h1 align="center">firstmate</h1>

<h3 align="center">Talk to one agent. Ship with a crew.</h3>

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
$ git clone https://github.com/ryxli/firstmate && cd firstmate
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

Clone the repo and launch your agent harness in it, as shown in Quick Start above.
`AGENTS.md` takes over from there: it runs `sbin/fm-bootstrap.sh`, which detects the toolchain (git, GitHub auth, herdr, and the rest), lists anything missing with its install command, and installs only after you approve.
See `AGENTS.md` section 3 for the full bootstrap procedure.

Each task then runs in its own herdr pane, so you can watch it in real time or type into the pane directly.

## How It Works

firstmate reads `projects/` and turns your chat requests into tasks, dispatched to workers running in isolated herdr panes and disposable git worktrees.
Ship tasks change a project and land as a PR or an approved local merge; scout tasks investigate, plan, or audit and end in a report, never touching the project.
An in-process supervision extension watches herdr events and status files and wakes firstmate only when a decision is actually needed, so routine progress stays silent.
For larger fleets, persistent domain supervisors split the work, each with its own home, state, and session lock.
All of this state (backlog, briefs, and registries) lives on disk, so restarting firstmate is a non-event.

See `AGENTS.md` sections 2 (layout and state), 5 (recovery), 6 (task lifecycle), 7 (supervision protocol), and 9 (self-update) for the full mechanics.

## The sbin/ toolbelt

firstmate drives these directly; you rarely need to, but they work by hand too.
Run `sbin/fm-toolbelt` for the live, generated tool list, one line per script.

## Configuration

Shared orchestrator behavior lives in `AGENTS.md`.
`AGENTS.md` section 2 documents `FM_HOME` and its override behavior, the environment variables that tune runtime timing, and the registry files (`data/projects.md`, `data/secondmates.md`, `data/captain.md`, `.tasks.toml`) that drive routing and backlog behavior.
Personal fleet state under `data/`, `state/`, and `config/` is gitignored and never tracked.

## Development

Tracked changes to firstmate itself ship directly to `main`; see `AGENTS.md` sections 1 and 4 for the shared-file list, workflow, and harness-adapter verification rule, and `CONTRIBUTING.md` for external contribution steps.

```sh
bash -n sbin/*.sh                          # syntax-check the toolbelt
shellcheck sbin/*.sh tests/*.sh            # lint the toolbelt and behavior tests; CI enforces this
for test_script in tests/*.test.sh; do "$test_script"; done   # behavior tests, matching CI
[ "$(readlink CLAUDE.md)" = "AGENTS.md" ]
[ "$(readlink .claude/skills)" = "../.agents/skills" ]
```
