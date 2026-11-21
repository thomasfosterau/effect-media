# effect-media

An experimental library for working with images, audio and video with [Effect](https://effect.website).

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. Nothing is published yet, and the API will change.

It decodes, transforms and encodes images through interchangeable backends, which all pass the same [conformance suite](packages/conformance):

| Package                                                             | What it is                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`@thomasfosterau/effect-media`](packages/effect-media)             | The core: data types, transforms as data, and the `ImageBackend` service                               |
| [`@thomasfosterau/effect-media-sharp`](packages/effect-media-sharp) | A backend on [sharp](https://sharp.pixelplumbing.com) (libvips), for Node, Bun and Deno                |
| [`@thomasfosterau/effect-media-wasm`](packages/effect-media-wasm)   | A backend on WebAssembly codecs ([jSquash](https://github.com/jamsinclair/jSquash)), for every runtime |

```ts
import { Image, Transform } from "@thomasfosterau/effect-media";
import { SharpBackend } from "@thomasfosterau/effect-media-sharp";
import { Effect } from "effect";

// A 480px-wide WebP thumbnail, turned upright first.
const thumbnail = (photo: Uint8Array) =>
  Image.process(photo, [Transform.autoOrient(), Transform.resize({ width: 480 })], {
    format: "webp",
  }).pipe(Effect.provide(SharpBackend.layer));
```

A browser backend, vector graphics and drawing come next. See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) to contribute; agents also read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE.md)
