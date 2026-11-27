---
"@thomasfosterau/effect-media": minor
---

Image decoding, transforms and encoding. New modules: `Raster` (decoded RGBA pixels and portable pixel operations), `Encoded` (encoded bytes with their sniffed media type), `Transform` (resize with CSS `object-fit` semantics, crop, rotate, flip, pad and auto-orient as data, planned into primitives), `ImageBackend` (the service an image engine provides) and `Image` (`decode`, `transform`, `encode`, `process` and `variants`; `decode` reads the EXIF orientation that `Transform.autoOrient` applies).
