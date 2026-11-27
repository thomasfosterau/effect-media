/**
 * Encoded images: the bytes of a file together with their media type.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { UnsupportedFormat } from "./MediaError.ts";
import * as MediaType from "./MediaType.ts";

/** The bytes of an encoded image, such as a JPEG file, and its media type. */
export class EncodedImage extends Data.Class<{
  readonly bytes: Uint8Array;
  readonly mediaType: MediaType.MediaType;
}> {}

/**
 * Wraps encoded bytes, identifying the format from their content. Fails with
 * `UnsupportedFormat` when the bytes are not a known image format.
 */
export const fromBytes = (bytes: Uint8Array): Effect.Effect<EncodedImage, UnsupportedFormat> =>
  MediaType.sniff(bytes).pipe(
    Option.filter((mediaType) => MediaType.kind(mediaType) === "image"),
    Option.match({
      onNone: () => Effect.fail(new UnsupportedFormat({ backend: "core", direction: "decode" })),
      onSome: (mediaType) => Effect.succeed(new EncodedImage({ bytes, mediaType })),
    }),
  );

/** The image format of an encoded image, if the library knows it by name. */
export const format = (self: EncodedImage): Option.Option<MediaType.ImageFormat> =>
  MediaType.toImageFormat(self.mediaType);
