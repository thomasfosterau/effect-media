/**
 * Decoded images as pixel buffers, and the pixel operations every backend can
 * fall back on. Pixels are 8-bit sRGB RGBA with straight alpha, rows top to
 * bottom with no padding.
 */
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Color from "./Color.ts";
import * as Geometry from "./Geometry.ts";
import * as Kernels from "./internal/kernels.ts";
import { InvalidDimensions } from "./MediaError.ts";

/** Decoded pixels: `width × height × 4` bytes of 8-bit sRGB RGBA, straight alpha. */
export class RasterImage extends Data.Class<{
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}> {}

/** Width and height must be positive integers no larger than this. */
export const maxDimension = 65_535;

const validDimension = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= maxDimension;

/**
 * Wraps pixel data, checking that the dimensions are valid and that the buffer
 * holds exactly `width × height × 4` bytes. The buffer is not copied.
 */
export const make = (
  width: number,
  height: number,
  data: Uint8Array,
  backend = "core",
): Result.Result<RasterImage, InvalidDimensions> =>
  validDimension(width) && validDimension(height) && data.length === width * height * 4
    ? Result.succeed(new RasterImage({ width, height, data }))
    : Result.fail(new InvalidDimensions({ backend, width, height }));

/** A raster of one colour. */
export const fill = (
  width: number,
  height: number,
  color: Color.Color,
): Result.Result<RasterImage, InvalidDimensions> => {
  const valid = validDimension(width) && validDimension(height);
  return make(
    width,
    height,
    valid ? Kernels.fill(width, height, Color.toRgba8(color)) : new Uint8Array(0),
  );
};

/** The size of a raster. */
export const size = (self: RasterImage): Geometry.Size => Geometry.size(self.width, self.height);

/** The `[r, g, b, a]` bytes of the pixel at `(x, y)`, or `None` outside the image. */
export const pixel = (
  self: RasterImage,
  x: number,
  y: number,
): Option.Option<readonly [number, number, number, number]> => {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= self.width ||
    y >= self.height
  ) {
    return Option.none();
  }
  const i = (y * self.width + x) * 4;
  const d = self.data;
  return Option.some([d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0]);
};

const raster = (width: number, height: number, data: Uint8Array): RasterImage =>
  new RasterImage({ width, height, data });

/** Copies out a rectangle, which must lie within the image (see `Transform.plan`). */
export const crop = (self: RasterImage, rect: Geometry.Rect): RasterImage =>
  raster(
    rect.width,
    rect.height,
    Kernels.crop(self.data, self.width, rect.x, rect.y, rect.width, rect.height),
  );

/** Rotates clockwise by a right angle. */
export const rotate = (self: RasterImage, degrees: 90 | 180 | 270): RasterImage => {
  const swap = degrees !== 180;
  return raster(
    swap ? self.height : self.width,
    swap ? self.width : self.height,
    Kernels.rotate(self.data, self.width, self.height, degrees),
  );
};

/** Mirrors left to right (`horizontal`) or top to bottom (`vertical`). */
export const flip = (self: RasterImage, axis: "horizontal" | "vertical"): RasterImage =>
  raster(self.width, self.height, Kernels.flip(self.data, self.width, self.height, axis));

/** Adds a border of the given widths, filled with a colour. */
export const pad = (
  self: RasterImage,
  edges: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  },
  background: Color.Color,
): RasterImage => {
  const width = self.width + edges.left + edges.right;
  const height = self.height + edges.top + edges.bottom;
  return raster(
    width,
    height,
    Kernels.pad(
      self.data,
      self.width,
      self.height,
      edges.left,
      edges.top,
      width,
      height,
      Color.toRgba8(background),
    ),
  );
};

/** Resamples to an exact size by picking the nearest source pixel. */
export const resizeNearest = (self: RasterImage, width: number, height: number): RasterImage =>
  raster(width, height, Kernels.resizeNearest(self.data, self.width, self.height, width, height));
