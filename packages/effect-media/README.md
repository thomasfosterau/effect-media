# @thomasfosterau/effect-media

The core of [effect-media](../../README.md): media data types and operations for [Effect](https://effect.website), with no native or wasm dependencies, so it runs on every JavaScript runtime.

| Module       | What it holds                                                                          |
| ------------ | -------------------------------------------------------------------------------------- |
| `Geometry`   | Points, sizes, rectangles and 2D affine matrices                                       |
| `Color`      | Colours in sRGB, linear sRGB, Display P3, Oklab and Oklch; conversions and CSS parsing |
| `MediaType`  | Media types, file-extension lookup and content sniffing                                |
| `MediaError` | The typed errors every backend reports                                                 |

```ts
import { Color } from "@thomasfosterau/effect-media";

const accent = Color.oklch(0.7, 0.1, 250);
Color.toHex(accent); // "#6da3da"
```

Each module is also importable by its own subpath, such as `@thomasfosterau/effect-media/Color`.
