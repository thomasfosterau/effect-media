/**
 * Reads EXIF metadata in plain TypeScript, so that every backend and runtime
 * sees the same tags. Parsing is lenient: a malformed entry is skipped rather
 * than failing the whole read, and every offset is bounds-checked.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import { dual } from "effect/Function";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { scan } from "./internal/scan.ts";

/**
 * The image file directories EXIF data is grouped into: `ifd0` describes the
 * main image, `exif` the capture, `gps` the location, `interop` compatibility
 * details and `ifd1` the embedded thumbnail.
 */
export type Directory = "ifd0" | "exif" | "gps" | "interop" | "ifd1";

/** A TIFF rational, kept as stored. */
export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * A tag's value, by TIFF field type: text (ASCII), numbers (the integer and
 * floating-point types), rationals, or opaque bytes (UNDEFINED).
 */
export type Value = Data.TaggedEnum<{
  Text: { readonly value: string };
  Numbers: { readonly values: ReadonlyArray<number> };
  Rationals: { readonly values: ReadonlyArray<Rational> };
  Bytes: { readonly bytes: Uint8Array };
}>;

/** Constructors, guards and matching for {@link Value}. */
export const Value = Data.taggedEnum<Value>();

/** The tags of one directory, by tag number. */
export type Tags = HashMap.HashMap<number, Value>;

/** The EXIF data of an image: every readable tag, by directory, and the thumbnail if there is one. */
export class Exif extends Data.Class<{
  readonly littleEndian: boolean;
  /** Pointers from one directory to another are left out. */
  readonly directories: HashMap.HashMap<Directory, Tags>;
  /** The JPEG thumbnail stored in `ifd1`. */
  readonly thumbnail: Option.Option<Uint8Array>;
}> {}

/** Numbers of commonly used tags, for {@link get}. Each comment names its directory. */
export const Tag = {
  /** ifd0 */
  ImageDescription: 0x010e,
  /** ifd0 */
  Make: 0x010f,
  /** ifd0 */
  Model: 0x0110,
  /** ifd0 */
  Orientation: 0x0112,
  /** ifd0 */
  Software: 0x0131,
  /** ifd0: when the file was last changed. */
  DateTime: 0x0132,
  /** ifd0 */
  Artist: 0x013b,
  /** ifd0 */
  Copyright: 0x8298,
  /** exif: seconds. */
  ExposureTime: 0x829a,
  /** exif */
  FNumber: 0x829d,
  /** exif: ISO speed. */
  PhotographicSensitivity: 0x8827,
  /** exif */
  DateTimeOriginal: 0x9003,
  /** exif */
  OffsetTimeOriginal: 0x9011,
  /** exif */
  SubSecTimeOriginal: 0x9291,
  /** exif: millimetres. */
  FocalLength: 0x920a,
  /** exif */
  LensModel: 0xa434,
  /** gps */
  GPSLatitudeRef: 0x0001,
  /** gps */
  GPSLatitude: 0x0002,
  /** gps */
  GPSLongitudeRef: 0x0003,
  /** gps */
  GPSLongitude: 0x0004,
  /** gps */
  GPSAltitudeRef: 0x0005,
  /** gps */
  GPSAltitude: 0x0006,
} as const;

// --- TIFF structure ------------------------------------------------------------

const EXIF_POINTER = 0x8769;
const GPS_POINTER = 0x8825;
const INTEROP_POINTER = 0xa005;
const THUMBNAIL_OFFSET = 0x0201;
const THUMBNAIL_LENGTH = 0x0202;

interface Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly little: boolean;
}

interface FieldType {
  readonly size: number;
  readonly kind: "text" | "number" | "rational" | "bytes";
  readonly read: (view: DataView, at: number, little: boolean) => number;
}

const uint8: FieldType = { size: 1, kind: "number", read: (view, at) => view.getUint8(at) };
const uint32: FieldType["read"] = (view, at, little) => view.getUint32(at, little);
const int32: FieldType["read"] = (view, at, little) => view.getInt32(at, little);

