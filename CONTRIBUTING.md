# Contributing

Thanks for wanting to contribute.

Firstmate's shared infrastructure uses a main-only workflow.
Maintainers commit proportionately verified shared changes directly to `main` and push `origin main`.
External contributions are welcome through ordinary GitHub pull requests.

Runtime tool versions (node, bun, and the `herdr` binary) are managed with `mise`; install it once per machine and the pinned versions follow the repo.

## Workflow

1. Fork the repository, then clone your fork.
2. Create a focused branch and make your changes.
3. Run the focused checks that cover the behavior you changed.
4. Commit the changes.
5. Push the branch to your fork:

   ```sh
   git push origin <branch>
   ```

6. Open a pull request against `main` with a concise description and the checks you ran.

## Repo conventions

- This repo is a template for running a firstmate orchestrator agent.
  `AGENTS.md` is the agent's entire job description; `CLAUDE.md` is a symlink to it, and `.claude/skills` is a symlink to `.agents/skills`.
- `AGENTS.md` section 1 is canonical for the tracked-file list: only shared material is tracked, and everything personal to one fleet's local state is gitignored.
- The command surface is the typed `fm` CLI (`sbin/fm`, bun): one verb module per file under `.omp/extensions/cli/verbs/`, auto-discovered, no registry to edit.
  Mark Cap-facing verbs with `surface: "captain"`; root `fm --help` is the curated workflow guide in help.ts; bare `fm <verb> --help` is rendered from passive `HelpSpec` before `run`; `fm toolbelt` lists every verb via shared `loadVerbs()`.
  New tooling is born typed - never new bash in `sbin/`.
  The remaining bash scripts in `sbin/` are held deliberately (live pane orchestration and cap-gated git mutation); each is ported to a verb when next touched (port-on-touch), and until then `shellcheck sbin/*.sh` must pass, enforced by CI.
- Changes to harness adapters (launch templates in `sbin/fm spawn`, the adapter tables in `AGENTS.md`) must be verified empirically against the real harness, never written from documentation alone.
- In Markdown, put each full sentence on its own line.

## Questions

Open an issue.
