/**
 * EXIF orientation: how a camera says its stored pixels should be turned for
 * display. Read from the file rather than the decoder, so that every backend
 * auto-orients the same way.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The EXIF orientation values. 1 is upright; 2–8 are the mirrorings and
 * right-angle rotations of the stored pixels (TIFF 6.0, tag 0x0112).
 */
export const Orientation = Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8]);
export type Orientation = typeof Orientation.Type;

const isOrientation = Schema.is(Orientation);

const u16 = (bytes: Uint8Array, at: number, little: boolean): number => {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  return little ? a | (b << 8) : (a << 8) | b;
};

const u32 = (bytes: Uint8Array, at: number, little: boolean): number =>
  little
    ? u16(bytes, at, true) + u16(bytes, at + 2, true) * 0x1_0000
    : u16(bytes, at, false) * 0x1_0000 + u16(bytes, at + 2, false);

const ORIENTATION_TAG = 0x0112;

// Searches the first IFD of a TIFF structure starting at `tiff` for the orientation tag.
const fromTiff = (bytes: Uint8Array, tiff: number): Option.Option<Orientation> => {
  const order = String.fromCharCode(bytes[tiff] ?? 0, bytes[tiff + 1] ?? 0);
  if (order !== "II" && order !== "MM") {
    return Option.none();
  }
  const little = order === "II";
  const ifd = tiff + u32(bytes, tiff + 4, little);
  const count = u16(bytes, ifd, little);
  const entry = (i: number): Option.Option<Orientation> => {
    if (i >= count || ifd + 2 + i * 12 + 12 > bytes.length) {
      return Option.none();
    }
    const at = ifd + 2 + i * 12;
    if (u16(bytes, at, little) !== ORIENTATION_TAG) {
      return entry(i + 1);
    }
    const value = u16(bytes, at + 8, little);
    return isOrientation(value) ? Option.some(value) : Option.none();
  };
  return entry(0);
};

// Walks JPEG marker segments from `at` until the EXIF APP1 segment or the image data.
const fromJpegSegments = (bytes: Uint8Array, at: number): Option.Option<Orientation> => {
  if (at + 4 > bytes.length || bytes[at] !== 0xff) {
    return Option.none();
  }
  const marker = bytes[at + 1] ?? 0;
  // Start of scan: no metadata segments follow.
  if (marker === 0xda) {
    return Option.none();
  }
  const length = u16(bytes, at + 2, false);
  const isExif =
    marker === 0xe1 && String.fromCharCode(...bytes.subarray(at + 4, at + 10)) === "Exif\0\0";
  return isExif ? fromTiff(bytes, at + 10) : fromJpegSegments(bytes, at + 2 + length);
};

/**
 * Reads the EXIF orientation of a JPEG, defaulting to 1 (upright) when there is
 * none. Other formats are treated as upright for now.
 */
export const read = (bytes: Uint8Array): Orientation =>
  bytes[0] === 0xff && bytes[1] === 0xd8
    ? Option.getOrElse(fromJpegSegments(bytes, 2), (): Orientation => 1)
    : 1;
