/**
 * The Rust engine in Node (the classroom server, tests). The same committed build as the browser,
 * started synchronously from the .wasm bytes. In the bundled server the file sits in
 * `dist/engine-wasm/` (copied by the server's tsup config); from source it is `../wasm/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as wasm from "../wasm/craftyap_wasm.js";

export type RustEngine = Pick<typeof wasm, "WasmWater" | "kit_cells_geometry">;
/** Everything the module exports (tests use the bare simulations too). */
export type RustModule = typeof wasm;

const FILE = "craftyap_wasm_bg.wasm";
let started: RustModule | null = null;

/** Start the module (once). Throws if the file is missing or cannot be instantiated. */
export function loadRustEngineSync(): RustModule {
  if (started) return started;
  const candidates = [new URL(`../wasm/${FILE}`, import.meta.url), new URL(`./engine-wasm/${FILE}`, import.meta.url)];
  const found = candidates.find((u) => existsSync(fileURLToPath(u)));
  if (!found) throw new Error(`Rust engine wasm not found (${candidates.map((u) => fileURLToPath(u)).join(", ")})`);
  wasm.initSync({ module: readFileSync(found) });
  started = wasm;
  return started;
}
