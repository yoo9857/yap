import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { WATER, WATER_FALLING, flowingWater } from "@robo/shared";
import { blockByKey } from "../src/craft/blocks.js";
import { pointInWater, stepBody, submersion, waterBodyAt, waterDepthAt, type Body } from "../src/craft/voxelBody.js";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { buildWaterGeometry, prepareWaterTransition } from "../src/craft/waterMesh.js";

const STONE = blockByKey("stone")!.id;
const DT = 1 / 60;

/**
 * A pool: stone floor at y = 0, a basin x/z 10‒19 holding water at y = 1‒2,
 * and banks around it whose top (y = 2) is one block above the water's
 * floor, so the bank's walkable surface is at y = 3.
 */
function pool(): VoxelWorld {
  const w = new VoxelWorld();
  for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
    w.set(x, 0, z, STONE);
    const inside = x >= 10 && x < 20 && z >= 10 && z < 20;
    for (let y = 1; y <= 2; y++) w.set(x, y, z, inside ? WATER : STONE);
  }
  return w;
}

const body = (x: number, y: number, z: number): Body => ({ x, y, z, vx: 0, vy: 0, vz: 0, grounded: false });

function run(w: VoxelWorld, b: Body, seconds: number, wish: [number, number], jump: boolean): void {
  for (let i = 0; i < seconds * 60; i++) stepBody(w, b, DT, wish[0], wish[1], jump);
}

