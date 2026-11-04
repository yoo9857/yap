/**
 * The Rust engine in the browser. Loaded only when asked for (`?engine=rust`): its own chunk plus a
 * small .wasm that Vite emits from the glue's `new URL(..., import.meta.url)`.
 */
import type * as Wasm from "../wasm/craftyap_wasm.js";

export type RustEngine = Pick<typeof Wasm, "WasmWater" | "kit_cells_geometry">;

/** Fetch and start the module. Rejects if the browser cannot run it; callers fall back to TS. */
export async function loadRustEngine(): Promise<RustEngine> {
  const mod = await import("../wasm/craftyap_wasm.js");
  await mod.default();
  return mod;
}