// TIFF field types 1 to 13 (TIFF 6.0, section 2); 13 is IFD, read as LONG.
const fieldTypes: ReadonlyArray<FieldType> = [
  uint8,
  { ...uint8, kind: "text" },
  { size: 2, kind: "number", read: (view, at, little) => view.getUint16(at, little) },
  { size: 4, kind: "number", read: uint32 },
  { size: 8, kind: "rational", read: uint32 },
  { size: 1, kind: "number", read: (view, at) => view.getInt8(at) },
  { ...uint8, kind: "bytes" },
  { size: 2, kind: "number", read: (view, at, little) => view.getInt16(at, little) },
  { size: 4, kind: "number", read: int32 },
  { size: 8, kind: "rational", read: int32 },
  { size: 4, kind: "number", read: (view, at, little) => view.getFloat32(at, little) },
  { size: 8, kind: "number", read: (view, at, little) => view.getFloat64(at, little) },
  { size: 4, kind: "number", read: uint32 },
];

const fits = (reader: Reader, at: number, length: number): boolean =>
  at >= 0 && length >= 0 && at + length <= reader.bytes.length;

const u16 = (reader: Reader, at: number): number => reader.view.getUint16(at, reader.little);
const u32 = (reader: Reader, at: number): number => reader.view.getUint32(at, reader.little);

const fromCharCodes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const decodeUtf8 = Option.liftThrowable((bytes: Uint8Array) =>
  decodeURIComponent(
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
  ),
);

// EXIF says ASCII, but many writers use UTF-8; Latin-1 when the bytes are not valid UTF-8.
const decodeText = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  const text = end === -1 ? bytes : bytes.subarray(0, end);
  return text.every((byte) => byte < 0x80)
    ? fromCharCodes(text)
    : Option.getOrElse(decodeUtf8(text), () => fromCharCodes(text));
};

const readValue = (reader: Reader, entry: number): Option.Option<Value> => {
  const count = u32(reader, entry + 4);
  return Arr.get(fieldTypes, u16(reader, entry + 2) - 1).pipe(
    Option.filter(() => count > 0),
    Option.flatMap((type) => {
      const length = type.size * count;
      const at = length <= 4 ? entry + 8 : u32(reader, entry + 8);
      if (!fits(reader, at, length)) {
        return Option.none();
      }
      const read = (i: number) => type.read(reader.view, at + i, reader.little);
      const values = Array.from({ length: count }, (_, i) => i * type.size);
      return Option.some(
        Match.value(type.kind).pipe(
          Match.when("text", () =>
            Value.Text({ value: decodeText(reader.bytes.subarray(at, at + length)) }),
          ),
          Match.when("bytes", () => Value.Bytes({ bytes: reader.bytes.slice(at, at + length) })),
          Match.when("rational", () =>
            Value.Rationals({
              values: values.map((i) => ({ numerator: read(i), denominator: read(i + 4) })),
            }),
          ),
          Match.when("number", () => Value.Numbers({ values: values.map(read) })),
          Match.exhaustive,
        ),
      );
    }),
  );
};

interface Ifd {
  readonly tags: Tags;
  readonly next: number;
}

const readIfd = (reader: Reader, offset: number): Option.Option<Ifd> => {
  if (offset < 8 || !fits(reader, offset, 2)) {
    return Option.none();
  }
  const count = u16(reader, offset);
  const entries = Array.from({ length: count }, (_, i) => offset + 2 + i * 12).filter((entry) =>
    fits(reader, entry, 12),
  );
  const tags = HashMap.fromIterable(
    Arr.getSomes(
      entries.map((entry) =>
        Option.map(readValue(reader, entry), (value) => [u16(reader, entry), value] as const),
      ),
    ),
  );
  const nextAt = offset + 2 + count * 12;
  return Option.some({ tags, next: fits(reader, nextAt, 4) ? u32(reader, nextAt) : 0 });
};

const firstNumber = (tags: Tags, tag: number): Option.Option<number> =>
  HashMap.get(tags, tag).pipe(
    Option.filter(Value.$is("Numbers")),
    Option.flatMap(({ values }) => Arr.head(values)),
  );

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];
const TIFF_LITTLE = [0x49, 0x49, 0x2a, 0];
const TIFF_BIG = [0x4d, 0x4d, 0, 0x2a];

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);

/**
 * Reads a TIFF-structured EXIF payload: the contents of a JPEG APP1 segment,
 * a PNG `eXIf` chunk or a HEIF `Exif` item, with or without its `Exif\0\0`
 * header. Use it for EXIF a backend hands over as bytes, such as sharp's
 * `metadata().exif`; {@link read} finds the payload in an image file.
 */
