import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Color from "../src/Color.ts";
import * as Geometry from "../src/Geometry.ts";
import type { Orientation } from "../src/Exif.ts";
import * as Transform from "../src/Transform.ts";

const planned = (
  input: readonly [number, number],
  pipeline: Transform.Pipeline,
  orientation: Orientation = 1,
): Transform.Plan =>
  Result.match(Transform.plan({ width: input[0], height: input[1] }, pipeline, orientation), {
    onFailure: (error) => assert.fail(error.message),
    onSuccess: (plan) => plan,
  });

const sizeOf = (plan: Transform.Plan) => `${plan.width}x${plan.height}`;
const tags = (plan: Transform.Plan) => plan.operations.map((operation) => operation._tag);

describe("Transform.plan", () => {
  describe("resize", () => {
    const box = (fit: Transform.Fit) => Transform.resize({ width: 200, height: 200, fit });

    it("gives every fit its CSS object-fit meaning", () => {
      assert.strictEqual(sizeOf(planned([400, 300], [box("fill")])), "200x200");
      assert.strictEqual(sizeOf(planned([400, 300], [box("inside")])), "200x150");
      assert.strictEqual(sizeOf(planned([400, 300], [box("outside")])), "267x200");
      assert.strictEqual(sizeOf(planned([400, 300], [box("cover")])), "200x200");
      assert.strictEqual(sizeOf(planned([400, 300], [box("contain")])), "200x200");
    });

    it("cover crops the overflow from the centre", () => {
      const plan = planned([400, 300], [box("cover")]);
      assert.deepStrictEqual(tags(plan), ["Resample", "Crop"]);
      assert.deepStrictEqual(plan.operations[1], {
        _tag: "Crop",
        rect: Geometry.rect(33, 0, 200, 200),
      });
    });

    it("contain pads the rest with the background, splitting it evenly", () => {
      const plan = planned(
        [400, 300],
        [Transform.resize({ width: 200, height: 201, fit: "contain", background: Color.white })],
      );
      assert.deepStrictEqual(tags(plan), ["Resample", "Pad"]);
      const pad = plan.operations[1];
      assert.isTrue(
        pad?._tag === "Pad" &&
          pad.top === 25 &&
          pad.bottom === 26 &&
          pad.left === 0 &&
          pad.right === 0,
      );
    });

    it("derives the missing side from the aspect ratio", () => {
      assert.strictEqual(
        sizeOf(planned([1200, 800], [Transform.resize({ width: 480 })])),
        "480x320",
      );
      assert.strictEqual(
        sizeOf(planned([1200, 800], [Transform.resize({ height: 100 })])),
        "150x100",
      );
    });

    it("never collapses a side to zero", () => {
      assert.strictEqual(sizeOf(planned([1000, 1], [Transform.resize({ width: 10 })])), "10x1");
    });

    it("withoutEnlargement leaves smaller images alone", () => {
      const plan = planned(
        [300, 200],
        [Transform.resize({ width: 480, withoutEnlargement: true })],
      );
      assert.strictEqual(sizeOf(plan), "300x200");
      assert.deepStrictEqual(plan.operations, []);
    });

    it("plans nothing when the size already matches", () => {
      assert.deepStrictEqual(planned([200, 200], [box("cover")]).operations, []);
    });
  });

  it("clips a crop to the image and drops one entirely outside it", () => {
    assert.strictEqual(sizeOf(planned([100, 100], [Transform.crop(80, 90, 50, 50)])), "20x10");
    assert.deepStrictEqual(planned([100, 100], [Transform.crop(200, 0, 10, 10)]).operations, []);
  });

  it("tracks the size through rotations and padding", () => {
    const plan = planned(
      [40, 30],
      [Transform.rotate(90), Transform.pad({ left: 5, bottom: 2 }), Transform.rotate(180)],
    );
    assert.strictEqual(sizeOf(plan), "35x42");
  });

  it("auto-orients by turning orientations 5 to 8 on their side", () => {
    const sizes = ([1, 2, 3, 4, 5, 6, 7, 8] as const).map((o) =>
      sizeOf(planned([40, 30], [Transform.autoOrient()], o)),
    );
    assert.deepStrictEqual(sizes, [
      "40x30",
      "40x30",
      "40x30",
      "40x30",
      "30x40",
      "30x40",
      "30x40",
      "30x40",
    ]);
    assert.deepStrictEqual(planned([40, 30], [Transform.autoOrient()], 1).operations, []);
  });

  it("fails when the output would be too large", () => {
    const result = Transform.plan({ width: 60_000, height: 10 }, [Transform.pad({ left: 6000 })]);
    assert.isTrue(Result.isFailure(result));
  });
});
