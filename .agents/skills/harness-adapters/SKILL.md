---
name: harness-adapters
description: Agent-only reference for firstmate harness operations. Use before spawning or recovering a crewmate or secondmate, handling a trust dialog, sending a harness-specific skill invocation, interrupting or exiting an agent, resuming an exited agent, or verifying a new harness adapter. Contains verified facts for omp, claude, codex, opencode, and pi.
user-invocable: false
---

# harness-adapters

Use this reference before any harness-specific firstmate operation: spawn, recovery, trust-dialog handling, skill invocation, interrupt, exit, resume, or adapter verification.

Crewmates default to the same harness firstmate is running on unless `config/crew-harness` records an adapter name.
The captain may override that file at bootstrap or later; a per-task instruction such as "run this one on codex" overrides it for that dispatch only.
`default` means mirror firstmate's own harness.

Each adapter splits into mechanics and knowledge.
The mechanics, including launch command and autonomy flag, live in `bin/fm-spawn.sh`.
Herdr provides native agent status (`idle`/`working`/`blocked`/`done`) for all adapters; turn-end detection is `working->idle` transitions, not per-harness hook files.
The supervision knowledge lives here: busy signature, exit command, interrupt, dialogs, resume behavior, skill invocation, and quirks.

Never dispatch a crewmate or secondmate on an unverified adapter.
If `config/crew-harness` names an unverified adapter, tell the captain and fall back to firstmate's own harness until that adapter is verified.
If the captain asks for a new harness, propose verifying it first: spawn a trivial supervised task using `fm-spawn`'s raw-launch-command escape hatch, confirm every fact empirically, then install its herdr integration (`herdr integration install <name>`) so herdr reports its status natively, record the launch mechanics in `fm-spawn` plus any `FM_COMPOSER_IDLE_RE` empty-composer override in `fm-herdr-lib.sh`, and the verified knowledge here.

## Detection

`bin/fm-harness.sh` prints firstmate's own harness, using verified env markers first and then process ancestry.
`bin/fm-harness.sh crew` resolves the effective crewmate harness from `config/crew-harness`.
On `unknown`, ask the captain instead of guessing.
A captain override always beats detection.
When verifying a new adapter, record its env marker and command name in `bin/fm-harness.sh`.

For stuck recovery, the target pane's harness is recorded as `harness=` in `state/<id>.meta`.
Use that value for interrupt, exit, resume, and skill-invocation facts.

## no-mistakes skill invocation

Send the validation skill using the target harness's skill invocation form.
Natural language is acceptable if uncertain.

- omp: `/skill:<skill>`, for example `/skill:no-mistakes`; natural language also works.
- claude: `/<skill>`, for example `/no-mistakes`.
- codex: `$<skill>`, for example `$no-mistakes`; `/<skill>` is claude-only and codex rejects it as "Unrecognized command".
- opencode: no separate verified skill invocation beyond normal slash-command behavior; use natural language if the exact skill command is uncertain.
- pi: no separate verified skill invocation beyond normal command behavior; use natural language if the exact skill command is uncertain.

## omp (oh-my-pi) (VERIFIED 2026-06-24, omp v16.1.16)

This workstation runs omp inside herdr, so omp is the default own-harness here.

| Fact | Value |
|---|---|
| Busy-pane signature | herdr native agent status (`working`); omp has no fixed busy footer string |
| Exit command | `/quit` |
| Interrupt | single Escape |
| Skill invocation | `/skill:<name>` (e.g. `/skill:no-mistakes`); natural language also works |

Detection: omp sets `OMPCODE=1` AND `CLAUDECODE=1` (Claude API compatibility), so `bin/fm-harness.sh` checks `OMPCODE` BEFORE the `CLAUDECODE` branch, otherwise omp misdetects as claude.
The launch template is `omp --auto-approve "$(cat <brief>)"`; `--auto-approve` is omp's skip-all-approvals autonomy flag (the analog of claude's `--dangerously-skip-permissions`).
No trust or permission dialog blocks a fresh worktree launch (an onboarding splash shows briefly, then the brief processes); still peek the pane within about 20 seconds as for any spawn.
Composer: omp draws a full rounded-box composer whose last visible line is the bottom border; `bin/fm-herdr-lib.sh` strips the full box-drawing set so a border-only idle composer reads as empty rather than pending input.

