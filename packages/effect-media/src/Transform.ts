/**
 * Image transforms as data. A `Pipeline` describes what to do; `plan` turns it
 * into a few primitive `Operation`s with every size worked out, so each backend
 * only implements the primitives and all backends agree on the geometry.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Color from "./Color.ts";
import * as Geometry from "./Geometry.ts";
import { InvalidDimensions } from "./MediaError.ts";
import type { Orientation } from "./Exif.ts";
import { maxDimension } from "./Raster.ts";

/**
 * How a resize fits the requested box, with the same meanings as CSS
 * `object-fit` and sharp:
 * - `cover`: fill the box, cropping the overflow from the centre.
 * - `contain`: fit inside the box, padding the rest with `background`.
 * - `fill`: stretch to the box, ignoring the aspect ratio.
 * - `inside`: fit inside the box; the output may be smaller than it.
 * - `outside`: cover the box; the output may be larger than it.
 */
export const Fit = Schema.Literals(["cover", "contain", "fill", "inside", "outside"]);
export type Fit = typeof Fit.Type;

/** The resampling filter, from fastest and blockiest to slowest and sharpest. */
export const Kernel = Schema.Literals(["nearest", "linear", "cubic", "mitchell", "lanczos3"]);
export type Kernel = typeof Kernel.Type;

const Pixels = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxDimension }));
const Offset = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxDimension }));
const RightAngle = Schema.Literals([90, 180, 270]);
const Axis = Schema.Literals(["horizontal", "vertical"]);

/** One step of a pipeline. */
export const Transform = Schema.TaggedUnion({
  /** Scales to a width, a height, or a box given by both. */
  Resize: {
    width: Schema.optional(Pixels),
    height: Schema.optional(Pixels),
    fit: Fit,
    kernel: Kernel,
    background: Color.Color,
    withoutEnlargement: Schema.Boolean,
  },
  /** Keeps a rectangle, clipped to the image. */
  Crop: { x: Offset, y: Offset, width: Pixels, height: Pixels },
  /** Rotates clockwise by a right angle. */
  Rotate: { degrees: RightAngle },
  /** Mirrors the image. */
  Flip: { axis: Axis },
  /** Adds a border. */
  Pad: { top: Offset, right: Offset, bottom: Offset, left: Offset, background: Color.Color },
  /** Turns the pixels upright according to the file's EXIF orientation. */
  AutoOrient: {},
});
export type Transform = typeof Transform.Type;

/** A sequence of transforms, applied in order. */
export type Pipeline = ReadonlyArray<Transform>;

/** Options for {@link resize}; `fit` defaults to `cover` and `kernel` to `lanczos3`. */
export interface ResizeOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: Fit;
  readonly kernel?: Kernel;
  /** The padding colour for `contain`; transparent by default. */
  readonly background?: Color.Color;
  /** Never scale up: an image already smaller than the box is left as it is. */
  readonly withoutEnlargement?: boolean;
}

/** Scales to a width, a height or a box. Give at least one of `width` and `height`. */
export const resize = (options: ResizeOptions): Transform =>
  Transform.cases.Resize.make({
    width: options.width,
    height: options.height,
    fit: options.fit ?? "cover",
    kernel: options.kernel ?? "lanczos3",
    background: options.background ?? Color.transparent,
    withoutEnlargement: options.withoutEnlargement ?? false,
  });

/** Keeps a rectangle of the image. */
export const crop = (x: number, y: number, width: number, height: number): Transform =>
  Transform.cases.Crop.make({ x, y, width, height });

/** Rotates clockwise by 90, 180 or 270 degrees. */
export const rotate = (degrees: 90 | 180 | 270): Transform =>
  Transform.cases.Rotate.make({ degrees });

/** Mirrors left to right (`horizontal`) or top to bottom (`vertical`). */
export const flip = (axis: "horizontal" | "vertical"): Transform =>
  Transform.cases.Flip.make({ axis });

/** Adds a border, transparent unless a colour is given. */
export const pad = (
  edges: {
    readonly top?: number;
    readonly right?: number;
    readonly bottom?: number;
    readonly left?: number;
  },
  background: Color.Color = Color.transparent,
): Transform =>
  Transform.cases.Pad.make({
    top: edges.top ?? 0,
    right: edges.right ?? 0,
    bottom: edges.bottom ?? 0,
    left: edges.left ?? 0,
    background,
  });

/** Turns the image upright according to its EXIF orientation. */
export const autoOrient = (): Transform => Transform.cases.AutoOrient.make({});

// --- planning -------------------------------------------------------------------

/** The primitives a backend implements. Every size and offset is already resolved. */
export const Operation = Schema.TaggedUnion({
  /** Scales to exactly this size. */
  Resample: { width: Pixels, height: Pixels, kernel: Kernel },
  /** Keeps a rectangle that lies within the image. */
  Crop: { rect: Geometry.Rect },
  Rotate: { degrees: RightAngle },
  Flip: { axis: Axis },
  Pad: { top: Offset, right: Offset, bottom: Offset, left: Offset, background: Color.Color },
});
export type Operation = typeof Operation.Type;

interface State {
  readonly width: number;
  readonly height: number;
  readonly operations: ReadonlyArray<Operation>;
}

const push = (
  state: State,
  width: number,
  height: number,
  ...operations: ReadonlyArray<Operation>
): State => ({
  width,
  height,
  operations: [...state.operations, ...operations],
});

