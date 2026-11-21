import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      SharpBackend: "src/SharpBackend.ts",
    },
    platform: "neutral",
    unbundle: true,
    dts: { generator: "tsgo" },
    sourcemap: true,
  },
  // Resolve the workspace packages to their TypeScript source (see tsconfig.base.json).
  ssr: { resolve: { conditions: ["effect-media-source", "node", "development|production"] } },
  test: {
    include: ["tests/**/*.test.ts"],
    // Encoding AVIF at several sizes takes a few seconds.
    testTimeout: 30_000,
  },
});
