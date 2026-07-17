/**
 * World-landmark voxel blueprints at REAL-WORLD scale — the Eiffel Tower is
 * 330 m tall here, the Great Pyramid's base is 230 m wide. Each landmark
 * picks its own voxel size (1.6 m sandstone courses for the pyramid, 0.4 m
 * blocks for the statue) so world dimensions are true while voxel counts
 * stay in the 15k–35k range. A post-pass bakes per-voxel realism: ambient
 * occlusion (crevices darken), deterministic color noise (no two bricks
 * identical) and ground-up weathering. Zero external assets.
 *
 * Blueprints are block lists in build order (bottom-up, spiraling) so
 * construction rises naturally. Workers deliver BUNDLES: one delivery lays
 * `deliverySize` voxels, keeping pacing constant (~DELIVERY_TARGET
 * deliveries per landmark) regardless of detail.
 */

export const DELIVERY_TARGET = 250; // deliveries to finish any landmark

export interface BlueprintBlock {
  x: number;
  y: number;
  z: number;
  color: string;
  /** Selects a physically distinct finish without adding a draw call per block. */
  surface: "masonry" | "metal" | "glass" | "emissive";
}

export interface Landmark {
  id: string;
  name: string;
  emoji: string;
  country: string;
  /** Real-world height, for the HUD plaque. */
  realHeightM: number;
  /** Meters per voxel for THIS landmark. */
  voxelSizeM: number;
  blocks: BlueprintBlock[];
  /** Voxels laid per worker delivery (bundle size). */
  deliverySize: number;
  /** Planar bounding radius + height in METERS (camera framing). */
  radiusM: number;
  heightM: number;
  /** Completion bonus in gold (base — world-tour multiplier applies). */
  bonus: number;
}

// ---------------------------------------------------------------- helpers

/** Deterministic per-voxel hash → [0,1). */
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

class Builder {
  readonly map = new Map<string, BlueprintBlock>();

  add(x: number, y: number, z: number, color: string): void {
    x = Math.round(x);
    y = Math.round(y);
    z = Math.round(z);
    if (y < 0) return;
    this.map.set(`${x},${y},${z}`, { x, y, z, color, surface: surfaceForColor(color) });
  }

  remove(x: number, y: number, z: number): void {
    this.map.delete(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`);
  }

  has(x: number, y: number, z: number): boolean {
    return this.map.has(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`);
  }

  /** Fill isolated one-voxel voids while preserving authored doors, arches and lattice bays. */
  sealMicroGaps(passes = 2): void {
    const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const;
    for (let pass = 0; pass < passes; pass++) {
      const candidates = new Map<string, { x: number; y: number; z: number }>();
      for (const block of this.map.values()) {
        for (const [dx, dy, dz] of directions) {
          const x = block.x + dx;
          const y = block.y + dy;
          const z = block.z + dz;
          if (y < 0 || this.has(x, y, z)) continue;
          candidates.set(`${x},${y},${z}`, { x, y, z });
        }
      }

      const fills: Array<{ x: number; y: number; z: number; color: string }> = [];
      for (const candidate of candidates.values()) {
        const neighbours: BlueprintBlock[] = [];
        for (const [dx, dy, dz] of directions) {
          const neighbour = this.map.get(
            `${candidate.x + dx},${candidate.y + dy},${candidate.z + dz}`,
          );
          if (neighbour) neighbours.push(neighbour);
        }
        // A surface pinhole has four or more supports; real openings do not.
        if (neighbours.length >= 4) {
          const colors = new Map<string, number>();
          for (const neighbour of neighbours) {
            colors.set(neighbour.color, (colors.get(neighbour.color) ?? 0) + 1);
          }
          const color = [...colors].sort((a, b) => b[1] - a[1])[0]![0];
          fills.push({ ...candidate, color });
        }
      }
      if (fills.length === 0) break;
      for (const fill of fills) this.add(fill.x, fill.y, fill.z, fill.color);
    }
  }

  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: string,
    hollow = false,
  ): void {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          if (hollow && x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;
          this.add(x, y, z, color);
        }
      }
    }
  }

  ring(
    cx: number,
    cz: number,
    y: number,
    radius: number,
    color: string,
    opts: {
      thick?: number;
      steps?: number;
      skip?: (angle: number, step: number) => boolean;
      squashZ?: number;
    } = {},
  ): void {
    // sample at FULL circumference density (airtight wall), but expose a
    // COARSE pattern index to `skip` so colonnades keep their column rhythm
    const patternSteps = opts.steps ?? Math.max(12, Math.ceil(radius * 8));
    const dense = Math.max(patternSteps, 12, Math.ceil(radius * 10));
    const thick = opts.thick ?? 1;
    const squash = opts.squashZ ?? 1;
    for (let k = 0; k < dense; k++) {
      const a = (k / dense) * Math.PI * 2;
      const i = Math.floor((a / (Math.PI * 2)) * patternSteps) % patternSteps;
      if (opts.skip?.(a, i)) continue;
      for (let t = 0; t < thick; t++) {
        const r = radius - t;
        if (r <= 0) continue;
        this.add(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r * squash, color);
      }
    }
  }

  disk(cx: number, cz: number, y: number, radius: number, color: string, squashZ = 1): void {
    const rz = radius * squashZ;
    for (let x = Math.floor(-radius); x <= radius; x++) {
      for (let z = Math.floor(-rz); z <= rz; z++) {
        if ((x * x) / (radius * radius) + (z * z) / (rz * rz) <= 1.02) {
          this.add(cx + x, y, cz + z, color);
        }
      }
    }
  }

  line(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    color: string,
    thick = 1,
  ): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1) * 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const z = z0 + (z1 - z0) * t;
      for (let dx = 0; dx < thick; dx++) {
        for (let dz = 0; dz < thick; dz++) {
          this.add(x + dx, y, z + dz, color);
        }
      }
    }
  }

  /** Bottom-up, spiral within each layer — the natural build order. */
  finish(): BlueprintBlock[] {
    return [...this.map.values()].sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      const angA = Math.atan2(a.z, a.x);
      const angB = Math.atan2(b.z, b.x);
      if (Math.abs(angA - angB) > 1e-9) return angA - angB;
      return Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z);
    });
  }
}