export const fromTiff = (input: Uint8Array): Option.Option<Exif> => {
  const bytes = startsWith(input, EXIF_HEADER) ? input.subarray(EXIF_HEADER.length) : input;
  const isLittle = startsWith(bytes, TIFF_LITTLE);
  if ((!isLittle && !startsWith(bytes, TIFF_BIG)) || bytes.length < 8) {
    return Option.none();
  }
  const reader: Reader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    little: isLittle,
  };
  // Offsets already read, so that directories pointing at each other cannot loop.
  const visited: Array<number> = [];
  const directory = (offset: number): Option.Option<Ifd> => {
    if (visited.includes(offset)) {
      return Option.none();
    }
    visited.push(offset);
    return readIfd(reader, offset);
  };
  const pointed = (from: Option.Option<Ifd>, tag: number): Option.Option<Ifd> =>
    Option.flatMap(from, (ifd) => Option.flatMap(firstNumber(ifd.tags, tag), directory));

  return Option.map(directory(u32(reader, 4)), (ifd0) => {
    const exif = pointed(Option.some(ifd0), EXIF_POINTER);
    const gps = pointed(Option.some(ifd0), GPS_POINTER);
    const interop = pointed(exif, INTEROP_POINTER);
    const ifd1 = ifd0.next === 0 ? Option.none() : directory(ifd0.next);
    const thumbnail = Option.flatMap(ifd1, ({ tags }) =>
      Option.flatMap(firstNumber(tags, THUMBNAIL_OFFSET), (at) =>
        Option.flatMap(firstNumber(tags, THUMBNAIL_LENGTH), (length) =>
          length > 0 && fits(reader, at, length)
            ? Option.some(bytes.slice(at, at + length))
            : Option.none(),
        ),
      ),
    );
    const linked: ReadonlyArray<readonly [Directory, Option.Option<Tags>]> = [
      ["ifd0", Option.some(HashMap.removeMany(ifd0.tags, [EXIF_POINTER, GPS_POINTER]))],
      ["exif", Option.map(exif, ({ tags }) => HashMap.remove(tags, INTEROP_POINTER))],
      ["gps", Option.map(gps, ({ tags }) => tags)],
      ["interop", Option.map(interop, ({ tags }) => tags)],
      ["ifd1", Option.map(ifd1, ({ tags }) => tags)],
    ];
    const directories = HashMap.fromIterable(
      Arr.getSomes(linked.map(([name, tags]) => Option.map(tags, (t) => [name, t] as const))),
    );
    return new Exif({ littleEndian: isLittle, directories, thumbnail });
  });
};

// --- containers ----------------------------------------------------------------

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  fromCharCodes(bytes.subarray(at, at + length));

const be16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

const be32 = (bytes: Uint8Array, at: number): number =>
  be16(bytes, at) * 0x1_0000 + be16(bytes, at + 2);

const be64 = (bytes: Uint8Array, at: number): number =>
  be32(bytes, at) * 0x1_0000_0000 + be32(bytes, at + 4);

const le32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
  (bytes[at + 3] ?? 0) * 0x100_0000;

// JPEG: the APP1 segment that starts `Exif\0\0`, before the start of scan.
const fromJpeg = (bytes: Uint8Array): Option.Option<Exif> =>
  scan(2, (at) => {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) {
      return Option.none();
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      // A fill byte before the marker.
      return at + 1;
    }
    if (marker === 0xda || marker === 0xd9) {
      return Option.none();
    }
    const end = at + 2 + be16(bytes, at + 2);
    const exif =
      marker === 0xe1 && startsWith(bytes, EXIF_HEADER, at + 4)
        ? fromTiff(bytes.subarray(at + 10, end))
        : Option.none();
    return Option.isSome(exif) ? exif : end;
  });

// PNG: the `eXIf` chunk, which comes before the image data.
const fromPng = (bytes: Uint8Array): Option.Option<Exif> =>
  scan(8, (at) => {
    if (at + 8 > bytes.length) {
      return Option.none();
    }
    const length = be32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === "eXIf") {
      return fromTiff(bytes.subarray(at + 8, at + 8 + length));
    }
    return type === "IDAT" || type === "IEND" ? Option.none() : at + 12 + length;
  });

// WebP: the RIFF `EXIF` chunk of the extended format.
const fromWebp = (bytes: Uint8Array): Option.Option<Exif> =>
  scan(12, (at) => {
    if (at + 8 > bytes.length) {
      return Option.none();
    }
    const length = le32(bytes, at + 4);
    return ascii(bytes, at, 4) === "EXIF"
      ? fromTiff(bytes.subarray(at + 8, at + 8 + length))
      : at + 8 + length + (length % 2);
  });

