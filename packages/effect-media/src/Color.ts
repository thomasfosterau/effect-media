/**
 * Colours tagged with their colour space, with conversions and CSS parsing.
 * Conversions follow CSS Color 4: sRGB and Display P3 share the sRGB transfer
 * curve, and Oklab and Oklch are Björn Ottosson's perceptual spaces.
 */
import * as Arr from "effect/Array";
import { dual } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The colour spaces a {@link Color} can be expressed in. The RGB spaces use
 * channels in `[0, 1]` (values outside are out of gamut); Oklab uses
 * lightness in `[0, 1]`; Oklch uses lightness, chroma and hue in degrees.
 */
export const ColorSpace = Schema.Literals(["srgb", "srgb-linear", "display-p3", "oklab", "oklch"]);
export type ColorSpace = typeof ColorSpace.Type;

const Channel = Schema.Finite;

/** A colour: three channels in a colour space, plus straight (unpremultiplied) alpha in `[0, 1]`. */
export class Color extends Schema.Class<Color, { readonly brand: unique symbol }>(
  "effect-media/Color",
)({
  space: ColorSpace,
  coords: Schema.Tuple([Channel, Channel, Channel]),
  alpha: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
}) {}

/** Raised by {@link parse} when a string is not a supported CSS colour. */
export class ColorParseError extends Schema.TaggedError<
  ColorParseError,
  { readonly brand: unique symbol }
>()("ColorParseError", {
  input: Schema.String,
}) {
  override get message(): string {
    return `Not a supported CSS colour: "${this.input}"`;
  }
}

type Triple = readonly [number, number, number];

/** Creates a colour in any space. */
export const make = (space: ColorSpace, coords: Triple, alpha = 1): Color =>
  new Color({ space, coords: [coords[0], coords[1], coords[2]], alpha });

/** An sRGB colour with channels in `[0, 1]`. */
export const srgb = (r: number, g: number, b: number, alpha = 1): Color =>
  make("srgb", [r, g, b], alpha);

/** An sRGB colour from 8-bit channels in `[0, 255]`; alpha stays in `[0, 1]`. */
export const rgb8 = (r: number, g: number, b: number, alpha = 1): Color =>
  srgb(r / 255, g / 255, b / 255, alpha);

/** An Oklch colour: lightness in `[0, 1]`, chroma (about `[0, 0.4]`), hue in degrees. */
export const oklch = (l: number, c: number, h: number, alpha = 1): Color =>
  make("oklch", [l, c, h], alpha);

/** Opaque black. */
export const black: Color = srgb(0, 0, 0);
/** Opaque white. */
export const white: Color = srgb(1, 1, 1);
/** Fully transparent black. */
export const transparent: Color = srgb(0, 0, 0, 0);

// --- transfer curves and matrices -------------------------------------------

// Sign-preserving, so out-of-gamut (negative) channels round-trip.
const decodeGamma = (c: number): number => {
  const abs = Math.abs(c);
  return abs <= 0.04045 ? c / 12.92 : Math.sign(c) * ((abs + 0.055) / 1.055) ** 2.4;
};

const encodeGamma = (c: number): number => {
  const abs = Math.abs(c);
  return abs <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * abs ** (1 / 2.4) - 0.055);
};

type Matrix3 = readonly [Triple, Triple, Triple];

const apply = (m: Matrix3, v: Triple): Triple => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

// Linear Display P3 <-> linear sRGB, through CIE XYZ (D65).
const P3_TO_SRGB: Matrix3 = [
  [1.22494017628056, -0.22494017628056, 0],
  [-0.0420569547096882, 1.04205695470969, 0],
  [-0.0196375545903344, -0.0786360455506318, 1.09827360014097],
];
const SRGB_TO_P3: Matrix3 = [
  [0.822461968714362, 0.177538031285638, 0],
  [0.033194198850267, 0.966805801149733, 0],
  [0.017082630964541, 0.072397440874433, 0.910519928161026],
];

// Linear sRGB <-> LMS and LMS' <-> Oklab (https://bottosson.github.io/posts/oklab/).
const SRGB_TO_LMS: Matrix3 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_TO_OKLAB: Matrix3 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
const OKLAB_TO_LMS: Matrix3 = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LMS_TO_SRGB: Matrix3 = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

const map3 = (v: Triple, f: (c: number) => number): Triple => [f(v[0]), f(v[1]), f(v[2])];

