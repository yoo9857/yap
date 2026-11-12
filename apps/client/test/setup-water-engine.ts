// The water surface is meshed by the Rust engine only (src/craft/waterMesher.ts). Tests get the
// committed WASM build, started synchronously, so `buildWaterGeometry` and VoxelView's
// worker-less path work in Node.
import { loadRustEngineSync } from "@robo/engine/node";
import { drawWaterSimple, setWaterEngine } from "../src/craft/waterMesher.js";

setWaterEngine(loadRustEngineSync());
// The older water tests judge the surface net (`?watershape=net`); the simple water the game draws
// by default has its own (water-simple.test.ts turns it on).
drawWaterSimple(false);
