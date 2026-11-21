/**
 * The service an image engine provides. Backends only decode, encode and apply
 * primitive operations; `Image` plans the pipeline, so geometry is identical
 * whichever backend runs it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import { EncodedImage } from "./Encoded.ts";
import {
  DecodeError,
  EncodeError,
  type ResourceLimitExceeded,
  UnsupportedFormat,
  type UnsupportedOperation,
} from "./MediaError.ts";
import { imageFormatMediaType, type ImageFormat, type MediaType } from "./MediaType.ts";
import type { RasterImage } from "./Raster.ts";
import type { Operation } from "./Transform.ts";

/** What to encode to. `quality` runs from 1 to 100 for lossy formats; backends pick a default. */
export interface EncodeOptions {
  readonly format: ImageFormat;
  readonly quality?: number;
  /** Encode losslessly, where the format supports it (WebP, AVIF). */
  readonly lossless?: boolean;
}

type Qualities = { readonly [F in ImageFormat]?: number };

const defaultQuality: Qualities = { avif: 50, jpeg: 80, webp: 80 };

/**
 * The quality to encode at: the requested one, or the format's default (80 for
 * JPEG and WebP, 50 for AVIF), so that every backend picks the same.
 */
export const quality = (options: EncodeOptions): number =>
  options.quality ?? defaultQuality[options.format] ?? 80;

/** An image engine, such as sharp or the WebAssembly codecs. */
export class ImageBackend extends Context.Service<
  ImageBackend,
  {
    /** A short name, used in errors: `"sharp"`, `"wasm"`. */
    readonly name: string;
    /** Decodes to pixels as stored, without applying EXIF orientation. */
    readonly decode: (
      image: EncodedImage,
    ) => Effect.Effect<RasterImage, DecodeError | UnsupportedFormat | ResourceLimitExceeded>;
    readonly encode: (
      image: RasterImage,
      options: EncodeOptions,
    ) => Effect.Effect<EncodedImage, EncodeError | UnsupportedFormat>;
    /** Applies one planned primitive. */
    readonly apply: (
      image: RasterImage,
      operation: Operation,
    ) => Effect.Effect<RasterImage, UnsupportedOperation>;
  }
>()("@thomasfosterau/effect-media/ImageBackend") {}

// --- for backend authors -------------------------------------------------------

/** The error a backend reports for a format it cannot read or write. */
export const unsupported = (
  backend: string,
  mediaType: MediaType,
  direction: "decode" | "encode",
): UnsupportedFormat => new UnsupportedFormat({ backend, mediaType, direction });

/** Runs a codec's decoding promise, reporting a rejection as `DecodeError`. */
export const tryDecode = <A>(
  backend: string,
  image: EncodedImage,
  run: () => PromiseLike<A>,
): Effect.Effect<A, DecodeError> =>
  Effect.tryPromise({
    try: async () => run(),
    catch: (cause) =>
      new DecodeError({
        backend,
        mediaType: image.mediaType,
        reason: P.isError(cause) ? cause.message : "unknown failure",
        cause,
      }),
  });

/** Runs a codec's encoding promise, reporting a rejection as `EncodeError`. */
export const tryEncode = (
  backend: string,
  format: ImageFormat,
  run: () => PromiseLike<Uint8Array>,
): Effect.Effect<EncodedImage, EncodeError> => {
  const mediaType = imageFormatMediaType[format];
  return Effect.tryPromise({
    try: async () => new EncodedImage({ bytes: await run(), mediaType }),
    catch: (cause) =>
      new EncodeError({
        backend,
        mediaType,
        reason: P.isError(cause) ? cause.message : "unknown failure",
        cause,
      }),
  });
};

/** A backend's encoders, by format; a missing format is unsupported. */
export type Encoders<I> = {
  readonly [F in ImageFormat]?: (image: I, options: EncodeOptions) => PromiseLike<Uint8Array>;
};

/** Encodes with the encoder for `options.format`, or fails with `UnsupportedFormat`. */
export const encodeWith = <I>(
  backend: string,
  encoders: Encoders<I>,
  image: I,
  options: EncodeOptions,
): Effect.Effect<EncodedImage, EncodeError | UnsupportedFormat> => {
  const encoder = encoders[options.format];
  return encoder === undefined
    ? Effect.fail(unsupported(backend, imageFormatMediaType[options.format], "encode"))
    : tryEncode(backend, options.format, () => encoder(image, options));
};