/** Bake realism: ambient occlusion, per-brick color noise, weathering. */
function bakeRealism(b: Builder, blocks: BlueprintBlock[], weathering: number): void {
  let maxY = 1;
  for (const blk of blocks) maxY = Math.max(maxY, blk.y);
  for (const blk of blocks) {
    let occ = 0;
    if (b.has(blk.x + 1, blk.y, blk.z)) occ++;
    if (b.has(blk.x - 1, blk.y, blk.z)) occ++;
    if (b.has(blk.x, blk.y + 1, blk.z)) occ++;
    if (b.has(blk.x, blk.y, blk.z + 1)) occ++;
    if (b.has(blk.x, blk.y, blk.z - 1)) occ++;
    const ao = 1 - Math.min(occ * 0.045, 0.2);
    const grime = 1 - weathering * Math.max(0, 1 - (blk.y / maxY) * 2.5) * 0.18;
    const noise = 0.94 + hash3(blk.x, blk.y, blk.z) * 0.12;
    blk.color = shade(blk.color, ao * grime * noise);
  }
}

function make(
  id: string,
  name: string,
  emoji: string,
  country: string,
  bonus: number,
  realHeightM: number,
  voxelSizeM: number,
  weathering: number,
  build: (b: Builder, V: (meters: number) => number) => void,
): Landmark {
  const b = new Builder();
  build(b, (meters) => meters / voxelSizeM);
  b.sealMicroGaps();
  const blocks = b.finish();
  bakeRealism(b, blocks, weathering);
  let r = 0;
  let h = 0;
  for (const blk of blocks) {
    r = Math.max(r, Math.hypot(blk.x, blk.z));
    h = Math.max(h, blk.y);
  }
  return {
    id,
    name,
    emoji,
    country,
    realHeightM,
    voxelSizeM,
    blocks,
    deliverySize: Math.max(1, Math.round(blocks.length / DELIVERY_TARGET)),
    radiusM: (r + 1) * voxelSizeM,
    heightM: (h + 1) * voxelSizeM,
    bonus,
  };
}

// ---------------------------------------------------------------- palette

const SAND = "#e3c489";
const SAND_DARK = "#c9a765";
const STONE = "#e9e1cf";
const STONE_DARK = "#cfc5ab";
const TRAVERTINE = "#e6d9bc";
const IRON = "#6e5138";
const IRON_DARK = "#544030";
const COPPER = "#5fae85";
const COPPER_DARK = "#478a68";
const GOLD = "#ffd21c";
const BRICK = "#bd6737";
const WHITE = "#f4f3ee";
const MARBLE = "#efece2";
const RED = "#d94040";
const WINDOW = "#1c2b38";
const GLASS = "#2e4b61";
const INTERIOR = "#262c33"; // dark room seen through windows/arches
const FLAME = "#ffa022";
const GRASS = "#55924a";
const GRASS_LIGHT = "#67a757";

/** Preserve material intent while the realism pass later varies each colour. */
function surfaceForColor(color: string): BlueprintBlock["surface"] {
  if (color === GLASS || color === WINDOW) return "glass";
  if (color === GOLD || color === FLAME || color === RED) return "emissive";
  if (
    color === IRON ||
    color === IRON_DARK ||
    color === COPPER ||
    color === COPPER_DARK
  ) return "metal";
  return "masonry";
}

// ---------------------------------------------------------------- landmarks
// All dimensions below are REAL: V(meters) converts to this landmark's voxels.

