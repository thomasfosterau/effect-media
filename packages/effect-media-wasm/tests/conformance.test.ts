import { suite } from "@thomasfosterau/effect-media-conformance";
import * as WasmNode from "../src/WasmNode.ts";

suite("wasm", WasmNode.layer);
