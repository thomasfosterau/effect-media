import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { defineConfig } from "vite-plus";

const ignorePatterns = ["**/dist/**", "**/coverage/**", "**/node_modules/**", ".changeset/*.md"];

const packages = ["effect-media"] as const;

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,ts,json,md,yaml,yml}": "vp check --fix",
  },
  fmt: {
    ignorePatterns,
  },
  lint: {
    ignorePatterns,
    // Type-aware linting through the tsrs that vite-plus bundles, patched by
    // `effect-tsgo patch --oxlint` (the `prepare` script) so that
    // `@effect/tsgo`'s `effecttsgo/*` rules run too.
    extends: [recommended, effect.configs.recommended],
    plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ["**/tests/**"],
        rules: {
          // Count the `assert*` helpers tests share as assertions.
          "vitest/expect-expect": [
            "warn",
            { assertFunctionNames: ["assert", "assert.*", "assert*"] },
          ],
        },
      },
    ],
  },
  run: {
    cache: true,
    tasks: {
      // The type gate of record: the Effect-patched tsc over each package's
      // source (no Node types) and then its tests.
      check: {
        command: packages.flatMap((name) => [
          `tsc -p packages/${name}/tsconfig.json`,
          `tsc -p packages/${name}/tests/tsconfig.json`,
        ]),
      },
      build: {
        command: "vp run -r build",
      },
      "test:unit": {
        command: "vp run -r test run",
      },
      fallow: {
        command: "vp exec fallow",
        cache: false,
      },
      "fallow:audit": {
        command: "vp exec fallow audit --base origin/main --quiet",
        cache: false,
      },
      // The single CI command.
      ci: {
        command: ["vp check", "vp run check", "vp run test:unit", "vp run build"],
        cache: false,
      },
    },
  },
});
