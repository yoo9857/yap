import { describe, expect, it, vi } from "vitest";
import { FluidSim, WATER, WATER_FALLING, WATER_SETTLED, flowingWater, isWater, waterLevel, type FluidWorld } from "../src/fluid.js";

/** A small test world: a floor at y = 0 (block 1), air above, optional walls. */
function makeWorld(size = 32) {
  const cells = new Map<string, number>();
  const blocked = new Set<string>();
  const world: FluidWorld & { cells: Map<string, number>; blocked: Set<string> } = {
    cells,
    blocked,
    get: (x, y, z) => (y <= 0 ? 1 : (cells.get(`${x},${y},${z}`) ?? 0)),
    open: (x, y, z) => y > 0 && y < 20 && Math.abs(x) <= size && Math.abs(z) <= size && !blocked.has(`${x},${y},${z}`),
    set: (x, y, z, id) => {
      if (id === 0) cells.delete(`${x},${y},${z}`);
      else cells.set(`${x},${y},${z}`, id);
    },
  };
  return world;
}

function settle(sim: FluidSim, world: FluidWorld, max = 400): number {
  let steps = 0;
  while (sim.busy && steps < max) {
    sim.step(world);
    steps++;
  }
  return steps;
}

const waterCells = (w: ReturnType<typeof makeWorld>) => [...w.cells.entries()].filter(([, id]) => isWater(id));

