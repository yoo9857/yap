import { isWater, MAX_BLOCK_SHAPE } from "@robo/shared";
import { z } from "zod";
import { voxelCoordinates, voxelKey, type VoxelKey } from "@robo/shared";
import { blockByKey, isKnownCell } from "./blocks.js";
import { ensureFieldStacks, fieldStarterHotbar, sanitizeCounts, sanitizeHotbar, type Counts } from "./inventory.js";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z } from "./voxelWorld.js";
import { isQuotaError, keepUnreadable, saveStatus, type KeyValueStorage } from "./craftSave.js";
import { furnitureSaveSchema, type FurnitureTuple } from "./furniture/layout.js";

/**
 * Education mode's endless empty field. The voxel grid stays the usual fixed
 * 160 x 160 window; the field scrolls it under the player. When the player
 * drifts more than RECENTER cells from the window's centre, edits in the old
 * window are banked by ABSOLUTE coordinates, the window is refilled around the
 * player and the body is shifted by the same amount — so building works
 * anywhere and the ground never ends. Outside the window, `outsideColumn`
 * keeps physics and machines on solid ground.
 */

/** Highest solid layer of the field (grass). */
export const FIELD_TOP = 3;
/** Window shifts snap to the renderer's chunk size, so chunks still in view
 *  are slid instead of rebuilt (see VoxelView.shift). */
const STEP = 16;
/** Small threshold so the window's edge always stays >= 72 cells out —
 *  beyond the farthest render distance, so nothing you built visibly drops
 *  off the edge of the world. */
const RECENTER = 8;
/** Farthest render distance the scrolling window can back. */
export const FIELD_MAX_VIEW = 72;
export const FIELD_SAVE_KEY = "craftyap-field-save-v1";
const SAVE_KEY = FIELD_SAVE_KEY;
const MAX_SAVED_EDITS = 400_000;
const CENTER_X = WORLD_X / 2;
const CENTER_Z = WORLD_Z / 2;

const id = (key: string) => blockByKey(key)!.id;

function fieldColumn(): Uint8Array {
  const column = new Uint8Array(WORLD_Y);
  column[0] = id("bedrock");
  for (let y = 1; y < FIELD_TOP; y++) column[y] = id("dirt");
  column[FIELD_TOP] = id("grass");
  return column;
}

const saveSchema = z.object({
  v: z.literal(1),
  originX: z.number().int(),
  originZ: z.number().int(),
  /** [absX, y, absZ, blockId, shape] — cells that differ from the flat field. */
  edits: z
    .array(z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number().int()]))
    .max(MAX_SAVED_EDITS),
  /** Checked key by key in `sanitizeCounts`: one bad value must not reject (and so wipe) the whole save. */
  inventory: z.record(z.string(), z.unknown()),
  /** Optional loadout. A bad value must not reject the whole field. */
  hotbar: z.unknown().optional(),
  player: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
  /** Adopted companion. Optional: fields saved before the adoption panel
   *  existed have none, and the caller falls back to the dog. */
  pet: z.string().optional(),
  /** Placed furniture in ABSOLUTE cells, like `edits`. */
  furniture: furnitureSaveSchema.optional(),
  /** Power-plant blueprints (science mode), ABSOLUTE anchors. Checked row by row in `loadPlants`. */
  plants: z.unknown().optional(),
});

export class FieldWindow {
  readonly world = new VoxelWorld();
  private readonly column = fieldColumn();
  /** Absolute cell key → [blockId, shape], for cells outside the live window
   *  (and, after a bank(), inside it too). */
  private readonly edits = new Map<VoxelKey, [number, number]>();
  /** Absolute cell key → the water a shaped block holds (VoxelWorld.wet), banked like `edits` so a
   *  scroll keeps it. Simulation state: never saved. */
  private readonly wet = new Map<VoxelKey, number>();
  /** Absolute coordinate of grid cell (0, 0). */
  private originX = -CENTER_X;
  private originZ = -CENTER_Z;
  /** Absolute coordinates of grid cell (0, 0), for callers that convert in a
   *  hot path (furniture collision) and cannot afford `toAbsolute`'s array. */
  get absOriginX(): number {
    return this.originX;
  }

  get absOriginZ(): number {
    return this.originZ;
  }

  /** world.version when the window last matched `edits`; skips idle banks. */
  private bankedVersion = -1;

  constructor() {
    this.world.outsideColumn = this.column;
    this.fill();
  }

  get spawn(): { x: number; y: number; z: number } {
    return { x: CENTER_X + 0.5, y: FIELD_TOP + 1, z: CENTER_Z + 0.5 };
  }

