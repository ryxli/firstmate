---
name: fm-operate-crew-harness
description: >-
  Operates crewmate harness adapters through select, interrupt, exit, recover,
  and relaunch. Use when a crew pane is wedged, needs interrupt/exit, or harness
  choice/recovery.
---

# fm-operate-crew-harness

This skill controls visible pane-backed workers only.

Channel hierarchy:
- OMP Task/Hub for bounded research/implementation/review
- peer bus (`peer_send`) for firstmate ↔ secondmate and mate ↔ mate handoffs
- whiteboard for durable lane state
- `fm send` for visible-pane steering/control only (not mate communication)
- `fm fleet stop` for persistent registered mate session exit

Routine firstmate and secondmate execution defaults to OMP subagents; persistent mate communication defaults to the peer bus.

Crewmates default to the same harness as firstmate.
Cap override: `config/crew-harness` (local, gitignored; absent or `default` = mirror own harness).
Per-task cap instruction overrides for that dispatch only.
Never dispatch on an unverified adapter; tell the cap and fall back.

Detect: `sbin/fm harness` (self), `sbin/fm harness crew` (effective crew), `sbin/fm harness inspect [name]` (typed registry).
On `unknown`, ask the cap. Cap override always beats detection.
Mechanics for launch live in `fm spawn`.
Interrupt/exit: `fm send <pane> --interrupt` or `fm send <pane> --exit` (reads `harness=` from meta via the internal adapter registry).
`fm send --exit` is withheld for Codex until slash-popup delay is encoded; use explicit exit there.
`fm send <pane> --key <key>` bypasses adapter lookup and is only for an explicit key sequence; when adapter-aware exit is unsupported, use the documented manual or timed exit path rather than guessed keys.

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
| Exit | `/quit` (slash popup needs about 1s between text and Enter; `fm send --exit` is unsupported) |
| Interrupt | single Escape |
| Skills | `$<skill>` (not `/<skill>`) |

Directory trust on first run per repo root: Enter. Resume: `codex resume <session-id>`.

### opencode

| Fact | Value |
|---|---|
| Exit | `/exit` |
| Interrupt | double Escape (flaky during long shells - may need exit + relaunch) |

No trust dialog.
If OpenCode exits unexpectedly, relaunch with the current OpenCode launch template, then send the next instruction explicitly.

### pi

| Fact | Value |
|---|---|
| Exit | `/quit` |
| Interrupt | single Escape |

Always autonomous. Brief must be one positional arg. Project trust may appear once per path (`~/.pi/agent/trust.json`). Env marker: `PI_CODING_AGENT=true`.

## Stuck-pane order

1. Peek (~40 lines).
2. If the brief already answers the blocker, send one corrective line with `fm send <pane> --steer <text>`.
3. `fm send <pane> --interrupt`, then one corrective `--steer` line.
4. Use `fm send <pane> --exit` when the adapter supports it; otherwise use its documented explicit exit path, then relaunch the same brief with a progress note.
5. Send terminals: `delivered=0` (idle submit), `queued=76` (accepted while working), `composer-blocked=75`, `failed=1`. Text never claims model-level `consumed`.
6. Never auto-retry `queued=76` or any send; retry can duplicate one logical instruction.
7. Second relaunch fails → backlog `failed`, escalate with evidence.

## includeSkills warning

A home's `config/omp.yml` `includeSkills` **replaces** the discoverable skill registry wholesale.
Do not use it to preload; it makes unlisted skills return Unknown skill.
Audit inject cost with `sbin/fm-context-weight` only when a non-replacing preload mechanism exists.
Inspect or repair specialist-home isolation with `fm home skills check|sync <id|path>` or `fm home skills reconcile <id|--all>`.
