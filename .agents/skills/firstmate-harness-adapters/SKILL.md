---
name: firstmate-harness-adapters
description: Use when choosing, configuring, detecting, verifying, launching, interrupting, exiting, or recovering a crewmate harness adapter.
---

# Firstmate harness adapters

This is the cold procedure reference extracted from the shared firstmate manual.
Read it before any harness selection, override, adapter verification, trust-dialog handling, interrupt, exit, or relaunch action.

## 4. Harness adapters

Crewmates default to the same harness you are running on.
The cap may override this at any time, typically at bootstrap: record the choice in `config/crew-harness` (a single word - an adapter name below; the file is local and gitignored, so each machine keeps its own; absent or `default` means mirror your own harness).
The recorded harness is used for every dispatch until changed; a per-task instruction from the cap ("run this one on codex") overrides it for that dispatch only.
Resolve `default` by detecting your own harness (below).

Each adapter splits into mechanics and knowledge.
The mechanics (launch command, autonomy flag) live in `sbin/fm spawn`; the knowledge you need while supervising (exit, interrupt, dialogs, quirks) lives in the tables below.
Herdr provides native agent status tracking (`idle`/`working`/`blocked`/`done`) for all adapters; turn-end detection is via `working→idle` transitions, not per-harness hook files.
**Never dispatch a crewmate on an unverified adapter.**
If `config/crew-harness` names an unverified one, tell the cap and fall back to your own harness until it is verified.
If the cap asks for a new harness, propose verifying it first: spawn a trivial supervised task using fm-spawn's raw-launch-command escape hatch, confirm every fact empirically, then record the mechanics in fm-spawn, any needed `FM_COMPOSER_IDLE_RE` empty-composer override, and the knowledge here, and commit.

### Detecting harnesses

`sbin/fm harness` prints your own harness (verified env markers first, then process ancestry); `sbin/fm harness crew` resolves the effective crewmate harness from `config/crew-harness`.
On `unknown`, ask the cap instead of guessing; a cap override always beats detection.
When you verify a new adapter, record its env marker and command name in that script.

### omp (oh-my-pi)

| Fact | Value |
|---|---|
| Exit command | `/quit` |
| Interrupt | single Escape |
| Skill invocation | `/skill:<name>` (e.g. `/skill:no-mistakes`); natural language also works |

Detection: omp sets `OMPCODE=1` AND `CLAUDECODE=1` (Claude API compatibility), so `sbin/fm harness` checks `OMPCODE` BEFORE the `CLAUDECODE` branch, otherwise omp misdetects as claude.
The launch template is `omp --auto-approve "$(cat <brief>)"`; `--auto-approve` is omp's skip-all-approvals autonomy flag (the analog of claude's `--dangerously-skip-permissions`).
No trust or permission dialog blocks a fresh worktree launch (an onboarding splash shows briefly, then the brief processes); still peek the pane within ~20s as for any spawn.
Composer: omp draws a full rounded box (`╭── … ──╮` over `╰── … ──╯`) whose last visible line is the bottom border; `sbin/fm-herdr-lib.sh` strips the full box-drawing set so a border-only idle composer reads as empty rather than pending input.

### claude

| Fact | Value |
|---|---|
| Exit command | `/exit` |
| Interrupt | single Escape |
| Skill invocation | `/<skill>` (e.g. `/no-mistakes`) |

First launch in a fresh worktree (or first ever on a machine) may show a trust or bypass-permissions confirmation.
After every spawn, peek the pane within ~20s; if such a dialog is showing, accept it with `sbin/fm send <window> --key Enter` (or the choice the dialog requires) and verify the brief started processing.

Ghost text: claude renders a predicted-next-prompt suggestion in an otherwise-empty composer after a turn completes.
Firstmate launches every claude crewmate with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` (env prefix in `sbin/fm spawn`) to suppress it; `sbin/fm-herdr-lib.sh` strips box-drawing borders as defense-in-depth for panes that flag cannot reach.

### codex

| Fact | Value |
|---|---|
| Exit command | `/quit` (slash popup needs ~1s between text and Enter; fm-send handles it) |
| Interrupt | single Escape |
| Skill invocation | `$<skill>` (e.g. `$no-mistakes`); `/<skill>` is claude-only and codex rejects it as "Unrecognized command" |

Directory trust dialog on first run per repo root ("Do you trust the contents of this directory?") - accept with Enter; the decision persists for the repo, so later worktrees of the same project skip it.
Resume after exit: `codex resume <session-id>` (printed on quit).

### opencode

| Fact | Value |
|---|---|
| Exit command | `/exit` |
| Interrupt | double Escape; known flaky while a long shell command runs - a wedged pane may need `/exit` and relaunch |

No trust dialog.
Opencode may auto-upgrade in the background, which can exit a running TUI mid-task.
If a pane shows the exit banner, relaunch with `--continue` to resume the session - but `--prompt` does NOT auto-submit alongside `--continue`; send the next instruction via fm-send once the TUI is up.

### pi

| Fact | Value |
|---|---|
| Exit command | `/quit` |
| Interrupt | single Escape |

pi has no permission system - crewmates are always autonomous.
Keep the brief as ONE positional argument - multiple positional args become separate queued messages (fm-spawn's template does this correctly).
Project trust dialog can appear on the first pi run in any not-yet-trusted directory (observed even on clean worktrees); accept with Enter - the decision persists per path in `~/.pi/agent/trust.json`, so later spawns in the same worktree slot skip it.
Environment marker for harness detection: pi sets `PI_CODING_AGENT=true` for its children.

### omp always-on skill injection

omp injects the skills named in a home's `config/omp.yml` `includeSkills:` list into every session at start, resolved against the home's skill surfaces (`.agents/skills` via the home symlink, `~/.omp/agent/managed-skills`, mate-local dirs).
That injection is always-on context cost per turn; audit it with `sbin/fm-context-weight` (per-mate section) before adding a skill to any mate's list.
