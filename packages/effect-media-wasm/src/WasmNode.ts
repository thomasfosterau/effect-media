/**
 * The WebAssembly backend on Node, Bun and Deno's Node compatibility, where the
 * codecs cannot fetch their own `.wasm` files: they are read from disk instead.
 */
import type { ImageBackend } from "@thomasfosterau/effect-media/ImageBackend";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import { readFile } from "node:fs/promises";
import * as WasmBackend from "./WasmBackend.ts";

const compile = (specifier: string): Effect.Effect<WebAssembly.Module> =>
  // The files ship with the installed packages; failing to read them is a broken install.
  Effect.tryPromise(async () =>
    WebAssembly.compile(await readFile(new URL(import.meta.resolve(specifier)))),
  ).pipe(Effect.orDie);

/** Compiles every codec module from the installed jSquash packages. */
export const modules: Effect.Effect<WasmBackend.Modules> = Effect.all(
  R.map(WasmBackend.moduleFiles, compile),
  {
    concurrency: "unbounded",
  },
);

/** The WebAssembly backend, with its codecs read from `node_modules`. */
export const layer: Layer.Layer<ImageBackend> = Layer.unwrap(
  Effect.map(modules, WasmBackend.layerWithModules),
);
