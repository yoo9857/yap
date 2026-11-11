import { FLUID_STEP, FluidSim, WATER, holdsWaterlog, isWater, shapeSeal, type FluidWorld } from "@robo/shared";
import type { FieldWindow } from "./fieldWorld.js";
import type { VoxelView } from "./voxelView.js";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z } from "./voxelWorld.js";
import type { RustEngine } from "../engine/rustEngine.js";

/**
 * Solo play's water: the shared fluid rules run against this machine's voxel
 * window. (In a classroom the SERVER runs the same sim and sends the result
 * as ordinary edits — a client simulating too would race it.)
 *
 * The sim works in ABSOLUTE coordinates, so a field scroll mid-flow never
 * points its pending cells at the wrong place; cells outside the live window
 * are closed to water, so a stream simply stops at the window's edge.
 *
 * WaterSim owns the scheduling (the step timer, waking saved water, field scrolls). The rules run
 * in a backend: TypeScript (`fluid.ts`, the default and the reference) or the Rust engine through
 * WASM (`?engine=rust`, docs/ENGINE.md) — the same rules, checked identical by
 * `test/rust-water.test.ts`.
 */
export interface WaterBackend {
  touch(ax: number, y: number, az: number): void;
  clear(): void;
  readonly busy: boolean;
  readonly pendingCount: number;
  /** One step; writes its changes into the world and returns how many cells changed. */
  step(maxMs: number): number;
  /** The whole window was replaced (a field scroll). */
  reload(): void;
  /** Stop listening to the world. */
  dispose(): void;
  readonly kind: "ts" | "rust";
}

/** Where the window sits and how it reads beyond its edge. */
interface Window {
  world: VoxelWorld;
  view: VoxelView;
  field: FieldWindow | null;
}

const ox = (w: Window) => w.field?.absOriginX ?? 0;
const oz = (w: Window) => w.field?.absOriginZ ?? 0;

/** Write one simulation change into the TS world exactly as the rules define `set`. */
function applyChange(w: Window, x: number, y: number, z: number, id: number): void {
  if (holdsWaterlog(w.world.get(x, y, z), w.world.getShape(x, y, z))) w.world.setWet(x, y, z, id);
  else w.world.setShaped(x, y, z, id, 0);
  w.view.markWaterDirty(x, y, z); // water ↔ air never changes a brick
}

/** The reference: `FluidSim` from @robo/shared reading the TS world directly. */
class TsWaterBackend implements WaterBackend {
  readonly kind = "ts";
  private readonly sim = new FluidSim();
  constructor(private readonly w: Window) {}

  private readonly fluidWorld: FluidWorld = {
    // outside the scrolled window the field's banked edits hold the water: reading the plain
    // column there (air) drained every stream whose source had just scrolled out of view
    // a shaped block's cell reads (and takes) the water it holds, not its block id (waterlog.ts).
    // Hot path: cells in the live window read the grid directly (field.cellAt allocates).
    get: (ax, y, az) => {
      const { world, field } = this.w, x = ax - ox(this.w), z = az - oz(this.w);
      if (!field || world.inBounds(x, y, z)) {
        const block = world.get(x, y, z);
        return block !== 0 && holdsWaterlog(block, world.getShape(x, y, z)) ? world.wetAt(x, y, z) : block;
      }
      const [block, shape] = field.cellAt(ax, y, az);
      return holdsWaterlog(block, shape) ? field.wetAt(ax, y, az) : block;
    },
    seal: (ax, y, az) => {
      const { world, field } = this.w, x = ax - ox(this.w), z = az - oz(this.w);
      if (!field || world.inBounds(x, y, z)) return world.waterSeal(x, y, z);
      const [block, shape] = field.cellAt(ax, y, az);
      return holdsWaterlog(block, shape) ? shapeSeal(shape) : 0;
    },
    open: (ax, y, az) => {
      const { world } = this.w, x = ax - ox(this.w), z = az - oz(this.w);
      return world.inBounds(x, y, z) && !(world.propDry?.(x, y, z) ?? false);
    },
    set: (ax, y, az, id) => {
      const x = ax - ox(this.w), z = az - oz(this.w);
      // outside the window nothing is written: REFUSED, so it is no change and wakes nothing (it
      // used to count as one and re-queue itself every step — banked water by the edge kept the
      // simulation busy forever)
      if (!this.w.world.inBounds(x, y, z)) return false;
      applyChange(this.w, x, y, z, id);
    },
  };

