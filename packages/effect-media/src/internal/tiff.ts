// The TIFF structure EXIF is stored in (TIFF 6.0 and CIPA DC-008): reading its
// directories into tag maps, and writing tag maps back out.
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { concat, decodeText, encodeText, startsWith } from "./bytes.ts";

export type Directory = "ifd0" | "exif" | "gps" | "interop" | "ifd1";

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

/** The TIFF field types that hold numbers, by name. */
export type NumberType =
  | "byte"
  | "short"
  | "long"
  | "sbyte"
  | "sshort"
  | "slong"
  | "float"
  | "double";

export type Value = Data.TaggedEnum<{
  Text: { readonly value: string };
  Numbers: { readonly type: NumberType; readonly values: ReadonlyArray<number> };
  Rationals: { readonly signed: boolean; readonly values: ReadonlyArray<Rational> };
  Bytes: { readonly bytes: Uint8Array };
}>;

export const Value = Data.taggedEnum<Value>();

export type Tags = HashMap.HashMap<number, Value>;

export interface Contents {
  readonly littleEndian: boolean;
  readonly directories: HashMap.HashMap<Directory, Tags>;
  readonly thumbnail: Option.Option<Uint8Array>;
}

export const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];
export const TIFF_LITTLE = [0x49, 0x49, 0x2a, 0];
export const TIFF_BIG = [0x4d, 0x4d, 0, 0x2a];

const EXIF_POINTER = 0x8769;
const GPS_POINTER = 0x8825;
const INTEROP_POINTER = 0xa005;
const THUMBNAIL_OFFSET = 0x0201;
const THUMBNAIL_LENGTH = 0x0202;
// Uncompressed thumbnails point at their strips; the offsets cannot survive a rewrite.
const STRIP_OFFSETS = 0x0111;
const STRIP_BYTE_COUNTS = 0x0117;

// Tags whose values are offsets into the TIFF structure. Reading resolves
// them and writing recomputes them, so they never appear in a tag map.
const structural = {
  ifd0: [EXIF_POINTER, GPS_POINTER],
  exif: [INTEROP_POINTER],
  gps: [],
  interop: [],
  ifd1: [THUMBNAIL_OFFSET, THUMBNAIL_LENGTH, STRIP_OFFSETS, STRIP_BYTE_COUNTS],
} satisfies Record<Directory, ReadonlyArray<number>>;

// --- field types -----------------------------------------------------------------

interface Numeric {
  readonly id: number;
  readonly size: number;
  readonly get: (view: DataView, at: number, little: boolean) => number;
  readonly set: (view: DataView, at: number, value: number, little: boolean) => void;
}

const numeric = {
  byte: { id: 1, size: 1, get: (v, at) => v.getUint8(at), set: (v, at, n) => v.setUint8(at, n) },
  short: {
    id: 3,
    size: 2,
    get: (v, at, le) => v.getUint16(at, le),
    set: (v, at, n, le) => v.setUint16(at, n, le),
  },
  long: {
    id: 4,
    size: 4,
    get: (v, at, le) => v.getUint32(at, le),
    set: (v, at, n, le) => v.setUint32(at, n, le),
  },
  sbyte: { id: 6, size: 1, get: (v, at) => v.getInt8(at), set: (v, at, n) => v.setInt8(at, n) },
  sshort: {
    id: 8,
    size: 2,
    get: (v, at, le) => v.getInt16(at, le),
    set: (v, at, n, le) => v.setInt16(at, n, le),
  },
  slong: {
    id: 9,
    size: 4,
    get: (v, at, le) => v.getInt32(at, le),
    set: (v, at, n, le) => v.setInt32(at, n, le),
  },
  float: {
    id: 11,
    size: 4,
    get: (v, at, le) => v.getFloat32(at, le),
    set: (v, at, n, le) => v.setFloat32(at, n, le),
  },
  double: {
    id: 12,
    size: 8,
    get: (v, at, le) => v.getFloat64(at, le),
    set: (v, at, n, le) => v.setFloat64(at, n, le),
  },
} satisfies Record<NumberType, Numeric>;

type Field =
  | { readonly kind: "text" | "bytes"; readonly size: 1 }
  | { readonly kind: "number"; readonly type: NumberType; readonly size: number }
  | { readonly kind: "rational"; readonly signed: boolean; readonly size: 8 };

const number = (type: NumberType): Field => ({ kind: "number", type, size: numeric[type].size });