interface Box {
  readonly type: string;
  /** Where the box's payload starts and ends. */
  readonly start: number;
  readonly end: number;
}

// The first ISO base media file format box of `type` in `[start, end)` (ISO/IEC 14496-12, 4.2).
const findBox = (bytes: Uint8Array, start: number, end: number, type: string): Option.Option<Box> =>
  scan(start, (at) => {
    if (at + 8 > end) {
      return Option.none();
    }
    const size = be32(bytes, at);
    const header = size === 1 ? 16 : 8;
    const total = size === 0 ? end - at : size === 1 ? be64(bytes, at + 8) : size;
    if (total < header || at + total > end) {
      return Option.none();
    }
    return ascii(bytes, at + 4, 4) === type
      ? Option.some({ type, start: at + header, end: at + total })
      : at + total;
  });

// A child box of a full box, whose payload starts with 4 bytes of version and flags.
const childBox = (bytes: Uint8Array, parent: Box, type: string): Option.Option<Box> =>
  findBox(bytes, parent.start + 4, parent.end, type);

// The payload of an `Exif` item or box: a 4-byte offset to the TIFF header, then the data.
const fromExifPayload = (payload: Uint8Array): Option.Option<Exif> =>
  payload.length < 4 ? Option.none() : fromTiff(payload.subarray(4 + be32(payload, 0)));

// An unsigned big-endian integer of 0, 2, 4 or 8 bytes, as `iloc` stores them.
const sized = (bytes: Uint8Array, at: number, size: number): number =>
  size === 8 ? be64(bytes, at) : size === 4 ? be32(bytes, at) : size === 2 ? be16(bytes, at) : 0;

// The ID of the `Exif` item in an `iinf` box (ISO/IEC 14496-12, 8.11.6).
const exifItemId = (bytes: Uint8Array, iinf: Box): Option.Option<number> =>
  scan(iinf.start + ((bytes[iinf.start] ?? 0) === 0 ? 6 : 8), (at) =>
    Option.match(findBox(bytes, at, iinf.end, "infe"), {
      onNone: () => Option.none(),
      onSome: (infe) => {
        const version = bytes[infe.start] ?? 0;
        const idSize = version === 2 ? 2 : 4;
        return version >= 2 && ascii(bytes, infe.start + 4 + idSize + 2, 4) === "Exif"
          ? Option.some(sized(bytes, infe.start + 4, idSize))
          : infe.end;
      },
    }),
  );

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((offset, part) => {
    joined.set(part, offset);
    return offset + part.length;
  }, 0);
  return joined;
};

// The bytes of item `id`, located by the `iloc` box (ISO/IEC 14496-12, 8.11.3).
const itemBytes = (
  bytes: Uint8Array,
  iloc: Box,
  idat: Option.Option<Box>,
  id: number,
): Option.Option<Uint8Array> => {
  const version = bytes[iloc.start] ?? 0;
  const sizes = bytes[iloc.start + 4] ?? 0;
  const moreSizes = bytes[iloc.start + 5] ?? 0;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0xf;
  const baseOffsetSize = moreSizes >> 4;
  const indexSize = version === 0 ? 0 : moreSizes & 0xf;
  const idSize = version < 2 ? 2 : 4;
  const extentSize = indexSize + offsetSize + lengthSize;
  const count = sized(bytes, iloc.start + 6, idSize);
  let index = 0;
  return scan(iloc.start + 6 + idSize, (at) => {
    if (index >= count || at >= iloc.end) {
      return Option.none();
    }
    index += 1;
    const itemId = sized(bytes, at, idSize);
    const methodAt = at + idSize;
    // Construction method 0 addresses the file; 1 addresses the `idat` box.
    const method = version === 0 ? 0 : be16(bytes, methodAt) & 0xf;
    const baseAt = methodAt + (version === 0 ? 2 : 4);
    const extentsAt = baseAt + baseOffsetSize + 2;
    const extentCount = be16(bytes, baseAt + baseOffsetSize);
    if (itemId !== id) {
      return extentsAt + extentCount * extentSize;
    }
    const origin =
      method === 0
        ? Option.some(0)
        : method === 1
          ? Option.map(idat, (box) => box.start)
          : Option.none();
    return Option.map(origin, (start) =>
      concat(
        Array.from({ length: extentCount }, (_, e) => {
          const extentAt = extentsAt + e * extentSize + indexSize;
          const from =
            start + sized(bytes, baseAt, baseOffsetSize) + sized(bytes, extentAt, offsetSize);
          const length = sized(bytes, extentAt + offsetSize, lengthSize);
          return bytes.subarray(from, length === 0 ? bytes.length : from + length);
        }),
      ),
    );
  });
};