const oklabToOklch = ([l, a, b]: Triple): Triple => {
  const c = Math.hypot(a, b);
  // Achromatic colours have no meaningful hue; CSS treats it as 0.
  const h = c < 1e-7 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [l, c, h];
};

const oklchToOklab = ([l, c, h]: Triple): Triple => {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
};

type Conversion = (coords: Triple) => Triple;

const oklabToLinearSrgb: Conversion = (lab) =>
  apply(
    LMS_TO_SRGB,
    map3(apply(OKLAB_TO_LMS, lab), (c) => c ** 3),
  );
const linearSrgbToOklab: Conversion = (rgb) =>
  apply(LMS_TO_OKLAB, map3(apply(SRGB_TO_LMS, rgb), Math.cbrt));

// Every space converts through linear sRGB.
const toLinearSrgb = {
  srgb: (c) => map3(c, decodeGamma),
  "srgb-linear": (c) => c,
  "display-p3": (c) => apply(P3_TO_SRGB, map3(c, decodeGamma)),
  oklab: oklabToLinearSrgb,
  oklch: (c) => oklabToLinearSrgb(oklchToOklab(c)),
} satisfies Record<ColorSpace, Conversion>;

const fromLinearSrgb = {
  srgb: (c) => map3(c, encodeGamma),
  "srgb-linear": (c) => c,
  "display-p3": (c) => map3(apply(SRGB_TO_P3, c), encodeGamma),
  oklab: linearSrgbToOklab,
  oklch: (c) => oklabToOklch(linearSrgbToOklab(c)),
} satisfies Record<ColorSpace, Conversion>;

/** Expresses a colour in another colour space. Out-of-gamut values are kept, not clipped. */
export const convert: {
  (space: ColorSpace): (self: Color) => Color;
  (self: Color, space: ColorSpace): Color;
} = dual(2, (self: Color, space: ColorSpace): Color => {
  if (self.space === space) {
    return self;
  }
  // Oklab and Oklch are the same space in polar form: skip the round trip.
  if (self.space === "oklab" && space === "oklch") {
    return make(space, oklabToOklch(self.coords), self.alpha);
  }
  if (self.space === "oklch" && space === "oklab") {
    return make(space, oklchToOklab(self.coords), self.alpha);
  }
  return make(space, fromLinearSrgb[space](toLinearSrgb[self.space](self.coords)), self.alpha);
});

/** The RGB colour spaces, whose channels have a `[0, 1]` gamut. */
export type RgbSpace = "srgb" | "srgb-linear" | "display-p3";

const GAMUT_EPSILON = 1e-6;

/**
 * Whether a colour fits the gamut of an RGB space (`srgb` by default), within a
 * small tolerance for rounding.
 */
export const inGamut: {
  (space?: RgbSpace): (self: Color) => boolean;
  (self: Color, space?: RgbSpace): boolean;
} = dual(
  (args) => args[0] instanceof Color,
  (self: Color, space: RgbSpace = "srgb"): boolean =>
    convert(self, space).coords.every((c) => c >= -GAMUT_EPSILON && c <= 1 + GAMUT_EPSILON),
);

const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));
const toByte = (c: number): number => Math.round(clamp01(c) * 255);

/** The colour as 8-bit sRGB `[r, g, b, a]`, clipping anything out of gamut. */
export const toRgba8 = (self: Color): readonly [number, number, number, number] => {
  const [r, g, b] = convert(self, "srgb").coords;
  return [toByte(r), toByte(g), toByte(b), toByte(self.alpha)];
};

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

