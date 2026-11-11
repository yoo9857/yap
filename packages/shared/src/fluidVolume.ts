/**
 * FINITE water: the same block ids as fluid.ts, read as AMOUNTS. A bucket is one cell of water and
 * it is never created or lost by flowing — a pool that is opened runs out, a wall put back leaves
 * the water outside to spread thin and dry. Only a SPRING (id 19, what every older save poured)
 * never runs dry.
 *
 * A cell holds 0‒8 eighths:
 *   28 (settled)      8 — a full cell
 *   20 … 26 (flowing) 7 … 1 — id = 27 − amount, so the drawn height falls with the amount exactly as
 *                     it used to fall with the distance from a source
 *   19 (spring)       8, and stays 8 whatever it gives away
 *   27 (falling)      0 — no water of its own: the trail under water that is dropping, so a fall
 *                     is visible while it runs and gone when the water above is
 * Nothing new is persisted and no id changes meaning for the renderer.
 *
 * One step, cell by cell in pending order, each move written at once (so the count is exact):
 *   1. DOWN: water over a cell that can take more gives it everything that fits. Through open air
 *      it drops straight to the first cell that holds it (the trail marks the way).
 *   2. SIDEWAYS, only when it cannot go down: an eighth at a time to the neighbour holding least,
 *      while that one is at least two eighths lower. One eighth of difference is a meniscus: a film
 *      stays where it is.
 *   3. DRYING: a film (one eighth) that nothing will feed — no neighbour three deep, nothing above —
 *      dries, slowly and deterministically (a hash of the cell and the step). So water spilled on
 *      open ground thins out and is gone; water held in by walls stays.
 * Shapes and doors work as in fluid.ts: `open` and `seal` are the same hooks.
 */

import { WATER, WATER_FALLING, WATER_SETTLED, faceBit, isWater, type FluidChange, type FluidWorld } from "./fluid.js";
import { voxelCoordinates, voxelKey, type VoxelKey } from "./voxelKey.js";

export const FULL = 8;

/** Eighths of water in a cell with this id (a spring counts as full; a trail holds none). */
export function waterAmount(id: number): number {
  if (id === WATER || id === WATER_SETTLED) return FULL;
  return id > WATER && id < WATER_FALLING ? WATER_FALLING - id : 0;
}

/** The id for an amount of finite water (0 = air). */
export const waterOfAmount = (amount: number): number => (amount <= 0 ? 0 : amount >= FULL ? WATER_SETTLED : WATER_FALLING - amount);

const N4: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** A film dries on about one evaluation in this many (≈ 2 s at four steps a second). */
const DRY_ODDS = 8;
/** How far through water a cell levels with others (cells). */
const REACH = 4;
/** Furthest a drop is followed down in one step. */
const MAX_DROP = 64;

export class FiniteFluidSim {
  private readonly pending = new Set<VoxelKey>();
  private stepCount = 0;
  constructor(private readonly budget = 4096) {}

  get busy(): boolean { return this.pending.size > 0; }
  get pendingCount(): number { return this.pending.size; }
  clear(): void { this.pending.clear(); }

  /** Something changed at this cell: it and its six neighbours need a look. */
  touch(x: number, y: number, z: number): void {
    this.pending.add(voxelKey(x, y, z));
    this.pending.add(voxelKey(x, y + 1, z));
    this.pending.add(voxelKey(x, y - 1, z));
    for (const [dx, dz] of N4) this.pending.add(voxelKey(x + dx, y, z + dz));
  }

  step(world: FluidWorld, maxMs = Infinity): FluidChange[] {
    const start = Number.isFinite(maxMs) ? performance.now() : 0;
    this.stepCount++;
    // Moves are written as they happen; what is reported is each touched cell's value at the end.
    const before = new Map<VoxelKey, number>();
    // A cell that RECEIVED water this step moves it on next step, not later in this one: otherwise
    // water ran several cells a step toward whichever side came later in the list.
    const fresh = new Set<VoxelKey>();
    const put = (x: number, y: number, z: number, id: number): boolean => {
      const key = voxelKey(x, y, z), now = world.get(x, y, z);
      if (now === id) return true;
      if (world.set(x, y, z, id) === false) return false;
      if (!before.has(key)) before.set(key, now);
      if (waterAmount(id) > waterAmount(now)) fresh.add(key);
      return true;
    };
    const work = [...this.pending];
    this.pending.clear();
    let evaluated = 0;
    for (let i = 0; i < work.length; i++) {
      if (evaluated >= this.budget || evaluated % 8 === 0 && Number.isFinite(maxMs) && evaluated > 0 && performance.now() - start >= maxMs) {
        for (let j = i; j < work.length; j++) this.pending.add(work[j]!); // the rest wait a step
        break;
      }
      evaluated++;
      if (fresh.has(work[i]!)) { this.pending.add(work[i]!); continue; }
      const [x, y, z] = voxelCoordinates(work[i]!);
      this.settle(world, x, y, z, put);
    }
    const changes: FluidChange[] = [];
    for (const [key, was] of before) {
      const [x, y, z] = voxelCoordinates(key), now = world.get(x, y, z);
      if (now === was) continue;
      changes.push([x, y, z, now]);
      this.touch(x, y, z);
    }
    return changes;
  }

