/**
 * Media types (MIME types) for images, audio and video, with file-extension
 * lookup and content sniffing from the first bytes of a file.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A media type such as `image/png`, lower-cased and without parameters. */
export const MediaType = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)),
  Schema.brand("effect-media/MediaType"),
);
export type MediaType = typeof MediaType.Type;

/** Image formats the library knows by name. Which ones decode or encode depends on the backend. */
export const ImageFormat = Schema.Literals([
  "avif",
  "bmp",
  "gif",
  "heif",
  "jpeg",
  "jxl",
  "png",
  "svg",
  "tiff",
  "webp",
]);
export type ImageFormat = typeof ImageFormat.Type;

// Validated once, at module load.
const known = (value: string): MediaType => MediaType.make(value);

/** The media type of each {@link ImageFormat}. */
export const imageFormatMediaType = {
  avif: known("image/avif"),
  bmp: known("image/bmp"),
  gif: known("image/gif"),
  heif: known("image/heif"),
  jpeg: known("image/jpeg"),
  jxl: known("image/jxl"),
  png: known("image/png"),
  svg: known("image/svg+xml"),
  tiff: known("image/tiff"),
  webp: known("image/webp"),
} as const satisfies Record<ImageFormat, MediaType>;

const extensions: ReadonlyArray<readonly [string, MediaType]> = [
  ["avif", imageFormatMediaType.avif],
  ["bmp", imageFormatMediaType.bmp],
  ["gif", imageFormatMediaType.gif],
  ["heic", imageFormatMediaType.heif],
  ["heif", imageFormatMediaType.heif],
  ["jpeg", imageFormatMediaType.jpeg],
  ["jpg", imageFormatMediaType.jpeg],
  ["jxl", imageFormatMediaType.jxl],
  ["png", imageFormatMediaType.png],
  ["svg", imageFormatMediaType.svg],
  ["tif", imageFormatMediaType.tiff],
  ["tiff", imageFormatMediaType.tiff],
  ["webp", imageFormatMediaType.webp],
  ["flac", known("audio/flac")],
  ["mp3", known("audio/mpeg")],
  ["m4a", known("audio/mp4")],
  ["oga", known("audio/ogg")],
  ["ogg", known("audio/ogg")],
  ["opus", known("audio/opus")],
  ["wav", known("audio/wav")],
  ["mov", known("video/quicktime")],
  ["mp4", known("video/mp4")],
  ["ogv", known("video/ogg")],
  ["webm", known("video/webm")],
];

/**
 * Validates and normalises a media type string: lower-cases it and drops
 * parameters such as `; charset=utf-8`.
 */
export const parse = (input: string): Option.Option<MediaType> => {
  const essence = (input.split(";")[0] ?? "").trim().toLowerCase();
  return Schema.is(MediaType)(essence) ? Option.some(essence) : Option.none();
};

/** The media type for a file extension or file name, such as `jpg` or `photo.JPG`. */
export const fromExtension = (fileNameOrExtension: string): Option.Option<MediaType> => {
  const extension = (fileNameOrExtension.split(".").pop() ?? "").toLowerCase();
  const found = extensions.find(([ext]) => ext === extension);
  return found === undefined ? Option.none() : Option.some(found[1]);
};

/** The usual file extension for a media type, without the dot. */
export const toExtension = (mediaType: MediaType): Option.Option<string> => {
  const found = extensions.find(([, type]) => type === mediaType);
  return found === undefined ? Option.none() : Option.some(found[0]);
};

/** The {@link ImageFormat} of a media type, if it is one the library knows. */
export const toImageFormat = (mediaType: MediaType): Option.Option<ImageFormat> => {
  const found = ImageFormat.literals.find((format) => imageFormatMediaType[format] === mediaType);
  return found === undefined ? Option.none() : Option.some(found);
};

/** Whether a media type is an image, audio or video type. */
export const kind = (mediaType: MediaType): "image" | "audio" | "video" | "other" => {
  const top = mediaType.slice(0, mediaType.indexOf("/"));
  return top === "image" || top === "audio" || top === "video" ? top : "other";
};

// --- sniffing ------------------------------------------------------------------

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

// ISO base media file brands (the `ftyp` box) that identify still images.
const AVIF_BRANDS: ReadonlyArray<string> = ["avif", "avis"];
const HEIF_BRANDS: ReadonlyArray<string> = ["heic", "heix", "heim", "heis", "mif1", "msf1"];

