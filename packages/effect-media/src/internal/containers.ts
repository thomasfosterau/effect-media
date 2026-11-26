// Where each image format keeps its EXIF and XMP metadata, and how to replace
// or remove them without decoding the image.
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
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

/** What to do with one kind of metadata. */
export type Change = Data.TaggedEnum<{
  Keep: Record<never, never>;
  Remove: Record<never, never>;
  Set: { readonly bytes: Uint8Array };
}>;

export const Change = Data.taggedEnum<Change>();

/** EXIF is a TIFF structure without its `Exif\0\0` header; XMP is a serialized packet. */
export interface Changes {
  readonly exif: Change;
  readonly xmp: Change;
}

/** The metadata found in a file. An XMP packet that cannot be read, such as a compressed one, is `Some(None)`. */
export interface Found {
  readonly exif: Option.Option<Uint8Array>;
  readonly xmp: Option.Option<Option.Option<Uint8Array>>;
}

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

const isKeep = Change.$is("Keep");

const setBytes = (change: Change): Option.Option<Uint8Array> =>
  Change.$is("Set")(change) ? Option.some(change.bytes) : Option.none();

// --- JPEG ------------------------------------------------------------------------

interface Segment {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
}

const XMP_HEADER = [...asciiBytes("http://ns.adobe.com/xap/1.0/"), 0];
const XMP_EXTENSION_HEADER = [...asciiBytes("http://ns.adobe.com/xmp/extension/"), 0];

const isApp1With = (bytes: Uint8Array, segment: Segment, header: ReadonlyArray<number>): boolean =>
  segment.marker === 0xe1 && startsWith(bytes, header, segment.start + 4);

const isExifSegment = (bytes: Uint8Array, segment: Segment): boolean =>
  isApp1With(bytes, segment, EXIF_HEADER);

const isXmpSegment = (bytes: Uint8Array, segment: Segment): boolean =>
  isApp1With(bytes, segment, XMP_HEADER) || isApp1With(bytes, segment, XMP_EXTENSION_HEADER);

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

const segmentPayload = (
  bytes: Uint8Array,
  segments: ReadonlyArray<Segment>,
  header: ReadonlyArray<number>,
): Option.Option<Uint8Array> =>
  Option.map(
    Option.fromUndefinedOr(segments.find((segment) => isApp1With(bytes, segment, header))),
    (segment) => bytes.subarray(segment.start + 4 + header.length, segment.end),
  );

const findJpeg = (bytes: Uint8Array): Found =>
  Option.match(jpegSegments(bytes), {
    onNone: () => ({ exif: Option.none(), xmp: Option.none() }),
    onSome: ({ segments }) => ({
      exif: segmentPayload(bytes, segments, EXIF_HEADER),
      // Extended XMP continues the main packet; editing the main packet drops it.
      xmp: Option.map(segmentPayload(bytes, segments, XMP_HEADER), Option.some),
    }),
  });

const MAX_SEGMENT = 0xffff;

const app1 = (header: ReadonlyArray<number>, payload: Uint8Array): Uint8Array =>
  concat([[0xff, 0xe1], toBe32(2 + header.length + payload.length).slice(2), header, payload]);

