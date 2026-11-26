// Where each image format keeps its EXIF payload, and how to replace or remove
// it without decoding the image.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { EncodeError, UnsupportedFormat, UnsupportedOperation } from "../MediaError.ts";
import * as MediaType from "../MediaType.ts";
import {
  ascii,
  asciiBytes,
  be16,
  be32,
  be64,
  concat,
  crc32,
  le16,
  le32,
  startsWith,
  toBe32,
  toLe24,
  toLe32,
} from "./bytes.ts";
import { scan } from "./scan.ts";
import { EXIF_HEADER, TIFF_BIG, TIFF_LITTLE } from "./tiff.ts";

export type WriteError = EncodeError | UnsupportedFormat | UnsupportedOperation;

type Container = "jpeg" | "png" | "webp" | "tiff" | "isobmff" | "jxl-container" | "jxl-codestream";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JXL_SIGNATURE_BOX = [0, 0, 0, 0x0c, ...asciiBytes("JXL "), 0x0d, 0x0a, 0x87, 0x0a];

const containerOf = (bytes: Uint8Array): Option.Option<Container> => {
  if (startsWith(bytes, [0xff, 0xd8])) {
    return Option.some("jpeg");
  }
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return Option.some("png");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return Option.some("webp");
  }
  if (startsWith(bytes, TIFF_LITTLE) || startsWith(bytes, TIFF_BIG)) {
    return Option.some("tiff");
  }
  if (startsWith(bytes, JXL_SIGNATURE_BOX)) {
    return Option.some("jxl-container");
  }
  if (startsWith(bytes, [0xff, 0x0a])) {
    return Option.some("jxl-codestream");
  }
  return ascii(bytes, 4, 4) === "ftyp" ? Option.some("isobmff") : Option.none();
};

// --- JPEG ------------------------------------------------------------------------

interface Segment {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
}

const isExifSegment = (bytes: Uint8Array, segment: Segment): boolean =>
  segment.marker === 0xe1 && startsWith(bytes, EXIF_HEADER, segment.start + 4);

// The marker segments before the start of scan, and where the scan starts.
const jpegSegments = (
  bytes: Uint8Array,
): Option.Option<{ readonly segments: ReadonlyArray<Segment>; readonly scanAt: number }> => {
  const segments: Array<Segment> = [];
  return Option.map(
    scan(2, (at) => {
      if (at + 4 > bytes.length || bytes[at] !== 0xff) {
        return Option.none();
      }
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xff) {
        // A fill byte before the marker.
        return at + 1;
      }
      if (marker === 0xda) {
        return Option.some(at);
      }
      const end = at + 2 + be16(bytes, at + 2);
      segments.push({ marker, start: at, end });
      return marker === 0xd9 ? Option.none() : end;
    }),
    (scanAt) => ({ segments, scanAt }),
  );
};

const jpegPayload = (bytes: Uint8Array): Option.Option<Uint8Array> =>
  Option.flatMap(jpegSegments(bytes), ({ segments }) =>
    Option.fromUndefinedOr(segments.find((segment) => isExifSegment(bytes, segment))).pipe(
      Option.map((segment) => bytes.subarray(segment.start + 10, segment.end)),
    ),
  );

const MAX_SEGMENT = 0xffff;

const replaceJpeg = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> =>
  Option.match(jpegSegments(bytes), {
    onNone: () => Result.fail(encodeError(bytes, "the JPEG has no start of scan")),
    onSome: ({ segments, scanAt }) => {
      const kept = segments.filter((segment) => !isExifSegment(bytes, segment));
      // JFIF requires its APP0 segment first; EXIF goes straight after it.
      const leading = kept.findIndex((segment) => segment.marker !== 0xe0);
      const split = leading === -1 ? kept.length : leading;
      const app1 = Option.map(payload, (tiff) => [
        0xff,
        0xe1,
        ...toBe32(2 + EXIF_HEADER.length + tiff.length).slice(2),
        ...EXIF_HEADER,
      ]);
      if (Option.exists(payload, (tiff) => 2 + EXIF_HEADER.length + tiff.length > MAX_SEGMENT)) {
        return Result.fail(
          encodeError(bytes, "the EXIF data is over the 64 KB a JPEG segment holds"),
        );
      }
      const range = ({ start, end }: Segment) => bytes.subarray(start, end);
      return Result.succeed(
        concat([
          [0xff, 0xd8],
          ...kept.slice(0, split).map(range),
          ...Option.match(app1, {
            onNone: () => [],
            onSome: (header) => [header, Option.getOrElse(payload, () => new Uint8Array())],
          }),
          ...kept.slice(split).map(range),
          bytes.subarray(scanAt),
        ]),
      );
    },
  });

