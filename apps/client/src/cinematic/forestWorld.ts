import { blockByKey } from "../craft/blocks.js";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z, surfaceY } from "../craft/voxelWorld.js";

/**
 * A lush forest island for the cinematic mode — same voxel grid + block ids as
 * craft, but NO castle and MANY more trees. A winding trail is kept clear so
 * the robot cast can trek through the woods without popping onto a trunk.
 *
 * Pure function of the seed (no three.js), exactly like generateIsland.
 */

const id = (key: string): number => blockByKey(key)!.id;

/** The cast's trek route across the island (world XZ, a closed loop). */
export const PATH_WAYPOINTS: readonly [number, number][] = [
  [17, 24],
  [31, 17],
  [47, 20],
  [60, 31],
  [63, 47],
  [53, 60],
  [39, 64],
  [25, 57],
  [16, 43],
];

const PATH_CLEAR = 5.0; // no trunks within this radius of the trail centreline

/** Deterministic 2D hash → [0,1). */
function hash2(x: number, z: number, seed: number): number {
  let h = (x * 374761393 + z * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Value noise on a 6-cell lattice. */
function noise2(x: number, z: number, seed: number): number {
  const gx = Math.floor(x / 6);
  const gz = Math.floor(z / 6);
  const fx = smooth((x - gx * 6) / 6);
  const fz = smooth((z - gz * 6) / 6);
  const a = hash2(gx, gz, seed);
  const b = hash2(gx + 1, gz, seed);
  const c = hash2(gx, gz + 1, seed);
  const d = hash2(gx + 1, gz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Squared distance from (px,pz) to segment (ax,az)->(bx,bz). */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + vx * t);
  const dz = pz - (az + vz * t);
  return dx * dx + dz * dz;
}

/** Min distance from (x,z) to the closed trail polyline. */
export function distToPath(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < PATH_WAYPOINTS.length; i++) {
    const a = PATH_WAYPOINTS[i]!;
    const b = PATH_WAYPOINTS[(i + 1) % PATH_WAYPOINTS.length]!;
    best = Math.min(best, segDist2(x, z, a[0], a[1], b[0], b[1]));
  }
  return Math.sqrt(best);
}

/** A single fuller oak: straight trunk + a rounded leaf blob. */
function plantTree(
  world: VoxelWorld,
  x: number,
  z: number,
  top: number,
  h: number,
  r: number,
): void {
  const log = id("oak-log");
  const leaves = id("oak-leaves");
  for (let y = 1; y <= h; y++) world.set(x, top + y, z, log);
  // canopy: wide at the base, tapering to a small crown — a soft blob
  for (let ly = h - 2; ly <= h + 2; ly++) {
    const rr = ly <= h ? r : Math.max(1, r - (ly - h));
    const rim = (rr + 0.35) * (rr + 0.35);
    for (let ox = -rr; ox <= rr; ox++) {
      for (let oz = -rr; oz <= rr; oz++) {
        if (ox === 0 && oz === 0 && ly <= h) continue; // keep the trunk clear
        if (ox * ox + oz * oz > rim) continue; // round the corners
        const yy = top + ly;
        if (world.inBounds(x + ox, yy, z + oz) && !world.isSolid(x + ox, yy, z + oz)) {
          world.set(x + ox, yy, z + oz, leaves);
        }
      }
    }
  }
  world.set(x, top + h + 2, z, leaves); // little tuft on top
}

/** Generate the forest island — pure function of the seed. */
export function generateForest(seed: number): VoxelWorld {
  const world = new VoxelWorld();
  const grass = id("grass");
  const dirt = id("dirt");
  const stone = id("stone");
  const sand = id("sand");
  const bedrock = id("bedrock");

  const cx = (WORLD_X - 1) / 2;
  const cz = (WORLD_Z - 1) / 2;

  // ---- terrain: a broad green plateau with gentle relief, sandy rim --------
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const dist = Math.hypot(x - cx, z - cz) / (WORLD_X / 2);
      const falloff = Math.max(0, 1 - dist * dist * 1.1);
      const h = Math.round((6 + noise2(x, z, seed) * 8) * falloff) + 3;
      for (let y = 0; y < h; y++) {
        let cell: number;
        if (y === 0) cell = bedrock;
        else if (y === h - 1) cell = h <= 6 ? sand : grass;
        else if (y >= h - 4) cell = h <= 6 ? sand : dirt;
        else cell = stone;
        world.set(x, y, z, cell);
      }
    }
  }

  // ---- dense forest: many trees, none on the trail ------------------------
  const trunks: [number, number][] = [];
  const spaced = (x: number, z: number): boolean => {
    for (const [tx, tz] of trunks) {
      if ((tx - x) * (tx - x) + (tz - z) * (tz - z) < 9) return false; // ≥3 apart
    }
    return true;
  };

  let planted = 0;
  for (let a = 0; a < 2600 && planted < 78; a++) {
    const x = 4 + Math.floor(hash2(a, 17, seed) * (WORLD_X - 8));
    const z = 4 + Math.floor(hash2(a, 91, seed) * (WORLD_Z - 8));
    let top = -1;
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      if (world.isSolid(x, y, z)) {
        top = y;
        break;
      }
    }
    if (top < 6 || world.get(x, top, z) !== grass) continue; // only on high grass
    if (distToPath(x, z) < PATH_CLEAR) continue; // keep the trail walkable
    if (!spaced(x, z)) continue;
    const big = hash2(a, 5, seed) > 0.72;
    const h = big ? 7 + Math.floor(hash2(a, 3, seed) * 3) : 4 + Math.floor(hash2(a, 3, seed) * 3);
    const r = big ? 3 : 2;
    plantTree(world, x, z, top, h, r);
    trunks.push([x, z]);
    planted++;
  }

  return world;
}

/** Ground height (top solid cell) at a world XZ — for placing walkers/props. */
export function groundY(world: VoxelWorld, x: number, z: number): number {
  return surfaceY(world, Math.floor(x), Math.floor(z));
}