  /**
   * Shift the window if `pos` (grid coordinates) wandered too far from its
   * centre. Returns the grid shift applied — callers subtract it from every
   * grid-space position they hold — or null when nothing moved.
   */
  recenter(pos: { x: number; z: number }): { dx: number; dz: number } | null {
    const dx = Math.abs(pos.x - CENTER_X) > RECENTER ? Math.round((pos.x - CENTER_X) / STEP) * STEP : 0;
    const dz = Math.abs(pos.z - CENTER_Z) > RECENTER ? Math.round((pos.z - CENTER_Z) / STEP) * STEP : 0;
    if (dx === 0 && dz === 0) return null;
    this.bank();
    this.originX += dx;
    this.originZ += dz;
    this.fill();
    return { dx, dz };
  }

  /** Record every cell of the live window that differs from the flat field. */
  private bank(): void {
    if (this.world.version === this.bankedVersion) return;
    // forget the window's old entries, then re-record what differs now —
    // keys are only built for edited cells, never for the 1.4M pristine ones
    for (const map of [this.edits, this.wet]) for (const key of map.keys()) {
      const [ax, y, az] = voxelCoordinates(key);
      if (this.world.inBounds(ax - this.originX, y, az - this.originZ)) map.delete(key);
    }
    const { cells, shapes, wet } = this.world;
    for (let y = 0; y < WORLD_Y; y++) {
      const pristine = this.column[y]!;
      let i = VoxelWorld.index(0, y, 0);
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++, i++) {
          if (cells[i] === pristine && shapes[i] === 0) continue;
          this.edits.set(voxelKey(x + this.originX, y, z + this.originZ), [cells[i]!, shapes[i]!]);
          if (wet[i]) this.wet.set(voxelKey(x + this.originX, y, z + this.originZ), wet[i]!);
        }
      }
    }
    this.bankedVersion = this.world.version;
  }

  /** Rebuild the window from the flat field plus banked edits. */
  private fill(): void {
    const { cells, shapes, wet } = this.world;
    for (let y = 0; y < WORLD_Y; y++) {
      const start = VoxelWorld.index(0, y, 0);
      cells.fill(this.column[y]!, start, start + WORLD_X * WORLD_Z);
    }
    shapes.fill(0);
    wet.fill(0);
    for (const [key, [block, shape]] of this.edits) {
      const [ax, y, az] = voxelCoordinates(key);
      const x = ax - this.originX;
      const z = az - this.originZ;
      if (!this.world.inBounds(x, y, z)) continue;
      const i = VoxelWorld.index(x, y, z);
      cells[i] = block;
      shapes[i] = shape;
    }
    for (const [key, water] of this.wet) {
      const [ax, y, az] = voxelCoordinates(key);
      const x = ax - this.originX, z = az - this.originZ;
      if (this.world.inBounds(x, y, z)) wet[VoxelWorld.index(x, y, z)] = water;
    }
    this.world.version++;
    this.bankedVersion = this.world.version;
  }

  // ------------------------------------------------------------ classroom
  // Shared fields talk in ABSOLUTE coordinates: every client scrolls its own
  // window, so grid coordinates mean different cells on different machines.

  toAbsolute(x: number, z: number): [number, number] {
    return [x + this.originX, z + this.originZ];
  }

  toGrid(ax: number, az: number): [number, number] {
    return [ax - this.originX, az - this.originZ];
  }

  /** What an absolute cell holds right now: [block, shape]. */
  cellAt(ax: number, y: number, az: number): [number, number] {
    const [x, z] = this.toGrid(ax, az);
    if (this.world.inBounds(x, y, z)) return [this.world.get(x, y, z), this.world.getShape(x, y, z)];
    return this.edits.get(voxelKey(ax, y, az)) ?? [this.column[y] ?? 0, 0];
  }

  /** Just the block id at an absolute cell (no tuple: for per-frame loops). */
  blockIdAt(ax: number, y: number, az: number): number {
    const x = ax - this.originX;
    const z = az - this.originZ;
    if (this.world.inBounds(x, y, z)) return this.world.get(x, y, z);
    const edit = this.edits.get(voxelKey(ax, y, az));
    return edit ? edit[0] : (this.column[y] ?? 0);
  }

  /** The water a shaped block at an absolute cell holds (0: none). */
  wetAt(ax: number, y: number, az: number): number {
    const [x, z] = this.toGrid(ax, az);
    if (this.world.inBounds(x, y, z)) return this.world.wet[VoxelWorld.index(x, y, z)]!;
    return this.wet.get(voxelKey(ax, y, az)) ?? 0;
  }

  /** Set the water a shaped block holds (classroom: the server's flow). Grid cell when it is in the
   *  live window (the caller redraws its water), else null. */
  applyWet(ax: number, y: number, az: number, water: number): [number, number, number] | null {
    const [x, z] = this.toGrid(ax, az);
    if (this.world.inBounds(x, y, z)) {
      this.world.setWet(x, y, z, water);
      return [x, y, z];
    }
    const key = voxelKey(ax, y, az);
    if (water) this.wet.set(key, water);
    else this.wet.delete(key);
    return null;
  }

  /**
   * Write a cell someone else changed. Returns its grid coordinates when it
   * is inside the live window (the caller re-renders that chunk), else null.
   */
  applyRemote(ax: number, y: number, az: number, block: number, shape: number): [number, number, number] | null {
    const [x, z] = this.toGrid(ax, az);
    if (this.world.inBounds(x, y, z)) {
      this.world.setShaped(x, y, z, block, shape);
      return [x, y, z];
    }
    const key = voxelKey(ax, y, az);
    this.wet.delete(key); // a written cell holds no water until the flow says so (VoxelWorld.set)
    if (block === (this.column[y] ?? 0) && shape === 0) this.edits.delete(key);
    else this.edits.set(key, [block, shape]);
    return null;
  }

  hasEdits(): boolean {
    return this.edits.size > 0 || this.world.version !== this.bankedVersion;
  }

  /** Teacher's water cleanup: remove sources, flow and waterlogs in view and in banked regions.
   *  Water below ground becomes air: draining a flooded hole must not fill it with soil. */
  drainWater(): void {
    for (const [key, [block]] of this.edits) {
      if (!isWater(block)) continue;
      const [, y] = voxelCoordinates(key);
      if (this.column[y]) this.edits.set(key, [0, 0]);
      else this.edits.delete(key);
    }
    this.wet.clear();
    const { cells, shapes, wet } = this.world;
    for (let i = 0; i < cells.length; i++) if (isWater(cells[i]!)) {
      cells[i] = 0;
      shapes[i] = 0;
    }
    wet.fill(0);
    this.world.version++;
  }

  /** Replace the whole field with the class's (join / reconnect). */
  replaceAll(edits: readonly (readonly [number, number, number, number, number])[]): void {
    this.edits.clear();
    this.wet.clear();
    for (const [ax, y, az, block, shape] of edits) {
      if (y >= 0 && y < WORLD_Y && (block !== this.column[y] || shape !== 0)) this.edits.set(voxelKey(ax, y, az), [block, shape]);
    }
    this.fill();
  }

  save(
    storage: KeyValueStorage,
    inventory: Counts,
    player: { x: number; y: number; z: number },
    pet?: string,
    furniture?: FurnitureTuple[],
    hotbar?: readonly string[],
    plants?: unknown[],
  ): boolean {
    this.bank();
    saveStatus.tooBig = false;
    // Never overwrite a readable save with one the loader would reject.
    if (this.edits.size > MAX_SAVED_EDITS) {
      saveStatus.tooBig = true;
      return false;
    }
    const edits = [...this.edits].map(([key, [block, shape]]) => [...voxelCoordinates(key), block, shape]);
    try {
      storage.setItem(
        SAVE_KEY,
        JSON.stringify({ v: 1, originX: this.originX, originZ: this.originZ, edits, inventory, player, pet, furniture, ...(plants?.length ? { plants } : {}), ...(hotbar ? { hotbar: [...hotbar] } : {}) }),
      );
      return true;
    } catch (e) {
      // ~20 characters an edit: the browser's ~5M-character quota runs out
      // around 250k edits, before the cap above
      saveStatus.tooBig = isQuotaError(e);
      return false;
    }
  }

  /** Restore a saved field; returns its inventory/player or null for a fresh one. */
  load(
    storage: KeyValueStorage,
  ): { inventory: Counts; hotbar: string[]; player: { x: number; y: number; z: number }; pet?: string; furniture?: unknown[]; plants?: unknown } | null {
    let raw: string | null;
    try {
      raw = storage.getItem(SAVE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      keepUnreadable(storage, SAVE_KEY, raw);
      return null;
    }
    const result = saveSchema.safeParse(parsed);
    if (!result.success) {
      keepUnreadable(storage, SAVE_KEY, raw);
      return null;
    }
    const d = result.data;
    this.originX = d.originX;
    this.originZ = d.originZ;
    this.edits.clear();
    this.wet.clear();
    for (const [x, y, zz, block, shape] of d.edits) {
      if (y < 0 || y >= WORLD_Y || shape < 0 || shape > MAX_BLOCK_SHAPE) continue;
      if (!isKnownCell(block)) continue;
      this.edits.set(voxelKey(x, y, zz), [block, shape]);
    }
    this.fill();
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, 1), hi - 1);
    return {
      inventory: sanitizeCounts(d.inventory),
      hotbar: Array.isArray(d.hotbar) ? sanitizeHotbar(d.hotbar) : fieldStarterHotbar(),
      player: { x: clamp(d.player.x, WORLD_X), y: clamp(d.player.y, WORLD_Y + 4), z: clamp(d.player.z, WORLD_Z) },
      pet: d.pet,
      furniture: d.furniture,
      plants: d.plants,
    };
  }
}

/** Education mode is for building, not grinding: a full stack of every placeable block. */
export function fieldStarterInventory(): Counts {
  return ensureFieldStacks({});
}

export function clearFieldSave(storage: { removeItem(key: string): void }): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* nothing to clear */
  }
}
