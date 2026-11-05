// Character physics on the Rust engine (body.rs) must move bodies EXACTLY as voxelBody.ts does:
// the same positions, velocities, grounded flag and submersion tick for tick, on the real island
// with every brick shape (ramps, corners, rounds, half blocks, stairs) and water laid in the path.
// It is what the native app's player runs on.
import { loadRustEngineSync } from "@robo/engine/node";
import { describe, expect, it } from "vitest";
import { generateIsland, surfaceY, type VoxelWorld } from "../src/craft/voxelWorld.js";
import { stepBody, unstick, type Body } from "../src/craft/voxelBody.js";
import { MAX_BLOCK_SHAPE } from "../src/craft/shapes.js";
import { BLOCKS } from "../src/craft/blocks.js";

const engine = loadRustEngineSync();
const DT = 1 / 60;
const STONE = BLOCKS.find((b) => b.key === "stone")!.id;
const WATER = 19;

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  edits: number[];
  start: number[];
}

/** A course around (cx, cz): shaped bricks and water strewn in the walker's way. */
function course(world: VoxelWorld, r: () => number, cx: number, cz: number, small: boolean): Case {
  const edits: number[] = [];
  for (let k = 0; k < 70; k++) {
    const x = cx + Math.floor(r() * 11) - 5, z = cz + Math.floor(r() * 11) - 5;
    const y = surfaceY(world, x, z) + 1;
    const kind = r();
    if (kind < 0.7) edits.push(x, y, z, STONE, Math.floor(r() * (MAX_BLOCK_SHAPE + 1)), 0);
    else if (kind < 0.85) edits.push(x, y, z, WATER + Math.floor(r() * 10), 0, 0);
    else edits.push(x, y, z, STONE, 51 + Math.floor(r() * 32), WATER + Math.floor(r() * 9)); // a waterlogged step
  }
  // a pool to swim in beside the course: two deep, settled water
  for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) {
    const x = cx + 3 + dx, z = cz - 1 + dz, top = surfaceY(world, x, z);
    edits.push(x, top, z, WATER + 9, 0, 0, x, top - 1, z, WATER + 9, 0, 0);
  }
  const start = [cx + 0.5, surfaceY(world, cx, cz) + 1, cz + 0.5, small ? 0.45 : NaN, small ? 0.6 : NaN, small ? 7.2 : NaN];
  return { edits, start };
}

/** The TypeScript run. Inputs are steered from the body's position (back toward the course when it
 *  strays 5 m, so it never walks off the island into the void) and recorded for the Rust replay. */
function runTs(world: VoxelWorld, c: Case, r: () => number, ticks: number, cx: number, cz: number): { out: number[]; inputs: number[] } {
  for (let i = 0; i < c.edits.length; i += 6) {
    const [x, y, z, block, shape, wet] = c.edits.slice(i, i + 6) as [number, number, number, number, number, number];
    if (shape > 0) world.setShaped(x, y, z, block, shape);
    else world.set(x, y, z, block);
    if (wet > 0) world.setWet(x, y, z, wet);
  }
  const s = c.start;
  const body: Body = { x: s[0]!, y: s[1]!, z: s[2]!, vx: 0, vy: 0, vz: 0, grounded: false };
  if (!Number.isNaN(s[3])) body.w = s[3];
  if (!Number.isNaN(s[4])) body.h = s[4];
  if (!Number.isNaN(s[5])) body.jumpSpeed = s[5];
  unstick(world, body);
  const out: number[] = [], inputs: number[] = [];
  let yaw = r() * Math.PI * 2;
  for (let t = 0; t < ticks; t++) {
    if (t % 30 === 0) yaw += (r() - 0.5) * 2;
    if (Math.hypot(body.x - cx - 0.5, body.z - cz - 0.5) > 5) yaw = Math.atan2(cx + 0.5 - body.x, cz + 0.5 - body.z);
    const moving = r() < 0.85;
    const fwd = moving ? 1 : 0, strafe = moving ? r() - 0.5 : 0;
    const len = Math.hypot(fwd, strafe) || 1;
    const wx = moving ? (Math.sin(yaw) * fwd - Math.cos(yaw) * strafe) / len : 0;
    const wz = moving ? (Math.cos(yaw) * fwd + Math.sin(yaw) * strafe) / len : 0;
    const push = r() < 0.03 ? 3 : 0;
    const jump = r() < 0.02 ? 1 : 0;
    inputs.push(wx, wz, jump, push, -push);
    stepBody(world, body, DT, wx, wz, jump !== 0, push, -push);
    out.push(body.x, body.y, body.z, body.vx, body.vy, body.vz, body.grounded ? 1 : 0, body.wet ?? 0);
  }
  return { out, inputs };
}

