// Regenerates the committed fixtures with sharp: `vp run fixtures` here. The
// outputs are committed so that every backend tests against the same bytes.
import { writeFile } from "node:fs/promises";
import sharp, { type Sharp } from "sharp";

const out = (file: string) => new URL(`../fixtures/${file}`, import.meta.url);

// A synthetic "photo": smooth gradients for resampling, hard edges and circles
// for detail, so lossy codecs and filters both have something to chew on.
const scene = (width: number, height: number, transparent: boolean) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d4e89"/><stop offset="0.6" stop-color="#f4a259"/><stop offset="1" stop-color="#f6d8ae"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#sky)" ${transparent ? 'fill-opacity="0.75"' : ""}/>
  <circle cx="300" cy="300" r="160" fill="#bc4b51"/>
  <circle cx="820" cy="420" r="220" fill="#5b8e7d" fill-opacity="0.8"/>
  <rect x="80" y="600" width="1040" height="120" fill="#2e2e3a"/>
  ${Array.from({ length: 24 }, (_, i) => `<rect x="${100 + i * 42}" y="620" width="20" height="80" fill="#f4e285"/>`).join("")}
</svg>`;

const photo = sharp(Buffer.from(scene(1200, 800, false)));
await writeFile(out("photo.jpg"), await photo.clone().jpeg({ quality: 85 }).toBuffer());

const small = sharp(Buffer.from(scene(120, 80, true)));
await writeFile(out("small.png"), await small.clone().png().toBuffer());
await writeFile(out("small.webp"), await small.clone().webp({ lossless: true }).toBuffer());
await writeFile(out("small.avif"), await small.clone().avif({ quality: 70 }).toBuffer());

// The resampling reference: sharp's lanczos3 downscale of the decoded photo.
const decoded = await sharp(out("photo.jpg").pathname)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
await writeFile(
  out("photo-300x200-lanczos3.png"),
  await sharp(decoded.data, {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
  })
    .resize(300, 200, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer(),
);

// Orientation fixtures: upright, the quadrants are red, green / blue, white.
// Each file stores the pixels that its EXIF orientation turns upright.
const upright = Buffer.from(
  Array.from({ length: 32 * 64 }, (_, i) => {
    const x = i % 64;
    const y = Math.floor(i / 64);
    return x < 32 ? (y < 16 ? [255, 0, 0] : [0, 0, 255]) : y < 16 ? [0, 255, 0] : [255, 255, 255];
  }).flat(),
);
const raw = (data: Buffer, width: number, height: number) =>
  sharp(data, { raw: { width, height, channels: 3 } });
const step = async (
  image: { data: Buffer; width: number; height: number },
  op: (s: Sharp) => Sharp,
) => {
  const { data, info } = await op(raw(image.data, image.width, image.height))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
// The inverse of the display transform for each orientation.
const toStored: ReadonlyArray<readonly [number, ReadonlyArray<(s: Sharp) => Sharp>]> = [
  [1, []],
  [2, [(s) => s.flop()]],
  [3, [(s) => s.rotate(180)]],
  [4, [(s) => s.flip()]],
  [5, [(s) => s.flop(), (s) => s.rotate(270)]],
  [6, [(s) => s.rotate(270)]],
  [7, [(s) => s.flop(), (s) => s.rotate(90)]],
  [8, [(s) => s.rotate(90)]],
];
for (const [orientation, ops] of toStored) {
  let image = { data: upright, width: 64, height: 32 };
  for (const op of ops) {
    image = await step(image, op);
  }
  const jpeg = await raw(image.data, image.width, image.height)
    .withMetadata({ orientation })
    .jpeg({ quality: 95 })
    .toBuffer();
  await writeFile(out(`orientation-${orientation}.jpg`), jpeg);
}
