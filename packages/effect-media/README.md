# @thomasfosterau/effect-media

The core of [effect-media](../../README.md): media data types and operations for [Effect](https://effect.website), with no native or wasm dependencies, so it runs on every JavaScript runtime. Decoding and encoding need a backend, such as [`effect-media-sharp`](../effect-media-sharp) or [`effect-media-wasm`](../effect-media-wasm).

| Module         | What it holds                                                                          |
| -------------- | -------------------------------------------------------------------------------------- |
| `Geometry`     | Points, sizes, rectangles and 2D affine matrices                                       |
| `Color`        | Colours in sRGB, linear sRGB, Display P3, Oklab and Oklch; conversions and CSS parsing |
| `MediaType`    | Media types, file-extension lookup and content sniffing                                |
| `Exif`         | Reading, editing and writing EXIF; stripping EXIF and XMP, or just the location        |
| `MediaError`   | The typed errors every backend reports                                                 |
| `Raster`       | Decoded RGBA pixels and portable pixel operations                                      |
| `Encoded`      | Encoded bytes with their sniffed media type                                            |
| `Transform`    | Resize, crop, rotate, flip, pad and auto-orient as data, planned into primitives       |
| `ImageBackend` | The service an image engine provides, and helpers for writing one                      |
| `Image`        | Decode, transform and encode with whichever backend is provided                        |

```ts
import { Color } from "@thomasfosterau/effect-media";

const accent = Color.oklch(0.7, 0.1, 250);
Color.toHex(accent); // "#6da3da"
```

Resizing follows CSS `object-fit` (`cover`, `contain`, `fill`, `inside`, `outside`), with `withoutEnlargement` to leave small images alone. `Image.variants` decodes once and writes several outputs, such as a set of responsive widths in WebP and AVIF.

Each module is also importable by its own subpath, such as `@thomasfosterau/effect-media/Color`.
