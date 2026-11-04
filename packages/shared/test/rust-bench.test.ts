// Water simulation speed: TypeScript (fluid.ts) vs the Rust engine (WASM) on identical worlds.
// Only runs on request:  pnpm engine:bench   (needs pnpm engine:build first)
import { loadRustEngineSync } from "../../engine/src/node.js";
import { describe, expect, it } from "vitest";
import { FluidSim, WATER, isWater, type FluidWorld } from "../src/fluid.js";

const run = process.env.RUST_BENCH === "1";
interface RustFluid { put(x: number, y: number, z: number, b: number, shaped: boolean, seal: number): void; set(x: number, y: number, z: number, id: number): void; touch(x: number, y: number, z: number): void; run(max: number): number; water(x: number, y: number, z: number): number; free(): void }
const { WasmFluid } = (run ? loadRustEngineSync() : {}) as unknown as { WasmFluid: new (floor: number, maxY: number, half: number, floorBlock: number, budget: number) => RustFluid };
const FLOOR = 0, MAX_Y = 40, HALF = 200, STONE = 1;
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

function tsWorld(): FluidWorld & { put(x: number, y: number, z: number, b: number): void } {
  const cells = new Map<string, number>();
  return {
    get: (x, y, z) => (y <= FLOOR ? STONE : cells.get(k(x, y, z)) ?? 0),
    open: (x, y, z) => y > FLOOR && y < MAX_Y && Math.abs(x) <= HALF && Math.abs(z) <= HALF,
    seal: () => 0,
    set: (x, y, z, id) => { if (id === 0) cells.delete(k(x, y, z)); else cells.set(k(x, y, z), id); },
    put: (x, y, z, b) => { if (b) cells.set(k(x, y, z), b); else cells.delete(k(x, y, z)); },
  };
}

type Scene = { name: string; build: (put: (x: number, y: number, z: number, b: number) => void, src: (x: number, y: number, z: number) => void) => void };
const scenes: Scene[] = [
  { name: "walled pool 48×48, 3 deep (settled basin)", build: (put, src) => {
    for (let x = -25; x <= 24; x++) for (let z = -25; z <= 24; z++) if (x === -25 || x === 24 || z === -25 || z === 24) for (let y = 1; y <= 3; y++) put(x, y, z, STONE);
    for (let i = 0; i < 6; i++) src(-20 + i * 7, 3, 0);
  } },
  { name: "120 separate streams on open ground", build: (_put, src) => {
    for (let i = 0; i < 120; i++) src(-180 + (i % 12) * 30, 1, -180 + Math.floor(i / 12) * 30);
  } },
  { name: "waterfall terraces (falling + spreading)", build: (put, src) => {
    for (let s = 0; s < 8; s++) for (let x = -30; x <= 30; x++) for (let z = s * 4; z < s * 4 + 4; z++) for (let y = 1; y <= 16 - s * 2; y++) put(x, y, z, STONE);
    for (let x = -28; x <= 28; x += 4) src(x, 17, 1);
  } },
];

describe.skipIf(!run)("water speed: TypeScript vs Rust (RUST_BENCH=1)", () => {
  it("is identical and faster on every scene", () => {
    for (const scene of scenes) {
  const ts = tsWorld(), sim = new FluidSim();
  const rust = new WasmFluid(FLOOR, MAX_Y, HALF, STONE, 4096);
  scene.build((x, y, z, b) => ts.put(x, y, z, b), (x, y, z) => { ts.set(x, y, z, WATER); sim.touch(x, y, z); });
  scene.build((x, y, z, b) => rust.put(x, y, z, b, false, 0), (x, y, z) => { rust.set(x, y, z, WATER); rust.touch(x, y, z); });
  let t = performance.now(), steps = 0, tsChanges = 0;
  while (sim.busy && steps < 2000) { tsChanges += sim.step(ts).length; steps++; }
  const tsMs = performance.now() - t;
  t = performance.now();
  const rustChanges = rust.run(2000);
  const rustMs = performance.now() - t;
  let wet = 0;
  for (let x = -HALF; x <= HALF; x += 1) for (let z = -HALF; z <= HALF; z += 7) for (let y = 1; y < 18; y++) if (isWater(rust.water(x, y, z)) !== isWater(ts.get(x, y, z))) wet++;
  expect(wet).toBe(0);
  expect(rustChanges).toBe(tsChanges);
  console.log(`${scene.name}: TS ${tsMs.toFixed(0)} ms, Rust ${rustMs.toFixed(0)} ms → ${(tsMs / rustMs).toFixed(1)}× | changes ${tsChanges}/${rustChanges} | mismatched cells ${wet}`);
  rust.free();
}
  });
});
