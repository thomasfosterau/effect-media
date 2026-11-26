/**
 * Reads, edits and writes EXIF metadata in plain TypeScript, so that every
 * backend and runtime sees the same tags, and strips EXIF and XMP for privacy.
 * Reading is lenient: a malformed entry is skipped rather than failing the
 * whole read.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import { dual } from "effect/Function";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as Containers from "./internal/containers.ts";
import * as Tiff from "./internal/tiff.ts";
import * as Xmp from "./internal/xmp.ts";

/**
 * The image file directories EXIF data is grouped into: `ifd0` describes the
 * main image, `exif` the capture, `gps` the location, `interop` compatibility
 * details and `ifd1` the embedded thumbnail.
 */
export type Directory = Tiff.Directory;

/** A TIFF rational, kept as stored. */
export type Rational = Tiff.Rational;

/** The TIFF field types that hold numbers: unsigned and signed integers of 8, 16 and 32 bits, and floats. */
export type NumberType = Tiff.NumberType;

/**
 * A tag's value, by TIFF field type: text (ASCII), numbers, rationals, or
 * opaque bytes (UNDEFINED). Numbers and rationals keep their stored type, so
 * that writing them back produces the same field.
 */
export type Value = Tiff.Value;

/** Constructors, guards and matching for {@link Value}. */
export const Value = Tiff.Value;

/** The tags of one directory, by tag number. */
export type Tags = Tiff.Tags;

/** The EXIF data of an image: every readable tag, by directory, and the thumbnail if there is one. */
export class Exif extends Data.Class<{
  readonly littleEndian: boolean;
  /** Offsets between directories, and to the thumbnail, are left out and recomputed on writing. */
  readonly directories: HashMap.HashMap<Directory, Tags>;
  /** The JPEG thumbnail stored with `ifd1`. */
  readonly thumbnail: Option.Option<Uint8Array>;
}> {}

/** Any error writing EXIF to a file can fail with. */
export type WriteError = Containers.WriteError;

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

// --- reading and writing -------------------------------------------------------

/**
 * Reads a TIFF-structured EXIF payload: the contents of a JPEG APP1 segment,
 * a PNG `eXIf` chunk or a HEIF `Exif` item, with or without its `Exif\0\0`
 * header. Use it for EXIF a backend hands over as bytes, such as sharp's
 * `metadata().exif`; {@link read} finds the payload in an image file.
 */
export const fromTiff = (bytes: Uint8Array): Option.Option<Exif> =>
  Option.map(Tiff.parse(bytes), (contents) => new Exif(contents));

/** Writes EXIF as a TIFF structure, without the `Exif\0\0` header: the inverse of {@link fromTiff}. */
export const toTiff = (self: Exif): Uint8Array => Tiff.serialize(self);

/**
 * Finds and reads the EXIF data in an image file: JPEG, PNG, WebP, TIFF, HEIF,
 * AVIF or JPEG XL. `None` when the file has none or the format is not one of these.
 */
export const read = (bytes: Uint8Array): Option.Option<Exif> =>
  Option.flatMap(Containers.find(bytes).exif, fromTiff);

/**
 * Replaces the EXIF data of an image file, or adds it, without re-encoding the
 * image. Works for JPEG, PNG, WebP and JPEG XL. HEIF and AVIF are overwritten in
 * place, so the new data must fit where the old was; TIFF is not supported.
 *
 * Offsets inside a camera's maker note are not rewritten, so some maker notes
 * no longer parse after a write.
 */
export const write: {
  (exif: Exif): (bytes: Uint8Array) => Result.Result<Uint8Array, WriteError>;
  (bytes: Uint8Array, exif: Exif): Result.Result<Uint8Array, WriteError>;
} = dual(2, (bytes: Uint8Array, exif: Exif) =>
  Containers.replace(bytes, {
    exif: Containers.Change.Set({ bytes: toTiff(exif) }),
    xmp: Containers.Change.Keep(),
  }),
);

const removeIfFound = (found: Option.Option<unknown>): Containers.Change =>
  Option.isSome(found) ? Containers.Change.Remove() : Containers.Change.Keep();

