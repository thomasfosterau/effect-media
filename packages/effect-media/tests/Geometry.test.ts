import { assert, describe, it } from "@effect/vitest";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Geometry from "../src/Geometry.ts";

const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -1000, maximum: 1000 }));

const assertPointClose = (actual: Geometry.Point, expected: Geometry.Point, epsilon = 1e-9) => {
  assert.isTrue(
    Math.abs(actual.x - expected.x) <= epsilon && Math.abs(actual.y - expected.y) <= epsilon,
    `(${actual.x}, ${actual.y}) ≉ (${expected.x}, ${expected.y})`,
  );
};

describe("Geometry", () => {
  it("rejects negative sizes", () => {
    assert.throws(() => Geometry.size(-1, 1));
  });

  describe("Rect", () => {
    const a = Geometry.rect(0, 0, 10, 10);

    it("contains excludes the right and bottom edges", () => {
      assert.isTrue(Geometry.contains(a, Geometry.point(0, 0)));
      assert.isTrue(Geometry.contains(a, Geometry.point(9.99, 9.99)));
      assert.isFalse(Geometry.contains(a, Geometry.point(10, 5)));
    });

    it("intersection is None for rectangles that only touch", () => {
      assert.isTrue(Option.isNone(Geometry.intersection(a, Geometry.rect(10, 0, 5, 5))));
      assert.deepStrictEqual(
        Geometry.intersection(a, Geometry.rect(5, 5, 10, 10)),
        Option.some(Geometry.rect(5, 5, 5, 5)),
      );
    });

    it("union covers both rectangles", () => {
      assert.deepStrictEqual(
        Geometry.union(a, Geometry.rect(20, -5, 5, 5)),
        Geometry.rect(0, -5, 25, 15),
      );
    });

    it("aspectRatio is None for zero height", () => {
      assert.isTrue(Option.isNone(Geometry.aspectRatio(Geometry.size(10, 0))));
      assert.deepStrictEqual(Geometry.aspectRatio(Geometry.size(16, 9)), Option.some(16 / 9));
    });
  });

  describe("Matrix", () => {
    it("multiply applies self first, then that", () => {
      const m = Geometry.multiply(Geometry.scale(2), Geometry.translate(10, 0));
      assertPointClose(Geometry.transformPoint(Geometry.point(1, 1), m), Geometry.point(12, 2));
    });

    it("rotate turns +x towards +y", () => {
      const p = Geometry.transformPoint(
        Geometry.point(1, 0),
        Geometry.rotate(Geometry.degrees(90)),
      );
      assertPointClose(p, Geometry.point(0, 1));
    });

    it("invert is None for a singular matrix", () => {
      assert.isTrue(Option.isNone(Geometry.invert(Geometry.scale(0, 1))));
    });

    it.prop(
      "invert undoes the transform",
      [Coordinate, Coordinate, Coordinate, Coordinate],
      ([angle, sx, tx, px]) => {
        const m = pipe(
          Geometry.rotate(angle),
          Geometry.multiply(Geometry.scale(1 + Math.abs(sx) / 100, 2)),
          Geometry.multiply(Geometry.translate(tx, -tx)),
        );
        const inverse = Option.match(Geometry.invert(m), {
          onNone: () => assert.fail("expected an invertible matrix"),
          onSome: (inverse) => inverse,
        });
        const p = Geometry.point(px, -px);
        assertPointClose(Geometry.transformPoint(Geometry.transformPoint(p, m), inverse), p, 1e-6);
      },
    );

    it("transformRect bounds a rotated rectangle", () => {
      const bounds = Geometry.transformRect(
        Geometry.rect(0, 0, 4, 2),
        Geometry.rotate(Geometry.degrees(90)),
      );
      assert.isTrue(Math.abs(bounds.x + 2) < 1e-9 && Math.abs(bounds.width - 2) < 1e-9);
      assert.isTrue(Math.abs(bounds.height - 4) < 1e-9);
    });
  });
});
