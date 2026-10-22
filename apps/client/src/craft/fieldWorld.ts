import { z } from "zod";
import { AIR, blockById, blockByKey } from "./blocks.js";
import { HOTBAR, sanitizeCounts, type Counts } from "./inventory.js";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z } from "./voxelWorld.js";
import type { KeyValueStorage } from "./craftSave.js";

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
const SAVE_KEY = "craftyap-field-save-v1";
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
    .max(400_000),
  inventory: z.record(z.string(), z.number()),
  player: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
  /** Adopted companion. Optional: fields saved before the adoption panel
   *  existed have none, and the caller falls back to the dog. */
  pet: z.string().optional(),
});

export class FieldWindow {
  readonly world = new VoxelWorld();
  private readonly column = fieldColumn();
  /** Absolute cell key → [blockId, shape], for cells outside the live window
   *  (and, after a bank(), inside it too). */
  private readonly edits = new Map<string, [number, number]>();
  /** Absolute coordinate of grid cell (0, 0). */
  private originX = -CENTER_X;
  private originZ = -CENTER_Z;
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
    for (const key of this.edits.keys()) {
      const [ax, y, az] = key.split(",").map(Number) as [number, number, number];
      if (this.world.inBounds(ax - this.originX, y, az - this.originZ)) this.edits.delete(key);
    }
    const { cells, shapes } = this.world;
    for (let y = 0; y < WORLD_Y; y++) {
      const pristine = this.column[y]!;
      let i = VoxelWorld.index(0, y, 0);
      for (let z = 0; z < WORLD_Z; z++) {
        for (let x = 0; x < WORLD_X; x++, i++) {
          if (cells[i] === pristine && shapes[i] === 0) continue;
          this.edits.set(`${x + this.originX},${y},${z + this.originZ}`, [cells[i]!, shapes[i]!]);
        }
      }
    }
    this.bankedVersion = this.world.version;
  }

  /** Rebuild the window from the flat field plus banked edits. */
  private fill(): void {
    const { cells, shapes } = this.world;
    for (let y = 0; y < WORLD_Y; y++) {
      const start = VoxelWorld.index(0, y, 0);
      cells.fill(this.column[y]!, start, start + WORLD_X * WORLD_Z);
    }
    shapes.fill(0);
    for (const [key, [block, shape]] of this.edits) {
      const [ax, y, az] = key.split(",").map(Number) as [number, number, number];
      const x = ax - this.originX;
      const z = az - this.originZ;
      if (!this.world.inBounds(x, y, z)) continue;
      const i = VoxelWorld.index(x, y, z);
      cells[i] = block;
      shapes[i] = shape;
    }
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
    return this.edits.get(`${ax},${y},${az}`) ?? [this.column[y] ?? 0, 0];
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
    const key = `${ax},${y},${az}`;
    if (block === (this.column[y] ?? 0) && shape === 0) this.edits.delete(key);
    else this.edits.set(key, [block, shape]);
    return null;
  }

  hasEdits(): boolean {
    return this.edits.size > 0 || this.world.version !== this.bankedVersion;
  }

  /** Replace the whole field with the class's (join / reconnect). */
  replaceAll(edits: readonly (readonly [number, number, number, number, number])[]): void {
    this.edits.clear();
    for (const [ax, y, az, block, shape] of edits) {
      if (y >= 0 && y < WORLD_Y) this.edits.set(`${ax},${y},${az}`, [block, shape]);
    }
    this.fill();
  }

  save(
    storage: KeyValueStorage,
    inventory: Counts,
    player: { x: number; y: number; z: number },
    pet?: string,
  ): void {
    this.bank();
    const edits = [...this.edits].map(([key, [block, shape]]) => [...key.split(",").map(Number), block, shape]);
    try {
      storage.setItem(
        SAVE_KEY,
        JSON.stringify({ v: 1, originX: this.originX, originZ: this.originZ, edits, inventory, player, pet }),
      );
    } catch {
      // storage full/unavailable — keep playing unsaved
    }
  }

  /** Restore a saved field; returns its inventory/player or null for a fresh one. */
  load(
    storage: KeyValueStorage,
  ): { inventory: Counts; player: { x: number; y: number; z: number }; pet?: string } | null {
    let parsed: unknown;
    try {
      const raw = storage.getItem(SAVE_KEY);
      if (!raw) return null;
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = saveSchema.safeParse(parsed);
    if (!result.success) return null;
    const d = result.data;
    this.originX = d.originX;
    this.originZ = d.originZ;
    this.edits.clear();
    for (const [x, y, zz, block, shape] of d.edits) {
      if (y < 0 || y >= WORLD_Y || shape < 0 || shape > 17) continue;
      if (block !== AIR && !blockById(block)) continue;
      this.edits.set(`${x},${y},${zz}`, [block, shape]);
    }
    this.fill();
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, 1), hi - 1);
    return {
      inventory: sanitizeCounts(d.inventory),
      player: { x: clamp(d.player.x, WORLD_X), y: clamp(d.player.y, WORLD_Y + 4), z: clamp(d.player.z, WORLD_Z) },
      pet: d.pet,
    };
  }
}

/** Education mode is for building, not grinding: start with full stacks. */
export function fieldStarterInventory(): Counts {
  const inventory: Counts = {};
  for (const key of HOTBAR) inventory[key] = 999;
  return inventory;
}

export function clearFieldSave(storage: { removeItem(key: string): void }): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* nothing to clear */
  }
}
