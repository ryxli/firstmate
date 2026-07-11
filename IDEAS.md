# Ideas (tiny slices)

Shared idea exchange between firstmate instances that push to this same firstmate remote (peer firstmates, not this fleet's crewmates). This is collaboration on the shared firstmate/harness template itself.
Rules: each is ONE super-small slice a peer firstmate could pick up and finish in one sitting - not a project, not a track. Harness/template only (a specific fleet's BFL or project work never goes here). If a slice grows, it becomes real shared work, not a parked idea. Claim a slice by noting your instance before developing it, so two firstmates do not collide.

## Open
- fm-panes staleness column - add an optional last-status age column to `bin/fm-panes.sh --all` so a glance shows which panes have gone quiet. Pure read, no new deps.
- warm-context peek shortcut - a `bin/fm-peek.sh <id> --context` mode that shows only the pane's current task + last status line, so checking a mate costs fewer tokens than a full peek. Tiny wrapper over existing peek.
- identity check in bootstrap - have `bin/fm-bootstrap.sh` run `bin/fm-identity-migrate.sh check` and print one line only if any home is unversioned. Reuses the landed gate; surfaces drift early.

## Developed / promoted
(none yet)
