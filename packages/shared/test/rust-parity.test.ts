// The Rust engine's water (engine/crates/core/src/fluid.rs, built by `pnpm engine:build`) must make
// EXACTLY the same changes, in the same order, every step, as this package's fluid.ts. Randomized
// worlds with walls, shaped blocks (sealed faces), sources and mid-run edits. Not skipped: the
// committed build (@robo/engine) is what runs here: what ships is what is checked.
import { loadRustEngineSync } from "../../engine/src/node.js";
import { describe, expect, it } from "vitest";
import { FluidSim, WATER, isWater, type FluidChange, type FluidWorld } from "../src/fluid.js";
import { shapeSeal } from "../src/waterlog.js";
import { ROUND, cornerShape, kitSlopeShape, slabShape, stairsShape } from "../src/blockShapes.js";


interface RustFluid {
  put(x: number, y: number, z: number, block: number, shaped: boolean, seal: number): void;
  set(x: number, y: number, z: number, id: number): void;
  touch(x: number, y: number, z: number): void;
  busy(): boolean;
  step(): Int32Array;
  water(x: number, y: number, z: number): number;
  run(maxSteps: number): number;
  free(): void;
}

const FLOOR = 0, MAX_Y = 12, HALF = 24, STONE = 1;
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** The same world as SparseWorld in fluid.rs. */
function tsWorld() {
  const cells = new Map<string, { block: number; shaped: boolean; seal: number; wet: number }>();
  const world: FluidWorld & { put(x: number, y: number, z: number, b: number, shaped: boolean, seal: number): void; water(x: number, y: number, z: number): number } = {
    get: (x, y, z) => { if (y <= FLOOR) return STONE; const c = cells.get(k(x, y, z)); return c ? (c.shaped ? c.wet : c.block) : 0; },
    open: (x, y, z) => y > FLOOR && y < MAX_Y && Math.abs(x) <= HALF && Math.abs(z) <= HALF,
    seal: (x, y, z) => { const c = cells.get(k(x, y, z)); return c?.shaped ? c.seal : 0; },
    set: (x, y, z, id) => {
      const c = cells.get(k(x, y, z));
      if (c?.shaped) c.wet = id;
      else if (id === 0) cells.delete(k(x, y, z));
      else cells.set(k(x, y, z), { block: id, shaped: false, seal: 0, wet: 0 });
    },
    put: (x, y, z, block, shaped, seal) => { if (block === 0) cells.delete(k(x, y, z)); else cells.set(k(x, y, z), { block, shaped, seal, wet: 0 }); },
    water: (x, y, z) => { const c = cells.get(k(x, y, z)); return c ? (c.shaped ? c.wet : isWater(c.block) ? c.block : 0) : 0; },
  };
  return world;
}

/** Deterministic LCG, so a failing seed can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const SEALS = [slabShape(0, 0), slabShape(0, 2), kitSlopeShape(0, 0), kitSlopeShape(1, 0), kitSlopeShape(2, 0), kitSlopeShape(3, 0),
  stairsShape(0, 0), stairsShape(3, 0), cornerShape(0, 0), ROUND].map(shapeSeal);

describe("Rust water = TypeScript water (engine parity)", () => {
  const { WasmFluid } = loadRustEngineSync() as unknown as { WasmFluid: new (floor: number, maxY: number, half: number, floorBlock: number, budget: number) => RustFluid };

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: same changes, same order, every step`, () => {
      const r = rng(seed), ts = tsWorld(), sim = new FluidSim(seed % 3 === 0 ? 64 : 4096);
      const rust = new WasmFluid(FLOOR, MAX_Y, HALF, STONE, seed % 3 === 0 ? 64 : 4096);
      try {
        const both = (fn: (w: { put: typeof ts.put; set: (x: number, y: number, z: number, id: number) => void; touch: (x: number, y: number, z: number) => void }) => void) => {
          fn({ put: (x, y, z, b, sh, m) => ts.put(x, y, z, b, sh, m), set: (x, y, z, id) => ts.set(x, y, z, id), touch: (x, y, z) => sim.touch(x, y, z) });
          fn({ put: (x, y, z, b, s, m) => rust.put(x, y, z, b, s, m), set: (x, y, z, id) => rust.set(x, y, z, id), touch: (x, y, z) => rust.touch(x, y, z) });
        };
        // terrain: walls and pits of stone, shaped blocks of every family and turn
        const n = 120 + Math.floor(r() * 200), placed: [number, number, number, number, boolean, number][] = [];
        for (let i = 0; i < n; i++) {
          const x = Math.floor(r() * 21) - 10, y = 1 + Math.floor(r() * 5), z = Math.floor(r() * 21) - 10;
          const shaped = r() < 0.4;
          placed.push([x, y, z, STONE, shaped, shaped ? SEALS[Math.floor(r() * SEALS.length)]! : 0]);
        }
        const sources: [number, number, number][] = [];
        for (let i = 0; i < 1 + Math.floor(r() * 4); i++) sources.push([Math.floor(r() * 15) - 7, 1 + Math.floor(r() * 5), Math.floor(r() * 15) - 7]);
        both((w) => {
          for (const p of placed) w.put(...p);
          for (const [x, y, z] of sources) { w.set(x, y, z, WATER); w.touch(x, y, z); }
        });
        let steps = 0, moved = 0;
        const editAt = 6 + Math.floor(r() * 10);
        const [ex, ey, ez] = sources[0]!;
        while ((sim.busy || rust.busy()) && steps < 300) {
          const a: FluidChange[] = sim.step(ts);
          const flat = rust.step();
          const b: FluidChange[] = [];
          for (let i = 0; i < flat.length; i += 4) b.push([flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!]);
          expect(b, `step ${steps}`).toEqual(a);
          moved += a.length;
          expect(rust.busy()).toBe(sim.busy);
          // mid-run: take the first source away (the stream drains) and drop a block in the flow
          if (++steps === editAt) both((w) => { w.set(ex, ey, ez, 0); w.touch(ex, ey, ez); w.put(ex + 1, ey, ez, STONE, true, SEALS[seed % SEALS.length]!); w.touch(ex + 1, ey, ez); });
        }
        expect(steps).toBeLessThan(300);
        expect(moved, "the scenario must actually move water").toBeGreaterThan(20);
        for (let x = -12; x <= 12; x++) for (let y = 1; y < MAX_Y; y++) for (let z = -12; z <= 12; z++) expect(rust.water(x, y, z), `${x},${y},${z}`).toBe(ts.water(x, y, z));
      } finally {
        rust.free();
      }
    });
  }
});
