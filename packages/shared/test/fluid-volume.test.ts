import { describe, expect, it } from "vitest";
import { WATER, WATER_FALLING, WATER_SETTLED, isWater, type FluidWorld } from "../src/fluid.js";
import { FULL, FiniteFluidSim, waterAmount, waterOfAmount } from "../src/fluidVolume.js";

const STONE = 1;
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A stone floor at y = 0, air above, 40 cells each way. */
function makeWorld() {
  const cells = new Map<string, number>();
  const world: FluidWorld & { put(x: number, y: number, z: number, id: number): void; total(): number; wet(): number; cells: Map<string, number> } = {
    cells,
    get: (x, y, z) => (y <= 0 ? STONE : cells.get(k(x, y, z)) ?? 0),
    open: (x, y, z) => y > 0 && y < 30 && Math.abs(x) <= 40 && Math.abs(z) <= 40,
    set: (x, y, z, id) => { if (id === 0) cells.delete(k(x, y, z)); else cells.set(k(x, y, z), id); },
    put: (x, y, z, id) => { cells.set(k(x, y, z), id); },
    total: () => [...cells.values()].reduce((sum, id) => sum + (id === WATER ? 0 : waterAmount(id)), 0),
    wet: () => [...cells.values()].filter((id) => isWater(id) && id !== WATER_FALLING).length,
  };
  return world;
}

function run(world: FluidWorld, sim: FiniteFluidSim, steps = 400): number {
  let n = 0;
  while (sim.busy && n < steps) { sim.step(world); n++; }
  return n;
}

/** A walled tank, inner x0..x1 × z0..z1, `h` high, every inner cell a full cell of finite water. */
function tank(w: ReturnType<typeof makeWorld>, sim: FiniteFluidSim, x0: number, x1: number, z0: number, z1: number, h: number) {
  for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) for (let y = 1; y <= h; y++) {
    const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1;
    w.put(x, y, z, inside ? WATER_SETTLED : STONE);
    if (inside) sim.touch(x, y, z);
  }
}

describe("finite water", () => {
  it("amounts and ids are one scale: a full cell, seven partial ones, nothing", () => {
    expect(waterAmount(WATER_SETTLED)).toBe(FULL);
    expect(waterAmount(WATER)).toBe(FULL);
    expect(waterAmount(WATER_FALLING)).toBe(0);
    for (let a = 0; a <= FULL; a++) expect(waterAmount(waterOfAmount(a))).toBe(a);
    expect(waterOfAmount(7)).toBe(20); // the fullest partial cell draws like the old level 1
    expect(waterOfAmount(1)).toBe(26);
  });

  it("a walled tank just stands: nothing moves, nothing is lost", () => {
    const w = makeWorld(), sim = new FiniteFluidSim();
    tank(w, sim, 0, 3, 0, 2, 1);
    run(w, sim);
    expect(sim.busy).toBe(false);
    expect(w.total()).toBe(12 * FULL);
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 2; z++) expect(w.get(x, 1, z)).toBe(WATER_SETTLED);
  });

  it("opening the tank lets it RUN OUT: the level inside drops, and no water is made on the way", () => {
    const w = makeWorld(), sim = new FiniteFluidSim();
    tank(w, sim, 0, 3, 0, 2, 1);
    run(w, sim);
    w.set(1, 1, 3, 0); sim.touch(1, 1, 3); // break one wall block
    let most = 0;
    for (let i = 0; i < 240; i++) { sim.step(w); most = Math.max(most, w.total()); } // a minute
    expect(most).toBeLessThanOrEqual(12 * FULL); // never more than was poured
    let inside = 0;
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 2; z++) inside += waterAmount(w.get(x, 1, z));
    expect(inside).toBeLessThan(12 * FULL / 2); // most of it has left
    run(w, sim, 20000);
    expect(w.total()).toBe(0);                  // and in the end it is all gone: open ground holds nothing
  });

  it("a bucket on flat ground spreads to a film and dries; in a pit it stays", () => {
    const w = makeWorld(), sim = new FiniteFluidSim();
    w.put(0, 1, 0, WATER_SETTLED); sim.touch(0, 1, 0);
    sim.step(w);
    expect([[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => waterAmount(w.get(x!, 1, z!))).sort()).toEqual([1, 1, 2, 2]); // shared alike
    sim.step(w);
    expect(w.wet()).toBeGreaterThan(4);        // it spread
    expect(w.total()).toBeLessThanOrEqual(FULL);
    run(w, sim, 2000);
    expect(w.total()).toBe(0);                 // and dried up
    expect(sim.busy).toBe(false);

    const p = makeWorld(), pit = new FiniteFluidSim();
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) p.put(x, 1, z, STONE);
    p.put(0, 1, 0, WATER_SETTLED); pit.touch(0, 1, 0);
    run(p, pit, 2000);
    expect(p.get(0, 1, 0)).toBe(WATER_SETTLED);
  });

  it("water falls to the first thing that holds it, with a trail only while it drops", () => {
    const w = makeWorld(), sim = new FiniteFluidSim();
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) w.put(x, 1, z, STONE); // a cup on the floor
    w.put(0, 9, 0, WATER_SETTLED); sim.touch(0, 9, 0);
    sim.step(w);
    expect(w.get(0, 1, 0)).toBe(WATER_SETTLED); // it is at the bottom
    expect(w.get(0, 9, 0)).toBe(0);
    expect(w.get(0, 5, 0)).toBe(WATER_FALLING); // the way it came
    run(w, sim);
    for (let y = 2; y <= 9; y++) expect(w.get(0, y, 0)).toBe(0); // the trail is gone with the water
    expect(w.total()).toBe(FULL);
  });

  it("a spring never runs dry, and what it feeds is still finite once the spring is gone", () => {
    const w = makeWorld(), sim = new FiniteFluidSim();
    w.put(0, 1, 0, WATER); sim.touch(0, 1, 0);
    for (let i = 0; i < 60; i++) sim.step(w);
    expect(w.get(0, 1, 0)).toBe(WATER);
    const around = w.total();
    expect(around).toBeGreaterThan(FULL); // more than a bucket has come out of it
    w.set(0, 1, 0, 0); sim.touch(0, 1, 0);  // scoop the spring
    run(w, sim, 4000);
    expect(w.total()).toBe(0);
  });

  it("two pools at different heights level out through a gap, to within a film", () => {
    const w = makeWorld(), sim = new FiniteFluidSim();
    // a trough 1 × 6, walled, the left half full and the right half empty
    for (let x = -1; x <= 6; x++) for (let z = -1; z <= 1; z++) {
      const inside = z === 0 && x >= 0 && x <= 5;
      if (!inside) w.put(x, 1, z, STONE);
      else if (x < 3) { w.put(x, 1, z, WATER_SETTLED); sim.touch(x, 1, z); }
    }
    run(w, sim, 2000);
    expect(w.total()).toBeGreaterThanOrEqual(3 * FULL - 2); // a wet front may dry an eighth or two
    expect(w.total()).toBeLessThanOrEqual(3 * FULL);
    const amounts = [0, 1, 2, 3, 4, 5].map((x) => waterAmount(w.get(x, 1, 0)));
    expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(2);
  });
});
