// Water in the air drawn as films and streams (waterGeometry.ts `streams`): each run of loose cells
// is a closed tube — capped where it starts and where it lands, its cells joined ring to ring. So
// with vertices welded by position, every edge of the stream part belongs to an even number of
// triangles; an odd one is a hole you can see into the water through. Checked on random layouts
// (blocks scattered and hanging, walls, terraces) after the water has spread.
import { afterAll, expect, it } from "vitest";
import { FluidSim, WATER, isWater, type FluidWorld } from "@robo/shared";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { buildWaterGeometry, drawWaterAsStreams } from "../src/craft/waterMesher.js";
import { blockByKey } from "../src/craft/blocks.js";

const rng = (seed: number) => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
afterAll(() => drawWaterAsStreams(false));

it("films and streams are closed tubes (fuzz, 90 layouts)", { timeout: 60000 }, () => {
  drawWaterAsStreams(true);
  const S = blockByKey("stone")!.id, Y = 3, C = 40;
  let tubes = 0;
  const bad: string[] = [];
  for (let seed = 1; seed <= 90; seed++) {
    const r = rng(seed), w = new VoxelWorld();
    for (let x = 20; x < 60; x++) for (let z = 20; z < 60; z++) for (let y = 0; y < Y; y++) w.set(x, y, z, S);
    const blocks: number[][] = [], waters: number[][] = [];
    const kind = seed % 3;
    if (kind === 0) { // a wall with water on top and beside it
      const h = 2 + Math.floor(r() * 4);
      for (let i = 0; i < 4; i++) for (let y = Y; y < Y + h; y++) blocks.push([C + i, y, C]);
      waters.push([C + Math.floor(r() * 4), Y + h, C], [C + 1, Y + h - 1, C + 1]);
    } else if (kind === 1) { // terraces
      let top = [C, Y, C];
      for (let x = C - 3; x <= C + 3; x++) for (let z = C - 3; z <= C + 3; z++) {
        const h = Math.floor(r() * 4);
        for (let y = Y; y < Y + h; y++) blocks.push([x, y, z]);
        if (Y + h > top[1]!) top = [x, Y + h, z];
      }
      waters.push(top, [C - 3 + Math.floor(r() * 7), Y + 5, C - 3 + Math.floor(r() * 7)]);
    } else { // scattered and hanging blocks, springs on, beside and above them
      const n = 6 + Math.floor(r() * 10);
      for (let i = 0; i < n; i++) blocks.push([C - 4 + Math.floor(r() * 9), Y + Math.floor(r() * 5), C - 4 + Math.floor(r() * 9)]);
      for (let i = 0; i < 3; i++) { const b = blocks[Math.floor(r() * blocks.length)]!; waters.push([b[0]! + (i === 1 ? 1 : 0), b[1]! + 1 + (i === 2 ? 2 : 0), b[2]!]); }
    }
    for (const [x, y, z] of blocks) w.set(x!, y!, z!, S);
    const fw: FluidWorld = { get: (x, y, z) => w.get(x, y, z), open: (x, y, z) => w.inBounds(x, y, z), set: (x, y, z, id) => { w.set(x, y, z, id); } };
    const sim = new FluidSim();
    for (const [x, y, z] of waters) if (w.get(x!, y!, z!) === 0) { w.set(x!, y!, z!, WATER); sim.touch(x!, y!, z!); }
    for (let i = 0; i < 400 && sim.busy; i++) sim.step(fw);
    const cells: number[] = [];
    for (let y = 0; y < 16; y++) for (let z = 20; z < 60; z++) for (let x = 20; x < 60; x++) if (isWater(w.get(x, y, z))) cells.push(x, y, z);
    const g = buildWaterGeometry(w, cells);
    if (!g) continue;
    const p = g.getAttribute("position"), grid = g.getAttribute("aGrid"), idx = g.index!;
    const key = (i: number) => `${Math.round(p.getX(i) * 1000)},${Math.round(p.getY(i) * 1000)},${Math.round(p.getZ(i) * 1000)}`;
    const edges = new Map<string, number>();
    for (let i = 0; i < idx.count; i += 3) {
      const t = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      if (grid.getW(t[0]!) < 200000) continue; // the lattice's
      tubes++;
      for (let j = 0; j < 3; j++) {
        const a = key(t[j]!), b = key(t[(j + 1) % 3]!);
        if (a === b) continue;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
      for (const v of t) expect(Number.isFinite(p.getX(v) + p.getY(v) + p.getZ(v))).toBe(true);
    }
    let open = 0, first = "";
    for (const [k, n] of edges) if (n % 2 === 1) { open++; first ||= k; }
    if (open) bad.push(`seed ${seed}: ${open} open edges, first ${first}`);
    g.dispose();
  }
  expect(tubes).toBeGreaterThan(5000); // the layouts really make water in the air
  expect(bad).toEqual([]);
});