  touch(ax: number, y: number, az: number): void { this.sim.touch(ax, y, az); }
  clear(): void { this.sim.clear(); }
  get busy(): boolean { return this.sim.busy; }
  get pendingCount(): number { return this.sim.pendingCount; }
  step(maxMs: number): number { return this.sim.step(this.fluidWorld, maxMs).length; }
  reload(): void { /* reads the world live */ }
  dispose(): void { /* nothing held */ }
}

/** Faces sealed per shape code for Rust, or 255 for a shape that holds no water. */
function sealTable(): Uint8Array {
  const table = new Uint8Array(256).fill(255);
  for (let s = 0; s < 256; s++) if (holdsWaterlog(1, s)) table[s] = shapeSeal(s);
  return table;
}

/**
 * The Rust engine's water. Rust keeps a mirror of the window (docs/ENGINE.md: the world lives on
 * the Rust side): the whole window on start and every scroll, each cell the game writes
 * (`VoxelWorld.onWrite`), the field's banked ring just outside the window (the only cells beyond it
 * the rules read), and solid furniture. Its changes come back in one array and are written here.
 */
class RustWaterBackend implements WaterBackend {
  readonly kind = "rust";
  private readonly water;
  /** Writes made by applying our own changes are already in Rust. */
  private applying = false;
  private propsVersion = -1;

  constructor(engine: RustEngine, private readonly w: Window, private readonly furniture: FurnitureSource | null) {
    this.water = new engine.WasmWater(WORLD_X, WORLD_Y, WORLD_Z, sealTable(), 4096);
    w.world.onWrite = (i) => {
      if (this.applying) return;
      const { cells, shapes, wet } = this.w.world;
      this.water.write(i, cells[i]!, shapes[i]!, wet[i]!);
    };
    this.reload();
  }

  reload(): void {
    const { world, field } = this.w;
    this.water.load(world.cells, world.shapes, world.wet, field ? world.outsideColumn ?? new Uint8Array(0) : new Uint8Array(0), ox(this.w), oz(this.w));
    if (field) this.water.edge(edgeRing(field, ox(this.w), oz(this.w)));
    this.propsVersion = -1;
    this.syncProps();
  }

  private syncProps(): void {
    if (!this.furniture) return;
    const v = this.furniture.version();
    if (v === this.propsVersion) return;
    this.propsVersion = v;
    this.water.props(Int32Array.from(this.furniture.dryCells()));
  }

  touch(ax: number, y: number, az: number): void { this.water.touch(ax, y, az); }
  clear(): void { this.water.clear(); }
  get busy(): boolean { return this.water.busy(); }
  get pendingCount(): number { return this.water.pending(); }

  step(maxMs: number): number {
    this.syncProps();
    const changes = this.water.step(maxMs);
    const x0 = ox(this.w), z0 = oz(this.w);
    this.applying = true;
    try {
      for (let i = 0; i < changes.length; i += 4) applyChange(this.w, changes[i]! - x0, changes[i + 1]!, changes[i + 2]! - z0, changes[i + 3]!);
    } finally {
      this.applying = false;
    }
    return changes.length / 4;
  }

  dispose(): void {
    this.w.world.onWrite = null;
    this.water.free();
  }
}

/** Furniture that keeps water out (closed doors: `FurnitureLayout.waterCells`) for the Rust mirror
 *  (absolute cells), and a version to skip unchanged layouts. */
export interface FurnitureSource {
  version(): number;
  /** Flat [ax, y, az]*. */
  dryCells(): number[];
}

/** The field's cells in the ring right outside the window that differ from the flat field:
 *  flat [ax, y, az, block, shape, wet]*. */
export function edgeRing(field: FieldWindow, originX: number, originZ: number): Int32Array {
  const out: number[] = [];
  const add = (ax: number, az: number) => {
    for (let y = 0; y < WORLD_Y; y++) {
      const [block, shape] = field.cellAt(ax, y, az), wet = field.wetAt(ax, y, az);
      if (block === (field.world.outsideColumn?.[y] ?? 0) && shape === 0 && wet === 0) continue;
      out.push(ax, y, az, block, shape, wet);
    }
  };
  for (let x = -1; x <= WORLD_X; x++) { add(originX + x, originZ - 1); add(originX + x, originZ + WORLD_Z); }
  for (let z = 0; z < WORLD_Z; z++) { add(originX - 1, originZ + z); add(originX + WORLD_X, originZ + z); }
  return Int32Array.from(out);
}

