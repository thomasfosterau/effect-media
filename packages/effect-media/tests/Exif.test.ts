import { assert, describe, it } from "@effect/vitest";
import { assertNone } from "@effect/vitest/utils";
import * as HashMap from "effect/HashMap";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Exif from "../src/Exif.ts";

const some = <A>(option: Option.Option<A>): A =>
  Option.match(option, { onNone: () => assert.fail("expected Some"), onSome: (value) => value });

// --- a small TIFF writer for fixtures -------------------------------------------

interface Field {
  readonly tag: number;
  /** TIFF field type: 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 7 UNDEFINED, 10 SRATIONAL. */
  readonly type: number;
  /** Text for ASCII; numbers otherwise, as numerator/denominator pairs for rationals. */
  readonly value: string | ReadonlyArray<number>;
}

interface Layout {
  readonly ifd0: ReadonlyArray<Field>;
  readonly exif?: ReadonlyArray<Field>;
  readonly gps?: ReadonlyArray<Field>;
  readonly ifd1?: ReadonlyArray<Field>;
  readonly thumbnail?: ReadonlyArray<number>;
}

const field = (tag: number, type: number, value: string | ReadonlyArray<number>): Field => ({
  tag,
  type,
  value,
});

const tiff = (layout: Layout, little = true): Uint8Array => {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) =>
    little ? [...u16(n & 0xffff), ...u16(n >>> 16)] : [...u16(n >>> 16), ...u16(n & 0xffff)];
  const valueBytes = ({ type, value }: Field): Array<number> => {
    if (P.isString(value)) {
      return [...Array.from(new TextEncoder().encode(value)), 0];
    }
    if (type === 3) {
      return value.flatMap(u16);
    }
    return type === 7 ? [...value] : value.flatMap((n) => u32(n >>> 0));
  };
  const count = ({ type, value }: Field) =>
    P.isString(value)
      ? new TextEncoder().encode(value).length + 1
      : type === 5 || type === 10
        ? value.length / 2
        : value.length;

  // Sizes first, so that pointers can be filled in when writing.
  const blockSize = (fields: ReadonlyArray<Field>) =>
    2 +
    fields.length * 12 +
    4 +
    fields.reduce((sum, f) => {
      const length = valueBytes(f).length;
      return sum + (length > 4 ? length : 0);
    }, 0);
  const pointerCount = (layout.exif ? 1 : 0) + (layout.gps ? 1 : 0);
  const ifd0Size = blockSize(layout.ifd0) + pointerCount * 12;
  const exifAt = 8 + ifd0Size;
  const gpsAt = exifAt + (layout.exif ? blockSize(layout.exif) : 0);
  const ifd1At = gpsAt + (layout.gps ? blockSize(layout.gps) : 0);
  const thumbFields = layout.thumbnail ? 2 : 0;
  const ifd1Size = layout.ifd1 ? blockSize(layout.ifd1) + thumbFields * 12 : 0;
  const thumbAt = ifd1At + ifd1Size;

  const out: Array<number> = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8)];
  const writeIfd = (at: number, fields: ReadonlyArray<Field>, next: number) => {
    const sorted = Arr.sort(
      fields,
      Order.mapInput(Order.Number, (f: Field) => f.tag),
    );
    // Values over 4 bytes go after the entries and the next-directory offset.
    const dataStart = at + 2 + sorted.length * 12 + 4;
    const { entries, overflow } = sorted.reduce(
      (acc, f) => {
        const bytes = valueBytes(f);
        const header = [...u16(f.tag), ...u16(f.type), ...u32(count(f))];
        return bytes.length > 4
          ? {
              entries: [...acc.entries, ...header, ...u32(dataStart + acc.overflow.length)],
              overflow: [...acc.overflow, ...bytes],
            }
          : {
              entries: [
                ...acc.entries,
                ...header,
                ...bytes,
                ...Array.from({ length: 4 - bytes.length }, () => 0),
              ],
              overflow: acc.overflow,
            };
      },
      { entries: Arr.empty<number>(), overflow: Arr.empty<number>() },
    );
    out.push(...u16(sorted.length), ...entries, ...u32(next), ...overflow);
  };
  writeIfd(
    8,
    [
      ...layout.ifd0,
      ...(layout.exif ? [field(0x8769, 4, [exifAt])] : []),
      ...(layout.gps ? [field(0x8825, 4, [gpsAt])] : []),
    ],
    layout.ifd1 ? ifd1At : 0,
  );
  if (layout.exif) writeIfd(exifAt, layout.exif, 0);
  if (layout.gps) writeIfd(gpsAt, layout.gps, 0);
  if (layout.ifd1) {
    const thumb = layout.thumbnail
      ? [field(0x0201, 4, [thumbAt]), field(0x0202, 4, [layout.thumbnail.length])]
      : [];
    writeIfd(ifd1At, [...layout.ifd1, ...thumb], 0);
  }
  if (layout.thumbnail) out.push(...layout.thumbnail);
  return Uint8Array.from(out);
};

