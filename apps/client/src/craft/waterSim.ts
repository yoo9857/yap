import { FLUID_STEP, FluidSim, WATER, isWater, type FluidWorld } from "@robo/shared";
import type { FieldWindow } from "./fieldWorld.js";
import type { VoxelView } from "./voxelView.js";
import { WORLD_X, WORLD_Z, type VoxelWorld } from "./voxelWorld.js";

/**
 * Solo play's water: the shared `FluidSim` run against this machine's voxel
 * window. (In a classroom the SERVER runs the same sim and sends the result
 * as ordinary edits — a client simulating too would race it.)
 *
 * The sim works in ABSOLUTE coordinates, so a field scroll mid-flow never
 * points its pending cells at the wrong place; cells outside the live window
 * are closed to water, so a stream simply stops at the window's edge.
 */
export class WaterSim {
  private readonly sim = new FluidSim();
  private timer = 0;
  private activeOriginX: number;
  private activeOriginZ: number;
  private wakeCursor = -1;

  constructor(
    private readonly world: VoxelWorld,
    private readonly view: VoxelView,
    private readonly field: FieldWindow | null,
  ) {
    this.activeOriginX = this.ox;
    this.activeOriginZ = this.oz;
  }

  private get ox(): number {
    return this.field?.absOriginX ?? 0;
  }

  private get oz(): number {
    return this.field?.absOriginZ ?? 0;
  }

  private readonly fluidWorld: FluidWorld = {
    get: (ax, y, az) => this.world.get(ax - this.ox, y, az - this.oz),
    open: (ax, y, az) => {
      const x = ax - this.ox;
      const z = az - this.oz;
      return this.world.inBounds(x, y, z) && !(this.world.propSolid?.(x, y, z) ?? false);
    },
    set: (ax, y, az, id) => {
      const x = ax - this.ox;
      const z = az - this.oz;
      this.world.setShaped(x, y, z, id, 0);
      this.view.markWaterDirty(x, y, z); // water ↔ air never changes a brick
    },
  };

  /** A grid cell changed (a block placed or mined, water poured or scooped). */
  touch(x: number, y: number, z: number): void {
    this.sim.touch(x + this.ox, y, z + this.oz);
  }

  /** Per fixed tick. Returns how many cells the water changed this tick. */
  update(dt: number): number {
    if (this.activeOriginX !== this.ox || this.activeOriginZ !== this.oz) {
      // The bank can restore water whose pending work was consumed while it
      // was outside the window. New window edges can also open a stopped flow.
      this.sim.clear();
      this.wakeAll();
    }
    this.wakeSlice();
    this.timer += dt;
    if (this.timer < FLUID_STEP) return 0;
    this.timer = Math.min(this.timer - FLUID_STEP, FLUID_STEP); // never a burst of catch-up steps
    if (!this.sim.busy) return 0;
    return this.sim.step(this.fluidWorld, 3).length;
  }

  /** Re-evaluate every saved water cell: a source may have been saved before
   *  its first flow step, so sources alone are not necessarily stable. */
  wakeAll(): void {
    this.activeOriginX = this.ox;
    this.activeOriginZ = this.oz;
    this.wakeCursor = 0;
  }

  /** Dense saves can contain hundreds of thousands of cells. Scan air cheaply,
   *  but activate at most 256 wet cells per fixed tick, rather than allocating
   *  their entire simulation frontier in one visible frame. */
  private wakeSlice(): void {
    if (this.wakeCursor < 0) return;
    const { cells } = this.world;
    const end = Math.min(cells.length, this.wakeCursor + 262_144);
    const start = performance.now();
    let activated = 0;
    while (this.wakeCursor < end && activated < 256) {
      const i = this.wakeCursor;
      if ((i & 1023) === 0 && performance.now() - start >= 1) break;
      this.wakeCursor++;
      const id = cells[i]!;
      if (id === 0 || !isWater(id)) continue;
      // VoxelWorld.index: (y * WORLD_Z + z) * WORLD_X + x
      const x = i % WORLD_X;
      const z = Math.floor(i / WORLD_X) % WORLD_Z;
      const y = Math.floor(i / (WORLD_X * WORLD_Z));
      if (id === WATER && x > 0 && x < WORLD_X - 1 && z > 0 && z < WORLD_Z - 1 && y > 0 &&
        isWater(cells[i - 1]!) && isWater(cells[i + 1]!) &&
        isWater(cells[i - WORLD_X]!) && isWater(cells[i + WORLD_X]!) &&
        isWater(cells[i - WORLD_X * WORLD_Z]!) && isWater(cells[i + WORLD_X * WORLD_Z]!) &&
        !(this.world.propSolid?.(x, y, z) ?? false)) continue;
      this.touch(x, y, z);
      activated++;
    }
    if (this.wakeCursor >= cells.length) this.wakeCursor = -1;
  }

  stats() { return { pending: this.sim.pendingCount, waking: this.wakeCursor >= 0 }; }

  clear(): void {
    this.sim.clear();
    this.wakeCursor = -1;
  }
}
