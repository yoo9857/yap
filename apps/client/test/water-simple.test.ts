// The simple water the game draws by default (water_mesh.rs `build_simple`, the owner's call
// 2026-11-12: "simple, like Minecraft — water that runs down"): a box per water cell, the corners
// of its top shared with the cells round it. So the surface has no cracks — every top vertex at
// one lattice corner of one layer stands at the same height — it falls from the spring to the
// last cell, falling water and water under water are full cells, and nothing is drawn against a
// block or more water.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FluidSim, WATER, WATER_FALLING, isWater, type FluidWorld } from "@robo/shared";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { buildWaterGeometry, drawWaterSimple } from "../src/craft/waterMesher.js";
import { blockByKey } from "../src/craft/blocks.js";

beforeAll(() => drawWaterSimple(true));
afterAll(() => drawWaterSimple(false));
const S = blockByKey("stone")!.id, Y = 3, C = 40;

function flow(build: (w: VoxelWorld) => number[][]) {
  const w = new VoxelWorld();
  for (let x = 20; x < 60; x++) for (let z = 20; z < 60; z++) for (let y = 0; y < Y; y++) w.set(x, y, z, S);
  const springs = build(w);
  const fw: FluidWorld = { get: (x, y, z) => w.get(x, y, z), open: (x, y, z) => w.inBounds(x, y, z), set: (x, y, z, id) => { w.set(x, y, z, id); } };
  const sim = new FluidSim();
  for (const [x, y, z] of springs) { w.set(x!, y!, z!, WATER); sim.touch(x!, y!, z!); }
  for (let i = 0; i < 400 && sim.busy; i++) sim.step(fw);
  const cells: number[] = [];
  for (let y = 0; y < 16; y++) for (let z = 20; z < 60; z++) for (let x = 20; x < 60; x++) if (isWater(w.get(x, y, z))) cells.push(x, y, z);
  const g = buildWaterGeometry(w, cells)!;
  const p = g.getAttribute("position"), n = g.getAttribute("normal"), grid = g.getAttribute("aGrid");
  const quads: { cell: number[]; face: number; v: number[][]; normal: number[] }[] = [];
  for (let i = 0; i < p.count; i += 4) quads.push({ cell: [grid.getX(i), grid.getY(i), grid.getZ(i)], face: Math.floor(grid.getW(i) / 4),
    v: [0, 1, 2, 3].map((k) => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]), normal: [n.getX(i), n.getY(i), n.getZ(i)] });
  return { w, g, quads };
}

describe("simple water", () => {
  it("a spring on open ground: one surface with no cracks, falling away from the spring", () => {
    const { w, g, quads } = flow(() => [[C, Y, C]]);
    const tops = quads.filter((q) => q.face === 0);
    expect(tops.length).toBeGreaterThan(50);
    const heights = new Map<string, number>();
    for (const q of tops) for (const [x, y, z] of q.v) {
      const key = `${x},${z},${q.cell[1]}`, seen = heights.get(key);
      if (seen === undefined) heights.set(key, y!); else expect(y, key).toBe(seen);
    }
    // the surface is highest at the spring and lowest at the stream's end
    const at = (x: number, z: number) => heights.get(`${x},${z},${Y}`)!;
    expect(at(C, C)).toBeGreaterThan(at(C + 3, C));
    expect(at(C + 3, C)).toBeGreaterThan(at(C + 7, C));
    expect(at(C + 7, C) - Y).toBeGreaterThan(0.05);
    // no face between two water cells, none against the ground
    for (const q of quads) {
      const [x, y, z] = q.cell as [number, number, number];
      if (q.face === 5) expect(w.get(x, y - 1, z)).toBe(0);
      if (q.face >= 1 && q.face <= 4) {
        const [dx, dz] = [[-1, 0], [0, 1], [1, 0], [0, -1]][q.face - 1]!;
        expect(w.get(x + dx!, y, z + dz!)).toBe(0);
        expect([q.normal[0], q.normal[2]]).toEqual([dx, dz]);
      }
    }
    // every triangle faces the way its normal points (outward)
    const p = g.getAttribute("position"), n = g.getAttribute("normal"), index = g.index!;
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const u = [p.getX(b) - p.getX(a), p.getY(b) - p.getY(a), p.getZ(b) - p.getZ(a)], v = [p.getX(c) - p.getX(a), p.getY(c) - p.getY(a), p.getZ(c) - p.getZ(a)];
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const dot = cross[0]! * n.getX(a) + cross[1]! * n.getY(a) + cross[2]! * n.getZ(a);
      if (Math.hypot(...cross) > 1e-6) expect(dot).toBeGreaterThan(0);
    }
    g.dispose();
  });

  it("a spring is a mound, not a box: its middle stands over its corners, lone corners are drawn in", () => {
    const ground = flow(() => [[C, Y, C]]);
    const top = ground.quads.filter((q) => q.face >= 6 && q.cell[0] === C && q.cell[2] === C);
    expect(top).toHaveLength(4);
    const middle = top[0]!.v[0]!, corner = top[0]!.v[2]!;
    expect([middle[0], middle[2]]).toEqual([C + 0.5, C + 0.5]);
    // a soft rise, not a point
    expect(middle[1]! - corner[1]!).toBeGreaterThan(0.04);
    expect(middle[1]! - corner[1]!).toBeLessThan(0.14);
    ground.g.dispose();
    // in the air nothing shares its corners: they are drawn in and down, the feet stay on the cell
    const air = flow(() => [[C, Y + 5, C]]);
    const lid = air.quads.filter((q) => q.face >= 6 && q.cell[1] === Y + 5);
    expect(lid).toHaveLength(4);
    for (const q of lid) { expect(q.v[2]![0]! % 1).not.toBe(0); expect(q.v[2]![1]!).toBeLessThan(Y + 5 + 0.75); }
    const feet = air.quads.filter((q) => q.face >= 1 && q.face <= 4 && q.cell[1] === Y + 5).flatMap((q) => q.v.slice(0, 2));
    expect(feet.length).toBe(8);
    for (const v of feet) { expect(v[0]! % 1).toBe(0); expect(v[1]).toBe(Y + 5); }
    air.g.dispose();
  });

  it("water falling off a pillar: whole cells from top to bottom, joined to the water it lands in", () => {
    const { w, g, quads } = flow((world) => {
      for (let y = Y; y < Y + 4; y++) world.set(C, y, C, S);
      return [[C, Y + 4, C]];
    });
    const falling = quads.filter((q) => w.get(q.cell[0]!, q.cell[1]!, q.cell[2]!) === WATER_FALLING && q.face >= 1 && q.face <= 4);
    expect(falling.length).toBeGreaterThan(8);
    // a falling cell with more water over it is a full cell: its sides reach the cell's top
    for (const q of falling) {
      const [x, y, z] = q.cell as [number, number, number];
      if (isWater(w.get(x, y + 1, z))) expect(Math.max(...q.v.map((v) => v[1]!))).toBe(y + 1);
    }
    // nothing but boxes: every vertex sits on a lattice line in x and z
    const p = g.getAttribute("position");
    // (a spring's top has a point in its middle and on its edges: halves there)
    for (let i = 0; i < p.count; i++) { expect(p.getX(i) * 2 % 1).toBe(0); expect(p.getZ(i) * 2 % 1).toBe(0); expect(Number.isFinite(p.getY(i))).toBe(true); }
    g.dispose();
  });
});