describe("fluid", () => {
  it("yields expensive work without dropping the pending frontier", () => {
    const world = makeWorld(), sim = new FluidSim();
    world.set(0, 1, 0, WATER); sim.touch(0, 1, 0);
    sim.step(world);
    const pending = sim.pendingCount;
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now += 5);
    try { sim.step(world, 1); } finally { clock.mockRestore(); }
    expect(sim.busy).toBe(true);
    expect(sim.pendingCount).toBeGreaterThan(pending - 9);
    expect(settle(sim, world)).toBeLessThan(400);
    expect(world.get(7, 1, 0)).toBe(flowingWater(7));
    world.set(0, 1, 0, 0); sim.touch(0, 1, 0); settle(sim, world);
    expect(waterCells(world)).toEqual([]);
  });

  it("two streams' ends a cell apart join; one spring still ends at seven cells, and it all drains", () => {
    // alone: the diamond of radius 7 and nothing more (its slanting edge must not grow)
    const one = makeWorld(), simOne = new FluidSim();
    one.set(0, 1, 0, WATER); simOne.touch(0, 1, 0); settle(simOne, one);
    expect(waterCells(one)).toHaveLength(113);
    // two springs 13 across and 3 along apart: each reaches 7, the line of cells 8 from both joins
    const w = makeWorld(), sim = new FluidSim();
    w.set(-6, 1, 0, WATER); sim.touch(-6, 1, 0);
    w.set(7, 1, 3, WATER); sim.touch(7, 1, 3);
    expect(settle(sim, w)).toBeLessThan(400);
    // no dry cell is left with water on two opposite sides
    for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) {
      if (isWater(w.get(x, 1, z))) continue;
      const wet = (dx: number, dz: number) => isWater(w.get(x + dx, 1, z + dz));
      expect(wet(1, 0) && wet(-1, 0) || wet(0, 1) && wet(0, -1), `${x},${z}`).toBe(false);
    }
    expect(waterCells(w).length).toBeGreaterThan(226); // more than the two diamonds: the joining cells
    expect(waterCells(w).length).toBeLessThan(260);    // ...and only those
    // a joined cell is the weakest water
    expect(w.get(2, 1, 0)).toBe(flowingWater(7)); // 8 from the first spring: only the join reaches it
    // take both springs away: everything dries
    w.set(-6, 1, 0, 0); sim.touch(-6, 1, 0); w.set(7, 1, 3, 0); sim.touch(7, 1, 3);
    expect(settle(sim, w)).toBeLessThan(400);
    expect(waterCells(w)).toEqual([]);
  });

  it("a source on a floor spreads 7 cells, one level weaker per cell", () => {
    const w = makeWorld();
    const sim = new FluidSim();
    w.set(0, 1, 0, WATER);
    sim.touch(0, 1, 0);
    expect(settle(sim, w)).toBeLessThan(400);
    for (let d = 1; d <= 7; d++) expect(w.get(d, 1, 0), `x=${d}`).toBe(flowingWater(d));
    expect(w.get(8, 1, 0)).toBe(0);
    // a diamond: |dx| + |dz| ≤ 7
    expect(w.get(3, 1, 4)).toBe(flowingWater(7));
    expect(w.get(4, 1, 4)).toBe(0);
    expect(waterCells(w).length).toBe(1 + 2 * 7 * 8); // centred diamond of radius 7
  });

  it("removing the source drains the stream completely", () => {
    const w = makeWorld();
    const sim = new FluidSim();
    w.set(0, 1, 0, WATER);
    sim.touch(0, 1, 0);
    settle(sim, w);
    w.set(0, 1, 0, 0);
    sim.touch(0, 1, 0);
    settle(sim, w);
    expect(waterCells(w)).toEqual([]);
  });

  it("falls straight down first, then spreads where it lands", () => {
    const w = makeWorld();
    const sim = new FluidSim();
    w.set(0, 5, 0, WATER); // floating source, 4 cells of air below
    sim.touch(0, 5, 0);
    settle(sim, w);
    for (let y = 1; y <= 4; y++) expect(w.get(0, y, 0), `y=${y}`).toBe(WATER_FALLING);
    // no sideways spread up in the air (it can fall instead)…
    expect(w.get(1, 5, 0)).toBe(0);
    // …but full-strength spread from the landing point
    expect(w.get(1, 1, 0)).toBe(flowingWater(1));
    expect(w.get(7, 1, 0)).toBe(flowingWater(7));
  });

  it("walls and closed doors hold water back", () => {
    const w = makeWorld();
    for (let z = -3; z <= 3; z++) w.set(2, 1, z, 3); // a stone wall at x = 2
    w.blocked.add("-2,1,0"); // a closed door at x = -2
    const sim = new FluidSim();
    w.set(0, 1, 0, WATER);
    sim.touch(0, 1, 0);
    settle(sim, w);
    expect(w.get(2, 1, 0)).toBe(3);
    expect(w.get(3, 1, 0)).toBe(0); // around the wall it would take ≥ 8 cells
    expect(w.get(-2, 1, 0)).toBe(0);
  });

  it("two sources over a floor make a third (the infinite pool)", () => {
    const w = makeWorld();
    const sim = new FluidSim();
    w.set(0, 1, 0, WATER);
    w.set(2, 1, 0, WATER);
    sim.touch(0, 1, 0);
    sim.touch(2, 1, 0);
    settle(sim, w);
    expect(w.get(1, 1, 0)).toBe(WATER);
  });

  it("is deterministic: the same edits give the same water", () => {
    const run = () => {
      const w = makeWorld();
      const sim = new FluidSim(50); // a small budget spreads the work over steps
      w.set(0, 3, 0, WATER);
      w.set(4, 1, 2, WATER);
      sim.touch(0, 3, 0);
      sim.touch(4, 1, 2);
      settle(sim, w, 2000);
      return JSON.stringify([...w.cells.entries()].sort());
    };
    expect(run()).toBe(run());
  });

  it("levels read back", () => {
    expect(waterLevel(WATER)).toBe(0);
    expect(waterLevel(WATER_FALLING)).toBe(0);
    expect(waterLevel(flowingWater(5))).toBe(5);
    expect(waterLevel(3)).toBe(8);
  });

  it("fills a fed closed pit instead of leaving a permanent notch under the stream", () => {
    const w = makeWorld(), sim = new FluidSim();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++)
      if (Math.abs(x) === 2 || Math.abs(z) === 2) for (let y = 1; y <= 3; y++) w.set(x, y, z, 3);
    w.set(0, 5, 0, WATER); sim.touch(0, 5, 0);
    settle(sim, w, 200);
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++)
      for (let y = 1; y <= 3; y++) expect(w.get(x, y, z), `${x},${y},${z}`).toBe(WATER_SETTLED);
    expect(w.get(1, 4, 0)).toBe(0); // no raised second sheet above the pool
  });

  it("keeps a lower outlet draining rather than sealing it into a pool", () => {
    const w = makeWorld(), sim = new FluidSim();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
      if (x !== 0 || z !== 0) w.set(x, 1, z, 3);
      if (Math.abs(x) === 2 || Math.abs(z) === 2) for (let y = 2; y <= 4; y++) w.set(x, y, z, 3);
    }
    for (let x = 0; x <= 3; x++) w.set(x, 1, 0, 0); // a drain continuing outside the rim
    w.set(0, 6, 0, WATER); sim.touch(0, 6, 0);
    settle(sim, w, 200);
    expect(w.get(0, 2, 0)).not.toBe(WATER);
    expect(isWater(w.get(1, 1, 1))).toBe(false); // remains the solid floor
    expect(w.get(0, 1, 0)).toBe(WATER_FALLING);
  });

  it("lets a waterfall enter an existing pool without floating water above it", () => {
    const w = makeWorld(), sim = new FluidSim();
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) w.set(x, 1, z, WATER);
    w.set(0, 5, 0, WATER); sim.touch(0, 5, 0);
    settle(sim, w, 200);
    expect(w.get(0, 2, 0)).toBe(WATER_FALLING);
    expect(w.get(1, 2, 0)).toBe(0);
    expect(w.get(0, 1, 0)).toBe(WATER);
  });

  it("a pond 20 × 20 is retained water all the way down, a cavity under a ledge included", () => {
    // sources poured over a walled pit; a ledge sticks out of one corner two up from the floor.
    // (Past the old 256-cell limit this was columns of falling water, the cavity stayed AIR and a
    // swimmer pressed into that corner dropped out of the water.)
    const w = makeWorld(), sim = new FluidSim(), size = 20;
    for (let x = -1; x <= size; x++) for (let z = -1; z <= size; z++) for (let y = 1; y <= 4; y++)
      if (x < 0 || z < 0 || x === size || z === size) w.set(x, y, z, 3);
    for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) w.set(x, 3, z, 3);
    for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) if (w.get(x, 4, z) === 0) { w.set(x, 4, z, WATER); sim.touch(x, 4, z); }
    settle(sim, w, 800);
    expect(sim.busy).toBe(false);
    for (const [x, z] of [[5, 5], [0, 0], [1, 1], [2, 0]] as const) for (let y = 1; y <= 2; y++) expect(w.get(x, y, z)).toBe(WATER_SETTLED);
    expect(w.get(5, 3, 5)).toBe(WATER_SETTLED);
    // it is still a basin: open a wall at the floor and it drains
    w.set(-1, 1, 5, 0); sim.touch(-1, 1, 5); settle(sim, w, 800);
    expect(w.get(5, 1, 5)).not.toBe(WATER_SETTLED);
  });

  it("drains retained water when a previously closed basin is broken open", () => {
    const w = makeWorld(), sim = new FluidSim();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++)
      if (Math.abs(x) === 2 || Math.abs(z) === 2) for (let y = 1; y <= 3; y++) w.set(x, y, z, 3);
    w.set(0, 5, 0, WATER); sim.touch(0, 5, 0); settle(sim, w, 200);
    expect(w.get(1, 3, 1)).toBe(WATER_SETTLED);
    w.set(2, 1, 0, 0); sim.touch(2, 1, 0); settle(sim, w, 200);
    expect(w.get(1, 3, 1)).not.toBe(WATER_SETTLED);
  });

  it("a closing door displaces a source and its orphan stream drains", () => {
    const w = makeWorld(), sim = new FluidSim();
    w.set(0, 1, 0, WATER); sim.touch(0, 1, 0); settle(sim, w);
    w.blocked.add("0,1,0"); sim.touch(0, 1, 0); settle(sim, w);
    expect(waterCells(w)).toEqual([]);
  });
});
