/**
 * Minecraft-style water, as a pure cellular automaton shared by the client
 * (solo island / field) and the classroom server (the authority for a shared
 * field). It reads and writes block ids through `FluidWorld`, so it knows
 * nothing of grids, windows or sockets.
 *
 * Water is ordinary block ids, so saves, the field's edit bank and the
 * classroom wire carry it unchanged:
 *   19        a SOURCE — what a player places; never drains on its own
 *   20 … 26   FLOWING water, level 1 … 7 (one level lower per cell it spreads)
 *   27        FALLING water — a column under water, spreading like a source
 *             where it lands
 * These ids are persisted: never renumber them.
 *
 * The rules (one synchronous step every FLUID_STEP seconds):
 *   - a source stays a source;
 *   - an open cell with water directly above it is falling water;
 *   - otherwise it takes the strongest horizontal neighbour that can spread
 *     sideways (source/falling = 0, flowing = its level) plus one, up to 7;
 *     past that it is dry (air);
 *   - water spreads sideways only where it cannot fall: over a solid floor
 *     or a source;
 *   - two neighbouring sources over a floor make a new source (the
 *     "infinite water" pool trick).
 * Because a flowing cell is always one weaker than what feeds it, cutting off
 * the source drains the whole stream within a few steps — no bookkeeping.
 */

import { voxelCoordinates, voxelKey, type VoxelKey } from "./voxelKey.js";

export const WATER = 19;
export const WATER_FLOW_BASE = 19; // + level 1..7 → 20..26
export const WATER_FALLING = 27;
/** Retained basin water, unlike an explicitly placed inexhaustible source.
 *  It drains again when terrain opens a lower outlet. Persisted: never reuse. */
export const WATER_SETTLED = 28;
export const WATER_MAX_LEVEL = 7;
/** Seconds between flow steps (Minecraft's 5 game ticks). */
export const FLUID_STEP = 0.25;

export const isWater = (id: number): boolean => id >= WATER && id <= WATER_SETTLED;
const reservoir = (id: number) => id === WATER || id === WATER_SETTLED;
/** Flowing water at a level (1‒7). */
export const flowingWater = (level: number): number => WATER_FLOW_BASE + level;
/** 0 for a source or falling water, else the flowing level 1‒7. Not water: 8. */
export function waterLevel(id: number): number {
  if (reservoir(id) || id === WATER_FALLING) return 0;
  if (id > WATER && id < WATER_FALLING) return id - WATER_FLOW_BASE;
  return 8;
}

/**
 * Height of the water surface inside its cell, 0‒1. Full when more water
 * sits on top (the caller passes `covered`), so a column has no seams.
 */
export function waterHeight(id: number, covered = false): number {
  if (!isWater(id)) return 0;
  if (covered || id === WATER_FALLING) return 1;
  return 0.875 - waterLevel(id) * 0.11;
}

export interface FluidWorld {
  /** Block id in a cell (0 = air). */
  get(x: number, y: number, z: number): number;
  /** May water exist in this cell at all — in range, and not inside solid
   *  furniture (a closed door holds water back, an open one lets it through)? */
  open(x: number, y: number, z: number): boolean;
  /** Return false if a write is refused (for example, a store filled during
   *  this synchronous step). Only committed writes become fluid changes. */
  set(x: number, y: number, z: number, id: number): void | boolean;
}

export type FluidChange = [x: number, y: number, z: number, id: number];

const N4: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N6: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

export class FluidSim {
  /** Cells to re-evaluate next step, in a deterministic (insertion) order. */
  private readonly pending = new Set<VoxelKey>();
  /** Most cells evaluated per step; the rest wait one more step. */
  constructor(private readonly budget = 4096) {}

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get pendingCount(): number { return this.pending.size; }