/** 기자의 피라미드 — 실측 밑변 230m × 높이 139m, 1.6m 석재 코스. */
const pyramid = make("pyramid", "Great Pyramid of Giza", "🔺", "Egypt", 500, 139, 1.6, 0.9, (b, V) => {
  const baseHalf = V(115); // 230 m base
  const height = V(139);
  for (let y = 0; y <= height; y++) {
    const half = Math.round(baseHalf * (1 - y / (height + 1)));
    if (half < 0) break;
    const color = y % 7 === 6 ? SAND_DARK : SAND;
    if (half <= 2) {
      b.box(-half, half, y, y, -half, half, GOLD); // gilded capstone courses
      continue;
    }
    // each course is an ANNULUS down to the next course's footprint, so the
    // step ledges are solid stone — no hollow interior visible from above
    const nextHalf = Math.round(baseHalf * (1 - (y + 1) / (height + 1)));
    const inner = Math.max(0, nextHalf - 1);
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        const m = Math.max(Math.abs(x), Math.abs(z));
        if (m < inner) continue;
        const ledge = m < half && y % 4 === 2;
        b.add(x, y, z, ledge ? SAND_DARK : color);
      }
    }
  }
  // recessed entrance on the +z face (real one sits ~17 m up the north face)
  const entY0 = V(10);
  const entY1 = V(17);
  for (let y = entY0; y <= entY1; y++) {
    const half = Math.round(baseHalf * (1 - y / (height + 1)));
    for (let x = -V(3); x <= V(3); x++) {
      b.remove(x, y, half);
      b.remove(x, y, half - 1);
      b.add(x, y, half - 2, WINDOW);
    }
  }
});

/** 빅벤(엘리자베스 타워) — 실측 96m, 0.5m 블록: 창틀·시계판·도머 첨탑. */
const bigBen = make("bigben", "Big Ben", "🕰️", "United Kingdom", 900, 96, 0.5, 0.7, (b, V) => {
  const half = V(6); // 12 m square shaft
  b.box(-half - 3, half + 3, 0, V(3), -half - 3, half + 3, STONE_DARK);
  const shaftTop = V(55);
  for (let y = V(3) + 1; y <= shaftTop; y++) {
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        const edge = Math.abs(x) === half || Math.abs(z) === half;
        if (!edge) continue;
        const u = Math.abs(x) === half ? z : x;
        const corner = Math.abs(u) >= half - 2;
        const stringCourse = y % V(11) <= 1;
        const bayCenters = [-Math.round(half * 0.55), 0, Math.round(half * 0.55)];
        const inBay = bayCenters.some((c) => Math.abs(u - c) <= 1);
        const frame = bayCenters.some((c) => Math.abs(u - c) === 2);
        let color = BRICK;
        if (corner || stringCourse || frame) color = STONE;
        else if (inBay) color = y % V(4.5) < V(3) ? GLASS : STONE_DARK;
        b.add(x, y, z, color);
      }
    }
    // dark interior liner: windows read as rooms, never as see-through holes
    b.box(-(half - 1), half - 1, y, y, -(half - 1), half - 1, INTERIOR, true);
  }
  // clock stage (dial is really 7 m across, centre ~55 m up)
  const stageHalf = half + 2;
  b.box(-stageHalf, stageHalf, shaftTop + 1, shaftTop + 2, -stageHalf, stageHalf, STONE_DARK, true);
  const stageTop = V(70);
  for (let y = shaftTop + 3; y <= stageTop; y++) {
    b.box(-stageHalf, stageHalf, y, y, -stageHalf, stageHalf, STONE, true);
  }
  const dialR = V(3.5);
  const cy = Math.round((shaftTop + 3 + stageTop) / 2);
  for (let u = -dialR; u <= dialR; u++) {
    for (let v = -dialR; v <= dialR; v++) {
      const r = Math.hypot(u, v);
      if (r > dialR + 0.4) continue;
      let color = WHITE;
      if (r < 1) color = WINDOW;
      else if (Math.abs(u) < 1 && v > 0) color = WINDOW;
      else if (Math.abs(v) < 1 && u > 0 && r < dialR * 0.7) color = WINDOW;
      else if (r > dialR - 1) color = GOLD;
      else if (r > dialR - 2 && Math.round((Math.atan2(v, u) / Math.PI) * 6 + 12) % 2 === 0) {
        color = WINDOW;
      }
      const y = cy + v;
      b.add(u, y, stageHalf + 1, color);
      b.add(u, y, -stageHalf - 1, color);
      b.add(stageHalf + 1, y, u, color);
      b.add(-stageHalf - 1, y, u, color);
    }
  }
  // dormered spire to 96 m
  const roofBase = stageTop + 1;
  const roofSteps = V(16);
  for (let i = 0; i <= roofSteps; i++) {
    const n = Math.round((stageHalf - 1) * (1 - i / roofSteps));
    if (n >= 1) {
      b.box(-n, n, roofBase + i, roofBase + i, -n, n, i % 2 === 0 ? COPPER_DARK : COPPER, n > 2);
      if (i === 3) {
        for (const s of [-n, n]) {
          b.add(0, roofBase + i, s, GOLD);
          b.add(s, roofBase + i, 0, GOLD);
        }
      }
    }
  }
  const lanternY = roofBase + roofSteps;
  b.box(-1, 1, lanternY + 1, lanternY + V(2.5), -1, 1, STONE, true);
  for (let y = lanternY + V(2.5) + 1; y <= V(96); y++) {
    b.add(0, y, 0, y > V(93) ? GOLD : COPPER_DARK);
  }
});

