/**
 * The conformance suite: every image backend runs it against the same
 * fixtures, so that swapping backends changes speed and file size, not results.
 */
import { assert, describe, layer } from "@effect/vitest";
import * as Encoded from "@thomasfosterau/effect-media/Encoded";
import * as Image from "@thomasfosterau/effect-media/Image";
import type { ImageBackend } from "@thomasfosterau/effect-media/ImageBackend";
import * as MediaType from "@thomasfosterau/effect-media/MediaType";
import * as Raster from "@thomasfosterau/effect-media/Raster";
import * as Transform from "@thomasfosterau/effect-media/Transform";
import * as Color from "@thomasfosterau/effect-media/Color";
import * as Geometry from "@thomasfosterau/effect-media/Geometry";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { readFileSync } from "node:fs";

/** A committed fixture's bytes. */
export const fixture = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${file}`, import.meta.url)));

/** The mean absolute difference per channel byte between two rasters of the same size. */
export const meanError = (a: Raster.RasterImage, b: Raster.RasterImage): number => {
  assert.strictEqual(a.width, b.width, "widths differ");
  assert.strictEqual(a.height, b.height, "heights differ");
  return (
    Arr.reduce(
      Arr.makeBy(a.data.length, (i) => i),
      0,
      (sum, i) => sum + Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)),
    ) / a.data.length
  );
};

const pixelAt = (image: Raster.RasterImage, x: number, y: number): ReadonlyArray<number> =>
  Option.match(Raster.pixel(image, x, y), {
    onNone: () => assert.fail(`no pixel at ${x}, ${y}`),
    onSome: (rgba) => rgba,
  });

const assertNear = (
  actual: ReadonlyArray<number>,
  expected: ReadonlyArray<number>,
  tolerance: number,
  what: string,
) =>
  assert.isTrue(
    Arr.every(Arr.zip(actual, expected), ([a, e]) => Math.abs(a - e) <= tolerance),
    `${what}: ${actual.join(",")} is not within ${tolerance} of ${expected.join(",")}`,
  );

const unwrap = <A, E>(result: Result.Result<A, E>): A =>
  Result.match(result, { onFailure: (e) => assert.fail(String(e)), onSuccess: (a) => a });

// A small raster with a different value in every byte, to catch any misplaced pixel.
const pattern = unwrap(
  Raster.make(5, 3, Uint8Array.from(Arr.makeBy(5 * 3 * 4, (i) => (i * 37 + 11) % 256))),
);

const sameBytes = (actual: Raster.RasterImage, expected: Raster.RasterImage, what: string) => {
  assert.strictEqual(
    `${actual.width}x${actual.height}`,
    `${expected.width}x${expected.height}`,
    what,
  );
  assert.deepStrictEqual(Array.from(actual.data), Array.from(expected.data), what);
};

// Runs a check per item, one at a time.
const each = <A, E, R>(items: Iterable<A>, check: (item: A) => Effect.Effect<void, E, R>) =>
  Effect.forEach(items, check, { concurrency: 1, discard: true });

const red = [255, 0, 0, 255];
const green = [0, 255, 0, 255];
const blue = [0, 0, 255, 255];
const white = [255, 255, 255, 255];

/** Registers the suite for a backend. */
export const suite = (name: string, backend: Layer.Layer<ImageBackend, never>): void => {
  describe(`${name} conformance`, () => {
    layer(backend, { timeout: "60 seconds" })((it) => {
      describe("decode", () => {
        it.effect("decodes JPEG, PNG, WebP and AVIF to RGBA at their stored size", () =>
          Effect.gen(function* () {
            const photo = yield* Image.decode(fixture("photo.jpg"));
            assert.strictEqual(`${photo.raster.width}x${photo.raster.height}`, "1200x800");
            yield* each(["small.png", "small.webp", "small.avif"], (file) =>
              Effect.gen(function* () {
                const { raster } = yield* Image.decode(fixture(file));
                assert.strictEqual(`${raster.width}x${raster.height}`, "120x80", file);
                assert.strictEqual(raster.data.length, 120 * 80 * 4, file);
                // The background is 75% opaque.
                assertNear([pixelAt(raster, 60, 2)[3] ?? 0], [191], 3, `${file} alpha`);
              }),
            );
          }),
        );

        it.effect("agrees with lossless sources exactly", () =>
          Effect.gen(function* () {
            const png = yield* Image.decode(fixture("small.png"));
            const webp = yield* Image.decode(fixture("small.webp"));
            sameBytes(webp.raster, png.raster, "lossless WebP vs PNG");
          }),
        );

        it.effect("returns stored pixels and the EXIF orientation, which AutoOrient applies", () =>
          each([1, 2, 3, 4, 5, 6, 7, 8], (orientation) =>
            Effect.gen(function* () {
              const what = `orientation ${orientation}`;
              const decoded = yield* Image.decode(fixture(`orientation-${orientation}.jpg`));
              assert.strictEqual(decoded.orientation, orientation, what);
              const upright = yield* Image.transform(
                decoded.raster,
                [Transform.autoOrient()],
                decoded.orientation,
              );
              assert.strictEqual(`${upright.width}x${upright.height}`, "64x32", what);
              assertNear(pixelAt(upright, 8, 8), red, 24, `${what} top left`);
              assertNear(pixelAt(upright, 56, 8), green, 24, `${what} top right`);
              assertNear(pixelAt(upright, 8, 24), blue, 24, `${what} bottom left`);
              assertNear(pixelAt(upright, 56, 24), white, 24, `${what} bottom right`);
            }),
          ),
        );

        it.effect("fails with DecodeError on corrupt data", () =>
          Effect.gen(function* () {
            const corrupt = fixture("photo.jpg").slice(0, 600);
            corrupt.fill(0x55, 200);
            const error = yield* Effect.flip(Image.decode(corrupt));
            assert.strictEqual(error._tag, "DecodeError");
          }),
        );

        it.effect("fails with UnsupportedFormat on bytes that are not an image", () =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              Image.decode(new TextEncoder().encode("plain text, not pixels")),
            );
            assert.strictEqual(error._tag, "UnsupportedFormat");
          }),
        );
      });

      describe("exact operations", () => {
        it.effect("crop, rotate, flip and pad match the core reference byte for byte", () =>
          Effect.gen(function* () {
            const cases: ReadonlyArray<readonly [string, Transform.Transform, Raster.RasterImage]> =
              [
                [
                  "crop",
                  Transform.crop(1, 1, 3, 2),
                  Raster.crop(pattern, Geometry.rect(1, 1, 3, 2)),
                ],
                ["rotate 90", Transform.rotate(90), Raster.rotate(pattern, 90)],
                ["rotate 180", Transform.rotate(180), Raster.rotate(pattern, 180)],
                ["rotate 270", Transform.rotate(270), Raster.rotate(pattern, 270)],
                [
                  "flip horizontal",
                  Transform.flip("horizontal"),
                  Raster.flip(pattern, "horizontal"),
                ],
                ["flip vertical", Transform.flip("vertical"), Raster.flip(pattern, "vertical")],
                [
                  "pad",
                  Transform.pad(
                    { top: 1, right: 2, bottom: 3, left: 4 },
                    Color.rgb8(10, 20, 30, 0.5),
                  ),
                  Raster.pad(
                    pattern,
                    { top: 1, right: 2, bottom: 3, left: 4 },
                    Color.rgb8(10, 20, 30, 0.5),
                  ),
                ],
                [
                  "nearest resize",
                  Transform.resize({ width: 10, height: 7, fit: "fill", kernel: "nearest" }),
                  Raster.resizeNearest(pattern, 10, 7),
                ],
              ];
            yield* each(cases, ([what, step, expected]) =>
              Effect.gen(function* () {
                sameBytes(yield* Image.transform(pattern, [step]), expected, what);
              }),
            );
          }),
        );
      });

      describe("resample", () => {
        it.effect("downscales close to the sharp lanczos3 reference", () =>
          Effect.gen(function* () {
            const photo = yield* Image.decode(fixture("photo.jpg"));
            const reference = yield* Image.decode(fixture("photo-300x200-lanczos3.png"));
            const resized = yield* Image.transform(photo.raster, [
              Transform.resize({ width: 300, height: 200, fit: "fill" }),
            ]);
            assert.isBelow(meanError(resized, reference.raster), 2);
          }),
        );

        it.effect("keeps a uniform translucent colour uniform with every kernel", () =>
          Effect.gen(function* () {
            const flat = unwrap(Raster.fill(40, 30, Color.rgb8(200, 100, 50, 0.5)));
            yield* each(Transform.Kernel.literals, (kernel) =>
              each(
                [
                  [17, 11],
                  [97, 61],
                ] as const,
                ([width, height]) =>
                  Effect.gen(function* () {
                    const resized = yield* Image.transform(flat, [
                      Transform.resize({ width, height, fit: "fill", kernel }),
                    ]);
                    assert.strictEqual(
                      `${resized.width}x${resized.height}`,
                      `${width}x${height}`,
                      kernel,
                    );
                    assertNear(pixelAt(resized, 0, 0), [200, 100, 50, 128], 2, `${kernel} corner`);
                    assertNear(
                      pixelAt(resized, Math.floor(width / 2), Math.floor(height / 2)),
                      [200, 100, 50, 128],
                      2,
                      `${kernel} centre`,
                    );
                  }),
              ),
            );
          }),
        );
      });

      describe("encode", () => {
        it.effect("round-trips losslessly through PNG and lossless WebP", () =>
          Effect.gen(function* () {
            const { raster } = yield* Image.decode(fixture("small.png"));
            yield* each(["png", "webp"] as const, (format) =>
              Effect.gen(function* () {
                const encoded = yield* Image.encode(raster, { format, lossless: true });
                assert.strictEqual(encoded.mediaType, MediaType.imageFormatMediaType[format]);
                sameBytes((yield* Image.decode(encoded.bytes)).raster, raster, format);
              }),
            );
          }),
        );

        it.effect("encodes JPEG, WebP and AVIF that decode close to the source", () =>
          Effect.gen(function* () {
            const { raster } = yield* Image.decode(fixture("photo.jpg"));
            yield* each(["jpeg", "webp", "avif"] as const, (format) =>
              Effect.gen(function* () {
                const encoded = yield* Image.encode(raster, { format });
                const sniffed = yield* Encoded.fromBytes(encoded.bytes);
                assert.strictEqual(
                  sniffed.mediaType,
                  MediaType.imageFormatMediaType[format],
                  format,
                );
                assert.isBelow(
                  meanError((yield* Image.decode(encoded.bytes)).raster, raster),
                  4,
                  format,
                );
              }),
            );
          }),
        );

        it.effect("fails with UnsupportedFormat for a format it cannot write", () =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(Image.encode(pattern, { format: "jxl" }));
            assert.strictEqual(error._tag, "UnsupportedFormat");
          }),
        );
      });

      describe("thumbnails", () => {
        it.effect("turns a photo into WebP and AVIF at several widths", () =>
          Effect.gen(function* () {
            const widths = [160, 480, 1024];
            const outputs = yield* Image.variants(
              fixture("photo.jpg"),
              Arr.flatMap(widths, (width) =>
                Arr.map(["webp", "avif"] as const, (format) => ({
                  pipeline: [
                    Transform.autoOrient(),
                    Transform.resize({ width, withoutEnlargement: true }),
                  ],
                  options: { format },
                  width,
                })),
              ),
            );
            assert.strictEqual(outputs.length, 6);
            yield* each(outputs, ({ variant, image }) =>
              Effect.gen(function* () {
                assert.strictEqual(
                  image.mediaType,
                  MediaType.imageFormatMediaType[variant.options.format],
                );
                const { raster } = yield* Image.decode(image.bytes);
                assert.strictEqual(
                  `${raster.width}x${raster.height}`,
                  `${variant.width}x${Math.round((variant.width * 2) / 3)}`,
                );
              }),
            );
          }),
        );

        it.effect("crops to fill square thumbnails", () =>
          Effect.gen(function* () {
            const square = yield* Image.process(
              fixture("photo.jpg"),
              [Transform.resize({ width: 200, height: 200 })],
              {
                format: "webp",
              },
            );
            const { raster } = yield* Image.decode(square.bytes);
            assert.strictEqual(`${raster.width}x${raster.height}`, "200x200");
          }),
        );
      });
    });
  });
};
