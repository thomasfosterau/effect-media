---
"@thomasfosterau/effect-media": patch
---

`Color.parse` accepts opaque `color(<space> r g b)` without a slash alpha, so it parses everything `Color.format` emits. A fourth space-separated value, as in `rgb(1 2 3 4)`, is now rejected rather than read as alpha.