const ascii = (text: string): Array<number> => Array.from(text, (c) => c.charCodeAt(0));
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [...be16(n >>> 16), ...be16(n & 0xffff)];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];

const jpeg = (payload: Uint8Array): Uint8Array => {
  const app1 = [...ascii("Exif"), 0, 0, ...payload];
  return Uint8Array.from([
    0xff,
    0xd8,
    // An APP0 (JFIF) segment and an XMP APP1 segment come first.
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xe1,
    ...be16(2 + 4),
    ...ascii("http"),
    0xff,
    0xe1,
    ...be16(2 + app1.length),
    ...app1,
    0xff,
    0xda,
    0,
    2,
  ]);
};

const box = (type: string, ...payload: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  const body = payload.flat();
  return [...be32(8 + body.length), ...ascii(type), ...body];
};

const sample = tiff({
  ifd0: [
    field(Exif.Tag.Make, 2, "Fujifilm"),
    field(Exif.Tag.Model, 2, "X-T5"),
    field(Exif.Tag.Orientation, 3, [6]),
    field(Exif.Tag.Artist, 2, "Zoë"),
  ],
  exif: [
    field(Exif.Tag.ExposureTime, 5, [1, 250]),
    field(Exif.Tag.FNumber, 5, [28, 10]),
    field(Exif.Tag.PhotographicSensitivity, 3, [400]),
    field(Exif.Tag.DateTimeOriginal, 2, "2024:05:01 14:30:00"),
    field(Exif.Tag.SubSecTimeOriginal, 2, "25"),
    field(Exif.Tag.OffsetTimeOriginal, 2, "+10:00"),
  ],
  gps: [
    field(Exif.Tag.GPSLatitudeRef, 2, "S"),
    field(Exif.Tag.GPSLatitude, 5, [33, 1, 52, 1, 1890, 100]),
    field(Exif.Tag.GPSLongitudeRef, 2, "E"),
    field(Exif.Tag.GPSLongitude, 5, [151, 1, 12, 1, 3600, 100]),
    field(Exif.Tag.GPSAltitudeRef, 7, [1]),
    field(Exif.Tag.GPSAltitude, 5, [5, 1]),
  ],
  ifd1: [field(0x0103, 3, [6])],
  thumbnail: [0xff, 0xd8, 0xff, 0xd9],
});

const assertSample = (exif: Option.Option<Exif.Exif>) => {
  const value = some(exif);
  assert.deepStrictEqual(Exif.orientation(value), Option.some(6));
  assert.deepStrictEqual(Exif.make(value), Option.some("Fujifilm"));
};

