---
name: fm-operate-crew-harness
description: >-
  Operates crewmate harness adapters through select, interrupt, exit, recover,
  and relaunch. Use when a crew pane is wedged, needs interrupt/exit, or harness
  choice/recovery.
---

# fm-operate-crew-harness

Crewmates default to the same harness as firstmate.
Cap override: `config/crew-harness` (local, gitignored; absent or `default` = mirror own harness).
Per-task cap instruction overrides for that dispatch only.
Never dispatch on an unverified adapter; tell the cap and fall back.

Detect: `sbin/fm harness` (self), `sbin/fm harness crew` (effective crew), `sbin/fm harness inspect [name]` (typed registry).
On `unknown`, ask the cap. Cap override always beats detection.
Mechanics for launch live in `fm spawn`.
Interrupt/exit: `fm send <pane> --interrupt` or `fm send <pane> --exit` (reads `harness=` from meta via the internal adapter registry).
`fm send --exit` is withheld for Codex until slash-popup delay is encoded; use explicit exit there.
Fall back to `fm send --key` only when meta lacks harness.

## Adapter facts

### omp

| Fact | Value |
|---|---|
| Exit | `/quit` |
| Interrupt | single Escape |
| Skills | `/skill:<name>` |

Detection checks `OMPCODE` before `CLAUDECODE`. Launch: `omp --auto-approve "$(cat <brief>)"`. Peek within ~20s after spawn.

### claude

| Fact | Value |
|---|---|
| Exit | `/exit` |
| Interrupt | single Escape |
| Skills | `/<skill>` |

Trust/bypass dialogs on first fresh worktree: `fm send <pane> --key Enter`. Spawn sets `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`.

### codex

| Fact | Value |
|---|---|
| Exit | `/quit` (~1s between text and Enter; fm-send handles it) |
| Interrupt | single Escape |
| Skills | `$<skill>` (not `/<skill>`) |

Directory trust on first run per repo root: Enter. Resume: `codex resume <session-id>`.

### opencode

| Fact | Value |
|---|---|
| Exit | `/exit` |
| Interrupt | double Escape (flaky during long shells - may need exit + relaunch) |

No trust dialog. Auto-upgrade can exit mid-task; relaunch with `--continue`, then `fm send` the next instruction (`--prompt` does not auto-submit with `--continue`).

### pi

| Fact | Value |
|---|---|
| Exit | `/quit` |
| Interrupt | single Escape |

Always autonomous. Brief must be one positional arg. Project trust may appear once per path (`~/.pi/agent/trust.json`). Env marker: `PI_CODING_AGENT=true`.

## Stuck-pane order

1. Peek (~40 lines).
2. Answer one line via `fm send` if the brief already answers.
3. `fm send <pane> --interrupt`, then one corrective line.
4. `fm send <pane> --exit`, then relaunch same brief with progress note.
5. Second relaunch fails → backlog `failed`, escalate with evidence.

## includeSkills warning

A home's `config/omp.yml` `includeSkills` **replaces** the discoverable skill registry wholesale.
Do not use it to preload; it makes unlisted skills return Unknown skill.
Audit inject cost with `sbin/fm-context-weight` only when a non-replacing preload mechanism exists.
