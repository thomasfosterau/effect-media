# Contributing

Read the [README](../README.md) first. Agents should also read [AGENTS.md](../AGENTS.md).

## Workflow

- Branch off the default branch (`main`) and open a pull request into it; never commit to it directly. Open a draft PR as soon as you start, so others can see the work.
- One PR per change, however large. It is your job to get the PR green, reviewed and free of conflicts. Rebase rather than merging the default branch in; PRs are squash-merged with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- Found something out of scope? File an issue and carry on. Keep issue bodies evergreen: update the body with context, rationale and the proposed fix rather than appending comments.
- Once there are dependencies, Dependabot keeps them current; update one by hand only when your change needs it.

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm; use it rather than calling them directly (`vp exec <bin>`, not `npx`). The repository is a pnpm workspace: the core package lives in `packages/effect-media`, and each backend will get its own package beside it.

| Command            | What it does                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `vp install`       | Dependencies, git hooks, and the Effect-patched `tsc`, Oxlint and tsrs (`prepare`)       |
| `vp check`         | Format, and type-aware lint with the Oxlint, `@effect/tsgo` and `@enfect/oxlint` rules   |
| `vp run check`     | The type gate: each package's `src` (no Node types), then its tests                      |
| `vp run test:unit` | Unit and property tests (Vitest through `@effect/vitest`)                                |
| `vp run build`     | `vp pack`: one ESM module and declaration file per public module                         |
| `vp run ci`        | All of the above, in order: the single CI command                                        |
| `vp run fallow`    | [Fallow](https://docs.fallow.tools): dead code, dependencies, duplication and complexity |

The pre-commit hook ([.vite-hooks/pre-commit](../.vite-hooks/pre-commit)) runs `vp staged` and then `vp run fallow:audit`, which fails only on findings the change introduces against `origin/main`. Fallow's findings are guidance; trace "unused" code before deleting it (`vp exec fallow dead-code --trace <file>:<export>`).

### Dependencies

Dependabot ([dependabot.yml](../.github/dependabot.yml)) opens every update weekly, on Wednesday morning Melbourne time: the named runtime sets (`effect` and the like) each in one PR, and every other development dependency in the single `toolchain` group. Security updates skip the schedule and open as soon as an advisory lands, one PR each. Vite+ selects Node.js from `.node-version` and pnpm from `packageManager`; pnpm's own switching is off (`runtimeOnFail` / `pmOnFail`), so one version of each is installed and used.

Every external version lives in the catalog in [pnpm-workspace.yaml](../pnpm-workspace.yaml) (`catalogMode: strict`); `package.json` files reference only `catalog:` (or `catalog:peers` for peer ranges). `effect-tsgo patch` supports only specific TypeScript, Oxlint and tsrs versions, so move `vite-plus`, `typescript` and `@effect/tsgo` together.

Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. The Lockfile workflow verifies it.

Library source must run on every runtime (Node, Bun, Deno, browsers, Cloudflare Workers): no Node built-ins and no DOM types in `packages/*/src`. Platform APIs belong in the backend package that adapts them.

### Changesets

Every change to a published package's behaviour or its emitted `.d.ts` (doc comments included, as a `patch`) carries a changeset: `pnpm changeset`. README, guides, CI and tooling need none. Nothing is published yet; the release workflow comes with the first release.

## Coding guidelines

- Use Effect v4 idioms throughout, and prefer Effect's own modules (`Option`, `Result`, `Array`, `Match`, `Schema`, `Stream`, …) to re-inventing them. Exceptions: non-Effect APIs (codecs, platform media APIs), adapted at the edge, and hot paths where a measurement shows plain code is needed. Read the installed `effect` package (`node_modules/effect/`) rather than guessing at its API.
- Exports follow Effect v4's layout: `index.ts` re-exports each module as a PascalCase namespace (`export * as Foo from "./Foo.ts"`), and each module is also importable through its own PascalCase subpath (`./Foo`).
- Fix lint findings rather than disabling rules; a rule is turned off only in config, scoped and with its reason.

### Comments

- A file-level comment only when it adds non-obvious context (under 50 words).
- Doc comments on exports where they help someone reading IntelliSense: what it's for, not a restatement of the signature.
- Inline comments only where the code can't explain itself: workarounds, performance, non-obvious decisions.
- Never reference GitHub issues, PRs or CI runs in code or docs; stable links to external documentation are fine.

### Tests

- Test logic, edge cases and regressions; don't test what the type system already enforces, or trivial code.
