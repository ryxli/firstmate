# Ideas (tiny slices)

Keel's own small, developable ideas for the firstmate/harness system. Tracked and shared so mates can pick a slice from the repo; expect Keel to fast-forward this file with new parked ideas over time.
Rules: each is ONE super-small slice a mate could pick up and finish in one sitting - not a project, not a track. Harness only (BFL work never goes here; that is the Work track in backlog.md). If a slice grows, promote it to the Harness queue in backlog.md instead.

## Open
- fm-panes staleness column - add an optional last-status age column to `bin/fm-panes.sh --all` so a glance shows which panes have gone quiet. Pure read, no new deps.
- warm-context peek shortcut - a `bin/fm-peek.sh <id> --context` mode that shows only the pane's current task + last status line, so checking a mate costs fewer tokens than a full peek. Tiny wrapper over existing peek.
- identity check in bootstrap - have `bin/fm-bootstrap.sh` run `bin/fm-identity-migrate.sh check` and print one line only if any home is unversioned. Reuses the landed gate; surfaces drift early.

## Developed / promoted
(none yet)
