import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One ESM module and declaration file per public module, so each is
    // importable by its PascalCase subpath and tree-shakes on its own.
    entry: {
      index: "src/index.ts",
      Color: "src/Color.ts",
      Encoded: "src/Encoded.ts",
      Geometry: "src/Geometry.ts",
      Image: "src/Image.ts",
      ImageBackend: "src/ImageBackend.ts",
      MediaError: "src/MediaError.ts",
      MediaType: "src/MediaType.ts",
      Orientation: "src/Orientation.ts",
      Raster: "src/Raster.ts",
      Transform: "src/Transform.ts",
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
