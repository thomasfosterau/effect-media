import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { defineConfig } from "vite-plus";

const ignorePatterns = ["**/dist/**", "**/coverage/**", "**/node_modules/**", ".changeset/*.md"];

// Each package's type-check projects: its `src` first, then its tests.
const typeChecks = [
  "packages/effect-media/tsconfig.json",
  "packages/effect-media/tests/tsconfig.json",
  "packages/effect-media-sharp/tsconfig.json",
  "packages/effect-media-sharp/tests/tsconfig.json",
  "packages/effect-media-wasm/tsconfig.json",
  "packages/effect-media-wasm/tsconfig.portable.json",
  "packages/effect-media-wasm/tests/tsconfig.json",
  "packages/conformance/tsconfig.json",
] as const;

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
        // Per-pixel loops over byte buffers: an `Array` pipeline here would
        // allocate for every pixel.
        files: ["packages/*/src/internal/kernels.ts"],
        rules: { "effect/imperative-loops": "off" },
      },
      {
        // Node-only code that reads files without pulling in a platform
        // package: the wasm Node loader, the test harness and its fixtures.
        files: ["packages/effect-media-wasm/src/WasmNode.ts", "packages/conformance/**"],
        rules: { "effect/use-filesystem-service": "off", "effect/avoid-sync-fs": "off" },
      },
      {
        // One-off Node scripts, such as the fixture generator: plain
        // sequential code reads best.
        files: ["packages/*/scripts/**"],
        rules: { "effect/imperative-loops": "off" },
      },
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
      // source (the core without Node or DOM types) and then its tests.
      check: {
        command: typeChecks.map((project) => `tsc -p ${project}`),
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
