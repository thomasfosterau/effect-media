/**
 * The typed errors every backend reports. Each names the backend that raised
 * it, so a program that swaps backends can still tell where a failure came from.
 */
import * as Schema from "effect/Schema";

const common = {
  /** The backend that raised the error, such as `"sharp"` or `"wasm"`. */
  backend: Schema.String,
  /** The media type involved, when known. */
  mediaType: Schema.optionalKey(Schema.String),
  /** The underlying error from the backend, kept for debugging. */
  cause: Schema.optionalKey(Schema.Defect()),
};

/** The input could not be decoded: corrupt, truncated or not what its media type claims. */
export class DecodeError extends Schema.TaggedError<
  DecodeError,
  { readonly brand: unique symbol }
>()("DecodeError", {
  ...common,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.backend} could not decode ${this.mediaType ?? "input"}: ${this.reason}`;
  }
}

/** The output could not be encoded with the requested format or options. */
export class EncodeError extends Schema.TaggedError<
  EncodeError,
  { readonly brand: unique symbol }
>()("EncodeError", {
  ...common,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.backend} could not encode ${this.mediaType ?? "output"}: ${this.reason}`;
  }
}

/** The backend cannot read or write this media type at all. */
export class UnsupportedFormat extends Schema.TaggedError<
  UnsupportedFormat,
  { readonly brand: unique symbol }
>()("UnsupportedFormat", {
  ...common,
  direction: Schema.Literals(["decode", "encode"]),
}) {
  override get message(): string {
    return `${this.backend} cannot ${this.direction} ${this.mediaType ?? "this format"}`;
  }
}

/**
 * The backend cannot perform an operation, rather than silently approximating
 * it. `operation` is the operation's tag, such as `"Resize"`.
 */
export class UnsupportedOperation extends Schema.TaggedError<
  UnsupportedOperation,
  { readonly brand: unique symbol }
>()("UnsupportedOperation", {
  ...common,
  operation: Schema.String,
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : ` (${this.detail})`;
    return `${this.backend} does not support ${this.operation}${detail}`;
  }
}

/** Width or height is zero, negative, not an integer, or too large for the backend. */
export class InvalidDimensions extends Schema.TaggedError<
  InvalidDimensions,
  { readonly brand: unique symbol }
>()("InvalidDimensions", {
  ...common,
  width: Schema.Finite,
  height: Schema.Finite,
}) {
  override get message(): string {
    return `${this.backend} cannot handle dimensions ${this.width}×${this.height}`;
  }
}

/**
 * The input would exceed a configured limit, such as a pixel count that guards
 * against decompression bombs.
 */
export class ResourceLimitExceeded extends Schema.TaggedError<
  ResourceLimitExceeded,
  { readonly brand: unique symbol }
>()("ResourceLimitExceeded", {
  ...common,
  limit: Schema.String,
  value: Schema.Finite,
  maximum: Schema.Finite,
}) {
  override get message(): string {
    return `${this.backend}: ${this.limit} ${this.value} exceeds the limit of ${this.maximum}`;
  }
}

/** Any error a media backend can raise. */
export type MediaError =
  | DecodeError
  | EncodeError
  | UnsupportedFormat
  | UnsupportedOperation
  | InvalidDimensions
  | ResourceLimitExceeded;
