# @thomasfosterau/effect-media-wasm

An [effect-media](../../README.md) image backend on WebAssembly codecs from [jSquash](https://github.com/jamsinclair/jSquash) (MozJPEG, the Squoosh PNG codec, libwebp, libavif) and Squoosh's resampler. It has no native code, so it runs wherever WebAssembly does. It reads and writes JPEG, PNG, WebP and AVIF.

Each codec needs its `.wasm` file, and how it gets one depends on the runtime:

| Runtime                           | Layer                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Browsers, Deno, bundlers          | `WasmBackend.layer`: each codec fetches the file beside its own module                           |
| Node and Bun                      | `WasmNode.layer` from `@thomasfosterau/effect-media-wasm/WasmNode`: the files are read from disk |
| Cloudflare Workers, anything else | `WasmBackend.layerWithModules(modules)` with modules you compile or import (see `moduleFiles`)   |

```ts
import { Image, Transform } from "@thomasfosterau/effect-media";
import * as WasmNode from "@thomasfosterau/effect-media-wasm/WasmNode";
import { Effect } from "effect";

const program = Image.process(bytes, [Transform.resize({ width: 640 })], { format: "webp" }).pipe(
  Effect.provide(WasmNode.layer),
);
```

Its results match the sharp backend within the tolerances of the shared conformance suite; exact operations (crop, rotate, flip, pad) match byte for byte.
