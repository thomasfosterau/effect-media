import { suite } from "@thomasfosterau/effect-media-conformance";
import * as SharpBackend from "../src/SharpBackend.ts";

suite("sharp", SharpBackend.layer);
