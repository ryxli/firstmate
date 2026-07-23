---
name: fm-operate-crew-harness
description: Select, control, and recover wedged visible crew harness panes.
---

# fm-operate-crew-harness

This skill controls visible pane workers only.
Use Task/Hub for bounded work, peer bus for mates, whiteboard for durable state, `fm send` only for visible steering, and `fm fleet stop` for registered mate exit.

## Select and control

Crew harness mirrors firstmate unless gitignored `config/crew-harness` sets a value; absent or `default` mirrors; cap dispatch overrides once.
Verify with `sbin/fm harness crew` or `sbin/fm harness inspect <name>`; `unknown` means ask cap and fall back; never dispatch unverified.
Launch is `fm spawn`.
Canonical control is `fm send <pane> --interrupt` or `fm send <pane> --exit`, reading pane `harness=`.
Codex `--exit` stays withheld until slash-popup delay is encoded; `--key` is only for specified keys, never guesses.

| Adapter | Exit | Interrupt | Notes |
|---|---|---|---|
| omp | `/quit` | Esc | `/skill:<name>`; `OMPCODE` before `CLAUDECODE`; peek about 20s. |
| claude | `/exit` | Esc | `/<skill>`; first worktree trust may need Enter. |
| codex | `/quit`, wait about 1s before Enter | Esc | `$<skill>`; trust may need Enter; resume `codex resume <session-id>`. |
| opencode | `/exit` | double Esc | No trust; long-shell interrupt flaky, so exit and relaunch if needed. |
| pi | `/quit` | Esc | Autonomous; brief one positional arg; trust `~/.pi/agent/trust.json`; env `PI_CODING_AGENT=true`. |

## Recovery and skills

Peek about 40 lines; if the brief answers the blocker, send one corrective `fm send <pane> --steer <text>`.
Then interrupt and steer once; then supported `fm send <pane> --exit` or explicit exit path; relaunch the same brief with a progress note.
Never auto-retry `queued=76` or any send because retry can duplicate an instruction.
Second relaunch failure backlogs `failed` and escalates with evidence.
`config/omp.yml` `includeSkills` replaces the discoverable registry; do not preload because unlisted skills become Unknown skill.
Audit cost with `sbin/fm-context-weight` only after non-replacing preload exists.
