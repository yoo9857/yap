import { describe, expect, it } from "vitest";
import { FACE_NY, FACE_NZ, FACE_PY, FACE_PZ, FluidSim, WATER, WATER_FALLING, flowingWater, isWater, type FluidWorld } from "../src/fluid.js";
import { SHAPE_SEALS, computeShapeSeal, holdsWaterlog, shapeSeal } from "../src/waterlog.js";
import { MAX_BLOCK_SHAPE } from "../src/blockShapes.js";
import { ROUND, cornerShape, kitSlopeShape, slabShape, stairsShape, KIT_CUBE } from "../src/blockShapes.js";

const STONE = 1;
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A floor at y = 0, air above; shaped blocks hold their water in a side layer, like the game's worlds. */
function makeWorld() {
  const cells = new Map<string, number>(), shapes = new Map<string, number>(), wet = new Map<string, number>();
  const block = (x: number, y: number, z: number) => (y <= 0 ? STONE : cells.get(k(x, y, z)) ?? 0);
  const shaped = (x: number, y: number, z: number) => holdsWaterlog(block(x, y, z), shapes.get(k(x, y, z)) ?? 0);
  const world: FluidWorld & { put(x: number, y: number, z: number, id: number, shape?: number): void; water(x: number, y: number, z: number): number } = {
    get: (x, y, z) => (shaped(x, y, z) ? wet.get(k(x, y, z)) ?? 0 : block(x, y, z)),
    open: (x, y, z) => y > 0 && y < 12 && Math.abs(x) <= 24 && Math.abs(z) <= 24,
    seal: (x, y, z) => (shaped(x, y, z) ? shapeSeal(shapes.get(k(x, y, z))!) : 0),
    set: (x, y, z, id) => {
      const key = k(x, y, z), map = shaped(x, y, z) ? wet : cells;
      if (id === 0) map.delete(key);
      else map.set(key, id);
    },
    put: (x, y, z, id, shape = 0) => {
      cells.set(k(x, y, z), id);
      shapes.set(k(x, y, z), shape);
      wet.delete(k(x, y, z));
    },
    /** The water in a cell, whichever layer holds it. */
    water: (x, y, z) => (shaped(x, y, z) ? wet.get(k(x, y, z)) ?? 0 : isWater(block(x, y, z)) ? block(x, y, z) : 0),
  };
  return world;
}

function settle(world: FluidWorld, ...sources: [number, number, number][]) {
  const sim = new FluidSim();
  for (const [x, y, z] of sources) { world.set(x, y, z, WATER); sim.touch(x, y, z); }
  for (let i = 0; i < 400 && sim.busy; i++) sim.step(world);
  expect(sim.busy).toBe(false);
  return sim;
}

/** A walled pit, inner cells x0..x1 × z0..z1, `depth` deep (its floor is the world floor). */
function pit(w: ReturnType<typeof makeWorld>, x0: number, x1: number, z0: number, z1: number, depth: number) {
  for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) continue;
    for (let y = 1; y <= depth; y++) w.put(x, y, z, STONE);
  }
}

