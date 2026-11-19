# Contributing

Read the [README](../README.md) first. Agents should also read [AGENTS.md](../AGENTS.md).

## Workflow

- Branch off the default branch (`main`) and open a pull request into it; never commit to it directly. Open a draft PR as soon as you start, so others can see the work.
- One PR per change, however large. It is your job to get the PR green, reviewed and free of conflicts. Rebase rather than merging the default branch in; PRs are squash-merged with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- Found something out of scope? File an issue and carry on. Keep issue bodies evergreen: update the body with context, rationale and the proposed fix rather than appending comments.
- Once there are dependencies, Dependabot keeps them current; update one by hand only when your change needs it.

## Toolchain

None is set up yet. The first code change brings in the toolchain the sibling `@thomasfosterau/effect-*` libraries share: [Vite+](https://viteplus.dev) (`vp`) on pnpm with a strict catalog, Oxlint with the Effect presets, Vitest through `vite-plus/test`, `vp pack` builds, a `vp run ci` task as the single CI command, [Fallow](https://docs.fallow.tools) as a pre-commit audit, and Changesets for releases. Document its commands and gates here when it lands.

## Coding guidelines

- Use Effect v4 idioms throughout, and prefer Effect's own modules (`Option`, `Result`, `Array`, `Match`, `Schema`, `Stream`, …) to re-inventing them. Exceptions: non-Effect APIs (codecs, platform media APIs), adapted at the edge, and hot paths where a measurement shows plain code is needed. Read the installed `effect` package (`node_modules/effect/`) rather than guessing at its API.
- Fix lint findings rather than disabling rules; a rule is turned off only in config, scoped and with its reason.

### Comments

- A file-level comment only when it adds non-obvious context (under 50 words).
- Doc comments on exports where they help someone reading IntelliSense: what it's for, not a restatement of the signature.
- Inline comments only where the code can't explain itself: workarounds, performance, non-obvious decisions.
- Never reference GitHub issues, PRs or CI runs in code or docs; stable links to external documentation are fine.

### Tests

- Test logic, edge cases and regressions; don't test what the type system already enforces, or trivial code.
