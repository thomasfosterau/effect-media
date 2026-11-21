/**
 * An `ImageBackend` on sharp (libvips). Each primitive runs as its own sharp
 * pipeline over raw pixels, because sharp reorders the operations of a single
 * pipeline and the core plan depends on their order.
 */
import * as Color from "@thomasfosterau/effect-media/Color";
import type { EncodedImage } from "@thomasfosterau/effect-media/Encoded";
import {
  ImageBackend,
  quality,
  encodeWith,
  tryDecode,
  unsupported,
  type EncodeOptions,
  type Encoders,
} from "@thomasfosterau/effect-media/ImageBackend";
import * as MediaError from "@thomasfosterau/effect-media/MediaError";
import * as MediaType from "@thomasfosterau/effect-media/MediaType";
import * as Raster from "@thomasfosterau/effect-media/Raster";
import { Operation } from "@thomasfosterau/effect-media/Transform";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import sharp, { type Color as SharpColor, type OutputInfo, type Sharp } from "sharp";

const name = "sharp";

// sharp's default `limitInputPixels`.
const maxInputPixels = 0x3fff * 0x3fff;

const decodable: ReadonlyArray<MediaType.ImageFormat> = [
  "avif",
  "gif",
  "jpeg",
  "png",
  "svg",
  "tiff",
  "webp",
];

const toRaster = ({ data, info }: { readonly data: Buffer; readonly info: OutputInfo }) =>
  new Raster.RasterImage({
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
  });

const fromRaw = (pipeline: Sharp): Effect.Effect<Raster.RasterImage> =>
  // A failure here is a bug (the plan only produces valid operations), so it is a defect.
  Effect.tryPromise(() =>
    pipeline.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true }),
  ).pipe(Effect.orDie, Effect.map(toRaster));

const toSharp = (image: Raster.RasterImage): Sharp =>
  sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } });

const background = (color: Color.Color): SharpColor => {
  const [r, g, b, a] = Color.toRgba8(color);
  return { r, g, b, alpha: a / 255 };
};

const decode = (image: EncodedImage) =>
  Effect.gen(function* () {
    const format = MediaType.toImageFormat(image.mediaType).pipe(
      Option.filter((f) => Arr.contains(decodable, f)),
    );
    if (Option.isNone(format)) {
      return yield* unsupported(name, image.mediaType, "decode");
    }
    const metadata = yield* tryDecode(name, image, () => sharp(image.bytes).metadata());
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
    if (pixels > maxInputPixels) {
      return yield* new MediaError.ResourceLimitExceeded({
        backend: name,
        mediaType: image.mediaType,
        limit: "pixels",
        value: pixels,
        maximum: maxInputPixels,
      });
    }
    // No `.rotate()`: pixels come back as stored, and `Transform.autoOrient` turns them.
    const decoded = yield* tryDecode(name, image, () =>
      sharp(image.bytes, { failOn: "error" })
        .toColourspace("srgb")
        .ensureAlpha()
        .raw({ depth: "uchar" })
        .toBuffer({ resolveWithObject: true }),
    );
    return toRaster(decoded);
  });

const bytesOf = async (pipeline: Sharp): Promise<Uint8Array> => {
  const bytes = await pipeline.toBuffer();
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
};

const encoders: Encoders<Raster.RasterImage> = {
  avif: (image, options) =>
    bytesOf(
      toSharp(image).avif({ quality: quality(options), lossless: options.lossless ?? false }),
    ),
  gif: (image) => bytesOf(toSharp(image).gif()),
  jpeg: (image, options) => bytesOf(toSharp(image).jpeg({ quality: quality(options) })),
  png: (image) => bytesOf(toSharp(image).png()),
  tiff: (image, options) => bytesOf(toSharp(image).tiff({ quality: quality(options) })),
  webp: (image, options) =>
    bytesOf(
      toSharp(image).webp({ quality: quality(options), lossless: options.lossless ?? false }),
    ),
};

const encode = (image: Raster.RasterImage, options: EncodeOptions) =>
  encodeWith(name, encoders, image, options);

const apply = (
  image: Raster.RasterImage,
  operation: Operation,
): Effect.Effect<Raster.RasterImage> =>
  Operation.match(operation, {
    Resample: ({ width, height, kernel }) =>
      // libvips samples nearest neighbour differently; the core one keeps every backend identical.
      kernel === "nearest"
        ? Effect.succeed(Raster.resizeNearest(image, width, height))
        : fromRaw(toSharp(image).resize(width, height, { fit: "fill", kernel })),
    Crop: ({ rect }) =>
      fromRaw(
        toSharp(image).extract({
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }),
      ),
    Rotate: ({ degrees }) => fromRaw(toSharp(image).rotate(degrees)),
    Flip: ({ axis }) =>
      fromRaw(axis === "horizontal" ? toSharp(image).flop() : toSharp(image).flip()),
    Pad: (pad) =>
      fromRaw(
        toSharp(image).extend({
          top: pad.top,
          right: pad.right,
          bottom: pad.bottom,
          left: pad.left,
          background: background(pad.background),
        }),
      ),
  });

/** The sharp backend. sharp loads its native addon when this module is imported. */
export const layer: Layer.Layer<ImageBackend> = Layer.succeed(ImageBackend, {
  name,
  decode,
  encode,
  apply,
});