// JPEG XL keeps EXIF in a top-level `Exif` box; HEIF and AVIF as an item of the `meta` box.
const fromIsoBmff = (bytes: Uint8Array): Option.Option<Exif> =>
  findBox(bytes, 0, bytes.length, "Exif").pipe(
    Option.map((box) => bytes.subarray(box.start, box.end)),
    Option.orElse(() =>
      Option.flatMap(findBox(bytes, 0, bytes.length, "meta"), (meta) =>
        Option.flatMap(childBox(bytes, meta, "iinf"), (iinf) =>
          Option.flatMap(exifItemId(bytes, iinf), (id) =>
            Option.flatMap(childBox(bytes, meta, "iloc"), (iloc) =>
              itemBytes(bytes, iloc, childBox(bytes, meta, "idat"), id),
            ),
          ),
        ),
      ),
    ),
    Option.flatMap(fromExifPayload),
  );

/**
 * Finds and reads the EXIF data in an image file: JPEG, PNG, WebP, TIFF, HEIF,
 * AVIF or JPEG XL (in its ISO container). `None` when the file has none or the
 * format is not one of these.
 */
export const read = (bytes: Uint8Array): Option.Option<Exif> => {
  if (startsWith(bytes, [0xff, 0xd8])) {
    return fromJpeg(bytes);
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return fromPng(bytes);
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return fromWebp(bytes);
  }
  if (startsWith(bytes, TIFF_LITTLE) || startsWith(bytes, TIFF_BIG)) {
    return fromTiff(bytes);
  }
  const firstBox = ascii(bytes, 4, 4);
  return firstBox === "ftyp" || firstBox === "JXL " ? fromIsoBmff(bytes) : Option.none();
};

// --- tags ----------------------------------------------------------------------

/** The value of a tag in a directory. */
export const get: {
  (directory: Directory, tag: number): (self: Exif) => Option.Option<Value>;
  (self: Exif, directory: Directory, tag: number): Option.Option<Value>;
} = dual(3, (self: Exif, directory: Directory, tag: number) =>
  Option.flatMap(HashMap.get(self.directories, directory), HashMap.get(tag)),
);

const text = (self: Exif, directory: Directory, tag: number): Option.Option<string> =>
  get(self, directory, tag).pipe(
    Option.filter(Value.$is("Text")),
    Option.map(({ value }) => value.trim()),
    Option.filter(Str.isNonEmpty),
  );

// Numbers, with rationals divided out; a zero denominator gives `NaN`.
const numbers = (self: Exif, directory: Directory, tag: number): ReadonlyArray<number> =>
  Option.match(get(self, directory, tag), {
    onNone: () => [],
    onSome: Value.$match({
      Numbers: ({ values }) => values,
      Rationals: ({ values }) =>
        values.map(({ numerator, denominator }) => numerator / denominator),
      Text: () => [],
      Bytes: ({ bytes }) => Array.from(bytes),
    }),
  });

const number = (self: Exif, directory: Directory, tag: number): Option.Option<number> =>
  Option.filter(Arr.head(numbers(self, directory, tag)), Number.isFinite);

/** The EXIF orientation values: 1 is upright, 2–8 the mirrorings and right-angle rotations. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const isOrientation = (value: number): value is Orientation =>
  Number.isInteger(value) && value >= 1 && value <= 8;

/**
 * How the stored pixels should be turned for display. HEIF and AVIF record
 * this in their own `irot` and `imir` properties, which take precedence.
 */
export const orientation = (self: Exif): Option.Option<Orientation> =>
  Option.filter(number(self, "ifd0", Tag.Orientation), isOrientation);

/** The camera or scanner maker. */
export const make = (self: Exif): Option.Option<string> => text(self, "ifd0", Tag.Make);

/** The camera or scanner model. */
export const model = (self: Exif): Option.Option<string> => text(self, "ifd0", Tag.Model);

/** The lens model. */
export const lensModel = (self: Exif): Option.Option<string> => text(self, "exif", Tag.LensModel);

