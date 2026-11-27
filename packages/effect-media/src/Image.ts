/**
 * Decoding, transforming and encoding images with whichever `ImageBackend` is
 * provided.
 */
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Option from "effect/Option";
import * as Encoded from "./Encoded.ts";
import * as Exif from "./Exif.ts";
import { ImageBackend, type EncodeOptions } from "./ImageBackend.ts";
import type * as MediaError from "./MediaError.ts";
import { RasterImage } from "./Raster.ts";
import * as Transform from "./Transform.ts";

/** Any error the image functions can fail with. */
export type ImageError =
  | MediaError.DecodeError
  | MediaError.EncodeError
  | MediaError.UnsupportedFormat
  | MediaError.UnsupportedOperation
  | MediaError.InvalidDimensions
  | MediaError.ResourceLimitExceeded;

/** A decoded image and the EXIF orientation it was stored with. */
export interface Decoded {
  readonly raster: RasterImage;
  readonly orientation: Exif.Orientation;
}

// HEIF and AVIF carry orientation in the container (`irot`, `imir`), which the
// decoders apply; their EXIF orientation is informative only.
const orientationOf = (encoded: Encoded.EncodedImage): Exif.Orientation =>
  Option.match(Encoded.format(encoded), {
    onNone: () => 1,
    onSome: (format) =>
      format === "avif" || format === "heif"
        ? 1
        : Option.getOrElse(
            Option.flatMap(Exif.read(encoded.bytes), Exif.orientation),
            (): Exif.Orientation => 1,
          ),
  });

/** Identifies the format of some bytes and decodes them. */
export const decode = (bytes: Uint8Array): Effect.Effect<Decoded, ImageError, ImageBackend> =>
  Effect.gen(function* () {
    const encoded = yield* Encoded.fromBytes(bytes);
    const backend = yield* ImageBackend;
    const raster = yield* backend.decode(encoded);
    return { raster, orientation: orientationOf(encoded) };
  });

/** Runs a pipeline on decoded pixels. `orientation` is used by `AutoOrient`. */
export const transform: {
  (
    pipeline: Transform.Pipeline,
    orientation?: Exif.Orientation,
  ): (self: RasterImage) => Effect.Effect<RasterImage, ImageError, ImageBackend>;
  (
    self: RasterImage,
    pipeline: Transform.Pipeline,
    orientation?: Exif.Orientation,
  ): Effect.Effect<RasterImage, ImageError, ImageBackend>;
} = dual(
  (args) => args[0] instanceof RasterImage,
  (self: RasterImage, pipeline: Transform.Pipeline, orientation: Exif.Orientation = 1) =>
    Effect.gen(function* () {
      const planned = yield* Effect.fromResult(Transform.plan(self, pipeline, orientation));
      const backend = yield* ImageBackend;
      return yield* Effect.reduce(
        planned.operations,
        () => self,
        (image: RasterImage, operation) => backend.apply(image, operation),
      );
    }),
);

/** Encodes pixels to a format. */
export const encode: {
  (
    options: EncodeOptions,
  ): (self: RasterImage) => Effect.Effect<Encoded.EncodedImage, ImageError, ImageBackend>;
  (
    self: RasterImage,
    options: EncodeOptions,
  ): Effect.Effect<Encoded.EncodedImage, ImageError, ImageBackend>;
} = dual(2, (self: RasterImage, options: EncodeOptions) =>
  Effect.gen(function* () {
    const backend = yield* ImageBackend;
    return yield* backend.encode(self, options);
  }),
);

/** Decodes bytes, runs a pipeline and encodes the result: the usual one-shot job. */
export const process = (
  bytes: Uint8Array,
  pipeline: Transform.Pipeline,
  options: EncodeOptions,
): Effect.Effect<Encoded.EncodedImage, ImageError, ImageBackend> =>
  Effect.gen(function* () {
    const { raster, orientation } = yield* decode(bytes);
    const transformed = yield* transform(raster, pipeline, orientation);
    return yield* encode(transformed, options);
  });

/**
 * Decodes once and produces one output per variant, such as a set of
 * responsive image widths in several formats.
 */
export const variants = <
  const V extends { readonly pipeline: Transform.Pipeline; readonly options: EncodeOptions },
>(
  bytes: Uint8Array,
  list: ReadonlyArray<V>,
): Effect.Effect<
  ReadonlyArray<{ readonly variant: V; readonly image: Encoded.EncodedImage }>,
  ImageError,
  ImageBackend
> =>
  Effect.gen(function* () {
    const { raster, orientation } = yield* decode(bytes);
    return yield* Effect.forEach(
      list,
      (variant) =>
        transform(raster, variant.pipeline, orientation).pipe(
          Effect.flatMap(encode(variant.options)),
          Effect.map((image) => ({ variant, image })),
        ),
      // One at a time: each variant holds a full-size intermediate raster.
      { concurrency: 1 },
    );
  });