const replaceJpeg = (bytes: Uint8Array, changes: Changes): Result.Result<Uint8Array, WriteError> =>
  Option.match(jpegSegments(bytes), {
    onNone: () => Result.fail(encodeError(bytes, "the JPEG has no start of scan")),
    onSome: ({ segments, scanAt }) => {
      const added = [
        ...Option.toArray(Option.map(setBytes(changes.exif), (tiff) => app1(EXIF_HEADER, tiff))),
        ...Option.toArray(Option.map(setBytes(changes.xmp), (xmp) => app1(XMP_HEADER, xmp))),
      ];
      if (added.some((segment) => segment.length - 2 > MAX_SEGMENT)) {
        return Result.fail(
          encodeError(bytes, "the metadata is over the 64 KB a JPEG segment holds"),
        );
      }
      const kept = segments.filter(
        (segment) =>
          !(isExifSegment(bytes, segment) && !isKeep(changes.exif)) &&
          !(isXmpSegment(bytes, segment) && !isKeep(changes.xmp)),
      );
      // JFIF requires its APP0 segment first; new metadata goes straight after it.
      const leading = kept.findIndex((segment) => segment.marker !== 0xe0);
      const split = leading === -1 ? kept.length : leading;
      const range = ({ start, end }: Segment) => bytes.subarray(start, end);
      return Result.succeed(
        concat([
          [0xff, 0xd8],
          ...kept.slice(0, split).map(range),
          ...added,
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

const XMP_KEYWORD = [...asciiBytes("XML:com.adobe.xmp"), 0];

// The chunks up to IEND; `complete` is false when the file ends or breaks before it.
interface Chunks {
  readonly chunks: ReadonlyArray<Chunk>;
  readonly complete: boolean;
}

const pngChunks = (bytes: Uint8Array): Chunks => {
  const chunks: Array<Chunk> = [];
  const complete = scan(8, (at) => {
    if (at + 12 > bytes.length) {
      return Option.none();
    }
    const type = ascii(bytes, at + 4, 4);
    const dataEnd = at + 8 + be32(bytes, at);
    if (dataEnd + 4 > bytes.length) {
      return Option.none();
    }
    chunks.push({ type, start: at, dataEnd });
    return type === "IEND" ? Option.some(true) : dataEnd + 4;
  });
  return { chunks, complete: Option.isSome(complete) };
};

const isXmpChunk = (bytes: Uint8Array, chunk: Chunk): boolean =>
  chunk.type === "iTXt" && startsWith(bytes, XMP_KEYWORD, chunk.start + 8);

// An iTXt chunk: keyword, compression flag and method, language and translated keyword, text.
const itxtText = (bytes: Uint8Array, chunk: Chunk): Option.Option<Uint8Array> => {
  const flagAt = chunk.start + 8 + XMP_KEYWORD.length;
  const language = bytes.indexOf(0, flagAt + 2);
  const translated = language === -1 ? -1 : bytes.indexOf(0, language + 1);
  return bytes[flagAt] !== 0 || translated === -1 || translated >= chunk.dataEnd
    ? Option.none()
    : Option.some(bytes.subarray(translated + 1, chunk.dataEnd));
};

const findPng = (bytes: Uint8Array): Found => {
  const { chunks } = pngChunks(bytes);
  const first = (predicate: (chunk: Chunk) => boolean) =>
    Option.fromUndefinedOr(chunks.find(predicate));
  return {
    exif: Option.map(
      first((chunk) => chunk.type === "eXIf"),
      (chunk) => bytes.subarray(chunk.start + 8, chunk.dataEnd),
    ),
    xmp: Option.map(
      first((chunk) => isXmpChunk(bytes, chunk)),
      (chunk) => itxtText(bytes, chunk),
    ),
  };
};

const pngChunk = (type: string, data: Uint8Array | ReadonlyArray<number>): Uint8Array => {
  const body = concat([asciiBytes(type), data]);
  return concat([toBe32(data.length), body, toBe32(crc32(body))]);
};

const replacePng = (bytes: Uint8Array, changes: Changes): Result.Result<Uint8Array, WriteError> => {
  const { chunks, complete } = pngChunks(bytes);
  if (!complete) {
    return Result.fail(encodeError(bytes, "the PNG has no IEND chunk"));
  }
  const kept = chunks.filter(
    (chunk) =>
      !(chunk.type === "eXIf" && !isKeep(changes.exif)) &&
      !(isXmpChunk(bytes, chunk) && !isKeep(changes.xmp)),
  );
  const firstData = kept.findIndex((chunk) => chunk.type === "IDAT" || chunk.type === "IEND");
  const added = [
    ...Arr.fromOption(Option.map(setBytes(changes.exif), (tiff) => pngChunk("eXIf", tiff))),
    // Uncompressed, with no language or translated keyword.
    ...Arr.fromOption(
      Option.map(setBytes(changes.xmp), (xmp) =>
        pngChunk("iTXt", concat([XMP_KEYWORD, [0, 0, 0, 0], xmp])),
      ),
    ),
  ];
  const range = (chunk: Chunk) => bytes.subarray(chunk.start, chunk.dataEnd + 4);
  return Result.succeed(
    concat([
      PNG_SIGNATURE,
      ...kept.slice(0, firstData).map(range),
      ...added,
      ...kept.slice(firstData).map(range),
    ]),
  );
};

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

const findWebp = (bytes: Uint8Array): Found => {
  const chunks = webpChunks(bytes);
  const data = (type: string) =>
    Option.map(
      Option.fromUndefinedOr(chunks.find((chunk) => chunk.type === type)),
      (chunk) => chunk.data,
    );
  return { exif: data("EXIF"), xmp: Option.map(data("XMP "), Option.some) };
};

const riffChunk = ({ type, data }: RiffChunk): Uint8Array =>
  concat([asciiBytes(type), toLe32(data.length), data, data.length % 2 === 1 ? [0] : []]);

const VP8X_XMP = 0x04;
const VP8X_EXIF = 0x08;
const VP8X_ALPHA = 0x10;

// The VP8X header a simple (lossy or lossless) WebP needs before it can carry metadata.
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
  changes: Changes,
): Result.Result<Uint8Array, WriteError> => {
  const all = webpChunks(bytes);
  const keptOf = (type: string, change: Change): ReadonlyArray<RiffChunk> =>
    Change.$match(change, {
      Keep: () => all.filter((chunk) => chunk.type === type),
      Remove: () => [],
      Set: ({ bytes: data }) => [{ type, data }],
    });
  const exif = keptOf("EXIF", changes.exif);
  const xmp = keptOf("XMP ", changes.xmp);
  const hasMetadata = Arr.isReadonlyArrayNonEmpty([...exif, ...xmp]);
  const extended = Option.fromUndefinedOr(all.find((chunk) => chunk.type === "VP8X"));
  const header = hasMetadata
    ? Option.orElse(extended, () => Option.flatMap(Option.fromUndefinedOr(all[0]), vp8x))
    : extended;
  if (hasMetadata && Option.isNone(header)) {
    return Result.fail(encodeError(bytes, "the WebP has no image chunk to describe"));
  }
  const flagged = Option.map(header, ({ data }) => {
    const flags = data.slice();
    const others = (flags[0] ?? 0) & ~(VP8X_EXIF | VP8X_XMP);
    flags[0] =
      others |
      (Arr.isReadonlyArrayNonEmpty(exif) ? VP8X_EXIF : 0) |
      (Arr.isReadonlyArrayNonEmpty(xmp) ? VP8X_XMP : 0);
    return { type: "VP8X", data: flags };
  });
  const image = all.filter((chunk) => !["VP8X", "EXIF", "XMP "].includes(chunk.type));
  // Metadata follows the image data: EXIF, then XMP.
  const chunks = [...Option.toArray(flagged), ...image, ...exif, ...xmp];
  const riff = concat([asciiBytes("WEBP"), ...chunks.map(riffChunk)]);
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

const cString = (bytes: Uint8Array, at: number, end: number): readonly [string, number] => {
  const nul = bytes.indexOf(0, at);
  const stop = nul === -1 || nul >= end ? end : nul;
  return [ascii(bytes, at, stop - at), stop + 1];
};

type ItemKind = "exif" | "xmp";

// The kind of item an `infe` box describes, if it is metadata (ISO/IEC 23008-12, A.2).
const itemKind = (bytes: Uint8Array, infe: Box): Option.Option<ItemKind> => {
  const version = bytes[infe.start] ?? 0;
  if (infe.type !== "infe" || version < 2) {
    return Option.none();
  }
  const typeAt = infe.start + 4 + (version === 2 ? 2 : 4) + 2;
  const type = ascii(bytes, typeAt, 4);
  if (type === "Exif") {
    return Option.some("exif");
  }
  const [, contentTypeAt] = cString(bytes, typeAt + 4, infe.end);
  const [contentType] = cString(bytes, contentTypeAt, infe.end);
  return type === "mime" && contentType === "application/rdf+xml"
    ? Option.some("xmp")
    : Option.none();
};

// The ID of the first item of `kind` in an `iinf` box (ISO/IEC 14496-12, 8.11.6).
const itemId = (bytes: Uint8Array, iinf: Box, kind: ItemKind): Option.Option<number> => {
  const entries = (bytes[iinf.start] ?? 0) === 0 ? 6 : 8;
  return Option.fromUndefinedOr(
    boxes(bytes, iinf.start + entries, iinf.end).find((infe) =>
      Option.exists(itemKind(bytes, infe), (found) => found === kind),
    ),
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

const heifExtents = (bytes: Uint8Array, kind: ItemKind): Option.Option<ReadonlyArray<Extent>> =>
  Option.flatMap(findBox(bytes, 0, bytes.length, "meta"), (meta) =>
    Option.flatMap(childBox(bytes, meta, "iinf"), (iinf) =>
      Option.flatMap(itemId(bytes, iinf, kind), (id) =>
        Option.flatMap(childBox(bytes, meta, "iloc"), (iloc) =>
          itemExtents(bytes, iloc, childBox(bytes, meta, "idat"), id),
        ),
      ),
    ),
  );

const joined = (bytes: Uint8Array, extents: ReadonlyArray<Extent>): Uint8Array =>
  concat(extents.map(({ start, end }) => bytes.subarray(start, end)));

const findHeif = (bytes: Uint8Array): Found => ({
  exif: heifExtents(bytes, "exif").pipe(
    Option.map((extents) => joined(bytes, extents)),
    Option.flatMap(fromExifPayload),
  ),
  // A stripped item stays, blanked.
  xmp: heifExtents(bytes, "xmp").pipe(
    Option.map((extents) => joined(bytes, extents)),
    Option.filter((packet) => packet.some((byte) => byte !== 0 && byte !== 0x20)),
    Option.map(Option.some),
  ),
});

// Overwrites an item in place: HEIF locates items by absolute offset, so they
// cannot grow. `pad` fills what the new data leaves.
const overwrite = (
  out: Uint8Array,
  extents: ReadonlyArray<Extent>,
  data: Option.Option<Uint8Array>,
  pad: number,
): boolean =>
  Option.match(data, {
    onNone: () => {
      extents.forEach(({ start, end }) => out.fill(0, start, end));
      return true;
    },
    onSome: (item) => {
      const only = Option.filter(Arr.head(extents), () => extents.length === 1);
      if (Option.isNone(only) || item.length > only.value.end - only.value.start) {
        return false;
      }
      out.fill(pad, only.value.start, only.value.end);
      out.set(item, only.value.start);
      return true;
    },
  });

const replaceHeif = (
  bytes: Uint8Array,
  changes: Changes,
): Result.Result<Uint8Array, WriteError> => {
  const out = bytes.slice();
  const apply = (
    kind: ItemKind,
    change: Change,
    encode: (data: Uint8Array) => Uint8Array,
    pad: number,
  ) =>
    Change.$match(change, {
      Keep: () => Result.succeed(undefined),
      Remove: () =>
        Option.match(heifExtents(bytes, kind), {
          onNone: () => Result.succeed(undefined),
          onSome: (extents) => Result.succeed(void overwrite(out, extents, Option.none(), pad)),
        }),
      Set: ({ bytes: data }) =>
        Option.match(heifExtents(bytes, kind), {
          onNone: () =>
            Result.fail(unsupported(bytes, `adding ${kind} to a HEIF or AVIF file that has none`)),
          onSome: (extents) =>
            overwrite(out, extents, Option.some(encode(data)), pad)
              ? Result.succeed(undefined)
              : Result.fail(
                  unsupported(
                    bytes,
                    `${kind} larger than the space the HEIF or AVIF file has for it`,
                  ),
                ),
        }),
    });
  return Result.all([
    apply("exif", changes.exif, (tiff) => concat([toBe32(0), tiff]), 0),
    // XMP is padded with spaces, which XML allows after the packet.
    apply("xmp", changes.xmp, (xmp) => xmp, 0x20),
  ]).pipe(Result.map(() => out));
};

const isMetadataBox = (bytes: Uint8Array, box: Box, type: string): boolean =>
  box.type === type || (box.type === "brob" && ascii(bytes, box.start, 4) === type);

const findJxl = (bytes: Uint8Array): Found => {
  const top = boxes(bytes, 0, bytes.length);
  const find = (type: string) => Option.fromUndefinedOr(top.find((box) => box.type === type));
  const compressedXmp = top.some(
    (box) => box.type === "brob" && ascii(bytes, box.start, 4) === "xml ",
  );
  return {
    exif: Option.flatMap(find("Exif"), (box) =>
      fromExifPayload(bytes.subarray(box.start, box.end)),
    ),
    xmp: Option.match(find("xml "), {
      onNone: () => (compressedXmp ? Option.some(Option.none()) : Option.none()),
      onSome: (box) => Option.some(Option.some(bytes.subarray(box.start, box.end))),
    }),
  };
};

const metadataBoxes = (changes: Changes): ReadonlyArray<Uint8Array> => [
  ...Option.toArray(
    Option.map(setBytes(changes.exif), (tiff) =>
      concat([toBe32(8 + 4 + tiff.length), asciiBytes("Exif"), toBe32(0), tiff]),
    ),
  ),
  ...Option.toArray(
    Option.map(setBytes(changes.xmp), (xmp) =>
      concat([toBe32(8 + xmp.length), asciiBytes("xml "), xmp]),
    ),
  ),
];

// JPEG XL keeps metadata in top-level `Exif` and `xml ` boxes, or Brotli-compressed `brob` ones.
const replaceJxlContainer = (
  bytes: Uint8Array,
  changes: Changes,
): Result.Result<Uint8Array, WriteError> => {
  const kept = boxes(bytes, 0, bytes.length).filter(
    (box) =>
      !(isMetadataBox(bytes, box, "Exif") && !isKeep(changes.exif)) &&
      !(isMetadataBox(bytes, box, "xml ") && !isKeep(changes.xmp)),
  );
  // After the signature, `ftyp` and the optional `jxll` level box, which lead the file.
  const leading = kept.findIndex((box) => !["JXL ", "ftyp", "jxll"].includes(box.type));
  const split = leading === -1 ? kept.length : leading;
  const range = (box: Box) => bytes.subarray(box.at, box.end);
  return Result.succeed(
    concat([
      ...kept.slice(0, split).map(range),
      ...metadataBoxes(changes),
      ...kept.slice(split).map(range),
    ]),
  );
};

// A bare codestream has nowhere for metadata, so adding some wraps it in the container format.
const replaceJxlCodestream = (
  bytes: Uint8Array,
  changes: Changes,
): Result.Result<Uint8Array, WriteError> => {
  const added = metadataBoxes(changes);
  return Result.succeed(
    Arr.isReadonlyArrayNonEmpty(added)
      ? concat([
          JXL_SIGNATURE_BOX,
          [0, 0, 0, 0x14, ...asciiBytes("ftypjxl "), 0, 0, 0, 0, ...asciiBytes("jxl ")],
          ...added,
          toBe32(8 + bytes.length),
          asciiBytes("jxlc"),
          bytes,
        ])
      : bytes,
  );
};

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

const nothing: Found = { exif: Option.none(), xmp: Option.none() };

const finders = {
  jpeg: findJpeg,
  png: findPng,
  webp: findWebp,
  // TIFF's XMP is a tag of its first directory, inside the EXIF structure.
  tiff: (bytes) => ({ exif: Option.some(bytes), xmp: Option.none() }),
  isobmff: findHeif,
  "jxl-container": findJxl,
  "jxl-codestream": () => nothing,
} satisfies Record<Container, (bytes: Uint8Array) => Found>;

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
  (bytes: Uint8Array, changes: Changes) => Result.Result<Uint8Array, WriteError>
>;

/** The EXIF and XMP metadata of an image file. */
export const find = (bytes: Uint8Array): Found =>
  Option.match(containerOf(bytes), {
    onNone: () => nothing,
    onSome: (container) => finders[container](bytes),
  });

/** Applies changes to an image file's metadata. */
export const replace = (
  bytes: Uint8Array,
  changes: Changes,
): Result.Result<Uint8Array, WriteError> =>
  isKeep(changes.exif) && isKeep(changes.xmp)
    ? Result.succeed(bytes)
    : Option.match(containerOf(bytes), {
        onNone: () =>
          Result.fail(
            new UnsupportedFormat({ backend: "core", ...mediaTypeOf(bytes), direction: "encode" }),
          ),
        onSome: (container) => replacers[container](bytes, changes),
      });