describe("Exif", () => {
  it("reads typed fields from a TIFF payload", () => {
    const exif = some(Exif.fromTiff(sample));
    assert.isTrue(exif.littleEndian);
    assert.deepStrictEqual(Exif.make(exif), Option.some("Fujifilm"));
    assert.deepStrictEqual(Exif.model(exif), Option.some("X-T5"));
    assert.deepStrictEqual(Exif.artist(exif), Option.some("Zoë"));
    assert.deepStrictEqual(Exif.orientation(exif), Option.some(6));
    assert.deepStrictEqual(Exif.exposureTime(exif), Option.some(1 / 250));
    assert.deepStrictEqual(Exif.fNumber(exif), Option.some(2.8));
    assert.deepStrictEqual(Exif.iso(exif), Option.some(400));
    assertNone(Exif.lensModel(exif));
    assert.deepStrictEqual(
      Exif.captureTime(exif),
      Option.some({
        local: "2024-05-01T14:30:00.25",
        offset: Option.some("+10:00"),
      }),
    );
    assert.deepStrictEqual(exif.thumbnail, Option.some(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])));
  });

  it("converts GPS coordinates to signed decimal degrees", () => {
    const { latitude, longitude, altitude } = some(Exif.location(some(Exif.fromTiff(sample))));
    assert.closeTo(latitude, -(33 + 52 / 60 + 18.9 / 3600), 1e-9);
    assert.closeTo(longitude, 151 + 12 / 60 + 36 / 3600, 1e-9);
    assert.deepStrictEqual(altitude, Option.some(-5));
  });

  it("reads big-endian data and drops directory pointers", () => {
    const exif = some(
      Exif.fromTiff(tiff({ ifd0: [field(Exif.Tag.Orientation, 3, [3])], exif: [] }, false)),
    );
    assert.isFalse(exif.littleEndian);
    assert.deepStrictEqual(Exif.orientation(exif), Option.some(3));
    assertNone(Exif.get(exif, "ifd0", 0x8769));
    assert.isTrue(HashMap.has(exif.directories, "exif"));
  });

  it("gives raw values with get", () => {
    const exif = some(Exif.fromTiff(sample));
    assert.deepStrictEqual(
      Exif.get(exif, "exif", Exif.Tag.FNumber),
      Option.some(Exif.Value.Rationals({ values: [{ numerator: 28, denominator: 10 }] })),
    );
    assert.deepStrictEqual(
      exif.pipe(Exif.get("gps", Exif.Tag.GPSAltitudeRef)),
      Option.some(Exif.Value.Bytes({ bytes: Uint8Array.from([1]) })),
    );
  });

  describe("finds EXIF in", () => {
    it("JPEG, after other APP segments", () => assertSample(Exif.read(jpeg(sample))));

    it("PNG", () => {
      const chunk = (type: string, data: ReadonlyArray<number>) => [
        ...be32(data.length),
        ...ascii(type),
        ...data,
        0,
        0,
        0,
        0,
      ];
      const png = Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...chunk(
          "IHDR",
          Array.from({ length: 13 }, () => 0),
        ),
        ...chunk("eXIf", [...sample]),
        ...chunk("IEND", []),
      ]);
      assertSample(Exif.read(png));
    });

    it("WebP, with or without an Exif header", () => {
      const webp = (exif: ReadonlyArray<number>) => {
        const padded = exif.length % 2 === 0 ? exif : [...exif, 0];
        const body = [
          ...ascii("WEBP"),
          ...ascii("VP8X"),
          ...le32(10),
          ...Array.from({ length: 10 }, () => 0),
          ...ascii("EXIF"),
          ...le32(exif.length),
          ...padded,
        ];
        return Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
      };
      assertSample(Exif.read(webp([...sample])));
      assertSample(Exif.read(webp([...ascii("Exif"), 0, 0, ...sample])));
    });

    it("TIFF", () => assertSample(Exif.read(sample)));

    it("HEIF, through the meta box's item location", () => {
      const ftyp = box("ftyp", ascii("heic"), [0, 0, 0, 0], ascii("mif1"));
      const payload = [...be32(0), ...sample];
      const infe = (id: number, type: string) =>
        box("infe", [2, 0, 0, 0], be16(id), [0, 0], ascii(type), [0]);
      const iinf = box("iinf", [0, 0, 0, 0], be16(2), infe(1, "hvc1"), infe(2, "Exif"));
      // iloc version 1, 4-byte offsets and lengths, no base offset; the Exif item uses idat.
      const iloc = (exifOffset: number) =>
        box(
          "iloc",
          [1, 0, 0, 0],
          [0x44, 0x00],
          be16(2),
          [...be16(1), 0, 0, 0, 0, ...be16(1), ...be32(0), ...be32(1)],
          [...be16(2), 0, 1, 0, 0, ...be16(1), ...be32(exifOffset), ...be32(payload.length)],
        );
      const idat = box("idat", [0xaa], payload);
      const meta = box(
        "meta",
        [0, 0, 0, 0],
        box(
          "hdlr",
          Array.from({ length: 24 }, () => 0),
        ),
        iinf,
        iloc(1),
        idat,
      );
      assertSample(Exif.read(Uint8Array.from([...ftyp, ...meta])));
    });

    it("JPEG XL, from its Exif box", () => {
      const jxl = [
        ...box("JXL ", [0x0d, 0x0a, 0x87, 0x0a]),
        ...box("ftyp", ascii("jxl "), [0, 0, 0, 0], ascii("jxl ")),
        ...box("Exif", be32(0), [...sample]),
      ];
      assertSample(Exif.read(Uint8Array.from(jxl)));
    });
  });

  describe("tolerates", () => {
    it("files without EXIF", () => {
      assertNone(Exif.read(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])));
      assertNone(Exif.read(Uint8Array.from(ascii("GIF89a"))));
      assertNone(Exif.read(new Uint8Array()));
    });

    it("truncation at every length", () => {
      const file = jpeg(sample);
      Arr.makeBy(file.length, (length) =>
        assert.doesNotThrow(() => Exif.read(file.subarray(0, length))),
      );
    });

    it("directories that point at each other", () => {
      const bytes = tiff({ ifd0: [field(Exif.Tag.Orientation, 3, [8])], exif: [] });
      // Point the Exif directory back at IFD0.
      const view = new DataView(bytes.buffer);
      const ifd0Count = view.getUint16(8, true);
      const pointer = Array.from({ length: ifd0Count }, (_, i) => 10 + i * 12).find(
        (at) => view.getUint16(at, true) === 0x8769,
      );
      view.setUint32((pointer ?? 0) + 8, 8, true);
      const exif = some(Exif.fromTiff(bytes));
      assert.deepStrictEqual(Exif.orientation(exif), Option.some(8));
      assert.isFalse(HashMap.has(exif.directories, "exif"));
    });

    it("values out of range", () => {
      const exif = some(
        Exif.fromTiff(
          tiff({
            ifd0: [field(Exif.Tag.Orientation, 3, [9]), field(Exif.Tag.Make, 2, "   ")],
            exif: [field(Exif.Tag.DateTimeOriginal, 2, "0000:00:00 00:00:00")],
            gps: [
              field(Exif.Tag.GPSLatitude, 5, [91, 1, 0, 1, 0, 1]),
              field(Exif.Tag.GPSLongitude, 5, [0, 1, 0, 1, 0, 1]),
            ],
          }),
        ),
      );
      assertNone(Exif.orientation(exif));
      assertNone(Exif.make(exif));
      assertNone(Exif.captureTime(exif));
      assertNone(Exif.location(exif));
    });
  });
});