/** The software that last wrote the file. */
export const software = (self: Exif): Option.Option<string> => text(self, "ifd0", Tag.Software);

/** The photographer or creator. */
export const artist = (self: Exif): Option.Option<string> => text(self, "ifd0", Tag.Artist);

/** The copyright notice. */
export const copyright = (self: Exif): Option.Option<string> => text(self, "ifd0", Tag.Copyright);

/** The exposure time, in seconds. */
export const exposureTime = (self: Exif): Option.Option<number> =>
  number(self, "exif", Tag.ExposureTime);

/** The f-number of the aperture. */
export const fNumber = (self: Exif): Option.Option<number> => number(self, "exif", Tag.FNumber);

/** The focal length of the lens, in millimetres. */
export const focalLength = (self: Exif): Option.Option<number> =>
  number(self, "exif", Tag.FocalLength);

/** The ISO speed. */
export const iso = (self: Exif): Option.Option<number> =>
  number(self, "exif", Tag.PhotographicSensitivity);

/** When a photo was taken, as the camera's clock read it. */
export interface CaptureTime {
  /** Local date and time, ISO 8601 without an offset: `2024-05-01T14:30:00.25`. */
  readonly local: string;
  /** The offset from UTC the camera recorded, such as `+10:00`; most cameras record none. */
  readonly offset: Option.Option<string>;
}

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;
const DIGITS = /^\d+$/;

const subSeconds = (self: Exif): string =>
  text(self, "exif", Tag.SubSecTimeOriginal).pipe(
    Option.filter((digits) => DIGITS.test(digits)),
    Option.match({ onNone: () => "", onSome: (digits) => `.${digits}` }),
  );

/**
 * When the photo was taken (`DateTimeOriginal`, with its sub-seconds and offset).
 * `None` for the all-zero placeholder some cameras write.
 */
export const captureTime = (self: Exif): Option.Option<CaptureTime> =>
  text(self, "exif", Tag.DateTimeOriginal).pipe(
    Option.flatMap((value) => Option.fromNullishOr(EXIF_DATE.exec(value))),
    Option.filter(([, , month, day]) => month !== "00" && day !== "00"),
    Option.map(([, year, month, day, hour, minute, second]) => ({
      local: `${year}-${month}-${day}T${hour}:${minute}:${second}${subSeconds(self)}`,
      offset: Option.filter(text(self, "exif", Tag.OffsetTimeOriginal), (o) => OFFSET.test(o)),
    })),
  );

/** A position from the GPS directory, in decimal degrees and metres. */
export interface Location {
  /** Positive north of the equator. */
  readonly latitude: number;
  /** Positive east of Greenwich. */
  readonly longitude: number;
  /** Metres above sea level; negative below it. */
  readonly altitude: Option.Option<number>;
}

// Degrees, minutes and seconds to signed decimal degrees.
const coordinate = (
  self: Exif,
  tag: number,
  refTag: number,
  negative: string,
  limit: number,
): Option.Option<number> =>
  Arr.match(numbers(self, "gps", tag), {
    onEmpty: () => Option.none(),
    onNonEmpty: ([degrees, minutes = 0, seconds = 0]) => {
      const isNegative = Option.exists(
        text(self, "gps", refTag),
        (ref) => ref.toUpperCase() === negative,
      );
      const value = (isNegative ? -1 : 1) * (degrees + minutes / 60 + seconds / 3600);
      return Number.isFinite(value) && Math.abs(value) <= limit
        ? Option.some(value)
        : Option.none();
    },
  });

const isBelowSeaLevel = (self: Exif): boolean =>
  Option.exists(Arr.head(numbers(self, "gps", Tag.GPSAltitudeRef)), (ref) => ref === 1);

/** Where the photo was taken. Personal data: strip EXIF from images you publish if it should stay private. */
export const location = (self: Exif): Option.Option<Location> =>
  Option.flatMap(coordinate(self, Tag.GPSLatitude, Tag.GPSLatitudeRef, "S", 90), (latitude) =>
    Option.map(coordinate(self, Tag.GPSLongitude, Tag.GPSLongitudeRef, "W", 180), (longitude) => ({
      latitude,
      longitude,
      altitude: Option.map(number(self, "gps", Tag.GPSAltitude), (metres) =>
        isBelowSeaLevel(self) ? -metres : metres,
      ),
    })),
  );
