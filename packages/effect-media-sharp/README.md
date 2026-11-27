# @thomasfosterau/effect-media-sharp

An [effect-media](../../README.md) image backend on [sharp](https://sharp.pixelplumbing.com) (libvips): the fastest choice on Node, and it also runs on Bun and Deno. It reads JPEG, PNG, WebP, AVIF, GIF, TIFF and SVG, and writes all of those but SVG.

```ts
import { Image, Transform } from "@thomasfosterau/effect-media";
import { SharpBackend } from "@thomasfosterau/effect-media-sharp";
import { Effect } from "effect";

const program = Image.process(bytes, [Transform.resize({ width: 640 })], { format: "avif" }).pipe(
  Effect.provide(SharpBackend.layer),
);
```

Images over sharp's default limit of 268 million pixels fail with `ResourceLimitExceeded` rather than being decoded.
