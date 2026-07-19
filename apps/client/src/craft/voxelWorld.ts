import { AIR, blockByKey } from "./blocks.js";

/**
 * The craft island — a fixed-size voxel grid (Uint8Array of block ids).
 * Generation is a pure function of the seed; mining/placing mutate cells.
 * No three.js in here: the renderer and the physics read through get().
 */

export const WORLD_X = 80;
export const WORLD_Y = 40;
export const WORLD_Z = 80;

/** Deterministic 2D hash → [0,1). */
function hash2(x: number, z: number, seed: number): number {
  let h = (x * 374761393 + z * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise on a 6-cell lattice — enough hills for a 48² island. */
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

export interface RayHit {
  /** The solid voxel that was hit. */
  voxel: [number, number, number];
  /** The empty cell just before it — where a placed block goes. */
  before: [number, number, number];
  /** Distance along the ray where the voxel was entered (0 if inside one). */
  dist: number;
}

export class VoxelWorld {
  readonly cells = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
  /** Per-cell brick SHAPE (0 = cube, 1 = round, 2–5 = slope facings). Parallel
   *  to `cells`; physics ignores it (every solid cell is a full AABB), only the
   *  renderer reads it. Cleared to 0 whenever a plain cube/air is written. */
  readonly shapes = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);

  static index(x: number, y: number, z: number): number {
    return (y * WORLD_Z + z) * WORLD_X + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < WORLD_X && y >= 0 && y < WORLD_Y && z >= 0 && z < WORLD_Z;
  }

  get(x: number, y: number, z: number): number {
    return this.inBounds(x, y, z) ? this.cells[VoxelWorld.index(x, y, z)]! : AIR;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (this.inBounds(x, y, z)) {
      const i = VoxelWorld.index(x, y, z);
      this.cells[i] = id;
      this.shapes[i] = 0; // a plain cube / air — never keep a stale shape
    }
  }

  /** Place a block with an explicit brick shape (round/slope). */
  setShaped(x: number, y: number, z: number, id: number, shape: number): void {
    if (this.inBounds(x, y, z)) {
      const i = VoxelWorld.index(x, y, z);
      this.cells[i] = id;
      this.shapes[i] = shape;
    }
  }

  getShape(x: number, y: number, z: number): number {
    return this.inBounds(x, y, z) ? this.shapes[VoxelWorld.index(x, y, z)]! : 0;
  }

  isSolid(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) !== AIR;
  }

  /** A solid cell with at least one air neighbour — the renderable surface. */
  isExposed(x: number, y: number, z: number): boolean {
    if (!this.isSolid(x, y, z)) return false;
    return (
      !this.isSolid(x + 1, y, z) ||
      !this.isSolid(x - 1, y, z) ||
      !this.isSolid(x, y + 1, z) ||
      !this.isSolid(x, y - 1, z) ||
      !this.isSolid(x, y, z + 1) ||
      !this.isSolid(x, y, z - 1)
    );
  }

  /** Grid-DDA ray march. Origin/dir in world units (1 voxel = 1 m). */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): RayHit | null {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const inv = (d: number) => (d !== 0 ? Math.abs(1 / d) : Infinity);
    const tDeltaX = inv(dx);
    const tDeltaY = inv(dy);
    const tDeltaZ = inv(dz);
    const frac = (v: number, dir: number) =>
      dir > 0 ? 1 - (v - Math.floor(v)) : v - Math.floor(v);
    let tMaxX = tDeltaX === Infinity ? Infinity : tDeltaX * frac(ox, dx);
    let tMaxY = tDeltaY === Infinity ? Infinity : tDeltaY * frac(oy, dy);
    let tMaxZ = tDeltaZ === Infinity ? Infinity : tDeltaZ * frac(oz, dz);
    let px = x;
    let py = y;
    let pz = z;

    for (let t = 0; t <= maxDist; ) {
      if (this.isSolid(x, y, z)) {
        return { voxel: [x, y, z], before: [px, py, pz], dist: t };
      }
      px = x;
      py = y;
      pz = z;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
      } else if (tMaxY <= tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
      }
      if (!this.inBounds(x, y, z) && t > maxDist) break;
    }
    return null;
  }
}

const id = (key: string) => blockByKey(key)!.id;