describe("water inside shaped blocks (waterlog)", () => {
  it("the precomputed seal table matches the geometry for every shape code", () => {
    expect(SHAPE_SEALS.length, "append the new shape codes' seals to SHAPE_SEALS").toBe(MAX_BLOCK_SHAPE + 1);
    for (let shape = 0; shape <= MAX_BLOCK_SHAPE; shape++) expect(SHAPE_SEALS[shape], `shape ${shape}`).toBe(computeShapeSeal(shape));
  });

  it("seals exactly the faces a shape covers", () => {
    expect(shapeSeal(slabShape(0, 0))).toBe(FACE_NY); // a floor; its half-height sides are open
    expect(shapeSeal(slabShape(0, 2))).toBe(FACE_PY); // upside down: a roof
    expect(shapeSeal(kitSlopeShape(0, 0))).toBe(FACE_NY | FACE_NZ); // floor + high back; triangle sides open
    expect(shapeSeal(kitSlopeShape(2, 0))).toBe(FACE_NY | FACE_PZ); // turned: the back is now +z
    expect(shapeSeal(stairsShape(0, 0))).toBe(FACE_NY | FACE_NZ); // 75 % sides stay open
    expect(shapeSeal(cornerShape(0, 0))).toBe(FACE_NY);
    expect(shapeSeal(ROUND)).toBe(FACE_NY | FACE_PY); // a disc covers 79 % of top and bottom
    expect(shapeSeal(KIT_CUBE)).toBe(63);
    expect(holdsWaterlog(STONE, KIT_CUBE)).toBe(false);
    expect(holdsWaterlog(WATER, ROUND)).toBe(false);
  });

  it("a triangle and a round side by side in a pool both fill, and so does a cluster", () => {
    const w = makeWorld();
    pit(w, 0, 6, 0, 6, 2);
    w.put(2, 1, 2, STONE, kitSlopeShape(1, 0)); w.put(3, 1, 2, STONE, ROUND); // triangle + round
    w.put(2, 1, 3, STONE, cornerShape(0, 0)); w.put(3, 1, 3, STONE, ROUND); // a 2×2 cluster
    w.put(5, 2, 5, STONE, ROUND); // at the surface
    settle(w, [0, 2, 0], [6, 2, 6]);
    for (const [x, y, z] of [[2, 1, 2], [3, 1, 2], [2, 1, 3], [3, 1, 3], [5, 2, 5]] as const) expect(w.water(x, y, z), `${x},${y},${z}`).not.toBe(0);
  });

  it("flowing water passes through half blocks, ramps and rounds and keeps going", () => {
    const w = makeWorld();
    w.put(1, 1, 0, STONE, slabShape(0, 0));
    w.put(2, 1, 0, STONE, ROUND);
    w.put(3, 1, 0, STONE, kitSlopeShape(1, 0)); // back toward ±x? whichever: its triangle sides face ±z
    settle(w, [0, 1, 0]);
    expect(w.water(1, 1, 0)).toBe(flowingWater(1));
    expect(w.water(2, 1, 0)).toBe(flowingWater(2));
    // past them the stream carries on, one level weaker per cell, as on open ground
    expect(w.water(5, 1, 0)).not.toBe(0);
  });

  it("a ramp's back and a stairs' back stop the water; their open side lets it in", () => {
    const w = makeWorld();
    // along +z from a source, in a one-wide channel: a ramp with its back toward the source
    for (const x of [-1, 1]) for (const z of [1, 2]) w.put(x, 1, z, STONE);
    w.put(0, 1, 1, STONE, kitSlopeShape(0, 0)); // back = −z
    settle(w, [0, 1, 0]);
    expect(w.water(0, 1, 1)).toBe(0);
    // turned round (back = +z): water enters the low side, and the back keeps it from passing on
    const v = makeWorld();
    for (const x of [-1, 1]) for (const z of [1, 2]) v.put(x, 1, z, STONE);
    v.put(0, 1, 1, STONE, kitSlopeShape(2, 0));
    settle(v, [0, 1, 0]);
    expect(v.water(0, 1, 1)).toBe(flowingWater(1));
    expect(v.water(0, 1, 2)).toBe(0);
    // stairs: same rule
    const s = makeWorld();
    for (const x of [-1, 1]) for (const z of [1, 2]) s.put(x, 1, z, STONE);
    s.put(0, 1, 1, STONE, stairsShape(2, 0));
    settle(s, [0, 1, 0]);
    expect(s.water(0, 1, 1)).toBe(flowingWater(1));
    expect(s.water(0, 1, 2)).toBe(0);
  });

  it("water falls into a half block from above and sits on its floor; a round's top turns it aside", () => {
    const w = makeWorld();
    w.put(0, 1, 0, STONE, slabShape(0, 0));
    w.put(0, 2, 0, WATER);
    settle(w, [0, 2, 0]);
    expect(w.water(0, 1, 0)).toBe(WATER_FALLING);
    const r = makeWorld();
    r.put(0, 1, 0, STONE, ROUND);
    settle(r, [0, 2, 0]);
    expect(r.water(0, 1, 0)).not.toBe(WATER_FALLING); // not fallen into: filled from the side, where it lands
    expect(r.water(1, 2, 0)).toBe(flowingWater(1)); // spreads over the round's top as over a floor
  });

  it("a half block at a pool's rim lets water over it; stairs whose back faces the land hold it", () => {
    const w = makeWorld();
    pit(w, 0, 2, 0, 2, 1);
    w.put(3, 1, 1, STONE, slabShape(0, 0)); // a gap in the east wall, filled with a half block
    settle(w, [1, 1, 1]);
    expect(w.water(3, 1, 1)).not.toBe(0);
    expect(w.water(4, 1, 1)).not.toBe(0); // and on out onto the land
    const s = makeWorld();
    pit(s, 0, 2, 0, 2, 1);
    s.put(3, 1, 1, STONE, stairsShape(3, 0)); // back toward +x (the land)
    expect(shapeSeal(stairsShape(3, 0)) & 1).toBe(1);
    settle(s, [1, 1, 1]);
    expect(s.water(3, 1, 1)).not.toBe(0);
    expect(s.water(4, 1, 1)).toBe(0);
  });

  it("a mined shaped block lets the flow back in; a placed one starts dry and refills", () => {
    const w = makeWorld();
    pit(w, 0, 2, 0, 0, 1);
    w.put(1, 1, 0, STONE, ROUND);
    const sim = settle(w, [0, 1, 0]);
    expect(w.water(1, 1, 0)).not.toBe(0);
    w.put(1, 1, 0, 0); sim.touch(1, 1, 0);
    for (let i = 0; i < 50 && sim.busy; i++) sim.step(w);
    expect(w.water(1, 1, 0)).not.toBe(0);
    w.put(1, 1, 0, STONE, slabShape(0, 0)); sim.touch(1, 1, 0);
    expect(w.water(1, 1, 0)).toBe(0);
    for (let i = 0; i < 50 && sim.busy; i++) sim.step(w);
    expect(w.water(1, 1, 0)).not.toBe(0);
  });
});