/** The colour as `#rrggbb`, or `#rrggbbaa` when not opaque, clipped to sRGB. */
export const toHex = (self: Color): string => {
  const [r, g, b, a] = toRgba8(self);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a === 255 ? "" : hex2(a)}`;
};

const formatNumber = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** The colour as a CSS Color 4 string in its own space, such as `oklch(0.7 0.1 250)`. */
export const format = (self: Color): string => {
  const channels = self.coords.map(formatNumber).join(" ");
  const alpha = self.alpha === 1 ? "" : ` / ${formatNumber(self.alpha)}`;
  return self.space === "oklab" || self.space === "oklch"
    ? `${self.space}(${channels}${alpha})`
    : `color(${self.space} ${channels}${alpha})`;
};

// --- parsing -----------------------------------------------------------------

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION = /^([a-z-]+)\(\s*(.*?)\s*\)$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(%|deg)?$/i;

const KEYWORDS = { black, white, transparent } satisfies Record<string, Color>;

const parseHex = (digits: string): Color => {
  const full = digits.length <= 4 ? Array.from(digits, (d) => d + d).join("") : digits;
  const byte = (i: number): number => Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
  return rgb8(byte(0), byte(1), byte(2), full.length === 8 ? byte(3) / 255 : 1);
};

// A CSS number or percentage; `percent` is what 100% means for this channel.
const parseValue = (token: string, percent: number): Option.Option<number> =>
  Option.map(Option.fromNullishOr(NUMBER.exec(token)), (match) => {
    const value = Number.parseFloat(token);
    return match[1] === "%" ? (value / 100) * percent : value;
  });

const parseTriple = (tokens: ReadonlyArray<string>, scales: Triple): Option.Option<Triple> => {
  const [a, b, c, ...extra] = tokens;
  if (a === undefined || b === undefined || c === undefined || Arr.isReadonlyArrayNonEmpty(extra)) {
    return Option.none();
  }
  return Option.all([
    parseValue(a, scales[0]),
    parseValue(b, scales[1]),
    parseValue(c.replace(/deg$/i, ""), scales[2]),
  ]);
};

interface Arguments {
  readonly channels: ReadonlyArray<string>;
  readonly alpha: number;
}

// Splits `a b c / d` or `a, b, c, d` into channel tokens and alpha.
const parseArguments = (body: string): Option.Option<Arguments> => {
  const [main = "", alphaToken, ...extra] = body.split("/").map((s) => s.trim());
  if (Arr.isReadonlyArrayNonEmpty(extra)) {
    return Option.none();
  }
  const tokens = main.includes(",") ? main.split(",").map((s) => s.trim()) : main.split(/\s+/);
  const legacyAlpha = alphaToken === undefined && tokens.length === 4;
  const channels = legacyAlpha ? tokens.slice(0, 3) : tokens;
  const alphaText = legacyAlpha ? tokens[3] : alphaToken;
  const alpha = alphaText === undefined ? Option.some(1) : parseValue(alphaText, 1);
  return alpha.pipe(
    Option.filter((a) => a >= 0 && a <= 1),
    Option.map((a): Arguments => ({ channels, alpha: a })),
  );
};

const isRgbSpace = Schema.is(Schema.Literals(["srgb", "srgb-linear", "display-p3"]));

// Each CSS colour function: channel scales for percentages, and the constructor.
const FUNCTIONS = {
  rgb: (args: Arguments) =>
    Option.map(parseTriple(args.channels, [255, 255, 255]), ([r, g, b]) =>
      rgb8(r, g, b, args.alpha),
    ),
  oklab: (args: Arguments) =>
    Option.map(parseTriple(args.channels, [1, 0.4, 0.4]), (c) => make("oklab", c, args.alpha)),
  oklch: (args: Arguments) =>
    Option.map(parseTriple(args.channels, [1, 0.4, 360]), (c) => make("oklch", c, args.alpha)),
  color: (args: Arguments) => {
    const [space, ...rest] = args.channels;
    return isRgbSpace(space)
      ? Option.map(parseTriple(rest, [1, 1, 1]), (c) => make(space, c, args.alpha))
      : Option.none();
  },
} satisfies Record<string, (args: Arguments) => Option.Option<Color>>;

const isFunctionName = Schema.is(Schema.Literals(["rgb", "oklab", "oklch", "color"]));
const isKeyword = Schema.is(Schema.Literals(["black", "white", "transparent"]));

const parseFunction = (name: string, body: string): Option.Option<Color> => {
  const key = name.toLowerCase() === "rgba" ? "rgb" : name.toLowerCase();
  return isFunctionName(key) ? Option.flatMap(parseArguments(body), FUNCTIONS[key]) : Option.none();
};

/**
 * Parses a CSS colour: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`
 * and `rgba()`, `oklab()`, `oklch()`, `color(srgb | srgb-linear | display-p3 …)`,
 * and the keywords `black`, `white` and `transparent`.
 */
export const parse = (input: string): Result.Result<Color, ColorParseError> => {
  const text = input.trim();
  const keyword = text.toLowerCase();
  const hex = HEX.exec(text)?.[1];
  const fn = FUNCTION.exec(text);
  const parsed = isKeyword(keyword)
    ? Option.some(KEYWORDS[keyword])
    : hex !== undefined
      ? Option.some(parseHex(hex))
      : fn?.[1] !== undefined
        ? parseFunction(fn[1], fn[2] ?? "")
        : Option.none();
  return Result.fromOption(parsed, () => new ColorParseError({ input }));
};
