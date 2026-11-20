import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as MediaError from "../src/MediaError.ts";

describe("MediaError", () => {
  it.effect("errors are yieldable and matched by tag", () =>
    Effect.gen(function* () {
      const tag = yield* Effect.fail(
        new MediaError.UnsupportedOperation({
          backend: "wasm",
          operation: "Resize",
          detail: "Lanczos3",
        }),
      ).pipe(Effect.catchTag("UnsupportedOperation", (error) => Effect.succeed(error.message)));
      assert.strictEqual(tag, "wasm does not support Resize (Lanczos3)");
    }),
  );

  it("messages name the backend and media type", () => {
    const error = new MediaError.DecodeError({
      backend: "sharp",
      mediaType: "image/png",
      reason: "truncated",
    });
    assert.strictEqual(error.message, "sharp could not decode image/png: truncated");
    assert.strictEqual(
      new MediaError.InvalidDimensions({ backend: "sharp", width: 0, height: 10 }).message,
      "sharp cannot handle dimensions 0×10",
    );
  });
});
