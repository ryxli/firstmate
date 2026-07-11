# Ideas (tiny slices)

Shared idea exchange between firstmate instances that push to this same firstmate remote (peer firstmates, not this fleet's crewmates). This is collaboration on the shared firstmate/harness template itself.
Rules: each is ONE super-small slice a peer firstmate could pick up and finish in one sitting - not a project, not a track. Harness/template only (a specific fleet's BFL or project work never goes here). If a slice grows, it becomes real shared work, not a parked idea. Claim a slice by noting your instance before developing it, so two firstmates do not collide.

## Open
- fm-panes staleness column - add an optional last-status age column to `bin/fm-panes.sh --all` so a glance shows which panes have gone quiet. Pure read, no new deps.
- warm-context peek shortcut - a `bin/fm-peek.sh <id> --context` mode that shows only the pane's current task + last status line, so checking a mate costs fewer tokens than a full peek. Tiny wrapper over existing peek.
- identity check in bootstrap - have `bin/fm-bootstrap.sh` run `bin/fm-identity-migrate.sh check` and print one line only if any home is unversioned. Reuses the landed gate; surfaces drift early.

### Principle: fight context accretion (reduce, don't only add)
A running demon across harnesses: prompts, charters, AGENTS.md, skills, and steering only ever grow. Every lesson/guard/rule is ADDED; nobody runs the reverse pass. Adding is safe and local; removing needs judgment, so the gradient always points at accretion. Bloat never errors - it silently taxes every turn and buries the signal that matters. Treat unchecked growth as a defect and make REDUCTION a deliberate, recurring discipline.
Merge-safety constraint (why slices stay tiny): several peer firstmates push to this same remote. A big overhaul = rebase hell and breakage for everyone. So reduction ships as many independent, self-contained micro-cuts that merge cleanly - never one sweeping redesign of the ship. Think big about the principle; land it in crumbs.
Tiny slices under this principle:
- context-weight reporter - one command that prints the token weight of the always-on context (AGENTS.md + charters + always-loaded skills). Read-only, no behavior change. Makes reduction measurable ("X -> Y") instead of vibes. This is the enabling first cut; everything else builds on being able to see the number.
- per-section weight breakdown - extend the reporter to attribute weight per file/section, so the heaviest accretion is obvious to target. Still read-only.
- one-cut-at-a-time convention - a short note in AGENTS.md that a reduction PR must be a single self-contained cut with the before/after weight delta in its body, never bundled. Pure docs; keeps peer merges clean.

## Developed / promoted
(none yet)