// --- PNG -------------------------------------------------------------------------

interface Chunk {
  readonly type: string;
  readonly start: number;
  /** Where the data ends; the CRC follows. */
  readonly dataEnd: number;
}

const pngChunks = (bytes: Uint8Array): Option.Option<ReadonlyArray<Chunk>> => {
  const chunks: Array<Chunk> = [];
  return scan(8, (at): number | Option.Option<ReadonlyArray<Chunk>> => {
    if (at + 12 > bytes.length) {
      return Option.none();
    }
    const type = ascii(bytes, at + 4, 4);
    const dataEnd = at + 8 + be32(bytes, at);
    if (dataEnd + 4 > bytes.length) {
      return Option.none();
    }
    chunks.push({ type, start: at, dataEnd });
    return type === "IEND" ? Option.some(chunks) : dataEnd + 4;
  });
};

// The `eXIf` chunk comes before the image data.
const pngPayload = (bytes: Uint8Array): Option.Option<Uint8Array> =>
  scan(8, (at) => {
    if (at + 8 > bytes.length) {
      return Option.none();
    }
    const length = be32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === "eXIf") {
      return Option.some(bytes.subarray(at + 8, at + 8 + length));
    }
    return type === "IDAT" || type === "IEND" ? Option.none() : at + 12 + length;
  });

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const body = concat([asciiBytes(type), data]);
  return concat([toBe32(data.length), body, toBe32(crc32(body))]);
};

const replacePng = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> =>
  Option.match(pngChunks(bytes), {
    onNone: () => Result.fail(encodeError(bytes, "the PNG has no IEND chunk")),
    onSome: (chunks) => {
      const kept = chunks.filter((chunk) => chunk.type !== "eXIf");
      const firstData = kept.findIndex((chunk) => chunk.type === "IDAT" || chunk.type === "IEND");
      const exif = Arr.fromOption(Option.map(payload, (tiff) => pngChunk("eXIf", tiff)));
      const range = (chunk: Chunk) => bytes.subarray(chunk.start, chunk.dataEnd + 4);
      return Result.succeed(
        concat([
          PNG_SIGNATURE,
          ...kept.slice(0, firstData).map(range),
          ...exif,
          ...kept.slice(firstData).map(range),
        ]),
      );
    },
  });

// --- WebP ------------------------------------------------------------------------

interface RiffChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

const webpChunks = (bytes: Uint8Array): ReadonlyArray<RiffChunk> => {
  const chunks: Array<RiffChunk> = [];
  scan(12, (at) => {
    if (at + 8 > bytes.length) {
      return Option.none();
    }
    const length = le32(bytes, at + 4);
    chunks.push({ type: ascii(bytes, at, 4), data: bytes.subarray(at + 8, at + 8 + length) });
    return at + 8 + length + (length % 2);
  });
  return chunks;
};

const webpPayload = (bytes: Uint8Array): Option.Option<Uint8Array> =>
  Option.map(
    Option.fromUndefinedOr(webpChunks(bytes).find((chunk) => chunk.type === "EXIF")),
    (chunk) => chunk.data,
  );

const riffChunk = ({ type, data }: RiffChunk): Uint8Array =>
  concat([asciiBytes(type), toLe32(data.length), data, data.length % 2 === 1 ? [0] : []]);

const VP8X_EXIF = 0x08;
const VP8X_ALPHA = 0x10;