// Major brands of non-image ISO files that are not plain MP4 video.
const MAJOR_BRANDS: ReadonlyArray<readonly [string, MediaType]> = [
  ["qt  ", known("video/quicktime")],
  ["M4A ", known("audio/mp4")],
];

const sniffIsoBmff = (bytes: Uint8Array): Option.Option<MediaType> => {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") {
    return Option.none();
  }
  const boxSize = Math.min(
    bytes.length,
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
  );
  // The major brand, then the compatible brands after the 4-byte minor version.
  const compatible = Arr.makeBy(Math.max(0, Math.floor((boxSize - 16) / 4)), (i) =>
    ascii(bytes, 16 + i * 4, 4),
  );
  const major = ascii(bytes, 8, 4);
  const brands = [major, ...compatible];
  const hasBrand = (list: ReadonlyArray<string>) => brands.some((brand) => list.includes(brand));
  if (hasBrand(AVIF_BRANDS)) return Option.some(imageFormatMediaType.avif);
  if (hasBrand(HEIF_BRANDS)) return Option.some(imageFormatMediaType.heif);
  return Arr.findFirst(MAJOR_BRANDS, ([brand]) => brand === major).pipe(
    Option.map(([, mediaType]) => mediaType),
    Option.orElseSome(() => known("video/mp4")),
  );
};

const sniffText = (bytes: Uint8Array): Option.Option<MediaType> => {
  // An SVG may start with a byte order mark, an XML declaration, comments or a doctype.
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024))
    .replace(BYTE_ORDER_MARK, "")
    .trimStart();
  return head.startsWith("<") && /<svg[\s>]/i.test(head)
    ? Option.some(imageFormatMediaType.svg)
    : Option.none();
};

// UTF-8's byte order mark, read byte by byte as Latin-1 characters by `ascii`.
const BYTE_ORDER_MARK = new RegExp("^\\u00EF\\u00BB\\u00BF");

const bytesAt =
  (signature: ReadonlyArray<number>) =>
  (bytes: Uint8Array): boolean =>
    startsWith(bytes, signature);

const textAt =
  (text: string, offset = 0) =>
  (bytes: Uint8Array): boolean =>
    ascii(bytes, offset, text.length) === text;

const riff = (form: string) => (bytes: Uint8Array) =>
  textAt("RIFF")(bytes) && textAt(form, 8)(bytes);

// Fixed signatures, checked in order. Each pairs a test of the first bytes with
// the media type it identifies.
const SIGNATURES: ReadonlyArray<readonly [(bytes: Uint8Array) => boolean, MediaType]> = [
  [bytesAt([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), imageFormatMediaType.png],
  [bytesAt([0xff, 0xd8, 0xff]), imageFormatMediaType.jpeg],
  [textAt("GIF87a"), imageFormatMediaType.gif],
  [textAt("GIF89a"), imageFormatMediaType.gif],
  [riff("WEBP"), imageFormatMediaType.webp],
  [bytesAt([0x49, 0x49, 0x2a, 0x00]), imageFormatMediaType.tiff],
  [bytesAt([0x4d, 0x4d, 0x00, 0x2a]), imageFormatMediaType.tiff],
  [(bytes) => textAt("BM")(bytes) && bytes.length >= 14, imageFormatMediaType.bmp],
  [bytesAt([0xff, 0x0a]), imageFormatMediaType.jxl],
  [
    bytesAt([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    imageFormatMediaType.jxl,
  ],
  [riff("WAVE"), known("audio/wav")],
  [textAt("fLaC"), known("audio/flac")],
  [textAt("OggS"), known("audio/ogg")],
  [textAt("ID3"), known("audio/mpeg")],
  [bytesAt([0xff, 0xfb]), known("audio/mpeg")],
  [bytesAt([0xff, 0xf3]), known("audio/mpeg")],
  // Matroska's EBML header; WebM is by far its most common use on the web.
  [bytesAt([0x1a, 0x45, 0xdf, 0xa3]), known("video/webm")],
];

/**
 * Identifies a media type from a file's first bytes (its "magic number"). Pass
 * at least the first 32 bytes; for SVG, up to the first kilobyte helps.
 */
export const sniff = (bytes: Uint8Array): Option.Option<MediaType> =>
  Arr.findFirst(SIGNATURES, ([matches]) => matches(bytes)).pipe(
    Option.map(([, mediaType]) => mediaType),
    Option.orElse(() => sniffIsoBmff(bytes)),
    Option.orElse(() => sniffText(bytes)),
  );
