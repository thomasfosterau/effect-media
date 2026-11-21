// Per-pixel loops over RGBA8 buffers. These are the hot paths CONTRIBUTING
// allows to be plain code: an Effect `Array` pipeline here allocates per pixel.

type Rgba = readonly [number, number, number, number];

export const fill = (width: number, height: number, rgba: Rgba): Uint8Array => {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out.set(rgba, i);
  }
  return out;
};

export const crop = (
  data: Uint8Array,
  stride: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array => {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * stride + x) * 4;
    out.set(data.subarray(start, start + width * 4), row * width * 4);
  }
  return out;
};

export const rotate = (
  data: Uint8Array,
  width: number,
  height: number,
  degrees: 90 | 180 | 270,
): Uint8Array => {
  const out = new Uint8Array(data.length);
  const outWidth = degrees === 180 ? width : height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Destination of source (x, y) after a clockwise rotation.
      const [dx, dy] =
        degrees === 90
          ? [height - 1 - y, x]
          : degrees === 180
            ? [width - 1 - x, height - 1 - y]
            : [y, width - 1 - x];
      const from = (y * width + x) * 4;
      out.set(data.subarray(from, from + 4), (dy * outWidth + dx) * 4);
    }
  }
  return out;
};

export const flip = (
  data: Uint8Array,
  width: number,
  height: number,
  axis: "horizontal" | "vertical",
): Uint8Array => {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to =
        axis === "horizontal"
          ? (y * width + (width - 1 - x)) * 4
          : ((height - 1 - y) * width + x) * 4;
      out.set(data.subarray(from, from + 4), to);
    }
  }
  return out;
};

export const pad = (
  data: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
  outWidth: number,
  outHeight: number,
  background: Rgba,
): Uint8Array => {
  const out = fill(outWidth, outHeight, background);
  for (let y = 0; y < height; y++) {
    out.set(data.subarray(y * width * 4, (y + 1) * width * 4), ((top + y) * outWidth + left) * 4);
  }
  return out;
};

export const resizeNearest = (
  data: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8Array => {
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    // Sample at pixel centres, as libvips does.
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / outWidth));
      const from = (sy * width + sx) * 4;
      out.set(data.subarray(from, from + 4), (y * outWidth + x) * 4);
    }
  }
  return out;
};
