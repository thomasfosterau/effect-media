// Byte-level helpers shared by the metadata parsers and writers. Reads past the
// end of a buffer give 0, so callers bounds-check only where it matters.
import * as Option from "effect/Option";

const fromCharCodes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

export const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  fromCharCodes(bytes.subarray(at, at + length));

export const asciiBytes = (text: string): Array<number> => Array.from(text, (c) => c.charCodeAt(0));

export const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);

export const be16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

export const be32 = (bytes: Uint8Array, at: number): number =>
  be16(bytes, at) * 0x1_0000 + be16(bytes, at + 2);

export const be64 = (bytes: Uint8Array, at: number): number =>
  be32(bytes, at) * 0x1_0000_0000 + be32(bytes, at + 4);

export const le16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

export const le32 = (bytes: Uint8Array, at: number): number =>
  le16(bytes, at) + le16(bytes, at + 2) * 0x1_0000;

const toBe16 = (n: number): Array<number> => [(n >>> 8) & 0xff, n & 0xff];

export const toBe32 = (n: number): Array<number> => [...toBe16(n >>> 16), ...toBe16(n & 0xffff)];

export const toLe24 = (n: number): Array<number> => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];

export const toLe32 = (n: number): Array<number> => [...toLe24(n), (n >>> 24) & 0xff];

export const concat = (parts: ReadonlyArray<Uint8Array | ReadonlyArray<number>>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((offset, part) => {
    joined.set(part, offset);
    return offset + part.length;
  }, 0);
  return joined;
};

const decodeUtf8 = Option.liftThrowable((bytes: Uint8Array) =>
  decodeURIComponent(
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
  ),
);

/** UTF-8 text, or Latin-1 when the bytes are not valid UTF-8. */
export const decodeText = (bytes: Uint8Array): string =>
  bytes.every((byte) => byte < 0x80)
    ? fromCharCodes(bytes)
    : Option.getOrElse(decodeUtf8(bytes), () => fromCharCodes(bytes));

const PERCENT_ESCAPE = /%([0-9A-F]{2})|[^%]/g;

/** The UTF-8 bytes of a string; lone surrogates, which cannot be encoded, become `?`. */
export const encodeText = (text: string): Array<number> => {
  const wellFormed = text.replace(/[\uD800-\uDFFF]/g, (c, at: number) => {
    const code = c.charCodeAt(0);
    const pair = code < 0xdc00 ? text.charCodeAt(at + 1) : text.charCodeAt(at - 1);
    const isPaired =
      code < 0xdc00 ? pair >= 0xdc00 && pair <= 0xdfff : pair >= 0xd800 && pair < 0xdc00;
    return isPaired ? c : "?";
  });
  return Array.from(encodeURIComponent(wellFormed).matchAll(PERCENT_ESCAPE), ([match, hex]) =>
    hex === undefined ? match.charCodeAt(0) : Number.parseInt(hex, 16),
  );
};

// The CRC-32 that PNG chunks carry (ISO 3309, as in zlib).
const CRC_TABLE: ReadonlyArray<number> = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
);

export const crc32 = (bytes: Uint8Array): number =>
  (bytes.reduce((crc, byte) => (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8), 0xffffffff) ^
    0xffffffff) >>>
  0;