/** Generate the island — pure function of the seed. */
export function generateIsland(seed: number): VoxelWorld {
  const world = new VoxelWorld();
  const grass = id("grass");
  const dirt = id("dirt");
  const stone = id("stone");
  const sand = id("sand");
  const bedrock = id("bedrock");
  const ores: [number, number][] = [
    [id("coal-ore"), 0.055],
    [id("iron-ore"), 0.03],
    [id("gold-ore"), 0.014],
    [id("diamond-ore"), 0.007],
  ];

  const cx = (WORLD_X - 1) / 2;
  const cz = (WORLD_Z - 1) / 2;
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      // island falloff: tall center, beaches at the rim
      const dist = Math.hypot(x - cx, z - cz) / (WORLD_X / 2);
      const falloff = Math.max(0, 1 - dist * dist * 1.15);
      const h = Math.round((5 + noise2(x, z, seed) * 7) * falloff) + 3;
      for (let y = 0; y < h; y++) {
        let cell: number;
        if (y === 0) cell = bedrock;
        else if (y === h - 1) cell = h <= 6 ? sand : grass;
        else if (y >= h - 4) cell = h <= 6 ? sand : dirt;
        else {
          cell = stone;
          const roll = hash2(x * 7 + y * 131, z * 13 + y, seed ^ 0x9e3779b9);
          for (const [ore, p] of ores) {
            // rarer ores demand depth (diamond only near bedrock)
            const deepEnough = ore < id("gold-ore") || y <= 6;
            if (deepEnough && roll < p) {
              cell = ore;
              break;
            }
          }
        }
        world.set(x, y, z, cell);
      }
    }
  }

  // a few oak trees on high grass
  const log = id("oak-log");
  const leaves = id("oak-leaves");
  let planted = 0;
  for (let attempt = 0; attempt < 220 && planted < 6; attempt++) {
    const x = 6 + Math.floor(hash2(attempt, 17, seed) * (WORLD_X - 12));
    const z = 6 + Math.floor(hash2(attempt, 91, seed) * (WORLD_Z - 12));
    let top = -1;
    for (let y = WORLD_Y - 1; y >= 0; y--) {
      if (world.isSolid(x, y, z)) {
        top = y;
        break;
      }
    }
    if (top < 6 || world.get(x, top, z) !== grass) continue;
    const height = 4 + Math.floor(hash2(attempt, 3, seed) * 2);
    for (let y = 1; y <= height; y++) world.set(x, top + y, z, log);
    for (let ly = height - 1; ly <= height + 1; ly++) {
      const r = ly === height + 1 ? 1 : 2;
      for (let ox = -r; ox <= r; ox++) {
        for (let oz = -r; oz <= r; oz++) {
          if (ox === 0 && oz === 0 && ly <= height) continue;
          if (Math.abs(ox) === r && Math.abs(oz) === r && r === 2) continue;
          if (!world.isSolid(x + ox, top + ly, z + oz)) {
            world.set(x + ox, top + ly, z + oz, leaves);
          }
        }
      }
    }
    planted++;
  }

  stampCastle(world);
  return world;
}

/** Highest solid cell at (x,z) — spawn helper. */
export function surfaceY(world: VoxelWorld, x: number, z: number): number {
  for (let y = WORLD_Y - 1; y >= 0; y--) {
    if (world.isSolid(x, y, z)) return y;
  }
  return 0;
}

// ---------------------------------------------------------------- castle

/**
 * Central keep — the island's landmark and the BR hot-drop. Stamped onto the
 * generated terrain: a flattened courtyard, crenellated curtain wall with a
 * gate, four corner towers, and a taller inner keep, lit by glowstone torches.
 * Deterministic (pure function of the already-seeded world).
 */
function stampCastle(world: VoxelWorld): void {
  const brick = id("stone-bricks");
  const stone = id("stone");
  const plank = id("oak-planks");
  const torch = id("glowstone");
  const gold = id("gold-block");

  const cx = Math.round(WORLD_X / 2);
  const cz = Math.round(WORLD_Z / 2);
  const half = 13; // curtain wall is (2*half+1) square
  const wallH = 6;
  const towerH = 11;
  const keepH = 14;

  // courtyard floor level = terrain height at the centre
  const floor = surfaceY(world, cx, cz);

  const fillColumn = (x: number, z: number, y0: number, y1: number, block: number) => {
    for (let y = y0; y <= y1; y++) world.set(x, y, z, block);
  };
  const clearColumn = (x: number, z: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) world.set(x, y, z, AIR);
  };

  // 1) flatten the pad: solid stone up to the floor, clear air above it
  for (let x = cx - half; x <= cx + half; x++) {
    for (let z = cz - half; z <= cz + half; z++) {
      if (!world.inBounds(x, 0, z)) continue;
      fillColumn(x, z, 1, floor - 1, stone);
      world.set(x, floor, z, brick); // courtyard tiling
      clearColumn(x, z, floor + 1, floor + keepH + 3);
    }
  }

  // 2) curtain wall with crenellations + a front gate
  const gateHalf = 2;
  for (let d = -half; d <= half; d++) {
    for (const [x, z] of [
      [cx + d, cz - half],
      [cx + d, cz + half],
      [cx - half, cz + d],
      [cx + half, cz + d],
    ] as const) {
      for (let h = 1; h <= wallH; h++) {
        // crenellations: gaps every other cell on the top course
        if (h === wallH && (d & 1) === 0) continue;
        world.set(x, floor + h, z, brick);
      }
    }
  }
  // gate: carve a 3-wide, 4-tall opening in the south wall, plank lintel
  for (let dx = -gateHalf; dx <= gateHalf; dx++) {
    clearColumn(cx + dx, cz + half, floor + 1, floor + 4);
    world.set(cx + dx, floor + 5, cz + half, plank);
  }

  // 3) four corner towers with battlements + a torch on top
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const tx = cx + sx * half;
    const tz = cz + sz * half;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const x = tx + ox;
        const z = tz + oz;
        const ring = Math.abs(ox) === 1 || Math.abs(oz) === 1;
        for (let h = 1; h <= towerH; h++) {
          if (h === towerH && !ring) continue; // hollow-ish top
          if (h === towerH && (ox + oz) % 2 !== 0) continue; // battlement gaps
          world.set(x, floor + h, z, brick);
        }
      }
    }
    world.set(tx, floor + towerH + 1, tz, torch); // torch glow atop each tower
  }

  // 4) inner keep — a taller block tower with a gold crown + plank door
  const kh = 5;
  for (let x = cx - kh; x <= cx + kh; x++) {
    for (let z = cz - kh; z <= cz + kh; z++) {
      const edge = Math.abs(x - cx) === kh || Math.abs(z - cz) === kh;
      if (!edge) continue;
      for (let h = 1; h <= keepH; h++) {
        if (h === keepH && ((x + z) & 1) === 0) continue; // battlements
        world.set(x, floor + h, z, brick);
      }
    }
  }
  clearColumn(cx, cz + kh, floor + 1, floor + 3); // keep doorway
  world.set(cx, floor + keepH + 1, cz, gold); // golden crown
  // corner torches inside the courtyard
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    world.set(cx + sx * (kh + 2), floor + 1, cz + sz * (kh + 2), torch);
  }
}