export class WaterSim {
  private backend: WaterBackend;
  private readonly window: Window;
  private timer = 0;
  private activeOriginX: number;
  private activeOriginZ: number;
  private wakeCursor = -1;

  constructor(
    private readonly world: VoxelWorld,
    view: VoxelView,
    private readonly field: FieldWindow | null,
    opts: { rust?: RustEngine | null; furniture?: FurnitureSource | null; maxStepMs?: number } = {},
  ) {
    this.activeOriginX = this.ox;
    this.activeOriginZ = this.oz;
    const w = { world, view, field };
    this.window = w;
    this.backend = opts.rust ? new RustWaterBackend(opts.rust, w, opts.furniture ?? null) : new TsWaterBackend(w);
    this.maxStepMs = opts.maxStepMs ?? 3;
  }

  private readonly maxStepMs: number;

  /** Which rules are running: the TypeScript reference or the Rust engine. */
  get engine(): "ts" | "rust" {
    return this.backend.kind;
  }

  private get ox(): number {
    return this.field?.absOriginX ?? 0;
  }

  private get oz(): number {
    return this.field?.absOriginZ ?? 0;
  }

  /** A grid cell changed (a block placed or mined, water poured or scooped). */
  touch(x: number, y: number, z: number): void {
    this.backend.touch(x + this.ox, y, z + this.oz);
  }

  /** Per fixed tick. Returns how many cells the water changed this tick. */
  update(dt: number): number {
    if (this.activeOriginX !== this.ox || this.activeOriginZ !== this.oz) {
      // The bank can restore water whose pending work was consumed while it
      // was outside the window. New window edges can also open a stopped flow.
      this.backend.reload();
      this.backend.clear();
      this.wakeAll();
    }
    this.wakeSlice();
    this.timer += dt;
    if (this.timer < FLUID_STEP) return 0;
    this.timer = Math.min(this.timer - FLUID_STEP, FLUID_STEP); // never a burst of catch-up steps
    if (!this.backend.busy) return 0;
    try {
      return this.backend.step(this.maxStepMs);
    } catch (err) {
      if (this.backend.kind !== "rust") throw err;
      this.fallBack(err);
      return 0;
    }
  }

  /** The Rust engine failed (a wasm trap): play on with the TypeScript rules, the same water. Its
   *  pending cells are gone with it, so every water cell is woken again. Nothing of a failed step
   *  was written (changes are applied only after Rust returns them). */
  private fallBack(err: unknown): void {
    console.warn("Rust water failed, continuing on the TypeScript rules", err);
    try { this.backend.dispose(); } catch { /* a trapped module may not even free */ }
    this.backend = new TsWaterBackend(this.window);
    this.wakeAll();
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
      // water cells, and shaped blocks holding water (a field scroll restores both)
      if ((id === 0 || !isWater(id)) && !this.world.wet[i]) continue;
      // VoxelWorld.index: (y * WORLD_Z + z) * WORLD_X + x
      const x = i % WORLD_X;
      const z = Math.floor(i / WORLD_X) % WORLD_Z;
      const y = Math.floor(i / (WORLD_X * WORLD_Z));
      if (id === WATER && x > 0 && x < WORLD_X - 1 && z > 0 && z < WORLD_Z - 1 && y > 0 &&
        isWater(cells[i - 1]!) && isWater(cells[i + 1]!) &&
        isWater(cells[i - WORLD_X]!) && isWater(cells[i + WORLD_X]!) &&
        isWater(cells[i - WORLD_X * WORLD_Z]!) && isWater(cells[i + WORLD_X * WORLD_Z]!) &&
        !(this.world.propDry?.(x, y, z) ?? false)) continue;
      this.touch(x, y, z);
      activated++;
    }
    if (this.wakeCursor >= cells.length) this.wakeCursor = -1;
  }

  stats() { return { pending: this.backend.pendingCount, waking: this.wakeCursor >= 0, engine: this.backend.kind }; }

  clear(): void {
    this.backend.clear();
    this.wakeCursor = -1;
  }

  dispose(): void {
    this.backend.dispose();
  }
}
