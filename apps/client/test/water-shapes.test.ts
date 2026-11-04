import { describe, expect, it } from "vitest";
import { WATER, flowingWater, slabShape, stairsShape, kitSlopeShape } from "@robo/shared";
import { VoxelWorld, WORLD_X, WORLD_Z } from "../src/craft/voxelWorld.js";
import { waterlogShapes } from "../src/craft/voxelView.js";

const at = (x: number, y: number, z: number) => (y * WORLD_Z + z) * WORLD_X + x;
const region = [{ x: 0, z: 0, minY: 0, maxY: 10 }];

describe("water around half blocks, stairs and ramps (mesher snapshot only)", () => {
  it("a half block in a pool takes the water around it; a whole block never does", () => {
    const w = new VoxelWorld();
    for (const [x, z] of [[4, 5], [6, 5], [5, 4], [5, 6]]) w.set(x, 3, z, flowingWater(2));
    w.setShaped(5, 3, 5, 3, slabShape(0, 0));
    w.set(9, 3, 9, 3);
    for (const [x, z] of [[8, 9], [10, 9], [9, 8], [9, 10]]) w.set(x, 3, z, WATER);
    const cells = w.cells.slice();
    waterlogShapes(cells, w, region, new Set());
    expect(cells[at(5, 3, 5)]).toBe(flowingWater(2));
    expect(cells[at(9, 3, 9)]).toBe(3);
    expect(w.get(5, 3, 5)).toBe(3); // the world itself is untouched
  });

  it("takes the HIGHEST water beside it, and is full when water covers it", () => {
    const w = new VoxelWorld();
    w.setShaped(5, 3, 5, 3, stairsShape(1, 0));
    w.set(4, 3, 5, flowingWater(5)); w.set(6, 3, 5, flowingWater(1)); w.set(5, 3, 4, 3); w.set(5, 3, 6, 3);
    const cells = w.cells.slice();
    waterlogShapes(cells, w, region, new Set());
    expect(cells[at(5, 3, 5)]).toBe(flowingWater(1));
    w.set(5, 4, 5, flowingWater(3));
    const covered = w.cells.slice();
    waterlogShapes(covered, w, region, new Set());
    expect(covered[at(5, 3, 5)]).toBe(WATER);
  });

  it("stays dry at a pool's edge (air beside it), and never chains into dry land", () => {
    const w = new VoxelWorld();
    w.setShaped(5, 3, 5, 3, kitSlopeShape(0, 0));
    w.set(4, 3, 5, WATER); // water on one side, air on the others
    const cells = w.cells.slice();
    waterlogShapes(cells, w, region, new Set());
    expect(cells[at(5, 3, 5)]).toBe(3);
    // two half blocks in a row: only the one beside real water fills, not the next through it
    const row = new VoxelWorld();
    row.set(3, 3, 5, WATER); row.setShaped(4, 3, 5, 3, slabShape(0, 0)); row.setShaped(5, 3, 5, 3, slabShape(0, 0));
    for (const x of [3, 4, 5, 6]) { row.set(x, 3, 4, 3); row.set(x, 3, 6, 3); }
    row.set(6, 3, 5, 3); row.set(2, 3, 5, 3);
    const rc = row.cells.slice();
    waterlogShapes(rc, row, region, new Set());
    expect(rc[at(4, 3, 5)]).toBe(WATER);
    expect(rc[at(5, 3, 5)]).toBe(3);
  });
});