  private settle(world: FluidWorld, x: number, y: number, z: number, put: (x: number, y: number, z: number, id: number) => boolean): void {
    const id = world.get(x, y, z);
    if (id !== 0 && !isWater(id)) return;
    if (!world.open(x, y, z)) { if (id !== 0) put(x, y, z, 0); return; } // a closed door pushes it out
    const spring = id === WATER;
    let amount = waterAmount(id);
    if (amount === 0) {
      // a trail lasts while water is dropping through from right above
      const fed = this.dropping(world, x, y + 1, z);
      if (id === WATER_FALLING && !fed) put(x, y, z, 0);
      else if (id === 0 && fed && this.takes(world, x, y, z, 0, -1, 0)) put(x, y, z, WATER_FALLING);
      return;
    }
    // 1. down
    if (this.takes(world, x, y, z, 0, -1, 0)) {
      let ty = y - 1;
      // through open air (or its own trail) to the first cell that holds water or stands on something
      while (y - ty < MAX_DROP && waterAmount(world.get(x, ty, z)) === 0 && this.takes(world, x, ty, z, 0, -1, 0)) ty--;
      const there = waterAmount(world.get(x, ty, z));
      const move = Math.min(amount, FULL - there);
      if (move > 0 && world.get(x, ty, z) !== WATER) {
        if (put(x, ty, z, waterOfAmount(there + move))) {
          for (let yy = y - 1; yy > ty; yy--) put(x, yy, z, WATER_FALLING);
          if (!spring) { amount -= move; put(x, y, z, waterOfAmount(amount)); }
        }
        if (!spring && amount === 0) return;
      }
      // what could not go down (the cell below filled up) spreads like standing water
      if (this.takes(world, x, y, z, 0, -1, 0)) return;
    }
    // 2. sideways: one eighth at a time to whichever cell in reach holds least, while that one is
    // at least two below this cell. "In reach" is a neighbour, or up to REACH cells away THROUGH
    // water: next-door only, a pool settled as a staircase (8, 7, 6 …: every step is one eighth)
    // and spilled water stood in a mound instead of running flat.
    const reach = this.reach(world, x, y, z);
    let left = amount;
    for (let n = 0; n < FULL && reach.length > 0; n++) {
      let low = reach[0]!;
      for (const c of reach) if (c[2] < low[2]) low = c;
      if (left - low[2] < 2) break;
      low[2]++;
      if (!spring) left--;
    }
    for (const [cx, cz, now] of reach) if (now !== waterAmount(world.get(cx, y, cz))) put(cx, y, cz, waterOfAmount(now));
    if (left !== amount) { amount = left; put(x, y, z, waterOfAmount(amount)); }
    // 3. a film with nothing deeper around it dries
    if (!spring && amount === 1 && this.lonely(world, x, y, z)) {
      if (hash(x, y, z, this.stepCount) % DRY_ODDS === 0) put(x, y, z, 0);
      else this.pending.add(voxelKey(x, y, z)); // look again next step
    }
  }

  /** The cells water here can level with: [x, z, amount], nearest first. Springs are passed through
   *  but never filled. */
  private reach(world: FluidWorld, x: number, y: number, z: number): [number, number, number][] {
    const out: [number, number, number][] = [], seen = new Set<number>([0]);
    let ring: [number, number][] = [[x, z]];
    for (let depth = 1; depth <= REACH && ring.length > 0; depth++) {
      const next: [number, number][] = [];
      for (const [cx, cz] of ring) for (const [dx, dz] of N4) {
        const nx = cx + dx, nz = cz + dz, key = (nx - x + 16) * 64 + (nz - z + 16);
        if (seen.has(key) || nx === x && nz === z) continue;
        if (!this.passes(world, cx, y, cz, dx, 0, dz) || !this.holds(world, nx, y, nz)) continue;
        seen.add(key);
        const id = world.get(nx, y, nz), amount = waterAmount(id);
        // water that could drop out of that cell is on its way down, not a level to match
        // (a DRY cell is only reached from next door: further off it would be water jumping a gap)
        if (id !== WATER && (depth === 1 || amount > 0 && !this.takes(world, nx, y, nz, 0, -1, 0))) out.push([nx, nz, amount]);
        if (amount > 0) next.push([nx, nz]); // only water carries the level further
      }
      ring = next;
    }
    return out;
  }

  /** Is water coming down out of this cell (so the cell under it is a fall's trail)? */
  private dropping(world: FluidWorld, x: number, y: number, z: number): boolean {
    const id = world.get(x, y, z);
    return (waterAmount(id) > 0 || id === WATER_FALLING) && this.passes(world, x, y, z, 0, -1, 0);
  }

  /** Could water in (x, y, z) move one cell toward (dx, dy, dz): the way is open and that cell is
   *  air, a trail, or water with room left? */
  private takes(world: FluidWorld, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
    if (!this.passes(world, x, y, z, dx, dy, dz) || !this.holds(world, x + dx, y + dy, z + dz)) return false;
    const id = world.get(x + dx, y + dy, z + dz);
    return id !== WATER && waterAmount(id) < FULL;
  }

  private holds(world: FluidWorld, x: number, y: number, z: number): boolean {
    const id = world.get(x, y, z);
    return (id === 0 || isWater(id)) && world.open(x, y, z);
  }

  private passes(world: FluidWorld, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
    if (!world.seal) return true;
    return (world.seal(x, y, z) & faceBit(dx, dy, dz)) === 0 && (world.seal(x + dx, y + dy, z + dz) & faceBit(-dx, -dy, -dz)) === 0;
  }

  private lonely(world: FluidWorld, x: number, y: number, z: number): boolean {
    if (isWater(world.get(x, y + 1, z))) return false;
    // a neighbour three deep or more will feed it (rule 2); two deep is just the film's own edge
    for (const [dx, dz] of N4) if (waterAmount(world.get(x + dx, y, z + dz)) > 2) return false;
    return true;
  }
}

function hash(x: number, y: number, z: number, step: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(step, 2246822519);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return (n ^ n >>> 16) >>> 0;
}
