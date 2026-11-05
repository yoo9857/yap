// The water surface on the Rust engine (water_mesh.rs) must build EXACTLY what waterGeometry.ts
// buildWaterGeometry builds: every attribute as float32 and every index, on randomized worlds that
// mix all water states (sources, flowing levels, falls, retained basins), solids and air, sparse and
// dense, inside the window and against its edge (the field's column beyond it). The native app
// draws the Rust one; the web stays the reference.
import { loadRustEngineSync } from "@robo/engine/node";
import { describe, expect, it } from "vitest";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z } from "../src/craft/voxelWorld.js";
import { buildWaterGeometry } from "../src/craft/waterGeometry.js";
import { blockByKey } from "../src/craft/blocks.js";

const engine = loadRustEngineSync();
const id = (k: string) => blockByKey(k)!.id;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

interface Case { world: VoxelWorld; cells: number[]; outside: Uint8Array | null }

function makeCase(seed: number): Case {
  const r = rng(seed), w = new VoxelWorld();
  const stone = id("stone"), glass = id("glass"), grass = id("grass");
  const edge = seed % 4 === 0; // against the window's edge, with ground beyond it
  const ox = edge ? 0 : 60, oz = edge ? WORLD_Z - 20 : 60, size = 20;
  const density = 0.15 + r() * 0.5;
  for (let x = ox; x < ox + size; x++) for (let z = oz; z < oz + size; z++) {
    w.set(x, 2, z, grass);
    for (let y = 3; y < 3 + 8; y++) {
      const v = r();
      if (v < density) {
        // every water state: 19 source, 20..26 flowing, 27 falling, 28 retained
        w.set(x, y, z, 19 + Math.floor(r() * 10));
      } else if (v < density + 0.15) w.set(x, y, z, r() < 0.8 ? stone : glass);
    }
  }
  // a structured pool and a fall, so long smooth surfaces are covered too
  for (let x = ox + 2; x < ox + 9; x++) for (let z = oz + 2; z < oz + 9; z++) { w.set(x, 3, z, 19); w.set(x, 4, z, 0); }
  for (let y = 4; y < 9; y++) w.set(ox + 12, y, oz + 12, 27);
  let outside: Uint8Array | null = null;
  if (edge) {
    outside = new Uint8Array(WORLD_Y);
    outside[0] = id("bedrock"); outside[1] = id("dirt"); outside[2] = grass;
    w.outsideColumn = outside;
  }
  const cells: number[] = [];
  for (let y = 0; y < WORLD_Y; y++) for (let z = oz; z < oz + size; z++) for (let x = ox; x < ox + size; x++) {
    const b = w.get(x, y, z);
    if (b !== 0) cells.push(x, y, z);
  }
  return { world: w, cells, outside };
}

const ATTRS: [string, number][] = [["position", 3], ["normal", 3], ["aWave", 1], ["aWet", 1], ["aFoam", 1], ["aDepth", 1], ["aFlow", 3], ["aImpact", 3], ["aGrid", 4]];

function compare(c: Case): { vertices: number; same: boolean } {
  let ts: ReturnType<typeof buildWaterGeometry> | "threw";
  try { ts = buildWaterGeometry(c.world, c.cells); } catch { ts = "threw"; }
  const rust = engine.water_mesh(c.world.cells, c.outside ?? new Uint8Array(0), Int32Array.from(c.cells));
  if (ts === "threw") { expect(rust[0]).toBe(-1); return { vertices: 0, same: true }; }
  if (!ts) { expect(rust[0]).toBe(0); return { vertices: 0, same: true }; }
  const n = ts.getAttribute("position").count, index = ts.index!;
  expect(rust[0], "vertex count").toBe(n);
  expect(rust[1], "index count").toBe(index.count);
  let at = 2;
  for (const [name, size] of ATTRS) {
    const expected = Float32Array.from(ts.getAttribute(name).array as ArrayLike<number>);
    const got = rust.subarray(at, at + n * size);
    at += n * size;
    for (let i = 0; i < expected.length; i++) {
      if (!Object.is(expected[i], got[i])) throw new Error(`${name}[${i}]: TypeScript ${expected[i]}, Rust ${got[i]}`);
    }
  }
  const indices = rust.subarray(at);
  for (let i = 0; i < index.count; i++) if (indices[i] !== index.getX(i)) throw new Error(`index ${i}: ${index.getX(i)} vs ${indices[i]}`);
  return { vertices: n, same: true };
}

describe("water surface: Rust = TypeScript", () => {
  it("identical on 24 random worlds (every water state, solids, the window edge)", () => {
    let total = 0;
    for (let seed = 1; seed <= 24; seed++) total += compare(makeCase(seed)).vertices;
    expect(total).toBeGreaterThan(10_000);
  });

  it("a lone source, an empty list and a sealed tank", () => {
    const w = new VoxelWorld();
    w.set(80, 5, 80, 19);
    compare({ world: w, cells: [80, 5, 80], outside: null });
    compare({ world: w, cells: [], outside: null });
    const t = new VoxelWorld(), stone = id("stone");
    for (let x = 9; x <= 11; x++) for (let y = 4; y <= 6; y++) for (let z = 9; z <= 11; z++) t.set(x, y, z, stone);
    t.set(10, 5, 10, 19);
    compare({ world: t, cells: [10, 5, 10], outside: null });
  });

  it("the grid's size is the same on both sides", () => {
    expect([WORLD_X, WORLD_Y, WORLD_Z]).toEqual([160, 56, 160]);
  });
});
