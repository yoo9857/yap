import { CASTLE_CENTER, WORLD_X, WORLD_Z, surfaceY, type VoxelWorld } from "../craft/voxelWorld.js";

/**
 * Where the storm closes and where everyone drops — chosen from the island
 * itself. The storm used to close on the castle, but the castle's courtyard is
 * walled in on every side (and battle has no digging), so the final circle
 * sat where nobody could stand and every match ended in the storm.
 *
 * Walkability is judged on column tops: two neighbouring columns connect when
 * their surfaces differ by at most one block, the same full-block ledge the
 * bots' hop clears. Only the largest connected area counts, so the centre and
 * every spawn can always reach each other.
 */
export interface Arena {
  cx: number;
  cz: number;
  /** Drop points, slot 0 is the player. */
  spawns: [number, number][];
}

/** The final circle (radius 3) plus a margin must be solid walkable ground. */
const CORE_RADIUS = 4;
/** The middle phases are judged on this square around the centre. */
const FIELD_HALF = 18;
const EDGE = 6;

export function pickArena(world: VoxelWorld, count: number, ringRadius: number): Arena {
  const W = WORLD_X;
  const D = WORLD_Z;
  const top = new Int16Array(W * D);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) top[x + z * W] = surfaceY(world, x, z);

  // largest region connected by ≤ 1-block steps
  const region = new Int32Array(W * D).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * D; start++) {
    if (region[start] !== -1 || top[start]! <= 0) continue;
    const id = sizes.length;
    let size = 0;
    region[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % W;
      const z = (i - x) / W;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]] as const) {
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        const n = nx + nz * W;
        if (region[n] !== -1 || top[n]! <= 0 || Math.abs(top[n]! - top[i]!) > 1) continue;
        region[n] = id;
        stack.push(n);
      }
    }
    sizes.push(size);
  }
  let main = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[main]!) main = i;
  const walk = (x: number, z: number): boolean =>
    x >= 0 && z >= 0 && x < W && z < D && region[x + z * W] === main;

  // summed-area table of walkable columns, for O(1) square counts
  const sat = new Int32Array((W + 1) * (D + 1));
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      sat[x + 1 + (z + 1) * (W + 1)] =
        (walk(x, z) ? 1 : 0) +
        sat[x + (z + 1) * (W + 1)]! +
        sat[x + 1 + z * (W + 1)]! -
        sat[x + z * (W + 1)]!;
    }
  }
  const square = (x: number, z: number, half: number): number => {
    const x0 = Math.max(0, x - half);
    const z0 = Math.max(0, z - half);
    const x1 = Math.min(W, x + half + 1);
    const z1 = Math.min(D, z + half + 1);
    return sat[x1 + z1 * (W + 1)]! - sat[x0 + z1 * (W + 1)]! - sat[x1 + z0 * (W + 1)]! + sat[x0 + z0 * (W + 1)]!;
  };

  // the most open ground wins; ties go to the castle, which stays the backdrop
  const core = (2 * CORE_RADIUS + 1) ** 2;
  let best = { x: CASTLE_CENTER, z: CASTLE_CENTER, score: -Infinity };
  for (let z = EDGE; z < D - EDGE; z++) {
    for (let x = EDGE; x < W - EDGE; x++) {
      if (!walk(x, z) || square(x, z, CORE_RADIUS) < core) continue;
      const score = square(x, z, FIELD_HALF) - Math.hypot(x - CASTLE_CENTER, z - CASTLE_CENTER) * 0.01;
      if (score > best.score) best = { x, z, score };
    }
  }
  const cx = best.x + 0.5;
  const cz = best.z + 0.5;

  // spawns on a ring, each moved to the nearest walkable column off the edge
  const inland = (x: number, z: number): boolean =>
    x >= EDGE && z >= EDGE && x < W - EDGE && z < D - EDGE && walk(x, z);
  const spawns: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const rx = Math.floor(cx + Math.cos(a) * ringRadius);
    const rz = Math.floor(cz + Math.sin(a) * ringRadius);
    spawns.push(nearestWalkable(inland, rx, rz, best.x, best.z));
  }
  return { cx, cz, spawns };
}

function nearestWalkable(
  walk: (x: number, z: number) => boolean,
  x: number,
  z: number,
  fallbackX: number,
  fallbackZ: number,
): [number, number] {
  for (let r = 0; r <= 24; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (walk(x + dx, z + dz)) return [x + dx + 0.5, z + dz + 0.5];
      }
    }
  }
  return [fallbackX + 0.5, fallbackZ + 0.5];
}