## claude (VERIFIED)

| Fact | Value |
|---|---|
| Busy-pane signature | `esc to interrupt` |
| Exit command | `/exit` |
| Interrupt | single Escape |
| Skill invocation | `/<skill>` (e.g. `/no-mistakes`) |

First launch in a fresh worktree, or first ever on a machine, may show a trust or bypass-permissions confirmation.
After every spawn, peek the pane within about 20 seconds.
If such a dialog is showing, accept it with `bin/fm-send.sh <pane> --key Enter`, or the choice the dialog requires, and verify the brief started processing.

Claude renders a predicted-next-prompt suggestion as dim/faint text inside an otherwise-empty composer after a turn completes.
Firstmate launches every claude crewmate and secondmate with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, scoped to firstmate-launched agents through `bin/fm-spawn.sh`, so it never touches the captain's global config and the ghost text never renders for firstmate-launched crewmates.
The CLI's `--prompt-suggestions` flag is print/SDK-mode only and does not suppress the interactive composer ghost text, verified empirically on v2.1.186.
As defense in depth for any pane that flag cannot reach, including the captain's own firstmate composer that away-mode reads, the composer reader in `bin/fm-herdr-lib.sh` works on herdr's plain pane text and strips box-drawing border chrome, so a border-only idle composer reads as empty rather than as pending input.
Herdr tracks agent status natively and `herdr pane read` returns plain text, so the old ANSI/SGR ghost-text stripping is gone; `fm-peek` and every other human or LLM-facing capture path is plain text.

## codex (VERIFIED 2026-06-11, codex-cli 0.139.0)

| Fact | Value |
|---|---|
| Busy-pane signature | `esc to interrupt` (shown as `• Working (Xs • esc to interrupt)`) |
| Exit command | `/quit` (slash popup needs about 1 second between text and Enter; `fm-send` handles it) |
| Interrupt | single Escape |
| Skill invocation | `$<skill>` (e.g. `$no-mistakes`); `/<skill>` is claude-only and codex rejects it as "Unrecognized command" |

Directory trust dialog on first run per repo root: "Do you trust the contents of this directory?"
Accept with Enter.
The decision persists for the repo, so later worktrees of the same project skip it.

Resume after exit with `codex resume <session-id>`.
The session id is printed on quit.

## opencode (VERIFIED 2026-06-11, v1.15.7-1.17.3)

| Fact | Value |
|---|---|
| Busy-pane signature | `esc interrupt` (dotted spinner footer; note no "to") |
| Exit command | `/exit` |
| Interrupt | double Escape; known flaky while a long shell command runs, so a wedged pane may need `/exit` and relaunch |

No trust dialog.
Opencode can auto-upgrade itself in the background and the running TUI can exit mid-task, observed live from 1.15.7 to 1.17.3.
If a pane shows the exit banner, relaunch with `--continue` to resume the session.
`--prompt` does not auto-submit alongside `--continue`, so send the next instruction via `fm-send` once the TUI is up.

## pi (VERIFIED 2026-06-11)

| Fact | Value |
|---|---|
| Busy-pane signature | `Working...` (braille spinner prefix; no `esc to interrupt` text) |
| Exit command | `/quit` |
| Interrupt | single Escape |

Pi has no permission system, so crewmates are always autonomous.
Keep the brief as one positional argument.
Multiple positional args become separate queued messages; `fm-spawn`'s template already does this correctly.

Project trust dialog can appear on the first pi run in any not-yet-trusted directory, observed even on clean worktrees.
Accept with Enter.
The decision persists per path in `~/.pi/agent/trust.json`, so later spawns in the same worktree slot skip it.

Pi sets `PI_CODING_AGENT=true` for its children; this is its harness-detection env marker.