// The VP8X header a simple (lossy or lossless) WebP needs before it can carry EXIF.
const vp8x = (image: RiffChunk): Option.Option<RiffChunk> => {
  const { type, data } = image;
  const header = (width: number, height: number, flags: number): RiffChunk => ({
    type: "VP8X",
    data: Uint8Array.from([flags, 0, 0, 0, ...toLe24(width - 1), ...toLe24(height - 1)]),
  });
  if (type === "VP8 " && startsWith(data, [0x9d, 0x01, 0x2a], 3)) {
    return Option.some(header(le16(data, 6) & 0x3fff, le16(data, 8) & 0x3fff, 0));
  }
  if (type === "VP8L" && data[0] === 0x2f) {
    const bits = le32(data, 1);
    const alpha = (bits >>> 28) & 1 ? VP8X_ALPHA : 0;
    return Option.some(header((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, alpha));
  }
  return Option.none();
};

const replaceWebp = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> => {
  const chunks = webpChunks(bytes).filter((chunk) => chunk.type !== "EXIF");
  const extended = Option.fromUndefinedOr(chunks.find((chunk) => chunk.type === "VP8X"));
  const header = Option.isSome(payload)
    ? Option.orElse(extended, () => Option.flatMap(Option.fromUndefinedOr(chunks[0]), vp8x))
    : extended;
  if (Option.isSome(payload) && Option.isNone(header)) {
    return Result.fail(encodeError(bytes, "the WebP has no image chunk to describe"));
  }
  const withFlag = Option.map(header, ({ data }) => {
    const flags = data.slice();
    flags[0] = Option.isSome(payload) ? (flags[0] ?? 0) | VP8X_EXIF : (flags[0] ?? 0) & ~VP8X_EXIF;
    return { type: "VP8X", data: flags };
  });
  const body = chunks.filter((chunk) => chunk.type !== "VP8X");
  // EXIF follows the image data and precedes XMP.
  const xmp = body.findIndex((chunk) => chunk.type === "XMP ");
  const split = xmp === -1 ? body.length : xmp;
  const all = [
    ...Option.toArray(withFlag),
    ...body.slice(0, split),
    ...Option.toArray(Option.map(payload, (data) => ({ type: "EXIF", data }))),
    ...body.slice(split),
  ];
  const riff = concat([asciiBytes("WEBP"), ...all.map(riffChunk)]);
  return Result.succeed(concat([asciiBytes("RIFF"), toLe32(riff.length), riff]));
};

// --- ISO base media file format (HEIF, AVIF, JPEG XL) ----------------------------------

interface Box {
  readonly type: string;
  /** Where the box's header starts. */
  readonly at: number;
  /** Where the box's payload starts and ends. */
  readonly start: number;
  readonly end: number;
}

// The ISO base media file format boxes in `[start, end)` (ISO/IEC 14496-12, 4.2).
const boxes = (bytes: Uint8Array, start: number, end: number): ReadonlyArray<Box> => {
  const found: Array<Box> = [];
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
    found.push({ type: ascii(bytes, at + 4, 4), at, start: at + header, end: at + total });
    return at + total;
  });
  return found;
};

const findBox = (bytes: Uint8Array, start: number, end: number, type: string): Option.Option<Box> =>
  Option.fromUndefinedOr(boxes(bytes, start, end).find((box) => box.type === type));

// A child of a full box, whose payload starts with 4 bytes of version and flags.
const childBox = (bytes: Uint8Array, parent: Box, type: string): Option.Option<Box> =>
  findBox(bytes, parent.start + 4, parent.end, type);

// An `Exif` item or box holds a 4-byte offset to the TIFF header, then the data.
const fromExifPayload = (payload: Uint8Array): Option.Option<Uint8Array> =>
  payload.length < 4 ? Option.none() : Option.some(payload.subarray(4 + be32(payload, 0)));

// An unsigned big-endian integer of 0, 2, 4 or 8 bytes, as `iloc` stores them.
const sized = (bytes: Uint8Array, at: number, size: number): number =>
  size === 8 ? be64(bytes, at) : size === 4 ? be32(bytes, at) : size === 2 ? be16(bytes, at) : 0;