// Field types 1 to 13 by number; 13 (IFD) is read as LONG.
const fields: ReadonlyArray<Field> = [
  number("byte"),
  { kind: "text", size: 1 },
  number("short"),
  number("long"),
  { kind: "rational", signed: false, size: 8 },
  number("sbyte"),
  { kind: "bytes", size: 1 },
  number("sshort"),
  number("slong"),
  { kind: "rational", signed: true, size: 8 },
  number("float"),
  number("double"),
  number("long"),
];

// --- reading -----------------------------------------------------------------------

interface Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly little: boolean;
}

const fits = (reader: Reader, at: number, length: number): boolean =>
  at >= 0 && length >= 0 && at + length <= reader.bytes.length;

const u16 = (reader: Reader, at: number): number => reader.view.getUint16(at, reader.little);
const u32 = (reader: Reader, at: number): number => reader.view.getUint32(at, reader.little);

const decodeAscii = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return decodeText(end === -1 ? bytes : bytes.subarray(0, end));
};

const readValue = (reader: Reader, entry: number): Option.Option<Value> => {
  const count = u32(reader, entry + 4);
  return Arr.get(fields, u16(reader, entry + 2) - 1).pipe(
    Option.filter(() => count > 0),
    Option.flatMap((field) => {
      const length = field.size * count;
      const at = length <= 4 ? entry + 8 : u32(reader, entry + 8);
      if (!fits(reader, at, length)) {
        return Option.none();
      }
      const offsets = Array.from({ length: count }, (_, i) => at + i * field.size);
      const range = reader.bytes.subarray(at, at + length);
      return Option.some(
        Match.value(field).pipe(
          Match.discriminatorsExhaustive("kind")({
            text: () => Value.Text({ value: decodeAscii(range) }),
            bytes: () => Value.Bytes({ bytes: range.slice() }),
            number: ({ type }) =>
              Value.Numbers({
                type,
                values: offsets.map((o) => numeric[type].get(reader.view, o, reader.little)),
              }),
            rational: ({ signed }) => {
              const part = (o: number) =>
                signed ? reader.view.getInt32(o, reader.little) : u32(reader, o);
              return Value.Rationals({
                signed,
                values: offsets.map((o) => ({ numerator: part(o), denominator: part(o + 4) })),
              });
            },
          }),
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

/** Reads a TIFF structure, with or without an `Exif\0\0` header. */
export const parse = (input: Uint8Array): Option.Option<Contents> => {
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
    const found: ReadonlyArray<readonly [Directory, Option.Option<Ifd>]> = [
      ["ifd0", Option.some(ifd0)],
      ["exif", exif],
      ["gps", pointed(Option.some(ifd0), GPS_POINTER)],
      ["interop", pointed(exif, INTEROP_POINTER)],
      ["ifd1", ifd1],
    ];
    const directories = HashMap.fromIterable(
      Arr.getSomes(
        found.map(([name, ifd]) =>
          Option.map(
            ifd,
            ({ tags }) => [name, HashMap.removeMany(tags, structural[name])] as const,
          ),
        ),
      ),
    );
    return { littleEndian: isLittle, directories, thumbnail };
  });
};

// --- writing -----------------------------------------------------------------------

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly data: Uint8Array;
}

const encodeValue = (tag: number, value: Value, little: boolean): Entry =>
  Value.$match(value, {
    Text: ({ value: text }) => {
      const data = Uint8Array.from([...encodeText(text), 0]);
      return { tag, type: 2, count: data.length, data };
    },
    Bytes: ({ bytes }) => ({ tag, type: 7, count: bytes.length, data: bytes }),
    Numbers: ({ type, values }) => {
      const { id, size, set } = numeric[type];
      const data = new Uint8Array(values.length * size);
      const view = new DataView(data.buffer);
      values.forEach((n, i) => set(view, i * size, n, little));
      return { tag, type: id, count: values.length, data };
    },
    Rationals: ({ signed, values }) => {
      const data = new Uint8Array(values.length * 8);
      const view = new DataView(data.buffer);
      const set = (at: number, n: number) =>
        signed ? view.setInt32(at, n, little) : view.setUint32(at, n, little);
      values.forEach(({ numerator, denominator }, i) => {
        set(i * 8, numerator);
        set(i * 8 + 4, denominator);
      });
      return { tag, type: signed ? 10 : 5, count: values.length, data };
    },
  });

const long = (tag: number, value: number, little: boolean): Entry =>
  encodeValue(tag, Value.Numbers({ type: "long", values: [value] }), little);

const byTag = Order.mapInput(Order.Number, (entry: Entry) => entry.tag);

// Values over four bytes are stored after the directory, each at an even offset.
const overflow = (entry: Entry): number =>
  entry.data.length > 4 ? entry.data.length + (entry.data.length % 2) : 0;

const blockSize = (entries: ReadonlyArray<Entry>): number =>
  2 + entries.length * 12 + 4 + entries.reduce((sum, entry) => sum + overflow(entry), 0);

const writeBlock = (
  view: DataView,
  at: number,
  entries: ReadonlyArray<Entry>,
  next: number,
  little: boolean,
): void => {
  view.setUint16(at, entries.length, little);
  const dataStart = at + 2 + entries.length * 12 + 4;
  view.setUint32(dataStart - 4, next, little);
  const target = new Uint8Array(view.buffer);
  entries.reduce((dataAt, entry, i) => {
    const entryAt = at + 2 + i * 12;
    view.setUint16(entryAt, entry.tag, little);
    view.setUint16(entryAt + 2, entry.type, little);
    view.setUint32(entryAt + 4, entry.count, little);
    if (entry.data.length <= 4) {
      target.set(entry.data, entryAt + 8);
      return dataAt;
    }
    view.setUint32(entryAt + 8, dataAt, little);
    target.set(entry.data, dataAt);
    return dataAt + overflow(entry);
  }, dataStart);
};

const ORDER: ReadonlyArray<Directory> = ["ifd0", "exif", "gps", "interop", "ifd1"];

/** Writes tag maps as a TIFF structure (without the `Exif\0\0` header). */
export const serialize = (contents: Contents): Uint8Array => {
  const little = contents.littleEndian;
  const tagsOf = (name: Directory) => HashMap.get(contents.directories, name);
  // Interop hangs off the Exif directory, so it is written only with it.
  const present = ORDER.filter(
    (name) => Option.isSome(tagsOf(name)) && (name !== "interop" || Option.isSome(tagsOf("exif"))),
  );
  const thumbnail = present.includes("ifd1") ? contents.thumbnail : Option.none();

  const entriesOf = (
    name: Directory,
    offsetOf: (name: Directory) => number,
    thumbnailAt: number,
  ): ReadonlyArray<Entry> => {
    const own = Option.match(tagsOf(name), {
      onNone: () => [],
      onSome: (tags) =>
        HashMap.toEntries(HashMap.removeMany(tags, structural[name])).map(([tag, value]) =>
          encodeValue(tag, value, little),
        ),
    });
    const pointer = (tag: number, to: Directory): ReadonlyArray<Entry> =>
      present.includes(to) ? [long(tag, offsetOf(to), little)] : [];
    const links = Match.value(name).pipe(
      Match.when("ifd0", () => [...pointer(EXIF_POINTER, "exif"), ...pointer(GPS_POINTER, "gps")]),
      Match.when("exif", () => pointer(INTEROP_POINTER, "interop")),
      Match.when("ifd1", () =>
        Option.match(thumbnail, {
          onNone: () => [],
          onSome: (bytes) => [
            long(THUMBNAIL_OFFSET, thumbnailAt, little),
            long(THUMBNAIL_LENGTH, bytes.length, little),
          ],
        }),
      ),
      Match.orElse(() => []),
    );
    return Arr.sort([...own, ...links], byTag);
  };

  // Pointer values never change a directory's size, so lay out with zeros first.
  const sizes = present.map((name) => blockSize(entriesOf(name, () => 0, 0)));
  const offsets = sizes.reduce<Array<number>>(
    (acc, _, i) => [...acc, i === 0 ? 8 : (acc[i - 1] ?? 0) + (sizes[i - 1] ?? 0)],
    [],
  );
  const end = (offsets.at(-1) ?? 8) + (sizes.at(-1) ?? 0);
  const offsetOf = (name: Directory) => offsets[present.indexOf(name)] ?? 0;

  const header = Uint8Array.from(little ? [...TIFF_LITTLE, 8, 0, 0, 0] : [...TIFF_BIG, 0, 0, 0, 8]);
  const out = concat([
    header,
    new Uint8Array(end - 8),
    Option.getOrElse(thumbnail, () => new Uint8Array()),
  ]);
  const view = new DataView(out.buffer);
  present.forEach((name) => {
    // IFD1 follows IFD0 in the chain of image directories.
    const next = name === "ifd0" && present.includes("ifd1") ? offsetOf("ifd1") : 0;
    writeBlock(view, offsetOf(name), entriesOf(name, offsetOf, end), next, little);
  });
  return out;
};
