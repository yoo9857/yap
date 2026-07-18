import { BODY_HEIGHT, BODY_WIDTH } from "../craft/voxelBody.js";
import type { VoxelWorld } from "../craft/voxelWorld.js";

/**
 * Hitscan combat — pure math, unit-tested. A shot is a ray tested against
 * every fighter's AABB and the terrain; whatever is closest wins.
 */

export const MAX_HP = 3;
export const FIRE_COOLDOWN = 0.35;
export const FIRE_RANGE = 42;
export const EYE_HEIGHT = 1.55;

export interface Fighter {
  /** Feet-center position (same convention as voxelBody). */
  x: number;
  y: number;
  z: number;
  hp: number;
}

export const alive = (f: Fighter): boolean => f.hp > 0;

const HALF = BODY_WIDTH / 2;

/** Ray-vs-fighter AABB (slab test). Returns entry distance or null. */
export function rayHitsFighter(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  f: Fighter,
  maxDist: number,
): number | null {
  let tMin = 0;
  let tMax = maxDist;
  const axes: [number, number, number, number][] = [
    [ox, dx, f.x - HALF, f.x + HALF],
    [oy, dy, f.y, f.y + BODY_HEIGHT],
    [oz, dz, f.z - HALF, f.z + HALF],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin <= maxDist ? tMin : null;
}

export interface ShotResult {
  kind: "fighter" | "block" | "miss";
  /** Index into the fighters array (kind === "fighter"). */
  index: number;
  dist: number;
}

/**
 * Resolve one shot: closest of terrain / any LIVE fighter (skipIndex = the
 * shooter, so nobody shoots themselves in the back of the head).
 */
export function resolveShot(
  world: VoxelWorld,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  fighters: readonly Fighter[],
  skipIndex: number,
): ShotResult {
  const block = world.raycast(ox, oy, oz, dx, dy, dz, FIRE_RANGE);
  let bestDist = block ? block.dist : FIRE_RANGE;
  let bestKind: ShotResult["kind"] = block ? "block" : "miss";
  let bestIndex = -1;
  for (let i = 0; i < fighters.length; i++) {
    if (i === skipIndex || !alive(fighters[i]!)) continue;
    const d = rayHitsFighter(ox, oy, oz, dx, dy, dz, fighters[i]!, FIRE_RANGE);
    if (d !== null && d < bestDist) {
      bestDist = d;
      bestKind = "fighter";
      bestIndex = i;
    }
  }
  return { kind: bestKind, index: bestIndex, dist: bestDist };
}

/** Line of sight between two fighters' eyes (terrain only). */
export function hasLineOfSight(world: VoxelWorld, a: Fighter, b: Fighter): boolean {
  const ax = a.x;
  const ay = a.y + EYE_HEIGHT;
  const az = a.z;
  const dx = b.x - ax;
  const dy = b.y + EYE_HEIGHT - ay;
  const dz = b.z - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const hit = world.raycast(ax, ay, az, dx / dist, dy / dist, dz / dist, dist);
  return hit === null || hit.dist >= dist - 0.6;
}
