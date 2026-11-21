/** Colours tagged with their colour space, with conversions and CSS parsing. */
export * as Color from "./Color.ts";

/** Encoded images: file bytes and their media type. */
export * as Encoded from "./Encoded.ts";

/** Two-dimensional points, sizes, rectangles and affine transforms. */
export * as Geometry from "./Geometry.ts";

/** Decode, transform and encode images with the provided backend. */
export * as Image from "./Image.ts";

/** The service an image engine provides. */
export * as ImageBackend from "./ImageBackend.ts";

/** The typed errors every backend reports. */
export * as MediaError from "./MediaError.ts";

/** Media types, file-extension lookup and content sniffing. */
export * as MediaType from "./MediaType.ts";

/** EXIF orientation. */
export * as Orientation from "./Orientation.ts";

/** Decoded pixel buffers and portable pixel operations. */
export * as Raster from "./Raster.ts";

/** Image transforms as data, and planning them into primitives. */
export * as Transform from "./Transform.ts";