describe("swimming", () => {
  it("water is not solid: bodies, rays and placement treat it like air", () => {
    const w = pool();
    expect(w.isSolid(15, 2, 15)).toBe(false);
    expect(w.isReplaceable(15, 2, 15)).toBe(true);
    expect(w.isExposed(15, 0, 15)).toBe(true); // the pool floor shows through
    const hit = w.raycast(15.5, 5, 15.5, 0, -1, 0, 10);
    expect(hit?.voxel).toEqual([15, 0, 15]); // the aim passes through water…
    const scoop = w.raycast(15.5, 5, 15.5, 0, -1, 0, 10, false, true);
    expect(scoop?.voxel).toEqual([15, 2, 15]); // …unless it is scooping it
  });

  it("sinks slowly instead of falling", () => {
    const w = pool();
    for (let x = 10; x < 20; x++) for (let z = 10; z < 20; z++) for (let y = 3; y <= 8; y++) w.set(x, y, z, WATER);
    const b = body(15.5, 5, 15.5); // fully under
    run(w, b, 0.5, [0, 0], false);
    expect(b.vy).toBeGreaterThan(-1.6);
    expect(b.vy).toBeLessThan(0);
    expect(b.wet).toBeGreaterThan(0.2);
  });

  it("Space swims up to the surface and keeps the head out", () => {
    const w = pool();
    const b = body(15.5, 1, 15.5);
    run(w, b, 3, [0, 0], true);
    // the surface is at 2.875: bobbing there, not launched into the air
    expect(b.y).toBeGreaterThan(1.8);
    expect(b.y).toBeLessThan(3.2);
    expect(pointInWater(w, b.x, b.y + 1.6, b.z)).toBe(false);
  });

  it("swimming into the bank with Space climbs out onto it", () => {
    const w = pool();
    const b = body(17.5, 1.5, 15.5);
    run(w, b, 3, [1, 0], true); // swim +x into the bank at x = 20
    expect(b.x).toBeGreaterThan(20);
    expect(b.y).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it("falling water is water to be in — down a wall's face, below it, and in the open", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) w.set(x, 0, z, STONE);
    // a fall down a wall's face, and on down below where the wall ends (a block hanging in the
    // air): the game draws it as whole cells, so a body in it is in water
    for (let y = 4; y <= 8; y++) w.set(7, y, 8, STONE);
    for (let y = 1; y <= 8; y++) w.set(8, y, 8, WATER_FALLING);
    w.set(8, 9, 8, WATER);
    expect(submersion(w, body(8.5, 5, 8.5))).toBe(1);
    expect(pointInWater(w, 8.5, 6.5, 8.5)).toBe(true);
    expect(waterBodyAt(w, 8, 2, 8)).toBe(WATER_FALLING);
    // and a fall with nothing beside it
    for (let y = 1; y <= 6; y++) w.set(14, y, 14, WATER_FALLING);
    w.set(14, 7, 14, WATER);
    expect(waterBodyAt(w, 14, 3, 14)).toBe(WATER_FALLING);
    expect(pointInWater(w, 14.5, 3.5, 14.5)).toBe(true);
    expect(submersion(w, body(14.5, 1, 14.5))).toBe(1);
  });

  it("the inside of deep water is water even where its cells are falling water", () => {
    // a wide pond: sources on top, and under them (no closed basin this size) falling water
    const w = new VoxelWorld();
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) {
      w.set(x, 0, z, STONE);
      for (let y = 1; y <= 4; y++) w.set(x, y, z, x === 0 || z === 0 || x === 29 || z === 29 ? STONE : y === 4 ? WATER : WATER_FALLING);
    }
    expect(waterBodyAt(w, 15, 2, 15)).toBe(WATER_FALLING);
    expect(pointInWater(w, 15.5, 2.5, 15.5)).toBe(true);
    expect(submersion(w, body(15.5, 1, 15.5))).toBe(1);
    // how far under the DRAWN surface (the top cell is full to 0.875), and just over it
    expect(waterDepthAt(w, 15.5, 2.5, 15.5)).toBeCloseTo(4.875 - 2.5, 5);
    expect(waterDepthAt(w, 15.5, 4.95, 15.5)).toBeCloseTo(-0.075, 5); // in the top cell, above the water
    expect(waterDepthAt(w, 15.5, 5.2, 15.5)).toBeCloseTo(-0.325, 5);  // in the air cell over it
    expect(waterDepthAt(w, 15.5, 7, 15.5)).toBeNull();
    // a fall down a block's face over the pond is water too: its depth is measured to its top
    for (let y = 6; y <= 9; y++) { w.set(10, y, 10, WATER_FALLING); w.set(9, y, 10, STONE); }
    expect(waterDepthAt(w, 10.5, 7.5, 10.5)).toBeCloseTo(10 - 7.5, 5);
  });

  it("water against a pond's wall beside an air pocket is still water (not a sheet)", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) {
      w.set(x, 0, z, STONE);
      for (let y = 1; y <= 4; y++) w.set(x, y, z, x === 0 || z === 0 || x === 29 || z === 29 ? STONE : y === 4 ? WATER : WATER_FALLING);
    }
    // a dry cell against the wall at (1, 2, 5): the falling water at (1, 2, 4) has the wall on one
    // side and that air on ANOTHER — block and air, but not across from each other
    w.set(1, 2, 5, 0);
    expect(waterBodyAt(w, 1, 2, 4)).toBe(WATER_FALLING);
    expect(submersion(w, body(1.5, 1, 4.5))).toBe(1);
    expect(pointInWater(w, 1.5, 2.5, 4.5)).toBe(true);
  });

  it("is slower in water than on land", () => {
    const w = pool();
    const wet = body(11.5, 1, 15.5);
    run(w, wet, 0.5, [1, 0], false);
    const dry = body(25.5, 3, 15.5);
    run(w, dry, 0.5, [1, 0], false);
    expect(wet.x - 11.5).toBeLessThan((dry.x - 25.5) * 0.75);
  });

  it("wading in a puddle still jumps normally", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) {
      w.set(x, 0, z, STONE);
      w.set(x, 1, z, flowingWater(6)); // a thin film
    }
    const b = body(5.5, 1, 5.5);
    b.grounded = true;
    expect(submersion(w, b)).toBeLessThan(0.35);
    stepBody(w, b, DT, 0, 0, true);
    expect(b.vy).toBeGreaterThan(7);
  });
});


