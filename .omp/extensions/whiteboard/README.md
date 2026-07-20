# whiteboard

A board-as-conversation loop for named agent sessions.

The board is a shared, free-form markdown file that is the primary channel between the cap and the agent.
The cap edits it in nvim; the agent reads the diff and replies by editing the board.
Loop state is session-local: enable it with `/wb loop` in each named agent session; it is not persisted across sessions.

## Board format

Two-zone convention (not an enforced schema):

- `## Now` - the latest exchange; newest message or reply always goes here.
- `## Working` - shared scratch: plan, open items, discovered work.

`/wb loop` seeds this skeleton (when enabling) if either heading is absent.
The cap may edit anywhere; the agent should not delete cap lines it does not understand.

## Slash surface

Only `/wb` is registered.

| Verb | Description |
|------|-------------|
| `/wb` / `/wb view` / `/wb open` | Show the current board |
| `/wb edit` / `/wb -e` | Open the board in `$EDITOR`/nvim |
| `/wb loop` | Toggle the loop on/off (seeds skeleton + loads settings on enable) |
| `/wb tick` | Run one board turn now (manual one-shot; does not enable the loop) |
| `/wb settings` | Open the settings file in nvim |
| `/wb status` | Loop on/off, autonomy, consecutive count, last outcome |
| `/wb rm <line[-line]>` | Remove one board line or an inclusive range |
| `/wb rr <line[-line]> <text>` | Replace one board line or range in place |
| `/wb rs <heading> :: <text>` | Replace a markdown section by its heading |
| `/wb help` | Verb list |

In `rr`/`rs` text, backslash escapes are decoded so a single-line slash command can write multiple lines: `\n` -> newline, `\t` -> tab, `\\` -> backslash, `\"` -> quote.
These are cap-facing quick edits over `board.removeLines`/`replaceRange`/`replaceSection`; the agent edits the board through `whiteboard_write` (full replace), so the granular primitives are not exposed as agent tools.

`ctrl+shift+w` opens the current board.

## Agent tools

Exactly three tools are registered:

- **`whiteboard_read`** - read the board; default returns a diff since last read; `mode:"full"` returns the complete numbered board.
- **`whiteboard_write`** - atomically replace the entire board (uses `board.replace`); updates the session's last-read snapshot.
- **`whiteboard_checkpoint`** - record the turn outcome; drives the loop continuation decision.

Checkpoint outcomes: `progress` | `settled` | `needs-decision` | `blocked` | `error`.

## Loop mechanics

On enabling the loop (`/wb loop`):

1. Settings are loaded from `$FM_HOME/config/whiteboard-settings`.
2. The board skeleton is seeded only when the board is empty (free-form; newest entries at the bottom).
3. A file watcher is armed on the board's parent directory (debounced).
4. An initial turn is queued immediately.

Each agent turn directive instructs: read the diff (whiteboard_read), reading the full board only when your context is stale or you explicitly need to re-ground; the extension is loaded once for the named session, so a wall-clock gap alone does not require a full re-read; do the work; append any reply at the bottom of the board (brief; the header already carries the agent id and time, so the agent never restates them); acknowledge by deletion - delete a cap message once read and handled (a message left on the board means unread) and delete the agent's own prior messages once the cap has responded (their reply is the read-ack), so the board holds only the live, unaddressed exchange; maintain `## Working`, keep chat minimal, then call `whiteboard_checkpoint` with a truthful outcome and one-sentence summary.

`## Working` is maintained as a next-action queue partitioned by owner: every item is a concrete doable next-action (verb + object) tagged `[agent]` (the loop burns it down) or `[cap]` (a decision, review, or must-read). Gated goals are decomposed to the slice doable now; a truly-blocked item names its unblock and owner; done items leave. A tick then always finds an `[agent]` action or a clean "only `[cap]` items" rest, never a vague stuck. This is a directive-enforced convention, not a parsed schema - the board is never machine-parsed.

