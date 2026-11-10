import { describe, expect, it } from "vitest";
import { ROUND, WATER, flowingWater, slabShape } from "@robo/shared";
import { VoxelWorld, WORLD_X, WORLD_Z } from "../src/craft/voxelWorld.js";
import { waterlogSnapshot } from "../src/craft/voxelView.js";
import { FieldWindow } from "../src/craft/fieldWorld.js";
import { submersion } from "../src/craft/voxelBody.js";

const at = (x: number, y: number, z: number) => (y * WORLD_Z + z) * WORLD_X + x;
const region = [{ x: 0, z: 0, minY: 0, maxY: 10 }];

describe("water held inside shaped blocks (client)", () => {
  it("drains visible and banked water, keeps shaped blocks and dug holes, and stays dry after scrolling", () => {
    const f = new FieldWindow();
    f.replaceAll([[0, 4, 0, WATER, 0], [1, 4, 0, 3, ROUND], [0, 2, 1, WATER, 0], [500, 4, 500, WATER, 0], [500, 2, 501, WATER, 0], [501, 4, 500, 3, ROUND]]);
    f.applyWet(1, 4, 0, WATER); f.applyWet(501, 4, 500, WATER);
    f.drainWater();
    expect(f.cellAt(0, 4, 0)).toEqual([0, 0]); expect(f.cellAt(500, 4, 500)).toEqual([0, 0]);
    expect(f.cellAt(0, 2, 1)).toEqual([0, 0]); expect(f.cellAt(500, 2, 501)).toEqual([0, 0]);
    expect(f.cellAt(1, 4, 0)).toEqual([3, ROUND]); expect(f.cellAt(501, 4, 500)).toEqual([3, ROUND]);
    expect(f.wetAt(1, 4, 0)).toBe(0); expect(f.wetAt(501, 4, 500)).toBe(0);
    f.recenter({ x: 580, z: 580 });
    expect(f.cellAt(500, 4, 500)).toEqual([0, 0]); expect(f.wetAt(501, 4, 500)).toBe(0);
    f.recenter({ x: -420, z: -420 });
    expect(f.cellAt(0, 4, 0)).toEqual([0, 0]); expect(f.cellAt(0, 2, 1)).toEqual([0, 0]);
    expect(f.cellAt(1, 4, 0)).toEqual([3, ROUND]);
  });
  it("the mesher's snapshot draws a shaped block's water as water; the world keeps the block", () => {
    const w = new VoxelWorld();
    w.setShaped(5, 3, 5, 3, slabShape(0, 0));
    w.setWet(5, 3, 5, flowingWater(2));
    w.setShaped(6, 3, 5, 3, ROUND); // dry
    const cells = w.cells.slice();
    expect(waterlogSnapshot(cells, w.wet, region)).toBe(1);
    expect(cells[at(5, 3, 5)]).toBe(flowingWater(2));
    expect(cells[at(6, 3, 5)]).toBe(3);
    expect(w.get(5, 3, 5)).toBe(3);
    expect(w.waterAt(5, 3, 5)).toBe(flowingWater(2));
  });

  it("writing a cell clears the water it held (both set and setShaped)", () => {
    const w = new VoxelWorld();
    w.setShaped(5, 3, 5, 3, ROUND); w.setWet(5, 3, 5, WATER);
    w.setShaped(5, 3, 5, 4, slabShape(0, 0));
    expect(w.wetAt(5, 3, 5)).toBe(0);
    w.setWet(5, 3, 5, WATER); w.set(5, 3, 5, 0);
    expect(w.waterAt(5, 3, 5)).toBe(0);
  });

  it("swimming counts the water inside a shaped block", () => {
    const w = new VoxelWorld();
    w.setShaped(5, 3, 5, 3, slabShape(0, 0)); w.setWet(5, 3, 5, WATER);
    expect(submersion(w, { x: 5.5, y: 3.5, z: 5.5, vx: 0, vy: 0, vz: 0, grounded: false })).toBeGreaterThan(0);
  });

  it("a field scroll keeps a shaped block's water (banked by absolute cell)", () => {
    const f = new FieldWindow();
    const [ax, az] = f.toAbsolute(80, 80);
    f.world.setShaped(80, 4, 80, 3, ROUND); f.world.setWet(80, 4, 80, WATER);
    expect(f.recenter({ x: 80 + 32, z: 80 })).not.toBeNull();
    expect(f.wetAt(ax, 4, az)).toBe(WATER);
    expect(f.recenter({ x: 80 - 32, z: 80 })).not.toBeNull(); // and back into the window
    const [gx, gz] = f.toGrid(ax, az);
    expect(f.world.waterAt(gx, 4, gz)).toBe(WATER);
    // a classmate's write to that cell (outside or inside) clears its water
    f.applyRemote(ax, 4, az, 3, ROUND);
    expect(f.wetAt(ax, 4, az)).toBe(0);
  });
});
