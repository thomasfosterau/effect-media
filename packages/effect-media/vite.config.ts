import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One ESM module and declaration file per public module, so each is
    // importable by its PascalCase subpath and tree-shakes on its own.
    entry: {
      index: "src/index.ts",
      Color: "src/Color.ts",
      Geometry: "src/Geometry.ts",
      MediaError: "src/MediaError.ts",
      MediaType: "src/MediaType.ts",
    },
    platform: "neutral",
    unbundle: true,
    dts: { generator: "tsgo" },
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
