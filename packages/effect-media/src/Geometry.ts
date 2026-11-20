/**
 * Two-dimensional geometry shared by images, vector graphics and video frames.
 * Coordinates follow the raster convention: the origin is the top-left corner
 * and `y` grows downwards.
 */
import { dual } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Coordinate = Schema.Finite;
const Extent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** A position in a 2D plane. */
export class Point extends Schema.Class<Point, { readonly brand: unique symbol }>(
  "effect-media/Point",
)({
  x: Coordinate,
  y: Coordinate,
}) {}

/** A non-negative width and height. */
export class Size extends Schema.Class<Size, { readonly brand: unique symbol }>(
  "effect-media/Size",
)({
  width: Extent,
  height: Extent,
}) {}

/** An axis-aligned rectangle given by its top-left corner and its size. */
export class Rect extends Schema.Class<Rect, { readonly brand: unique symbol }>(
  "effect-media/Rect",
)({
  x: Coordinate,
  y: Coordinate,
  width: Extent,
  height: Extent,
}) {}

/**
 * A 2D affine transform, in the same layout as CSS and Canvas `DOMMatrix`:
 * `x' = a·x + c·y + e` and `y' = b·x + d·y + f`.
 */
export class Matrix extends Schema.Class<Matrix, { readonly brand: unique symbol }>(
  "effect-media/Matrix",
)({
  a: Coordinate,
  b: Coordinate,
  c: Coordinate,
  d: Coordinate,
  e: Coordinate,
  f: Coordinate,
}) {}

/** The origin, `(0, 0)`. */
export const origin: Point = new Point({ x: 0, y: 0 });

/** The transform that leaves every point where it is. */
export const identity: Matrix = new Matrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** Creates a point. */
export const point = (x: number, y: number): Point => new Point({ x, y });

/** Creates a size. */
export const size = (width: number, height: number): Size => new Size({ width, height });

/** Creates a rectangle from its top-left corner and size. */
export const rect = (x: number, y: number, width: number, height: number): Rect =>
  new Rect({ x, y, width, height });

/** Converts degrees to radians, the unit every angle in this library uses. */
export const degrees = (value: number): number => (value * Math.PI) / 180;

/** The area of a size or rectangle. */
export const area = (self: Size | Rect): number => self.width * self.height;

/** The width divided by the height, or `None` when the height is zero. */
export const aspectRatio = (self: Size | Rect): Option.Option<number> =>
  self.height === 0 ? Option.none() : Option.some(self.width / self.height);

/** The rectangle at the origin with the given size. */
export const fromSize = (self: Size): Rect => rect(0, 0, self.width, self.height);

/** The size of a rectangle. */
export const toSize = (self: Rect): Size => size(self.width, self.height);

/** The centre point of a rectangle. */
export const center = (self: Rect): Point =>
  point(self.x + self.width / 2, self.y + self.height / 2);

/** Whether a point lies inside a rectangle. The right and bottom edges are excluded. */
export const contains: {
  (p: Point): (self: Rect) => boolean;
  (self: Rect, p: Point): boolean;
} = dual(
  2,
  (self: Rect, p: Point): boolean =>
    p.x >= self.x && p.y >= self.y && p.x < self.x + self.width && p.y < self.y + self.height,
);

/** The overlap of two rectangles, or `None` when they do not overlap. */
export const intersection: {
  (that: Rect): (self: Rect) => Option.Option<Rect>;
  (self: Rect, that: Rect): Option.Option<Rect>;
} = dual(2, (self: Rect, that: Rect): Option.Option<Rect> => {
  const x0 = Math.max(self.x, that.x);
  const y0 = Math.max(self.y, that.y);
  const x1 = Math.min(self.x + self.width, that.x + that.width);
  const y1 = Math.min(self.y + self.height, that.y + that.height);
  return x1 > x0 && y1 > y0 ? Option.some(rect(x0, y0, x1 - x0, y1 - y0)) : Option.none();
});

/** The smallest rectangle containing both rectangles. */
export const union: {
  (that: Rect): (self: Rect) => Rect;
  (self: Rect, that: Rect): Rect;
} = dual(2, (self: Rect, that: Rect): Rect => {
  const x0 = Math.min(self.x, that.x);
  const y0 = Math.min(self.y, that.y);
  const x1 = Math.max(self.x + self.width, that.x + that.width);
  const y1 = Math.max(self.y + self.height, that.y + that.height);
  return rect(x0, y0, x1 - x0, y1 - y0);
});

/** A transform that moves points by `(tx, ty)`. */
export const translate = (tx: number, ty: number): Matrix =>
  new Matrix({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });

/** A transform that scales about the origin; `sy` defaults to `sx`. */
export const scale = (sx: number, sy: number = sx): Matrix =>
  new Matrix({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

/** A transform that rotates about the origin by `radians`, clockwise on screen. */
export const rotate = (radians: number): Matrix => {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new Matrix({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
};

/**
 * Composes two transforms: the result applies `self` first, then `that`.
 * `pipe(m, multiply(translate(10, 0)))` reads as "m, then move right by 10".
 */
export const multiply: {
  (that: Matrix): (self: Matrix) => Matrix;
  (self: Matrix, that: Matrix): Matrix;
} = dual(
  2,
  (self: Matrix, that: Matrix): Matrix =>
    new Matrix({
      a: that.a * self.a + that.c * self.b,
      b: that.b * self.a + that.d * self.b,
      c: that.a * self.c + that.c * self.d,
      d: that.b * self.c + that.d * self.d,
      e: that.a * self.e + that.c * self.f + that.e,
      f: that.b * self.e + that.d * self.f + that.f,
    }),
);

/** The determinant of a transform; zero means it collapses the plane and has no inverse. */
export const determinant = (self: Matrix): number => self.a * self.d - self.b * self.c;

/** The inverse transform, or `None` when the transform is not invertible. */
export const invert = (self: Matrix): Option.Option<Matrix> => {
  const det = determinant(self);
  if (det === 0 || !Number.isFinite(1 / det)) {
    return Option.none();
  }
  return Option.some(
    new Matrix({
      a: self.d / det,
      b: -self.b / det,
      c: -self.c / det,
      d: self.a / det,
      e: (self.c * self.f - self.d * self.e) / det,
      f: (self.b * self.e - self.a * self.f) / det,
    }),
  );
};

/** Applies a transform to a point. */
export const transformPoint: {
  (m: Matrix): (self: Point) => Point;
  (self: Point, m: Matrix): Point;
} = dual(2, (self: Point, m: Matrix): Point =>
  point(m.a * self.x + m.c * self.y + m.e, m.b * self.x + m.d * self.y + m.f),
);

/** The axis-aligned bounds of a rectangle after a transform, such as a rotated image's canvas. */
export const transformRect: {
  (m: Matrix): (self: Rect) => Rect;
  (self: Rect, m: Matrix): Rect;
} = dual(2, (self: Rect, m: Matrix): Rect => {
  const corners = [
    transformPoint(point(self.x, self.y), m),
    transformPoint(point(self.x + self.width, self.y), m),
    transformPoint(point(self.x, self.y + self.height), m),
    transformPoint(point(self.x + self.width, self.y + self.height), m),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return rect(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
});
