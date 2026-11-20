import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Color from "../src/Color.ts";

const Unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const assertClose = (
  actual: ReadonlyArray<number>,
  expected: ReadonlyArray<number>,
  epsilon = 1e-4,
) => {
  assert.strictEqual(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.isTrue(
      Math.abs(value - (expected[i] ?? Number.NaN)) <= epsilon,
      `${actual.join(", ")} ≉ ${expected.join(", ")}`,
    );
  });
};

describe("Color", () => {
  describe("convert", () => {
    it("matches the CSS Color 4 reference values for sRGB red", () => {
      const red = Color.srgb(1, 0, 0);
      assertClose(Color.convert(red, "oklab").coords, [0.627955, 0.224863, 0.125846]);
      assertClose(Color.convert(red, "oklch").coords, [0.627955, 0.257683, 29.2339], 1e-3);
      assertClose(Color.convert(red, "display-p3").coords, [0.917488, 0.200287, 0.138561]);
      assertClose(
        Color.convert(Color.srgb(0.5, 0.5, 0.5), "srgb-linear").coords,
        [0.214041, 0.214041, 0.214041],
      );
    });

    it("gives achromatic colours a hue of zero", () => {
      assert.strictEqual(Color.convert(Color.white, "oklch").coords[2], 0);
    });

    it("keeps alpha", () => {
      assert.strictEqual(Color.convert(Color.srgb(1, 0, 0, 0.25), "oklch").alpha, 0.25);
    });

    it.prop("round-trips sRGB through every space", [Unit, Unit, Unit], ([r, g, b]) => {
      const color = Color.srgb(r, g, b);
      Color.ColorSpace.literals.forEach((space) => {
        assertClose(Color.convert(Color.convert(color, space), "srgb").coords, [r, g, b]);
      });
    });

    it("keeps out-of-gamut values instead of clipping them", () => {
      const p3Green = Color.make("display-p3", [0, 1, 0]);
      const inSrgb = Color.convert(p3Green, "srgb");
      assert.isFalse(Color.inGamut(p3Green));
      assert.isTrue(Color.inGamut(p3Green, "display-p3"));
      assert.isTrue(inSrgb.coords[0] < 0);
      assertClose(Color.convert(inSrgb, "display-p3").coords, [0, 1, 0]);
    });
  });

  describe("parse", () => {
    const ok = (input: string): Color.Color =>
      Result.match(Color.parse(input), {
        onSuccess: (color) => color,
        onFailure: (error) => assert.fail(error.message),
      });

    it("parses hex in all four lengths", () => {
      assert.deepStrictEqual(Color.toRgba8(ok("#f80")), [255, 136, 0, 255]);
      assert.deepStrictEqual(Color.toRgba8(ok("#f808")), [255, 136, 0, 136]);
      assert.deepStrictEqual(Color.toRgba8(ok("#FF8800")), [255, 136, 0, 255]);
      assert.deepStrictEqual(Color.toRgba8(ok("#ff880080")), [255, 136, 0, 128]);
    });

    it("parses rgb() in comma and space syntax, with percentages", () => {
      assert.deepStrictEqual(Color.toRgba8(ok("rgb(255, 0, 0)")), [255, 0, 0, 255]);
      assert.deepStrictEqual(Color.toRgba8(ok("rgba(255, 0, 0, 0.5)")), [255, 0, 0, 128]);
      assert.deepStrictEqual(Color.toRgba8(ok("rgb(100% 50% 0% / 50%)")), [255, 128, 0, 128]);
    });

    it("parses oklch(), oklab() and color()", () => {
      assert.deepStrictEqual(ok("oklch(0.7 0.1 250deg)").coords, [0.7, 0.1, 250]);
      assert.deepStrictEqual(ok("oklch(70% 25% 250)").coords, [0.7, 0.1, 250]);
      assert.strictEqual(ok("oklab(0.5 0.1 -0.1)").space, "oklab");
      const p3 = ok("color(display-p3 1 0.5 0 / 0.25)");
      assert.strictEqual(p3.space, "display-p3");
      assert.deepStrictEqual(p3.coords, [1, 0.5, 0]);
      assert.strictEqual(p3.alpha, 0.25);
    });

    it("parses keywords", () => {
      assert.strictEqual(Color.toHex(ok("transparent")), "#00000000");
      assert.strictEqual(Color.toHex(ok(" White ")), "#ffffff");
    });

    it("rejects what it does not support", () => {
      [
        "",
        "#ff",
        "red",
        "rgb(1 2)",
        "rgb(1 2 3 / 2)",
        "color(oklch 1 2 3)",
        "hsl(0 0% 0%)",
      ].forEach((input) => {
        assert.isTrue(Result.isFailure(Color.parse(input)), input);
      });
    });

    it.prop("round-trips through format", [Unit, Unit, Unit, Unit], ([r, g, b, a]) => {
      const color = Color.make("display-p3", [r, g, b], a);
      const parsed = ok(Color.format(color));
      assert.strictEqual(parsed.space, "display-p3");
      assertClose([...parsed.coords, parsed.alpha], [r, g, b, a], 1e-6);
    });
  });

  it("toHex clips to sRGB and omits opaque alpha", () => {
    assert.strictEqual(Color.toHex(Color.rgb8(255, 136, 0)), "#ff8800");
    assert.strictEqual(Color.toHex(Color.make("display-p3", [0, 1, 0])), "#00ff00");
  });
});
