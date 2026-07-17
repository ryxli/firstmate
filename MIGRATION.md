# Migration note - 2026-07-17 consolidation cutover

This file landing on `main` is the cutover signal: the consolidation is fully landed and reconcile work can resume on any surface.
Delete this file once both machines have completed the steps below.

**Status: the originating machine (Keel's laptop) confirmed complete on 2026-07-17** - local `cap.md` renamed, `fm health` smoke clean, global omp config trimmed.
One step was missing from the original checklist and remains for the second machine (step 5 below).
The second machine deletes this file after finishing it - no further cross-machine confirmation needed.

## What changed

1. **The typed `fm` CLI replaced most of sbin's bash.**
   Every deleted `sbin/fm-<x>.sh` is now invoked as `sbin/fm <x>` - same flags, env vars, output, and exit codes.
   Verb modules live one-per-file in `.omp/extensions/cli/verbs/` and are auto-discovered; new tooling is born typed (see `CONTRIBUTING.md`).
   The `fm-axi` name is fully retired; `fm` subsumes its `fleet` and `home` commands.
   Still bash on purpose (port-on-touch): spawn, send, teardown, update, fleet-sync, bootstrap, brief, merge-local, reconcile-status, lavish-open, lavish-steward, and the shared libs.
2. **Retired outright** (recoverable from git history): `kpi-view` (+ template), `skill-census`, `home-move`, `fm-view-lib.sh`, `fm-eval-run`.
   The longitudinal performance need is owned by the new `fm milestone-view` dashboard.
3. **Persona rename: captain -> cap** across all tracked text.
   The shared-text guard still catches legacy "captain" leaks and deliberately does not flag bare "cap".

## Steps on each machine after pulling

1. `mv data/captain.md data/cap.md` (local layer; tracked pointers already expect `cap.md`).
2. Restart any live firstmate session so nothing calls deleted script paths from stale context.
3. Smoke check: `sbin/fm health` should run clean end-to-end (warns about genuinely stale fleet state are fine).
4. Trust CI for the full suite; run individual `tests/*.test.sh` only when touching that surface.
5. Trim firstmate skills out of the machine-global omp config: in `~/.omp/agent/config.yml` under `skills.includeSkills`, remove `afk`, `crew-supervisor`, `updatefirstmate`, and `firstmate-evaluation` (keep personal machine-wide tools such as `lavish`, `gh-axi`).
   Firstmate skills load per-home only: the template's `.omp/config.yml` covers firstmate sessions, and each secondmate home's `config/omp.yml` covers that mate; a home list REPLACES the global array wholesale, so homes must list everything they need.
   If a secondmate home has no `config/omp.yml`, create one (see the note in any existing mate's copy).