/** 피사의 사탑 — 실측 55.9m·기울기 3.97°, 0.42m 블록: 8단 아케이드. */
const pisa = make("pisa", "Leaning Tower of Pisa", "🏛️", "Italy", 1300, 56, 0.42, 0.5, (b, V) => {
  const rBase = V(7.8); // 15.5 m diameter
  const r = V(6.2);
  const tierH = V(6.2);
  const lean = Math.tan((3.97 * Math.PI) / 180); // the real tilt
  for (let tier = 0; tier < 8; tier++) {
    for (let dy = 0; dy < tierH; dy++) {
      const y = tier * tierH + dy;
      const cx = y * lean;
      const isBase = tier === 0;
      const rr = isBase ? rBase : r;
      const wallColor = tier % 2 === 0 ? MARBLE : shade(MARBLE, 0.96);
      b.ring(cx, 0, y, rr, wallColor, { thick: 2, steps: Math.ceil(rr * 7.5) });
      if (!isBase && dy >= 2 && dy <= tierH - 3) {
        const isCap = dy === 2 || dy === tierH - 3;
        b.ring(cx, 0, y, rr + 2, WHITE, {
          steps: 30,
          skip: (_a, i) => !isCap && i % 2 === 1,
        });
      }
      if (isBase && dy >= 2 && dy % 2 === 0) {
        b.ring(cx, 0, y, rr, STONE_DARK, { steps: 24, skip: (_a, i) => i % 2 === 1 });
      }
      if (dy === tierH - 1) b.disk(cx, 0, y, rr + 2, MARBLE);
    }
  }
  // belfry
  const topY = 8 * tierH;
  const belfryH = V(6);
  for (let dy = 0; dy <= belfryH; dy++) {
    const y = topY + dy;
    b.ring(y * lean, 0, y, r - 2, WHITE, {
      thick: 2,
      steps: 32,
      skip: (_a, i) => dy >= 2 && dy <= belfryH - 2 && i % 4 >= 2,
    });
  }
  b.disk((topY + belfryH + 1) * lean, 0, topY + belfryH + 1, r - 2, MARBLE);
});

/** 에펠탑 — 실측 330m(안테나 포함)·기단 125m, 1.1m 격자 부재. */
const eiffel = make("eiffel", "Eiffel Tower", "🗼", "France", 1800, 330, 1.1, 0.35, (b, V) => {
  const legBase = V(62.5); // 125 m between opposite legs
  const firstDeck = V(57);
  const secondDeck = V(115);
  const topDeck = V(276);
  const legAt = (y: number) =>
    Math.max(legBase * Math.max(0, 1 - y / (firstDeck * 1.55)) ** 1.6, V(4));
  // legs to the second deck
  for (let y = 0; y <= secondDeck; y++) {
    const s = legAt(y);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.box(sx * s - 1, sx * s + 1, y, y, sz * s - 1, sz * s + 1, IRON, y % 3 !== 0);
      }
    }
    if (y > 2 && y < firstDeck - 2 && y % 5 === 0) {
      const s2 = legAt(y + 2.5);
      for (const [ax, az, bx, bz] of [
        [1, 1, -1, 1],
        [-1, 1, -1, -1],
        [-1, -1, 1, -1],
        [1, -1, 1, 1],
      ] as const) {
        b.line(ax * s, y, az * s, bx * s2, y + 5, bz * s2, IRON_DARK, 2);
        b.line(bx * s, y, bz * s, ax * s2, y + 5, az * s2, IRON_DARK, 2);
      }
    }
  }
  // the grand arches (39 m radius openings)
  for (let t = -V(19); t <= V(19); t++) {
    const y = V(35) - (t * t) / V(11);
    if (y < V(3)) continue;
    const s = legAt(y);
    for (const [px, pz] of [
      [t, s + 1],
      [t, -s - 1],
      [s + 1, t],
      [-s - 1, t],
    ] as const) {
      b.add(px, y, pz, IRON);
      b.add(px, y + 1, pz, IRON_DARK);
    }
  }
  // first deck (57 m)
  const d1 = Math.round(legAt(firstDeck)) + V(4);
  b.box(-d1, d1, firstDeck, firstDeck + 2, -d1, d1, IRON, true);
  b.box(-d1 + 1, d1 - 1, firstDeck, firstDeck, -d1 + 1, d1 - 1, IRON_DARK, true);
  // second deck (115 m)
  const d2 = Math.round(legAt(secondDeck)) + V(2);
  b.box(-d2, d2, secondDeck, secondDeck + 2, -d2, d2, IRON, true);
  // upper lattice to the top deck (276 m)
  for (let y = secondDeck + 3; y <= topDeck; y++) {
    const t = (y - secondDeck) / (topDeck - secondDeck);
    const s = Math.max(legAt(secondDeck) * (1 - t) ** 1.1, 1.4);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.add(sx * s, y, sz * s, IRON);
        b.add(sx * s, y, sz * (s - 1), IRON);
        b.add(sx * (s - 1), y, sz * s, IRON);
      }
    }
    if (y % 5 === 0) {
      for (let i = -Math.ceil(s); i <= Math.ceil(s); i++) {
        b.add(i, y, s, IRON_DARK);
        b.add(i, y, -s, IRON_DARK);
        b.add(s, y, i, IRON_DARK);
        b.add(-s, y, i, IRON_DARK);
      }
    }
    if (y % 5 === 2) {
      const s2 = Math.max(legAt(secondDeck) * (1 - (y + 3 - secondDeck) / (topDeck - secondDeck)) ** 1.1, 1.4);
      b.line(s, y, s, -s2, y + 3, s2, IRON_DARK, 2);
      b.line(-s, y, -s, s2, y + 3, -s2, IRON_DARK, 2);
    }
  }
  // top deck + antenna to 330 m
  b.box(-3, 3, topDeck + 1, topDeck + 3, -3, 3, IRON, true);
  for (let y = topDeck + 4; y <= V(328); y++) {
    b.add(0, y, 0, IRON);
    if (y % 3 === 0) b.add(1, y, 0, IRON_DARK);
  }
  b.add(0, V(329), 0, GOLD);
  b.add(0, V(330), 0, RED);
});

