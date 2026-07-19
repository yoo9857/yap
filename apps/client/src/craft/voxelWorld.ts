import { AIR, blockByKey } from "./blocks.js";

/**
 * The craft island — a fixed-size voxel grid (Uint8Array of block ids).
 * Generation is a pure function of the seed; mining/placing mutate cells.
 * No three.js in here: the renderer and the physics read through get().
 */

export const WORLD_X = 80;
export const WORLD_Y = 56;
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
      // Keep malformed tool/save input from poisoning the parallel shape
      // buffer. Unknown shapes can otherwise produce invalid rotations and
      // undefined geometry in the renderer.
      this.shapes[i] = Number.isInteger(shape) && shape >= 0 && shape <= 17 ? shape : 0;
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

  stampHogwartsCastle(world);
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
// Legacy compact castle kept as a reference for future biome variants.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  // Keep the academy on a substantial plinth even on a low-noise seed.
  const floor = Math.max(4, surfaceY(world, cx, cz));

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

/** Large magical-school starting castle: layered walls, courtyards, wings,
 * observatory towers and lit windows, all authored as playable voxels. */
function stampHogwartsCastle(world: VoxelWorld): void {
  const brick = id("stone-bricks");
  const stone = id("stone");
  const plank = id("oak-planks");
  const glass = id("glass");
  const torch = id("glowstone");
  const gold = id("gold-block");

  const cx = Math.floor(WORLD_X / 2);
  const cz = Math.floor(WORLD_Z / 2);
  const floor = surfaceY(world, cx, cz);
  const outer = 26;
  const wallH = 8;
  const towerH = 20;
  const keepH = 25;

  const box = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, block: number) => {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) world.set(x, y, z, block);
      }
    }
  };
  const clear = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number) => {
    box(x0, x1, z0, z1, y0, y1, AIR);
  };
  const battlements = (x0: number, x1: number, z0: number, z1: number, y: number, every = 2) => {
    for (let x = x0; x <= x1; x++) {
      if ((x - x0) % every === 0) {
        world.set(x, y, z0, brick);
        world.set(x, y, z1, brick);
      }
    }
    for (let z = z0; z <= z1; z++) {
      if ((z - z0) % every === 0) {
        world.set(x0, y, z, brick);
        world.set(x1, y, z, brick);
      }
    }
  };
  const tower = (tx: number, tz: number, radius: number, height: number, roof: number) => {
    box(tx - radius, tx + radius, tz - radius, tz + radius, floor + 1, floor + height, brick);
    // Window bands and slit windows give the towers a habitable interior.
    for (let y = floor + 4; y < floor + height - 1; y += 5) {
      world.set(tx - radius - 1, y, tz, glass);
      world.set(tx + radius + 1, y, tz, glass);
      world.set(tx, y, tz - radius - 1, glass);
    }
    battlements(tx - radius - 1, tx + radius + 1, tz - radius - 1, tz + radius + 1, floor + height + 1);
    // Stepped slate roof with a glowing finial.
    for (let layer = 0; layer < 4; layer++) {
      const r = radius + 1 - layer;
      box(tx - r, tx + r, tz - r, tz + r, floor + height + 2 + layer, floor + height + 2 + layer, roof);
    }
    world.set(tx, floor + height + 6, tz, torch);
    world.set(tx, floor + height + 7, tz, gold);
  };
  const wing = (x0: number, x1: number, z0: number, z1: number, height: number) => {
    // Thick perimeter walls, open interior, regular enchanted windows.
    box(x0, x1, z0, z0 + 1, floor + 1, floor + height, brick);
    box(x0, x1, z1 - 1, z1, floor + 1, floor + height, brick);
    box(x0, x0 + 1, z0, z1, floor + 1, floor + height, brick);
    box(x1 - 1, x1, z0, z1, floor + 1, floor + height, brick);
    for (let y = floor + 4; y < floor + height - 1; y += 4) {
      for (let x = x0 + 3; x < x1 - 1; x += 5) {
        world.set(x, y, z0 - 1, glass);
        world.set(x, y, z1 + 1, glass);
      }
    }
    // Long stepped roof, taller at its ridge.
    for (let layer = 0; layer < 5; layer++) {
      box(x0 + layer, x1 - layer, z0 + layer, z1 - layer, floor + height + 1 + layer, floor + height + 1 + layer, plank);
    }
  };

  // A broad square foundation and a paved great courtyard.
  box(cx - outer, cx + outer, cz - outer, cz + outer, 1, floor - 1, stone);
  box(cx - outer, cx + outer, cz - outer, cz + outer, floor, floor, brick);
  clear(cx - outer + 2, cx + outer - 2, cz - outer + 2, cz + outer - 2, floor + 1, WORLD_Y - 1);

  // Double-thickness curtain wall, crenels, corner towers and four gate arches.
  for (let d = -outer; d <= outer; d++) {
    for (let t = 0; t < 2; t++) {
      for (let y = floor + 1; y <= floor + wallH; y++) {
        world.set(cx + d, y, cz - outer + t, brick);
        world.set(cx + d, y, cz + outer - t, brick);
        world.set(cx - outer + t, y, cz + d, brick);
        world.set(cx + outer - t, y, cz + d, brick);
      }
    }
  }
  // South gatehouse: open arch, portcullis, lanterns and a covered bridge lip.
  clear(cx - 3, cx + 3, cz + outer - 2, cz + outer + 1, floor + 1, floor + 5);
  box(cx - 5, cx + 5, cz + outer - 3, cz + outer + 2, floor + 1, floor + wallH + 3, brick);
  clear(cx - 3, cx + 3, cz + outer - 4, cz + outer + 3, floor + 1, floor + 5);
  for (let x = cx - 2; x <= cx + 2; x++) world.set(x, floor + 3, cz + outer - 3, gold);
  // Tall stained-glass gatehouse windows and a crenellated parapet.
  for (const x of [cx - 4, cx + 4]) {
    for (const y of [floor + 6, floor + 8, floor + 10]) world.set(x, y, cz + outer - 3, glass);
  }
  battlements(cx - 5, cx + 5, cz + outer - 4, cz + outer + 3, floor + wallH + 4);
  box(cx - 6, cx + 6, cz + outer + 3, cz + outer + 7, floor, floor + 1, stone);
  battlements(cx - outer, cx + outer, cz - outer, cz + outer, floor + wallH + 1);

  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    tower(cx + sx * outer, cz + sz * outer, 3, towerH, plank);
  }
  // Intermediate watchtowers make the silhouette a school campus, not a box.
  tower(cx - outer, cz, 2, 15, plank);
  tower(cx + outer, cz, 2, 16, plank);
  tower(cx - 10, cz - outer, 2, 14, plank);
  tower(cx + 10, cz - outer, 2, 14, plank);

  // Central keep and its tall observatory crown.
  const kh = 10;
  box(cx - kh, cx + kh, cz - kh, cz - kh + 1, floor + 1, floor + keepH, brick);
  box(cx - kh, cx + kh, cz + kh - 1, cz + kh, floor + 1, floor + keepH, brick);
  box(cx - kh, cx - kh + 1, cz - kh, cz + kh, floor + 1, floor + keepH, brick);
  box(cx + kh - 1, cx + kh, cz - kh, cz + kh, floor + 1, floor + keepH, brick);
  for (let y = floor + 5; y < floor + keepH - 2; y += 5) {
    for (const side of [-1, 1]) {
      world.set(cx + side * (kh + 1), y, cz - 4, glass);
      world.set(cx + side * (kh + 1), y, cz + 4, glass);
    }
  }
  clear(cx - 2, cx + 2, cz + kh - 2, cz + kh + 1, floor + 1, floor + 4);
  battlements(cx - kh - 1, cx + kh + 1, cz - kh - 1, cz + kh + 1, floor + keepH + 1);
  for (let layer = 0; layer < 6; layer++) {
    const r = kh + 1 - layer;
    box(cx - r, cx + r, cz - r, cz + r, floor + keepH + 2 + layer, floor + keepH + 2 + layer, plank);
  }
  world.set(cx, floor + keepH + 8, cz, gold);
  world.set(cx, floor + keepH + 9, cz, torch);

  // Four connected academic wings and a taller great hall at the north end.
  wing(cx - 25, cx - 12, cz - 15, cz + 15, 12);
  wing(cx + 12, cx + 25, cz - 15, cz + 15, 13);
  wing(cx - 12, cx + 12, cz - 25, cz - 13, 15);
  wing(cx - 11, cx + 11, cz + 13, cz + 25, 11);
  tower(cx, cz - 23, 4, 19, plank);

  // Courtyard braziers and four small magical garden pools.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const x = cx + sx * 17;
    const z = cz + sz * 17;
    box(x - 2, x + 2, z - 2, z + 2, floor + 1, floor + 1, stone);
    world.set(x, floor + 2, z, torch);
    box(x - 1, x + 1, z - 1, z + 1, floor + 1, floor + 1, glass);
  }

  // A block-built moat, drawbridge and formal approach fill the foreground of
  // the start map and give the gate a readable arrival sequence.
  for (let d = -outer - 3; d <= outer + 3; d++) {
    for (let t = 0; t < 2; t++) {
      world.set(cx + d, floor + 1, cz - outer - 3 + t, glass);
      world.set(cx + d, floor + 1, cz + outer + 3 - t, glass);
      world.set(cx - outer - 3 + t, floor + 1, cz + d, glass);
      world.set(cx + outer + 3 - t, floor + 1, cz + d, glass);
    }
  }
  box(cx - 4, cx + 4, cz + outer + 3, cz + outer + 12, floor + 1, floor + 2, plank);
  box(cx - 5, cx + 5, cz + outer + 12, cz + outer + 15, floor + 1, floor + 1, stone);
  for (let z = cz + outer + 9; z <= cz + outer + 15; z += 2) {
    world.set(cx - 5, floor + 2, z, torch);
    world.set(cx + 5, floor + 2, z, torch);
  }

  // Astronomy garden / glasshouse in the south-east courtyard.
  box(cx + 4, cx + 10, cz + 5, cz + 12, floor + 1, floor + 4, glass);
  box(cx + 3, cx + 11, cz + 4, cz + 13, floor + 5, floor + 5, glass);
  box(cx + 6, cx + 8, cz + 7, cz + 10, floor + 1, floor + 1, gold);
  for (let z = cz + 6; z <= cz + 11; z += 2) world.set(cx + 7, floor + 2, z, torch);

  // Garden parterres, hedges and carved stone seats around the courtyard.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const gx = cx + sx * 13;
    const gz = cz + sz * 13;
    box(gx - 4, gx + 4, gz - 1, gz + 1, floor + 1, floor + 1, id("oak-leaves"));
    box(gx - 1, gx + 1, gz - 4, gz + 4, floor + 1, floor + 1, id("oak-leaves"));
    box(gx - 2, gx + 2, gz - 2, gz + 2, floor + 1, floor + 1, glass);
    world.set(gx, floor + 2, gz, torch);
  }

  // The island edge is a managed school park rather than empty terrain.
  for (let i = 0; i < 20; i++) {
    const side = i % 4;
    const lane = 6 + (i * 7) % 25;
    const x = side === 0 ? cx - outer - 4 : side === 1 ? cx + outer + 4 : cx - outer + lane;
    const z = side === 2 ? cz - outer - 4 : side === 3 ? cz + outer + 4 : cz - outer + lane;
    const top = surfaceY(world, x, z);
    if (top > floor - 2 && top < WORLD_Y - 5 && !(side === 3 && Math.abs(x - cx) < 10)) {
      for (let y = top + 1; y <= top + 3; y++) world.set(x, y, z, id("oak-log"));
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.abs(dx) + Math.abs(dz) < 4) world.set(x + dx, top + 4, z + dz, id("oak-leaves"));
        }
      }
    }
  }

  // Four guaranteed lawn courts keep the expanded island readable at its
  // corners and provide safe landing pads for exploration.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const gx = cx + sx * (outer + 6);
    const gz = cz + sz * (outer + 6);
    box(gx - 4, gx + 4, gz - 4, gz + 4, floor + 1, floor + 1, id("grass"));
    box(gx - 1, gx + 1, gz - 7, gz + 7, floor + 2, floor + 2, stone);
    box(gx - 7, gx + 7, gz - 1, gz + 1, floor + 2, floor + 2, stone);
    const treeX = gx + 3;
    const treeZ = gz + 3;
    for (let y = floor + 2; y <= floor + 5; y++) world.set(treeX, y, treeZ, id("oak-log"));
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) < 4) world.set(treeX + dx, floor + 6, treeZ + dz, id("oak-leaves"));
      }
    }
  }

  // Preserve a green playable island rim around the much larger school.
  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      if (Math.abs(x - cx) <= outer + 1 && Math.abs(z - cz) <= outer + 1) continue;
      for (let y = WORLD_Y - 1; y >= 1; y--) {
        const cell = world.get(x, y, z);
        if (cell !== AIR) {
          if (cell === stone || cell === id("dirt")) world.set(x, y, z, id("grass"));
          break;
        }
      }
    }
  }
}