// The ID of the `Exif` item in an `iinf` box (ISO/IEC 14496-12, 8.11.6).
const exifItemId = (bytes: Uint8Array, iinf: Box): Option.Option<number> => {
  const entries = (bytes[iinf.start] ?? 0) === 0 ? 6 : 8;
  return Option.fromUndefinedOr(
    boxes(bytes, iinf.start + entries, iinf.end).find((infe) => {
      const version = bytes[infe.start] ?? 0;
      const idSize = version === 2 ? 2 : 4;
      return (
        infe.type === "infe" &&
        version >= 2 &&
        ascii(bytes, infe.start + 4 + idSize + 2, 4) === "Exif"
      );
    }),
  ).pipe(
    Option.map((infe) => sized(bytes, infe.start + 4, (bytes[infe.start] ?? 0) === 2 ? 2 : 4)),
  );
};

interface Extent {
  readonly start: number;
  readonly end: number;
}

// Where item `id`'s bytes are, from the `iloc` box (ISO/IEC 14496-12, 8.11.3).
const itemExtents = (
  bytes: Uint8Array,
  iloc: Box,
  idat: Option.Option<Box>,
  id: number,
): Option.Option<ReadonlyArray<Extent>> => {
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
    const methodAt = at + idSize;
    // Construction method 0 addresses the file; 1 addresses the `idat` box.
    const method = version === 0 ? 0 : be16(bytes, methodAt) & 0xf;
    const baseAt = methodAt + (version === 0 ? 2 : 4);
    const extentsAt = baseAt + baseOffsetSize + 2;
    const extentCount = be16(bytes, baseAt + baseOffsetSize);
    if (sized(bytes, at, idSize) !== id) {
      return extentsAt + extentCount * extentSize;
    }
    const origin =
      method === 0
        ? Option.some(0)
        : method === 1
          ? Option.map(idat, (box) => box.start)
          : Option.none();
    return Option.map(origin, (start) =>
      Array.from({ length: extentCount }, (_, e) => {
        const extentAt = extentsAt + e * extentSize + indexSize;
        const from =
          start + sized(bytes, baseAt, baseOffsetSize) + sized(bytes, extentAt, offsetSize);
        const length = sized(bytes, extentAt + offsetSize, lengthSize);
        return {
          start: Math.min(from, bytes.length),
          end: Math.min(length === 0 ? bytes.length : from + length, bytes.length),
        };
      }),
    );
  });
};

const heifExifExtents = (bytes: Uint8Array): Option.Option<ReadonlyArray<Extent>> =>
  Option.flatMap(findBox(bytes, 0, bytes.length, "meta"), (meta) =>
    Option.flatMap(childBox(bytes, meta, "iinf"), (iinf) =>
      Option.flatMap(exifItemId(bytes, iinf), (id) =>
        Option.flatMap(childBox(bytes, meta, "iloc"), (iloc) =>
          itemExtents(bytes, iloc, childBox(bytes, meta, "idat"), id),
        ),
      ),
    ),
  );

const heifPayload = (bytes: Uint8Array): Option.Option<Uint8Array> =>
  heifExifExtents(bytes).pipe(
    Option.map((extents) => concat(extents.map(({ start, end }) => bytes.subarray(start, end)))),
    Option.flatMap(fromExifPayload),
  );

// HEIF and AVIF locate items by absolute offsets, so EXIF is rewritten in place:
// blanked to strip it, or overwritten when the new data fits the old space.
const replaceHeif = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> => {
  const extents = heifExifExtents(bytes);
  if (Option.isNone(extents)) {
    return Option.isNone(payload)
      ? Result.succeed(bytes)
      : Result.fail(unsupported(bytes, "adding EXIF to a HEIF or AVIF file that has none"));
  }
  const out = bytes.slice();
  if (Option.isNone(payload)) {
    extents.value.forEach(({ start, end }) => out.fill(0, start, end));
    return Result.succeed(out);
  }
  const item = concat([toBe32(0), payload.value]);
  const only = Option.filter(Arr.head(extents.value), () => extents.value.length === 1);
  if (Option.isNone(only) || item.length > only.value.end - only.value.start) {
    return Result.fail(
      unsupported(bytes, "EXIF larger than the space the HEIF or AVIF file has for it"),
    );
  }
  out.fill(0, only.value.start, only.value.end);
  out.set(item, only.value.start);
  return Result.succeed(out);
};

const isExifBox = (bytes: Uint8Array, box: Box): boolean =>
  box.type === "Exif" || (box.type === "brob" && ascii(bytes, box.start, 4) === "Exif");

