import { assert, describe, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Color from "../src/Color.ts";
import * as Geometry from "../src/Geometry.ts";
import * as Raster from "../src/Raster.ts";

const Side = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9 }));

// Every pixel's RGBA bytes encode its position, so any misplaced pixel shows.
const numbered = (width: number, height: number): Raster.RasterImage =>
  Result.match(
    Raster.make(
      width,
      height,
      Uint8Array.from(Arr.makeBy(width * height * 4, (i) => (i * 7 + 3) % 256)),
    ),
    { onFailure: (error) => assert.fail(error.message), onSuccess: (raster) => raster },
  );

const same = (a: Raster.RasterImage, b: Raster.RasterImage) => {
  assert.strictEqual(`${a.width}x${a.height}`, `${b.width}x${b.height}`);
  assert.deepStrictEqual(Array.from(a.data), Array.from(b.data));
};

describe("Raster", () => {
  it("make rejects a buffer of the wrong length and zero sizes", () => {
    assert.isTrue(Result.isFailure(Raster.make(2, 2, new Uint8Array(15))));
    assert.isTrue(Result.isFailure(Raster.make(0, 2, new Uint8Array(0))));
    assert.isTrue(Result.isFailure(Raster.fill(Raster.maxDimension + 1, 1, Color.black)));
  });

  it("pixel reads RGBA and is None outside the image", () => {
    const red = Result.match(Raster.fill(2, 2, Color.rgb8(255, 0, 0)), {
      onFailure: (error) => assert.fail(error.message),
      onSuccess: (raster) => raster,
    });
    assert.deepStrictEqual(Raster.pixel(red, 1, 1), Option.some([255, 0, 0, 255] as const));
    assert.isTrue(Option.isNone(Raster.pixel(red, 2, 0)));
  });

  it("rotate 90 moves the top-left pixel to the top-right", () => {
    const image = numbered(3, 2);
    const turned = Raster.rotate(image, 90);
    assert.strictEqual(`${turned.width}x${turned.height}`, "2x3");
    assert.deepStrictEqual(Raster.pixel(turned, 1, 0), Raster.pixel(image, 0, 0));
    assert.deepStrictEqual(Raster.pixel(turned, 0, 0), Raster.pixel(image, 0, 1));
  });

  it.prop("four quarter turns and two flips are the identity", [Side, Side], ([width, height]) => {
    const image = numbered(width, height);
    same(Raster.rotate(Raster.rotate(Raster.rotate(Raster.rotate(image, 90), 90), 90), 90), image);
    same(Raster.rotate(Raster.rotate(image, 270), 90), image);
    same(Raster.rotate(Raster.rotate(image, 180), 180), image);
    same(Raster.flip(Raster.flip(image, "horizontal"), "horizontal"), image);
    same(Raster.flip(Raster.flip(image, "vertical"), "vertical"), image);
    // A half turn is both flips.
    same(Raster.rotate(image, 180), Raster.flip(Raster.flip(image, "horizontal"), "vertical"));
  });

  it.prop(
    "cropping out the padding gives the original back",
    [Side, Side, Side, Side],
    ([width, height, left, top]) => {
      const image = numbered(width, height);
      const padded = Raster.pad(image, { top, left, right: 1, bottom: 2 }, Color.white);
      assert.deepStrictEqual(
        Raster.pixel(padded, 0, 0),
        Option.some([255, 255, 255, 255] as const),
      );
      same(Raster.crop(padded, Geometry.rect(left, top, width, height)), image);
    },
  );

  it("resizeNearest repeats pixels when enlarging by a whole factor", () => {
    const image = numbered(2, 2);
    const big = Raster.resizeNearest(image, 4, 4);
    assert.deepStrictEqual(Raster.pixel(big, 1, 1), Raster.pixel(image, 0, 0));
    assert.deepStrictEqual(Raster.pixel(big, 3, 2), Raster.pixel(image, 1, 1));
    same(Raster.resizeNearest(big, 2, 2), image);
  });
});
