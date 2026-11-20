import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as MediaType from "../src/MediaType.ts";

const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number>>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) => (P.isString(part) ? Array.from(part, (c) => c.charCodeAt(0)) : part)),
  );

const sniffed = (input: Uint8Array): Option.Option<string> => MediaType.sniff(input);

describe("MediaType", () => {
  it("parse normalises case and drops parameters", () => {
    assert.deepStrictEqual(MediaType.parse("Image/PNG; charset=binary"), Option.some("image/png"));
    assert.isTrue(Option.isNone(MediaType.parse("png")));
    assert.isTrue(Option.isNone(MediaType.parse("image/")));
  });

  it("maps extensions both ways", () => {
    assert.deepStrictEqual(MediaType.fromExtension("Photo.JPG"), Option.some("image/jpeg"));
    assert.deepStrictEqual(MediaType.fromExtension("heic"), Option.some("image/heif"));
    assert.isTrue(Option.isNone(MediaType.fromExtension("archive.zip")));
    assert.deepStrictEqual(
      MediaType.toExtension(MediaType.imageFormatMediaType.jpeg),
      Option.some("jpeg"),
    );
  });

  it("toImageFormat and kind", () => {
    assert.deepStrictEqual(
      MediaType.toImageFormat(MediaType.imageFormatMediaType.svg),
      Option.some("svg"),
    );
    assert.strictEqual(MediaType.kind(MediaType.imageFormatMediaType.webp), "image");
  });

  describe("sniff", () => {
    it("recognises image signatures", () => {
      assert.deepStrictEqual(
        sniffed(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0])),
        Option.some("image/png"),
      );
      assert.deepStrictEqual(sniffed(bytes([0xff, 0xd8, 0xff, 0xe0])), Option.some("image/jpeg"));
      assert.deepStrictEqual(sniffed(bytes("GIF89a")), Option.some("image/gif"));
      assert.deepStrictEqual(
        sniffed(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")),
        Option.some("image/webp"),
      );
      assert.deepStrictEqual(sniffed(bytes("II", [0x2a, 0])), Option.some("image/tiff"));
      assert.deepStrictEqual(sniffed(bytes([0xff, 0x0a, 0])), Option.some("image/jxl"));
    });

    it("tells AVIF, HEIF and MP4 apart by their ftyp brands", () => {
      const ftyp = (major: string, ...compatible: Array<string>) =>
        bytes([0, 0, 0, 16 + 4 * compatible.length], "ftyp", major, [0, 0, 0, 0], ...compatible);
      assert.deepStrictEqual(sniffed(ftyp("avif", "mif1", "miaf")), Option.some("image/avif"));
      assert.deepStrictEqual(sniffed(ftyp("mif1", "avif")), Option.some("image/avif"));
      assert.deepStrictEqual(sniffed(ftyp("heic", "mif1")), Option.some("image/heif"));
      assert.deepStrictEqual(sniffed(ftyp("isom", "mp41")), Option.some("video/mp4"));
      assert.deepStrictEqual(sniffed(ftyp("qt  ")), Option.some("video/quicktime"));
    });

    it("recognises SVG after an XML declaration and comments", () => {
      assert.deepStrictEqual(
        sniffed(
          bytes('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg">'),
        ),
        Option.some("image/svg+xml"),
      );
      assert.isTrue(Option.isNone(sniffed(bytes("<html><body>svg</body></html>"))));
    });

    it("recognises audio and video signatures", () => {
      assert.deepStrictEqual(
        sniffed(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")),
        Option.some("audio/wav"),
      );
      assert.deepStrictEqual(sniffed(bytes("fLaC")), Option.some("audio/flac"));
      assert.deepStrictEqual(sniffed(bytes("OggS")), Option.some("audio/ogg"));
      assert.deepStrictEqual(sniffed(bytes("ID3", [4, 0])), Option.some("audio/mpeg"));
      assert.deepStrictEqual(sniffed(bytes([0x1a, 0x45, 0xdf, 0xa3])), Option.some("video/webm"));
    });

    it("returns None for unknown or too-short input", () => {
      assert.isTrue(Option.isNone(sniffed(bytes())));
      assert.isTrue(Option.isNone(sniffed(bytes("RIFF"))));
      assert.isTrue(Option.isNone(sniffed(bytes("hello world"))));
    });
  });
});