const jxlPayload = (bytes: Uint8Array): Option.Option<Uint8Array> =>
  Option.flatMap(findBox(bytes, 0, bytes.length, "Exif"), (box) =>
    fromExifPayload(bytes.subarray(box.start, box.end)),
  );

const exifBox = (tiff: Uint8Array): Uint8Array =>
  concat([toBe32(8 + 4 + tiff.length), asciiBytes("Exif"), toBe32(0), tiff]);

// JPEG XL keeps EXIF in a top-level `Exif` box (or a Brotli-compressed `brob` one).
const replaceJxlContainer = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> => {
  const kept = boxes(bytes, 0, bytes.length).filter((box) => !isExifBox(bytes, box));
  // After the signature, `ftyp` and the optional `jxll` level box, which lead the file.
  const leading = kept.findIndex((box) => !["JXL ", "ftyp", "jxll"].includes(box.type));
  const split = leading === -1 ? kept.length : leading;
  const range = (box: Box) => bytes.subarray(box.at, box.end);
  return Result.succeed(
    concat([
      ...kept.slice(0, split).map(range),
      ...Option.toArray(Option.map(payload, exifBox)),
      ...kept.slice(split).map(range),
    ]),
  );
};

// A bare codestream has nowhere for EXIF, so writing wraps it in the container format.
const replaceJxlCodestream = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> =>
  Result.succeed(
    Option.match(payload, {
      onNone: () => bytes,
      onSome: (tiff) =>
        concat([
          JXL_SIGNATURE_BOX,
          [0, 0, 0, 0x14, ...asciiBytes("ftypjxl "), 0, 0, 0, 0, ...asciiBytes("jxl ")],
          exifBox(tiff),
          toBe32(8 + bytes.length),
          asciiBytes("jxlc"),
          bytes,
        ]),
    }),
  );

// --- dispatch ----------------------------------------------------------------------

const mediaTypeOf = (bytes: Uint8Array): { readonly mediaType?: string } =>
  Option.match(MediaType.sniff(bytes), {
    onNone: () => ({}),
    onSome: (mediaType) => ({ mediaType }),
  });

const encodeError = (bytes: Uint8Array, reason: string): EncodeError =>
  new EncodeError({ backend: "core", ...mediaTypeOf(bytes), reason });

const unsupported = (bytes: Uint8Array, detail: string): UnsupportedOperation =>
  new UnsupportedOperation({
    backend: "core",
    ...mediaTypeOf(bytes),
    operation: "Exif.write",
    detail,
  });

const locators = {
  jpeg: jpegPayload,
  png: pngPayload,
  webp: webpPayload,
  tiff: Option.some,
  isobmff: heifPayload,
  "jxl-container": jxlPayload,
  "jxl-codestream": () => Option.none(),
} satisfies Record<Container, (bytes: Uint8Array) => Option.Option<Uint8Array>>;

const replacers = {
  jpeg: replaceJpeg,
  png: replacePng,
  webp: replaceWebp,
  tiff: (bytes) => Result.fail(unsupported(bytes, "TIFF files, whose structure EXIF is part of")),
  isobmff: replaceHeif,
  "jxl-container": replaceJxlContainer,
  "jxl-codestream": replaceJxlCodestream,
} satisfies Record<
  Container,
  (bytes: Uint8Array, payload: Option.Option<Uint8Array>) => Result.Result<Uint8Array, WriteError>
>;

/** The TIFF-structured EXIF payload of an image file, without any `Exif\0\0` header. */
export const locate = (bytes: Uint8Array): Option.Option<Uint8Array> =>
  Option.flatMap(containerOf(bytes), (container) => locators[container](bytes));

/** Replaces an image file's EXIF payload, or removes it when `payload` is `None`. */
export const replace = (
  bytes: Uint8Array,
  payload: Option.Option<Uint8Array>,
): Result.Result<Uint8Array, WriteError> =>
  Option.match(containerOf(bytes), {
    onNone: () =>
      Result.fail(
        new UnsupportedFormat({ backend: "core", ...mediaTypeOf(bytes), direction: "encode" }),
      ),
    onSome: (container) => replacers[container](bytes, payload),
  });
