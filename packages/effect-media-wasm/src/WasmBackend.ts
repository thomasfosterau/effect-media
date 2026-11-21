/**
 * An `ImageBackend` on the jSquash WebAssembly codecs (MozJPEG, OxiPNG's PNG
 * codec, libwebp, libavif) and Squoosh's resampler. Exact pixel operations use
 * the core's own kernels.
 */
import decodeAvif, { init as initAvifDecode } from "@jsquash/avif/decode.js";
import encodeAvif, { init as initAvifEncode } from "@jsquash/avif/encode.js";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import encodePng from "@jsquash/png/encode.js";
import initResize, { resize as wasmResize } from "@jsquash/resize/lib/resize/pkg/squoosh_resize.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
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
import { Operation, type Kernel } from "@thomasfosterau/effect-media/Transform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const name = "wasm";

/**
 * Compiled codec modules, for runtimes where the codecs cannot fetch their own
 * `.wasm` files (Node, Cloudflare Workers). `webpEncode` must be the SIMD build
 * (`webp_enc_simd.wasm`) wherever WebAssembly SIMD is available, which is every
 * current runtime.
 */
export interface Modules {
  readonly avifDecode: WebAssembly.Module;
  readonly avifEncode: WebAssembly.Module;
  readonly jpegDecode: WebAssembly.Module;
  readonly jpegEncode: WebAssembly.Module;
  readonly png: WebAssembly.Module;
  readonly resize: WebAssembly.Module;
  readonly webpDecode: WebAssembly.Module;
  readonly webpEncode: WebAssembly.Module;
}

/** The `.wasm` file behind each of {@link Modules}, as a package specifier. */
export const moduleFiles = {
  avifDecode: "@jsquash/avif/codec/dec/avif_dec.wasm",
  avifEncode: "@jsquash/avif/codec/enc/avif_enc.wasm",
  jpegDecode: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  jpegEncode: "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
  png: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  resize: "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
  webpDecode: "@jsquash/webp/codec/dec/webp_dec.wasm",
  webpEncode: "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
} as const satisfies { readonly [K in keyof Modules]: string };

// The codecs read `.buffer` whole, so hand them memory of their own.
const ownBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const toImageData = (image: Raster.RasterImage): ImageData => ({
  // A copy, so the codec gets a plain `ArrayBuffer` of its own.
  data: new Uint8ClampedArray(image.data),
  width: image.width,
  height: image.height,
  colorSpace: "srgb",
});

const fromImageData = (image: ImageData): Raster.RasterImage =>
  new Raster.RasterImage({
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength).slice(),
  });

type Decoders = {
  readonly [F in MediaType.ImageFormat]?: (
    buffer: ArrayBuffer,
  ) => Promise<Option.Option<ImageData>>;
};

const decoders: Decoders = {
  // libavif reports failure by resolving to nothing rather than rejecting.
  avif: (buffer) => decodeAvif(buffer).then(Option.fromNullishOr),
  // MozJPEG leaves EXIF orientation alone unless asked; `Transform.autoOrient` applies it.
  jpeg: (buffer) => decodeJpeg(buffer).then(Option.some),
  png: (buffer) => decodePng(buffer).then(Option.some),
  webp: (buffer) => decodeWebp(buffer).then(Option.some),
};

const encoders: Encoders<Raster.RasterImage> = {
  avif: async (image, options) =>
    new Uint8Array(
      await encodeAvif(toImageData(image), {
        quality: quality(options),
        lossless: options.lossless ?? false,
      }),
    ),
  jpeg: async (image, options) =>
    new Uint8Array(await encodeJpeg(toImageData(image), { quality: quality(options) })),
  png: async (image) => new Uint8Array(await encodePng(toImageData(image))),
  webp: async (image, options) =>
    new Uint8Array(
      await encodeWebp(
        toImageData(image),
        options.lossless === true ? { lossless: 1, exact: 1 } : { quality: quality(options) },
      ),
    ),
};

const decode = (image: EncodedImage) =>
  Option.match(
    Option.flatMapNullishOr(MediaType.toImageFormat(image.mediaType), (format) => decoders[format]),
    {
      onNone: () => Effect.fail(unsupported(name, image.mediaType, "decode")),
      onSome: (run) =>
        tryDecode(name, image, () => run(ownBuffer(image.bytes))).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new MediaError.DecodeError({
                    backend: name,
                    mediaType: image.mediaType,
                    reason: "decoding failed",
                  }),
                ),
              onSome: (decoded) => Effect.succeed(fromImageData(decoded)),
            }),
          ),
        ),
    },
  );

const encode = (image: Raster.RasterImage, options: EncodeOptions) =>
  encodeWith(name, encoders, image, options);

// Squoosh's resampler, by index; nearest neighbour comes from the core.
const resizeMethod = {
  linear: 0,
  cubic: 1,
  mitchell: 2,
  lanczos3: 3,
} as const satisfies { readonly [K in Exclude<Kernel, "nearest">]: number };

const resample = (
  image: Raster.RasterImage,
  width: number,
  height: number,
  kernel: Kernel,
): Raster.RasterImage => {
  if (kernel === "nearest") {
    return Raster.resizeNearest(image, width, height);
  }
  // Premultiplied, in gamma-encoded sRGB: what sharp does, so the backends agree.
  const out = wasmResize(
    image.data,
    image.width,
    image.height,
    width,
    height,
    resizeMethod[kernel],
    true,
    false,
  );
  return new Raster.RasterImage({
    width,
    height,
    data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
  });
};

const apply = (
  image: Raster.RasterImage,
  operation: Operation,
): Effect.Effect<Raster.RasterImage> =>
  Effect.sync(() =>
    Operation.match(operation, {
      Resample: ({ width, height, kernel }) => resample(image, width, height, kernel),
      Crop: ({ rect }) => Raster.crop(image, rect),
      Rotate: ({ degrees }) => Raster.rotate(image, degrees),
      Flip: ({ axis }) => Raster.flip(image, axis),
      Pad: (pad) => Raster.pad(image, pad, pad.background),
    }),
  );

/**
 * Initialises the codecs and builds the backend. Without `modules`, each codec
 * fetches its `.wasm` file next to its own module, which works in browsers,
 * Deno and bundlers that copy the files.
 */
export const make = (modules?: Modules): Effect.Effect<ImageBackend["Service"]> =>
  Effect.tryPromise(async () => {
    const m = modules;
    await Promise.all([
      m === undefined ? initAvifDecode() : initAvifDecode(m.avifDecode),
      m === undefined ? initAvifEncode() : initAvifEncode(m.avifEncode),
      m === undefined ? initJpegDecode() : initJpegDecode(m.jpegDecode),
      m === undefined ? initJpegEncode() : initJpegEncode(m.jpegEncode),
      initPng(m?.png),
      initResize(m?.resize),
      m === undefined ? initWebpDecode() : initWebpDecode(m.webpDecode),
      m === undefined ? initWebpEncode() : initWebpEncode(m.webpEncode),
    ]);
    return { name, decode, encode, apply };
    // Codecs that cannot load are a deployment problem, not something to recover from.
  }).pipe(Effect.orDie);

/** The backend, with each codec fetching its own `.wasm` file. */
export const layer: Layer.Layer<ImageBackend> = Layer.effect(ImageBackend, make());

/** The backend, from codec modules compiled by the caller. */
export const layerWithModules = (modules: Modules): Layer.Layer<ImageBackend> =>
  Layer.effect(ImageBackend, make(modules));