const FIELDS = ["x", "y", "z", "vx", "vy", "vz", "grounded", "wet"];

const stats: { case: string; travel: number; air: number; wet: number; climbs: number }[] = [];
describe("character physics: Rust = TypeScript (stepBody)", () => {
  const island = 20260718;
  const spots: [number, number][] = [[40, 66], [100, 100], [20, 120], [79, 18], [60, 30], [120, 60]];
  spots.forEach(([cx, cz], k) => {
    for (const small of [false, true]) {
      it(`${small ? "pet-sized" : "player"} body around (${cx}, ${cz})`, () => {
        const world = generateIsland(island);
        const r = rng(1000 + k * 7 + (small ? 1 : 0));
        const c = course(world, r, cx, cz, small);
        const { out: ts, inputs } = runTs(world, c, r, 900, cx, cz);
        const rs = Array.from(engine.body_trace(island, new Float64Array(c.edits), new Float64Array(c.start), new Float64Array(inputs), DT));
        expect(rs.length).toBe(ts.length);
        // the course must exercise the physics, not stand still: travel, airtime, contact, water
        let travel = 0, air = 0, wet = 0, climbs = 0;
        for (let t = 1; t < ts.length / 8; t++) {
          travel += Math.hypot(ts[t * 8]! - ts[t * 8 - 8]!, ts[t * 8 + 2]! - ts[t * 8 - 6]!);
          if (!ts[t * 8 + 6]) air++;
          if (ts[t * 8 + 7]! > 0) wet++;
          if (ts[t * 8 + 1]! > ts[t * 8 - 7]! + 0.05 && ts[t * 8 + 6]) climbs++;
        }
        stats.push({ case: `${cx},${cz}${small ? " small" : ""}`, travel: +travel.toFixed(1), air, wet, climbs });
        expect(travel).toBeGreaterThan(10);
        expect(air, "kept on the course, not falling off the island").toBeLessThan(750);
        for (let i = 0; i < ts.length; i++) {
          if (ts[i] !== rs[i]) {
            const tick = Math.floor(i / 8);
            expect.fail(`tick ${tick} ${FIELDS[i % 8]}: ts ${ts[i]} rust ${rs[i]} (ts body ${ts.slice(tick * 8, tick * 8 + 8).join(", ")})`);
          }
        }
      });
    }
  });

  it("rays (aim, camera probes) hit the same cells at the same distance through every shape", () => {
    const world = generateIsland(island);
    const r = rng(77);
    const edits: number[] = [];
    for (const [cx, cz] of spots) edits.push(...course(world, r, cx, cz, false).edits);
    for (let i = 0; i < edits.length; i += 6) {
      const [x, y, z, block, shape, wet] = edits.slice(i, i + 6) as [number, number, number, number, number, number];
      if (shape > 0) world.setShaped(x, y, z, block, shape);
      else world.set(x, y, z, block);
      if (wet > 0) world.setWet(x, y, z, wet);
    }
    const rays: number[] = [];
    for (let k = 0; k < 3000; k++) {
      const [cx, cz] = spots[k % spots.length]!;
      const ox = cx + (r() - 0.5) * 10, oz = cz + (r() - 0.5) * 10, oy = surfaceY(world, Math.floor(ox), Math.floor(oz)) + 0.5 + r() * 3;
      let dx = r() - 0.5, dy = r() - 0.7, dz = r() - 0.5;
      if (k % 7 === 0) { dx = 0; dz = 0; dy = -1; } // straight down, a zero component
      const l = Math.hypot(dx, dy, dz);
      rays.push(ox, oy, oz, dx / l, dy / l, dz / l, 2 + r() * 8, k % 3 === 0 ? 1 : 0);
    }
    const rs = Array.from(engine.raycast_trace(island, new Float64Array(edits), new Float64Array(rays)));
    let shaped = 0;
    for (let k = 0; k < rays.length / 8; k++) {
      const q = rays.slice(k * 8, k * 8 + 8);
      const h = world.raycast(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, q[6]!, false, q[7] === 1);
      const ts = h ? [1, ...h.voxel, ...h.before, h.dist] : [0, 0, 0, 0, 0, 0, 0, 0];
      if (h && world.getShape(...h.voxel) !== 0) shaped++;
      expect(rs.slice(k * 8, k * 8 + 8), `ray ${k}`).toEqual(ts);
    }
    expect(shaped, "rays reached shaped bricks").toBeGreaterThan(100);
  });

  it("the courses together swim and climb (the parity above covers those paths)", () => {
    expect(stats.length).toBe(spots.length * 2);
    expect(stats.reduce((n, s) => n + s.wet, 0)).toBeGreaterThan(300);
    expect(stats.reduce((n, s) => n + s.climbs, 0)).toBeGreaterThan(30);
  });
});
