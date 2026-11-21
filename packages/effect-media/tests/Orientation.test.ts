import { assert, describe, it } from "@effect/vitest";
import * as Orientation from "../src/Orientation.ts";

// A minimal JPEG prefix: SOI, an APP1 EXIF segment holding one IFD entry, then SOS.
const jpegWithOrientation = (value: number, littleEndian: boolean): Uint8Array => {
  const u16 = (n: number) => (littleEndian ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) =>
    littleEndian ? [...u16(n & 0xffff), ...u16(n >>> 16)] : [...u16(n >>> 16), ...u16(n & 0xffff)];
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(value),
    0,
    0,
    ...u32(0),
  ];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = exif.length + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...exif,
    0xff,
    0xda,
    0,
    2,
  ]);
};

describe("Orientation.read", () => {
  it("reads the EXIF orientation in either byte order, past other segments", () => {
    assert.strictEqual(Orientation.read(jpegWithOrientation(6, true)), 6);
    assert.strictEqual(Orientation.read(jpegWithOrientation(8, false)), 8);
  });

  it("treats missing, invalid and non-JPEG orientations as upright", () => {
    assert.strictEqual(Orientation.read(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), 1);
    assert.strictEqual(Orientation.read(jpegWithOrientation(9, true)), 1);
    assert.strictEqual(Orientation.read(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 1);
    assert.strictEqual(Orientation.read(jpegWithOrientation(6, true).subarray(0, 20)), 1);
  });
});