// The rotation and mirroring that turn stored pixels upright, per EXIF orientation.
const ORIENT = {
  1: [],
  2: [{ _tag: "Flip", axis: "horizontal" }],
  3: [{ _tag: "Rotate", degrees: 180 }],
  4: [{ _tag: "Flip", axis: "vertical" }],
  5: [
    { _tag: "Rotate", degrees: 90 },
    { _tag: "Flip", axis: "horizontal" },
  ],
  6: [{ _tag: "Rotate", degrees: 90 }],
  7: [
    { _tag: "Rotate", degrees: 270 },
    { _tag: "Flip", axis: "horizontal" },
  ],
  8: [{ _tag: "Rotate", degrees: 270 }],
} as const satisfies { readonly [O in Orientation]: ReadonlyArray<Operation> };

const atLeastOne = (n: number): number => Math.max(1, Math.round(n));

type ResizeStep = Extract<Transform, { _tag: "Resize" }>;

// The box to fit into: a missing side follows the aspect ratio.
const boxOf = (state: State, step: ResizeStep): readonly [number, number] => {
  const width =
    step.width ?? atLeastOne((state.width * (step.height ?? state.height)) / state.height);
  return [width, step.height ?? atLeastOne((state.height * width) / state.width)];
};

// The size to resample to before any crop or pad.
const scaledSize = (
  state: State,
  fit: Fit,
  box: readonly [number, number],
): readonly [number, number] => {
  if (fit === "fill") {
    return box;
  }
  const scaleX = box[0] / state.width;
  const scaleY = box[1] / state.height;
  const scale =
    fit === "cover" || fit === "outside" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  return [atLeastOne(state.width * scale), atLeastOne(state.height * scale)];
};

// Cover crops the overflow from the centre; contain pads the shortfall around it.
const fitToBox = (
  state: State,
  fit: Fit,
  [boxWidth, boxHeight]: readonly [number, number],
  background: Color.Color,
): State => {
  const { width, height } = state;
  if (fit === "cover" && (width > boxWidth || height > boxHeight)) {
    const rect = Geometry.rect(
      Math.floor((width - boxWidth) / 2),
      Math.floor((height - boxHeight) / 2),
      boxWidth,
      boxHeight,
    );
    return push(state, boxWidth, boxHeight, { _tag: "Crop", rect });
  }
  if (fit === "contain" && (width < boxWidth || height < boxHeight)) {
    const left = Math.floor((boxWidth - width) / 2);
    const top = Math.floor((boxHeight - height) / 2);
    const right = boxWidth - width - left;
    const bottom = boxHeight - height - top;
    return push(state, boxWidth, boxHeight, { _tag: "Pad", top, right, bottom, left, background });
  }
  return state;
};

const planResize = (state: State, step: ResizeStep): State => {
  const box = boxOf(state, step);
  // With only one side given, every fit gives the same proportional result.
  const fit = step.width === undefined || step.height === undefined ? "fill" : step.fit;
  const [width, height] = scaledSize(state, fit, box);
  if (step.withoutEnlargement && (width > state.width || height > state.height)) {
    return state;
  }
  const resampled =
    width === state.width && height === state.height
      ? state
      : push(state, width, height, { _tag: "Resample", width, height, kernel: step.kernel });
  return fitToBox(resampled, fit, box, step.background);
};

const planCrop = (state: State, step: Extract<Transform, { _tag: "Crop" }>): State =>
  Option.match(
    Geometry.intersection(
      Geometry.rect(0, 0, state.width, state.height),
      Geometry.rect(step.x, step.y, step.width, step.height),
    ),
    {
      // A crop entirely outside the image would leave nothing; keep the image instead.
      onNone: () => state,
      onSome: (rect) => push(state, rect.width, rect.height, { _tag: "Crop", rect }),
    },
  );

const planStep =
  (orientation: Orientation) =>
  (state: State, step: Transform): State =>
    Transform.match(step, {
      Resize: (resize) => planResize(state, resize),
      Crop: (crop) => planCrop(state, crop),
      Rotate: (rotate) =>
        rotate.degrees === 180
          ? push(state, state.width, state.height, rotate)
          : push(state, state.height, state.width, rotate),
      Flip: (flip) => push(state, state.width, state.height, flip),
      Pad: (pad) =>
        push(state, state.width + pad.left + pad.right, state.height + pad.top + pad.bottom, pad),
      AutoOrient: () => {
        const swap = orientation >= 5;
        return push(
          state,
          swap ? state.height : state.width,
          swap ? state.width : state.height,
          ...ORIENT[orientation],
        );
      },
    });

/** The planned primitives and the size of the image they produce. */
export interface Plan {
  readonly operations: ReadonlyArray<Operation>;
  readonly width: number;
  readonly height: number;
}

/**
 * Resolves a pipeline against an input size and EXIF orientation. Fails with
 * `InvalidDimensions` when the output would be larger than a backend can hold.
 */
export const plan = (
  input: { readonly width: number; readonly height: number },
  pipeline: Pipeline,
  orientation: Orientation = 1,
): Result.Result<Plan, InvalidDimensions> => {
  const initial: State = { width: input.width, height: input.height, operations: [] };
  const result = Arr.reduce(pipeline, initial, planStep(orientation));
  return result.width > maxDimension || result.height > maxDimension
    ? Result.fail(
        new InvalidDimensions({ backend: "core", width: result.width, height: result.height }),
      )
    : Result.succeed(result);
};