/** 콜로세움 — 실측 189×156m·높이 48m, 0.95m 석재: 아치 3단+애틱. */
const colosseum = make("colosseum", "Colosseum", "🏟️", "Italy", 2400, 48, 0.95, 0.85, (b, V) => {
  const A = V(94.5); // 189 m major axis
  const C = V(78); // 156 m minor axis
  const H = V(48);
  const tierH = Math.floor(H / 3.4);
  // Six samples for each of the real 80 bays keep the elliptical wall continuous.
  const COLS = 480;
  const broken = (ang: number, y: number) =>
    y >= tierH * 2 && ang > Math.PI * 0.12 && ang < Math.PI * (y >= tierH * 2 + V(4) ? 1.25 : 1.05);
  for (let i = 0; i < COLS; i++) {
    const ang = (i / COLS) * Math.PI * 2;
    const ox = Math.cos(ang);
    const oz = Math.sin(ang);
    for (let y = 0; y <= H; y++) {
      if (broken(ang, y)) continue;
      const tierLocal = y % tierH;
      const isAttic = y > tierH * 3;
      const baySample = i % 6;
      const pier = baySample <= 1;
      const archBand = tierLocal >= 3 && tierLocal <= tierH - 3 && !isAttic;
      const archTop =
        tierLocal >= tierH - 4 && tierLocal <= tierH - 3 && baySample >= 2;
      const color = tierLocal >= tierH - 2 ? shade(TRAVERTINE, 0.9) : TRAVERTINE;
      const solid =
        !archBand || pier || archTop || (isAttic && baySample !== 3 && baySample !== 4);
      if (solid) {
        b.add(ox * A, y, oz * C, color);
        b.add(ox * (A - 1), y, oz * (C - 1), shade(TRAVERTINE, 0.85));
        if (y % 2 === 0) b.add(ox * (A - 2), y, oz * (C - 2), shade(TRAVERTINE, 0.8));
      }
      if (y <= tierH * 2 && i % 2 === 0) {
        const archInner = tierLocal >= 3 && tierLocal <= tierH - 5 && baySample >= 2;
        if (!archInner) b.add(ox * A * 0.72, y, oz * C * 0.72, shade(TRAVERTINE, 0.82));
      }
      // seating bowl
      if (y <= tierH + 2 && i % 2 === 1) {
        const rr = 0.7 - (tierH + 2 - y) * 0.014;
        if (rr > 0.45) b.add(ox * (A * rr), y, oz * (C * rr), shade(SAND_DARK, 0.9));
      }
    }
  }
  // arena (real: 83×48 m) + hypogeum corridor walls
  b.disk(0, 0, 0, V(41), SAND, 0.58);
  for (let x = -V(34); x <= V(34); x += V(7)) {
    b.box(x, x, 1, 2, -V(17), V(17), shade(SAND_DARK, 0.85));
  }
  for (let z = -V(17); z <= V(17); z += V(8)) {
    b.box(-V(34), V(34), 1, 2, z, z, shade(SAND_DARK, 0.8));
  }
});