function edges(g: THREE.BufferGeometry): Map<string, number> {
  const p = g.getAttribute("position"), index = g.index!;
  const name = (i: number) => `${p.getX(i).toFixed(6)},${p.getY(i).toFixed(6)},${p.getZ(i).toFixed(6)}`;
  const result = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let j = 0; j < 3; j++) {
      const a = name(ids[j]!), b = name(ids[(j + 1) % 3]!);
      if (a === b) continue;
      const key = a < b ? `${a}/${b}` : `${b}/${a}`;
      result.set(key, (result.get(key) ?? 0) + 1);
    }
  }
  return result;
}
const allWater = (w: VoxelWorld, lo = 4, hi = 13): number[] => {
  const cells: number[] = [];
  for (let y = 0; y < 15; y++) for (let z = lo; z <= hi; z++) for (let x = lo; x <= hi; x++)
    if (w.get(x, y, z) >= WATER && w.get(x, y, z) <= 28) cells.push(x, y, z);
  return cells;
};

describe("continuous water boundary", () => {
  it("closes every local arrangement of eight water/air cells", () => {
    for (let pattern = 1; pattern < 256; pattern++) {
      const w = new VoxelWorld(), cells: number[] = [];
      for (let i = 0; i < 8; i++) if (pattern & 1 << i) {
        const x = 8 + (i & 1), y = 4 + (i >> 1 & 1), z = 8 + (i >> 2 & 1);
        w.set(x, y, z, WATER); cells.push(x, y, z);
      }
      const g = buildWaterGeometry(w, cells)!, index = g.index!, topology = new Map<string, number>();
      for (let i = 0; i < index.count; i += 3) for (let j = 0; j < 3; j++) {
        const a = index.getX(i + j), b = index.getX(i + (j + 1) % 3), key = a < b ? `${a}/${b}` : `${b}/${a}`;
        topology.set(key, (topology.get(key) ?? 0) + 1);
      }
      expect([...topology.values()].every((n) => n === 2), `pattern ${pattern}`).toBe(true);
      g.dispose();
    }
  });

  it("bounds isolated-droplet geometry without opening its surface", () => {
    const w = new VoxelWorld(), cells: number[] = [];
    for (let y = 8; y < 16; y++) for (let z = 32; z < 48; z++) for (let x = 32; x < 48; x++)
      if ((x + y + z) % 2 === 0) { w.set(x, y, z, WATER); cells.push(x, y, z); }
    const g = buildWaterGeometry(w, cells)!;
    const bytes = Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, g.index!.array.byteLength);
    expect(bytes).toBeLessThan(2_200_000);
    expect([...edges(g).values()].every((n) => n === 2)).toBe(true);
    g.dispose();
  });

  it("keeps alternating droplets closed across independently built chunks", () => {
    const w = new VoxelWorld(), left: number[] = [], right: number[] = [];
    for (let y = 8; y < 12; y++) for (let z = 14; z < 18; z++) for (let x = 14; x < 18; x++)
      if ((x + y + z) % 2 === 0) { w.set(x, y, z, WATER); (x < 16 ? left : right).push(x, y, z); }
    const a = buildWaterGeometry(w, left)!, b = buildWaterGeometry(w, right)!, joined = edges(a);
    for (const [key, count] of edges(b)) joined.set(key, (joined.get(key) ?? 0) + count);
    expect([...joined.values()].every((n) => n === 2)).toBe(true);
    a.dispose(); b.dispose();
  });

  it("draws only the exposed pool surface and shares its vertices", () => {
    const w = pool(), cells: number[] = [];
    for (let x = 10; x < 20; x++) for (let z = 10; z < 20; z++) for (let y = 1; y <= 2; y++) cells.push(x, y, z);
    const g = buildWaterGeometry(w, cells)!;
    expect(g.getAttribute("position").count).toBeLessThan(300);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBeCloseTo(2.875, 5);
    expect(g.index!.count).toBeLessThanOrEqual(1200);
    g.dispose();
  });

  it("retains water below a hovering block, including the visible air gap", () => {
    const w = pool(), cells: number[] = [];
    w.set(15, 3, 15, STONE);
    for (let x = 10; x < 20; x++) for (let z = 10; z < 20; z++) cells.push(x, 2, z);
    const g = buildWaterGeometry(w, cells)!;
    const p = g.getAttribute("position");
    expect(Array.from({ length: p.count }, (_, i) => p.getY(i)).every((y) => y > 2.7 && y < 3)).toBe(true);
    expect(g.index!.count).toBeGreaterThanOrEqual(600);
    g.dispose();
  });

  it("fills up to a block sunk in a pond: no square of surface in a gap under it", () => {
    const w = pool(), cells: number[] = [];
    for (let x = 10; x < 20; x++) for (let z = 10; z < 20; z++) { w.set(x, 3, z, WATER); cells.push(x, 2, z, x, 3, z); }
    w.set(15, 3, 15, STONE); // in the pond's top layer, water all round it
    const g = buildWaterGeometry(w, cells)!, p = g.getAttribute("position"), index = g.index!;
    // no triangle lies under the block (the old gap face sat at y = 2.875 across its whole cell)
    for (let i = 0; i < index.count; i += 3) {
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < 3; j++) { const k = index.getX(i + j); cx += p.getX(k) / 3; cy += p.getY(k) / 3; cz += p.getZ(k) / 3; }
      expect(cx > 15.2 && cx < 15.8 && cz > 15.2 && cz < 15.8 && cy < 3.01).toBe(false);
    }
    g.dispose();
  });

  it("is watertight through source, curved outlet, fall and receiving water (er/se1)", () => {
    const w = new VoxelWorld();
    for (let y = 3; y <= 8; y++) w.set(8, y, 8, y === 8 ? WATER : WATER_FALLING);
    for (let x = 6; x <= 10; x++) for (let z = 6; z <= 10; z++) w.set(x, 2, z, WATER);
    w.set(7, 8, 8, flowingWater(1));
    const g = buildWaterGeometry(w, allWater(w))!;
    expect([...edges(g).values()].every((n) => n === 2)).toBe(true);
    const impact = g.getAttribute("aImpact");
    expect(Array.from({ length: impact.count }, (_, i) => impact.getZ(i)).some((n) => n > 0)).toBe(true);
    g.dispose();
  });

  it("draws a falling column straight: as wide halfway up a block as at its joints", () => {
    const w = new VoxelWorld();
    for (let y = 2; y <= 12; y++) w.set(8, y, 8, WATER_FALLING);
    const g = buildWaterGeometry(w, allWater(w))!, p = g.getAttribute("position");
    // the widest point at each height, well away from the column's two ends
    const reach = new Map<number, number>();
    for (let i = 0; i < p.count; i++) {
      const y = Math.round(p.getY(i) * 4) / 4;
      if (y < 5 || y > 10) continue;
      reach.set(y, Math.max(reach.get(y) ?? 0, Math.hypot(p.getX(i) - 8.5, p.getZ(i) - 8.5)));
    }
    const widths = [...reach.values()];
    expect(widths.length).toBeGreaterThan(8); // joints AND the faces between them
    // the face centres used to sit 10 cm inside the edges: a column pinched once per block
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.02);
    expect(Math.min(...widths)).toBeGreaterThan(0.3);
    g.dispose();
  });

  it("draws a fall beside a wall as a sheet on that wall, and a free fall as a whole column", () => {
    const w = new VoxelWorld();
    for (let y = 2; y <= 12; y++) { w.set(8, y, 8, WATER_FALLING); w.set(7, y, 8, STONE); w.set(20, y, 8, WATER_FALLING); }
    const reach = (x0: number) => {
      const g = buildWaterGeometry(w, Array.from({ length: 11 }, (_, i) => [x0, i + 2, 8]).flat())!, p = g.getAttribute("position");
      let far = 0;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > 5 && p.getY(i) < 10) far = Math.max(far, p.getX(i) - x0);
      g.dispose();
      return far;
    };
    expect(reach(8)).toBeLessThan(0.56);    // on the wall at x = 8: a third of the cell, rounded out to half at most
    expect(reach(8)).toBeGreaterThan(0.25);
    expect(reach(20)).toBeGreaterThan(0.7); // nothing to run down: a stream 0.6 m wide (FALL) in the cell's middle,
    expect(reach(20)).toBeLessThan(0.97);   // neither a sheet nor the whole cell
  });

  it("runs water that fell onto a ramp down it as a film, not as a cell of water around it", () => {
    const w = new VoxelWorld();
    w.set(8, 3, 8, WATER_FALLING);
    for (let x = 6; x <= 10; x++) for (let z = 6; z <= 10; z++) w.set(x, 2, z, STONE);
    // the ramp's top: the cell's full height at z = 8, the floor at z = 9 (shapeProfile's form)
    const ramp = 3 | 3 << 2 | 1 << 4 | 1 << 6;
    const top = (profile: number) => {
      const g = buildWaterGeometry({ get: (x, y, z) => w.get(x, y, z), profile: (x, y, z) => (x === 8 && y === 3 && z === 8 ? profile : 0) }, [8, 3, 8])!;
      const p = g.getAttribute("position");
      let back = 0, front = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.getZ(i) < 8.3) back = Math.max(back, p.getY(i));
        if (p.getZ(i) > 8.7) front = Math.max(front, p.getY(i));
      }
      g.dispose();
      return { back, front };
    };
    expect(top(ramp).front).toBeLessThan(3.4);                      // over the ramp: a film at its foot…
    expect(top(ramp).back).toBeGreaterThan(top(ramp).front + 0.4);  // …rising to its top edge
    expect(top(0).front).toBeGreaterThan(top(ramp).front + 0.3);    // plain falling water: the whole cell
  });

  it("a fall meets the water below it in a line, not in a skirt half a cell high and a cell wide", () => {
    const w = new VoxelWorld();
    for (let y = 3; y <= 8; y++) w.set(8, y, 8, WATER_FALLING);
    for (let x = 5; x <= 11; x++) for (let z = 5; z <= 11; z++) w.set(x, 2, z, WATER);
    const g = buildWaterGeometry(w, allWater(w))!, p = g.getAttribute("position");
    // just above the pool's surface (2.875), how far the fall's foot spreads from its axis
    let spread = 0;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 3.0 && p.getY(i) < 3.4)
      spread = Math.max(spread, Math.abs(p.getX(i) - 8.5), Math.abs(p.getZ(i) - 8.5));
    expect(spread).toBeLessThan(0.62); // was 0.75: the foot reached half way into the next cell, 0.3 m up
    g.dispose();
  });

  it("keeps diagonal disconnected streams separate and closed", () => {
    const w = new VoxelWorld(); w.set(8, 4, 8, WATER); w.set(9, 5, 9, WATER);
    const g = buildWaterGeometry(w, allWater(w))!;
    expect([...edges(g).values()].every((n) => n === 2)).toBe(true);
    g.dispose();
  });

  it("shares positions, normals, animation and impacts across independent chunks", () => {
    const w = new VoxelWorld(), left: number[] = [], right: number[] = [];
    for (let x = 12; x <= 20; x++) for (let z = 12; z <= 20; z++) {
      w.set(x, 0, z, STONE); w.set(x, 1, z, flowingWater(Math.min(7, x - 11)));
      (x < 16 ? left : right).push(x, 1, z);
    }
    const a = buildWaterGeometry(w, left)!, b = buildWaterGeometry(w, right)!;
    const nodes = (g: THREE.BufferGeometry) => {
      const ids = g.getAttribute("aGrid"), map = new Map<string, number[]>();
      for (let i = 0; i < ids.count; i++) map.set([ids.getX(i), ids.getY(i), ids.getZ(i), ids.getW(i)].join(","),
        ["position", "normal", "aWave", "aWet", "aDepth", "aFlow", "aImpact"].flatMap((name) => {
          const attr = g.getAttribute(name); return Array.from({ length: attr.itemSize }, (_, c) => attr.array[i * attr.itemSize + c]!);
        }));
      return map;
    };
    const na = nodes(a), nb = nodes(b); let shared = 0;
    for (const [key, value] of na) if (nb.has(key)) { expect(nb.get(key)).toEqual(value); shared++; }
    expect(shared).toBeGreaterThan(5); a.dispose(); b.dispose();
  });

  it("interpolates an interrupted level change from its displayed position", () => {
    const w = new VoxelWorld();
    const build = (id: number) => {
      for (let x = 9; x <= 11; x++) for (let z = 9; z <= 11; z++) w.set(x, 1, z, id);
      return buildWaterGeometry(w, [10, 1, 10])!;
    };
    const old = build(WATER), next = build(flowingWater(3)); prepareWaterTransition(next, old, 0, 0, 10);
    const third = build(flowingWater(6)); prepareWaterTransition(third, next, 0, 0, 10.09);
    const i = 0;
    expect(next.getAttribute("aTransition").getY(i)).toBeCloseTo(old.getAttribute("position").getY(i), 5);
    expect(third.getAttribute("aTransition").getY(i)).toBeCloseTo(
      (old.getAttribute("position").getY(i) + next.getAttribute("position").getY(i)) / 2, 4);
    old.dispose(); next.dispose(); third.dispose();
  });

  it("survives arbitrary stair destruction without NaNs, long panels or non-manifold edges", () => {
    let seed = 9017;
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 4294967296;
    const w = new VoxelWorld();
    for (let y = 1; y <= 8; y++) for (let z = 5; z <= 11; z++) for (let x = 5; x <= 11; x++) {
      const r = random(); w.set(x, y, z, r < 0.25 ? STONE : r < 0.65 ? WATER_FALLING : WATER);
    }
    for (let edit = 0; edit < 25; edit++) {
      w.set(5 + Math.floor(random() * 7), 1 + Math.floor(random() * 8), 5 + Math.floor(random() * 7), 0);
      const g = buildWaterGeometry(w, allWater(w))!;
      for (const a of Object.values(g.attributes)) expect(a.array.every((n) => Number.isFinite(n))).toBe(true);
      const p = g.getAttribute("position"), index = g.index!;
      let maxEdge = 0;
      for (let i = 0; i < index.count; i += 3) for (let j = 0; j < 3; j++) {
        const a = index.getX(i + j), b = index.getX(i + (j + 1) % 3);
        maxEdge = Math.max(maxEdge, Math.hypot(p.getX(a) - p.getX(b), p.getY(a) - p.getY(b), p.getZ(a) - p.getZ(b)));
      }
      // a pool's level face beside a fall's foot runs from the sheet (a 0.09 m film at the landing
      // cell's face) to the far side of the next cell: 1.91 × 1, and up to 2.22 across its corner
      expect(maxEdge).toBeLessThan(2.3);
      const topology = new Map<string, number>();
      for (let i = 0; i < index.count; i += 3) for (let j = 0; j < 3; j++) {
        const a = index.getX(i + j), b = index.getX(i + (j + 1) % 3);
        const key = a < b ? `${a}/${b}` : `${b}/${a}`;
        topology.set(key, (topology.get(key) ?? 0) + 1);
      }
      // Distinct components can touch the same solid corner geometrically;
      // each actual surface edge must still have at most two incident faces.
      expect([...topology.values()].every((n) => n <= 2)).toBe(true);
      g.dispose();
    }
  });
});
