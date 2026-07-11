# Contributing

Thanks for wanting to contribute.

Firstmate's shared infrastructure uses a main-only workflow.
Maintainers commit proportionately verified shared changes directly to `main` and push `origin main`.
External contributions are welcome through ordinary GitHub pull requests.

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
- Only shared material is tracked: `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `.tasks.toml`, `.github/workflows/`, `sbin/`, and `.agents/skills/`.
  Everything personal to one captain's fleet (`data/`, `state/`, `config/`, `projects/`, `.no-mistakes/`) is gitignored; never commit it.
  The root `.tasks.toml` is tracked `tasks-axi` config for `data/backlog.md`; compatible `tasks-axi` uses it for routine backlog mutations.
  It does not make `data/` tracked.
- Helper scripts in `sbin/` are plain bash.
  Each starts with a usage header comment; keep it accurate when you change behavior.
  `shellcheck sbin/*.sh` must pass, and CI enforces it.
- Changes to harness adapters (launch templates in `sbin/fm-spawn.sh`, the adapter tables in `AGENTS.md`) must be verified empirically against the real harness, never written from documentation alone.
- In Markdown, put each full sentence on its own line.

## Questions

Open an issue, or talk to me on [Discord](https://discord.gg/Wsy2NpnZDu).