/** 남산서울타워 — 타워 실측 236.7m, 0.9m 부재: 격자 축·전망 포드·안테나. */
const namsan = make("namsan", "N Seoul Tower", "🗼", "South Korea", 3200, 237, 0.9, 0.3, (b, V) => {
  // base hill (stylized 25 m mound — the real mountain stays home)
  const hillH = V(25);
  for (let y = 0; y <= hillH; y++) {
    const r = V(40) * (1 - y / (hillH * 1.3));
    b.ring(0, 0, y, r, y % 2 === 0 ? GRASS : GRASS_LIGHT, { thick: 3, steps: Math.ceil(r * 7) });
    if (y === hillH) b.disk(0, 0, y, r, GRASS);
    if (y < hillH - 2) {
      for (let k = 0; k < 7; k++) {
        const a = hash3(y, k, 7) * Math.PI * 2;
        if (hash3(k, y, 3) > 0.5) {
          const rr = r + 2;
          b.add(Math.cos(a) * rr, y + 1, Math.sin(a) * rr, shade(GRASS, 0.7));
          b.add(Math.cos(a) * rr, y + 2, Math.sin(a) * rr, shade(GRASS_LIGHT, 0.8));
        }
      }
    }
  }
  // shaft to the pod (~135 m of tower)
  const podBase = V(160);
  for (let y = hillH + 1; y <= podBase; y++) {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      b.box(
        Math.cos(a) * V(5.5) - 0.5,
        Math.cos(a) * V(5.5) + 0.5,
        y,
        y,
        Math.sin(a) * V(5.5) - 0.5,
        Math.sin(a) * V(5.5) + 0.5,
        WHITE,
      );
    }
    b.box(-1, 1, y, y, -1, 1, shade(WHITE, 0.92), true);
    if (y % V(5.5) === 0) b.ring(0, 0, y, V(5.5), STONE_DARK, { steps: 26 });
    if (y % 7 === 3 && y < podBase - 4) {
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const a2 = ((k + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        b.line(
          Math.cos(a) * V(5.5),
          y,
          Math.sin(a) * V(5.5),
          Math.cos(a2) * V(5.5),
          y + 4,
          Math.sin(a2) * V(5.5),
          shade(WHITE, 0.85),
        );
      }
    }
  }
  // observation pod (real diameter ~26 m)
  const podR = V(13);
  b.disk(0, 0, podBase + 1, podR - 2, STONE_DARK);
  b.disk(0, 0, podBase + 2, podR, shade(STONE_DARK, 0.9));
  for (let y = podBase + 3; y <= podBase + 8; y++) {
    const isWindowBand = y >= podBase + 4 && y <= podBase + 6;
    b.ring(0, 0, y, podR, isWindowBand ? GLASS : WHITE, { thick: 2, steps: 84 });
    if (isWindowBand && y === podBase + 5) b.ring(0, 0, y, podR, WHITE, { steps: 21 });
  }
  b.ring(0, 0, podBase + 9, podR - 1, "#3a97c9", { steps: 76, thick: 2 });
  b.disk(0, 0, podBase + 10, podR - 3, STONE_DARK);
  b.disk(0, 0, podBase + 11, podR - 6, shade(STONE_DARK, 0.92));
  // antenna to 237 m
  for (let y = podBase + 12; y <= V(236); y++) {
    const seg = Math.floor((y - podBase) / 7) % 2 === 0;
    b.add(0, y, 0, seg ? RED : WHITE);
    if (y < V(200)) b.add(1, y, 0, seg ? RED : WHITE);
    if (y % 10 === 0) {
      b.add(2, y, 0, STONE_DARK);
      b.add(-1, y, 0, STONE_DARK);
      b.add(0, y, 2, STONE_DARK);
      b.add(0, y, -1, STONE_DARK);
    }
  }
});