/**
 * Removes the EXIF and XMP metadata from an image file, without re-encoding
 * the image. HEIF and AVIF keep the space, blanked. Unchanged when there is none.
 */
export const strip = (bytes: Uint8Array): Result.Result<Uint8Array, WriteError> => {
  const found = Containers.find(bytes);
  return Containers.replace(bytes, {
    exif: removeIfFound(found.exif),
    xmp: removeIfFound(found.xmp),
  });
};

/**
 * Removes where an image was taken and keeps its other metadata: the GPS
 * directory of its EXIF, and the GPS, city, state, country and IPTC location
 * properties of its XMP. An XMP packet that cannot be edited safely, such as a
 * compressed one, is removed whole. Unchanged when there is no location.
 */
export const stripLocation = (bytes: Uint8Array): Result.Result<Uint8Array, WriteError> => {
  const found = Containers.find(bytes);
  const exif = Option.match(
    Option.filter(Option.flatMap(found.exif, fromTiff), (e) => HashMap.has(e.directories, "gps")),
    {
      onNone: () => Containers.Change.Keep(),
      onSome: (e) => Containers.Change.Set({ bytes: toTiff(removeDirectory(e, "gps")) }),
    },
  );
  const xmp = Option.match(found.xmp, {
    onNone: () => Containers.Change.Keep(),
    onSome: (packet) =>
      Option.match(Option.flatMap(packet, Xmp.withoutLocation), {
        onNone: () => Containers.Change.Remove(),
        onSome: (edited) =>
          Option.exists(packet, (original) => original === edited)
            ? Containers.Change.Keep()
            : Containers.Change.Set({ bytes: edited }),
      }),
  });
  return Containers.replace(bytes, { exif, xmp });
};

// --- editing -------------------------------------------------------------------

const modifyTags = (self: Exif, directory: Directory, f: (tags: Tags) => Tags): Exif =>
  new Exif({
    littleEndian: self.littleEndian,
    thumbnail: self.thumbnail,
    directories: HashMap.set(
      self.directories,
      directory,
      f(Option.getOrElse(HashMap.get(self.directories, directory), () => HashMap.empty())),
    ),
  });

/** Sets a tag, adding its directory if it has none. */
export const set: {
  (directory: Directory, tag: number, value: Value): (self: Exif) => Exif;
  (self: Exif, directory: Directory, tag: number, value: Value): Exif;
} = dual(4, (self: Exif, directory: Directory, tag: number, value: Value) =>
  modifyTags(self, directory, HashMap.set(tag, value)),
);

/** Removes a tag. */
export const remove: {
  (directory: Directory, tag: number): (self: Exif) => Exif;
  (self: Exif, directory: Directory, tag: number): Exif;
} = dual(3, (self: Exif, directory: Directory, tag: number) =>
  HashMap.has(self.directories, directory)
    ? modifyTags(self, directory, HashMap.remove(tag))
    : self,
);

/**
 * Removes a whole directory, such as `gps` to drop the location. Removing
 * `exif` removes `interop` too, and removing `ifd1` removes the thumbnail.
 */
export const removeDirectory: {
  (directory: Directory): (self: Exif) => Exif;
  (self: Exif, directory: Directory): Exif;
} = dual(2, (self: Exif, directory: Directory) => {
  const dropped: ReadonlyArray<Directory> =
    directory === "exif" ? ["exif", "interop"] : [directory];
  return new Exif({
    littleEndian: self.littleEndian,
    directories: HashMap.removeMany(self.directories, dropped),
    thumbnail: directory === "ifd1" ? Option.none() : self.thumbnail,
  });
});

/**
 * Records a new orientation, such as 1 after the pixels have been turned
 * upright, so that viewers do not turn them again.
 */
export const withOrientation: {
  (orientation: Orientation): (self: Exif) => Exif;
  (self: Exif, orientation: Orientation): Exif;
} = dual(2, (self: Exif, orientation: Orientation) =>
  set(self, "ifd0", Tag.Orientation, Value.Numbers({ type: "short", values: [orientation] })),
);

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
