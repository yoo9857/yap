import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { WATER, WATER_FALLING, flowingWater } from "@robo/shared";
import { blockByKey } from "../src/craft/blocks.js";
import { pointInWater, stepBody, submersion, type Body } from "../src/craft/voxelBody.js";
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
      expect(maxEdge).toBeLessThan(2);
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
