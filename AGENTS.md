# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file only adds what is specific to agents.

- You may open pull requests in this repository (GitHub MCP tools or `gh`). Say which gates ran and which couldn't.
- Out-of-scope work you notice: file an issue and move on.
- Write idiomatic Effect v4 (see docs/CONTRIBUTING.md).
- The toolchain matches the sibling `@thomasfosterau/effect-*` libraries, but check the commands in docs/CONTRIBUTING.md and `vite.config.ts` rather than assuming theirs exist here.
- `vp run test:unit` is quick; use `vp test run <file>` from the package directory while iterating.

## Pull requests

- **Write the PR body with the `pr` skill** from Matt Pocock's skills (`mattpocock-skills:pr`), filling in the repository's pull request template where there is one.
- **Resolve merge conflicts before you hand a PR over.** Rebase onto `origin/main` and push; a PR that conflicts with `main` isn't finished.
- **Mark the PR ready for review as soon as the initial draft is finished.** Don't wait for CI to run, for reviews, or for the owner to do it. Keep fixing CI failures and review findings on the ready PR.