/** 자유의 여신상 — 횃불까지 실측 93m(동상 46m), 0.55m 동판. */
const liberty = make("liberty", "Statue of Liberty", "🗽", "United States", 4200, 93, 0.4, 0.4, (b, V) => {
  // star fort (Fort Wood's 11-point star, ~5 m tall) — shell walls + rays
  for (let y = 0; y <= V(5); y++) {
    b.ring(0, 0, y, V(16) - y, STONE_DARK, { thick: 3, steps: Math.ceil((V(16) - y) * 7) });
    if (y <= 2) {
      for (let k = 0; k < 11; k++) {
        const a = (k / 11) * Math.PI * 2;
        b.line(
          Math.cos(a) * V(10),
          y,
          Math.sin(a) * V(10),
          Math.cos(a) * (V(21) - y),
          y,
          Math.sin(a) * (V(21) - y),
          shade(STONE_DARK, 0.92),
          1,
        );
      }
    }
  }
  b.disk(0, 0, V(5), V(13), STONE_DARK); // fort terrace
  // pedestal (real: 47 m to the statue's feet, tapering granite)
  const pedTop = V(47);
  for (let y = V(5) + 1; y <= pedTop; y++) {
    const t = (y - V(5)) / (pedTop - V(5));
    const half = Math.round(V(15) - t * V(6));
    b.box(-half, half, y, y, -half, half, y % V(4) === 0 ? STONE_DARK : STONE, true);
    if (t > 0.35 && t < 0.85) {
      for (const s of [-Math.round(half / 2), 0, Math.round(half / 2)]) {
        b.add(s, y, half, WINDOW);
        b.add(s, y, -half, WINDOW);
        b.add(half, y, s, WINDOW);
        b.add(-half, y, s, WINDOW);
      }
    }
  }
  b.box(-V(10), V(10), pedTop + 1, pedTop + 2, -V(10), V(10), STONE_DARK, true);
  // robed figure (statue itself: 46 m from feet to torch)
  const bodyBase = pedTop + 3;
  const shoulders = bodyBase + V(28);
  for (let y = bodyBase; y <= shoulders; y++) {
    const t = (y - bodyBase) / (shoulders - bodyBase);
    // Broad robe hem, pinched waist and a distinct shoulder mantle.
    const radiusM =
      t < 0.58
        ? 8.2 - (t / 0.58) * 3.15
        : t < 0.82
          ? 5.05 - ((t - 0.58) / 0.24) * 0.75
          : 4.3 + ((t - 0.82) / 0.18) * 1.65;
    const baseR = V(radiusM);
    const steps = Math.ceil(baseR * 8.5);
    const bodyShiftX = Math.sin(t * Math.PI) * V(0.28);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const foldWave = Math.sin(a * 9 + t * 3.1) + Math.sin(a * 5 - t * 5.4) * 0.42;
      const fold = foldWave > 0.48 ? 2 : foldWave < -0.72 ? -1 : 0;
      const wrinkle = Math.sin(a * 19 + t * 7) > 0.78 ? 1 : 0;
      const mantle = t > 0.78 && Math.sin(a + 0.6) > 0.15 ? V(0.55) : 0;
      const r = baseR + (fold + wrinkle) * 0.72 + mantle;
      const color = fold > 0 ? COPPER_DARK : wrinkle > 0 ? shade(COPPER, 0.92) : COPPER;
      b.add(bodyShiftX + Math.cos(a) * r, y, Math.sin(a) * r + 1, color);
      if (fold > 0) {
        b.add(bodyShiftX + Math.cos(a) * (r - 1), y, Math.sin(a) * (r - 1) + 1, COPPER_DARK);
        if (y % 3 === 0) b.add(bodyShiftX + Math.cos(a) * (r + 1), y, Math.sin(a) * (r + 1) + 1, shade(COPPER, 1.05));
      }
    }
    // inner liner: fold gaps must reveal dark drapery depth, never hollow air
    b.ring(bodyShiftX, 1, y, baseR - 1.5, shade(COPPER_DARK, 0.72), { thick: 1 });
    if (y === bodyBase) b.disk(0, 1, y, baseR + 1, COPPER);
  }
  b.ring(0, 0.4, shoulders, V(5.7), COPPER_DARK, {
    thick: 3,
    steps: Math.ceil(V(5.7) * 8.5),
  });
  for (let y = shoulders + 1; y <= shoulders + V(2.2); y++) {
    b.ring(0, 0.2, y, V(1.75), COPPER, {
      thick: 2,
      steps: Math.ceil(V(1.75) * 9),
    });
  }
  // tablet arm (left) — the tabula is really 7.2 m tall
  b.line(-V(4), shoulders - V(3), 1, -V(10), shoulders - V(9), 2, COPPER, 3);
  b.box(-V(13), -V(9.5), shoulders - V(10), shoulders - V(2.8), 2, 4, COPPER_DARK);
  b.box(-V(12.5), -V(10), shoulders - V(9), shoulders - V(4), 3, 3, shade(COPPER, 1.08));
  // Finger channels, inset tablet border and a compact hint of the inscription.
  for (let finger = 0; finger < 4; finger++) {
    b.line(-V(10.2) - finger, shoulders - V(4.2), 1, -V(10.2) - finger, shoulders - V(6.3), 1, COPPER_DARK);
  }
  b.box(-V(12.2), -V(10.3), shoulders - V(8.6), shoulders - V(8.3), 1, 1, shade(COPPER, 0.7));
  b.box(-V(12.2), -V(10.3), shoulders - V(5.1), shoulders - V(4.8), 1, 1, shade(COPPER, 0.7));
  for (let mark = 0; mark < 5; mark++) {
    b.add(-V(11.8) + mark * 2, shoulders - V(6.7), 1, COPPER_DARK);
  }
  // torch arm (right) — torch flame tops out at 93 m
  // torch arm raised (right) — flame tops out at the real 93 m
  const torchTip = V(92);
  b.line(V(4), shoulders - V(1), 0, V(10.5), torchTip - V(6), 0, COPPER, 3);
  b.box(V(9.5), V(12.5), torchTip - V(6), torchTip - V(4.8), -2, 2, COPPER_DARK); // hand
  for (let finger = -2; finger <= 2; finger++) {
    b.line(V(10), torchTip - V(5.1) + finger, -2, V(12.1), torchTip - V(5.1) + finger, -2, shade(COPPER, finger % 2 ? 0.86 : 1));
  }
  // torch balcony: gold ring with balusters
  const torchX = V(11);
  b.ring(torchX, 0, torchTip - V(4.2), V(1.6), GOLD, { thick: 2, steps: 16 });
  b.ring(torchX, 0, torchTip - V(3.4), V(1.8), GOLD, { steps: 16 });
  b.ring(torchX, 0, torchTip - V(2.6), V(1.9), GOLD, { steps: 18 });
  // flame: voxel teardrop, bright core with golden skin
  const flameBase = torchTip - V(2.2);
  for (let y = flameBase; y <= torchTip; y++) {
    const t = (y - flameBase) / Math.max(1, torchTip - flameBase);
    const r = Math.max(0.6, V(1.5) * Math.sin(Math.PI * (0.25 + t * 0.7)));
    b.disk(torchX + Math.sin(t * 3) * 0.6, 0, y, r, t > 0.75 ? FLAME : GOLD);
  }
  b.add(torchX, torchTip + 1, 0, FLAME); // licking tip

  // head — solid sculpted head (real face is 5 m tall), front faces -z
  const headBase = shoulders + V(1.7);
  const headH = V(6);
  const headTop = headBase + headH;
  for (let y = headBase; y <= headTop; y++) {
    const t = (y - headBase) / headH;
    // skull profile: narrow chin → full crown
    const r = V(2.9) * (0.62 + 0.5 * Math.sin(Math.PI * (0.22 + t * 0.6)));
    b.disk(0, 1, y, r, COPPER, 0.86);
    // flowing hair at the back and sides
    if (t < 0.75) {
      b.ring(0, 1.6, y, r + 1, COPPER_DARK, {
        thick: 2,
        steps: Math.ceil((r + 1) * 8.5),
        skip: (a) => Math.sin(a) < 0.15,
      });
    }
  }
  // face carving (front surface ≈ z = 1 - r)
  const eyeY = headBase + Math.round(headH * 0.55);
  const faceR = V(2.9) * (0.62 + 0.5 * Math.sin(Math.PI * (0.22 + 0.55 * 0.6)));
  const faceZ = Math.round(1 - faceR);
  for (const sx of [-1, 1]) {
    const ex = sx * V(0.82);
    b.box(ex - 1, ex + 1, eyeY, eyeY, faceZ - 1, faceZ, COPPER_DARK);
    b.line(ex - 2, eyeY + 2, faceZ, ex + 2, eyeY + 1, faceZ - 1, shade(COPPER, 0.76));
    b.add(sx * V(1.45), eyeY - 1, faceZ, shade(COPPER, 1.08));
  }
  for (let y = eyeY - 3; y <= eyeY + 1; y++) {
    b.add(0, y, faceZ - 2, shade(COPPER, 1.13));
    if (y < eyeY) b.add(1, y, faceZ - 1, shade(COPPER, 1.04));
  }
  b.box(-V(0.8), V(0.8), eyeY - V(1.55), eyeY - V(1.4), faceZ - 1, faceZ - 1, shade(COPPER, 0.69));
  b.box(-V(0.65), V(0.65), eyeY - V(1.9), eyeY - V(1.75), faceZ, faceZ, shade(COPPER, 0.88));
  b.box(-V(1.25), V(1.25), eyeY - V(2.5), eyeY - V(2.2), faceZ + 1, faceZ + 2, COPPER_DARK);

  // crown: diadem band + windowed brow plate + SEVEN thick rays (real: 2.7 m)
  b.ring(0, 1, headTop, V(3), shade(COPPER, 1.12), {
    thick: 3,
    steps: Math.ceil(V(3) * 9),
  });
  b.ring(0, 1, headTop + 1, V(2.8), shade(COPPER, 1.06), {
    thick: 3,
    steps: Math.ceil(V(2.8) * 9),
  });
  for (let k = 0; k < 7; k++) {
    // the 25 crown windows hint: dark voxels between ray roots
    const wa = Math.PI + Math.PI * (0.1 + (k / 7) * 0.8);
    b.add(Math.cos(wa) * V(2.6), headTop, 1 + Math.sin(wa) * V(2.6), WINDOW);
  }
  for (let k = 0; k < 7; k++) {
    const a = Math.PI + Math.PI * (0.05 + (k / 6) * 0.9);
    const dx = Math.cos(a) * V(5.2);
    const dz = Math.sin(a) * V(5.2);
    b.line(0, headTop + 1, 1, dx, headTop + V(3.8), 1 + dz, shade(COPPER, 1.05), 2);
    b.add(dx, headTop + V(3.8) + 1, 1 + dz, shade(COPPER, 1.15)); // ray tip
  }
});

/** The world tour, roughly ascending effort. */
export const LANDMARKS: Landmark[] = [pyramid, bigBen, pisa, eiffel, colosseum, namsan, liberty];

export function landmarkAt(index: number): Landmark {
  return LANDMARKS[index % LANDMARKS.length]!;
}

export function tourOf(index: number): number {
  return Math.floor(index / LANDMARKS.length);
}

/** Gold multiplier for repeat world tours (prestige-lite). */
export function tourMultiplier(tour: number): number {
  return 1.5 ** tour;
}