  /** Something changed at this cell: it and its six neighbours need a look. */
  touch(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of N6) {
      this.pending.add(voxelKey(x + dx, y + dy, z + dz));
    }
  }

  clear(): void {
    this.pending.clear();
  }

  /** Run one synchronous step: read everything, then write. Returns what changed. */
  step(world: FluidWorld, maxMs = Infinity): FluidChange[] {
    const start = Number.isFinite(maxMs) ? performance.now() : 0;
    const changes: FluidChange[] = [];
    // One containment walk per basin per synchronous step, shared by all its
    // cells. Small pits can fill without flooding an unbounded open field.
    const basins = new Map<VoxelKey, boolean>();
    let evaluated = 0;
    for (const key of this.pending) {
      this.pending.delete(key);
      const [x, y, z] = voxelCoordinates(key);
      const now = world.get(x, y, z);
      const next = nextState(world, x, y, z, now, basins);
      if (next !== now) changes.push([x, y, z, next]);
      if (++evaluated >= this.budget || evaluated % 8 === 0 && Number.isFinite(maxMs) && performance.now() - start >= maxMs) break;
    }
    const committed: FluidChange[] = [];
    for (const change of changes) {
      const [x, y, z, id] = change;
      if (world.set(x, y, z, id) === false) continue;
      committed.push(change);
      this.touch(x, y, z);
    }
    return committed;
  }
}

/** Can water stand in (or flow into) this cell? */
function holds(world: FluidWorld, x: number, y: number, z: number): boolean {
  const id = world.get(x, y, z);
  return (id === 0 || isWater(id)) && world.open(x, y, z);
}

/** Water spreads sideways only where it cannot fall: over a floor or a source. */
function spreadsSideways(world: FluidWorld, x: number, y: number, z: number): boolean {
  const below = world.get(x, y - 1, z);
  // A fall enters an existing pool instead of building a second, raised
  // sheet across its surface. Contained basins still fill via settledBasin.
  if (reservoir(below) && world.get(x, y, z) === WATER_FALLING) return false;
  return reservoir(below) || !holds(world, x, y - 1, z);
}

/** A fed depression with a closed rim and no lower outlet can retain water.
 *  The traversal is bounded: large lakes/open ground keep the normal flow rule. */
function settledBasin(world: FluidWorld, x: number, y: number, z: number, memo: Map<VoxelKey, boolean>): boolean {
  const start = voxelKey(x, y, z), cached = memo.get(start);
  if (cached !== undefined) return cached;
  const cells: [number, number][] = [[x, z]], seen = new Set([start]);
  let contained = true, fed = false;
  for (let i = 0; i < cells.length; i++) {
    const [cx, cz] = cells[i]!;
    const below = world.get(cx, y - 1, cz);
    if (!reservoir(below) && holds(world, cx, y - 1, cz)) contained = false;
    fed ||= reservoir(world.get(cx, y, cz)) || isWater(world.get(cx, y + 1, cz));
    for (const [dx, dz] of N4) {
      const nx = cx + dx, nz = cz + dz, k = voxelKey(nx, y, nz);
      if (seen.has(k) || !holds(world, nx, y, nz)) continue;
      seen.add(k); cells.push([nx, nz]);
    }
    if (cells.length > 256) { contained = false; break; }
  }
  const result = contained && fed;
  for (const [cx, cz] of cells) memo.set(voxelKey(cx, y, cz), result);
  return result;
}

/** What this cell should hold next step. */
export function nextState(world: FluidWorld, x: number, y: number, z: number, now: number,
  basins = new Map<VoxelKey, boolean>()): number {
  if (!(now === 0 || isWater(now))) return now;
  if (!world.open(x, y, z)) return 0; // a closed door displaces even a source
  if (now === WATER) return WATER;
  let sources = 0;
  let best = 8;
  for (const [dx, dz] of N4) {
    const id = world.get(x + dx, y, z + dz);
    if (!isWater(id)) continue;
    if (id === WATER) sources++;
    if (!spreadsSideways(world, x + dx, y, z + dz)) continue;
    best = Math.min(best, waterLevel(id));
  }
  const below = world.get(x, y - 1, z);
  if (sources >= 2 && (below === WATER || !holds(world, x, y - 1, z))) return WATER;
  if ((isWater(now) || reservoir(below) || best <= WATER_MAX_LEVEL) &&
    (reservoir(below) || !holds(world, x, y - 1, z)) && settledBasin(world, x, y, z, basins)) return WATER_SETTLED;
  if (isWater(world.get(x, y + 1, z))) return WATER_FALLING;
  return best + 1 <= WATER_MAX_LEVEL ? flowingWater(best + 1) : 0;
}