Each directive also carries a compact plaintext status header the agent (and the cap, since the turn is displayed) can scan: `tick N`, the agent id, the wall-clock time plus the gap since the previous tick (`+Xm since last tick`), the time since the last human edit (`<$USER> edited: Xm ago` - grows while the cap is away, reads `just now` on a cap-edit turn), the consecutive-turn count, and the previous turn's duration/outcome/result. Each field is on its own line and omitted until it has a value; the machine tick token trails at the end.

The full numbered protocol (steps 1-6) is re-injected only on the first tick of a session or every `WB_FULL_EVERY`-th tick (default 5, a periodic re-ground); every other tick carries the status header plus a one-line protocol reminder, so the boilerplate is not re-sent each turn. A wall-clock gap between ticks no longer forces the full protocol - in a persistent session the protocol is already in context. Set `WB_FULL_EVERY` low (e.g. 2) for more frequent full re-grounds, or 0 to send full only on the first tick.

After a `progress` checkpoint, the loop self-continues if autonomy is on and the consecutive-turn counter is under `max_turns`.
After `settled`, `needs-decision`, `blocked`, or `error`, the loop rests and waits for the next cap edit.
A board save resets the consecutive counter to 0 and queues one new turn.
The watcher observes the parent directory and re-reads the canonical board after every rename event because Darwin reports an atomic save using only the temporary filename; content equality suppresses unrelated directory events.

While the loop is enabled, the interactive omp footer renders an identity-generic `WB <id> · <state> · <h:mm AM/PM>` badge.
The state is `edit` during save debounce, `queued` before delivery, `running` during the turn, a decrementing `<Ns>` countdown before scheduled continuation, and `waiting` while resting after a terminal outcome.
The trailing time is the local wall-clock of the latest queued tick (`lastTickQueuedAt`), formatted the same way as the tick directive header; it stays fixed across countdown refreshes and only advances when a new tick is actually queued.
Disabling the loop hides the badge.
Tick count and detailed loop state remain available through `/wb status`; the footer shows neither.

Autonomy is not gated on presence. With autonomy on, a `progress` checkpoint self-continues the loop up to the `max_turns` cap whether the cap is watching this board, working another pane, or away - useful work multiplies regardless of presence. `max_turns` is the sole runaway/cost backstop (raise it to multiply harder); `settled`, `needs-decision`, `blocked`, and `error` rest the loop. A destructive, irreversible, or security-sensitive action is parked on the board as a cap must-read rather than executed autonomously.

Per-turn interaction signals (trigger, since-last-tick gap, turn duration, terminal outcome, consecutive count, full-vs-compact, since-last-edit, board size, board-changed) are appended as JSONL to `<home>/state/whiteboard-metrics.jsonl`, best-effort. `board-changed` is the independent productivity signal - whether the turn actually changed the board, observed rather than self-declared - so a `progress` turn that changed nothing shows up as unverified.

`/wb tick` fires a single board turn on demand without enabling the loop (no self-continuation), which is useful to poke one exchange manually.
`/wb tick now` (or `/wb tick!`) delivers one steer that interrupts an active turn immediately, but coalesces behind an already-pending tick and collapses repeated requests until that tick is delivered.

`/wb loop` (toggling off), `session_switch`, and `session_branch` fully clear the loop.
`session_shutdown` stops timers but leaves the runtime for status inspection.

## Settings

`$FM_HOME/config/whiteboard-settings` is a `key=value` file.
Missing file uses defaults; unknown keys are ignored.

| Key | Default | Description |
|-----|---------|-------------|
| `autonomy` | `on` | `on` = self-continue on progress; `off` = one reply per cap edit |
| `max_turns` | `12` | Consecutive self-continued turns before resting |

## Board path

Named identity (`$FM_HOME/data/whiteboard.md`) when `config/identity schema_version=1` resolves, else the global fallback (`~/.omp/agent/whiteboard.md` or `WHITEBOARD_FILE`).
