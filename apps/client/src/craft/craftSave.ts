import { z } from "zod";
import { AIR, blockById } from "./blocks.js";
import { sanitizeCounts, type Counts } from "./inventory.js";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z, generateIsland, surfaceY } from "./voxelWorld.js";

/**
 * Craft-mode persistence. The world regenerates from its seed; only the
 * player's EDITS (a sparse diff of mined/placed cells) are stored, so the
 * save stays tiny no matter how long you play. Corrupt or hostile payloads
 * fall back to a fresh island — never a crash.
 */

const SAVE_KEY = "craftyap-craft-save-v1";

const saveSchema = z.object({
  v: z.literal(1),
  seed: z.number().int(),
  /** [index, blockId] pairs — cells that differ from the generated island. */
  edits: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).max(200_000),
  inventory: z.record(z.string(), z.number()),
  player: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
  savedAtMs: z.number().finite().positive(),
});

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CraftGameState {
  seed: number;
  world: VoxelWorld;
  inventory: Counts;
  player: { x: number; y: number; z: number };
}

export function freshState(seed: number): CraftGameState {
  const world = generateIsland(seed);
  // spawn on the grass SOUTH of the central castle, not on top of the keep,
  // so the landmark is right in front of you at the start
  const x = WORLD_X / 2 + 0.5;
  const z = WORLD_Z / 2 + 22.5;
  return {
    seed,
    world,
    inventory: {},
    player: { x, y: surfaceY(world, Math.floor(x), Math.floor(z)) + 1, z },
  };
}

export function serializeCraft(state: CraftGameState, nowMs: number): string {
  const pristine = generateIsland(state.seed);
  const edits: [number, number][] = [];
  for (let i = 0; i < state.world.cells.length; i++) {
    if (state.world.cells[i] !== pristine.cells[i]) {
      edits.push([i, state.world.cells[i]!]);
    }
  }
  return JSON.stringify({
    v: 1,
    seed: state.seed,
    edits,
    inventory: state.inventory,
    player: state.player,
    savedAtMs: nowMs,
  });
}

export function saveCraft(state: CraftGameState, storage: KeyValueStorage, nowMs: number): void {
  try {
    storage.setItem(SAVE_KEY, serializeCraft(state, nowMs));
  } catch {
    // storage full/unavailable — keep playing unsaved
  }
}

export function clearCraftSave(storage: { removeItem(key: string): void }): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function loadCraft(storage: KeyValueStorage, defaultSeed: number): CraftGameState {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SAVE_KEY);
  } catch {
    /* unavailable */
  }
  if (!raw) return freshState(defaultSeed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshState(defaultSeed);
  }
  const result = saveSchema.safeParse(parsed);
  if (!result.success) return freshState(defaultSeed);

  const d = result.data;
  const state = freshState(d.seed);
  const cellCount = WORLD_X * WORLD_Y * WORLD_Z;
  for (const [index, id] of d.edits) {
    if (index < cellCount && (id === AIR || blockById(id))) {
      state.world.cells[index] = id;
    }
  }
  state.inventory = sanitizeCounts(d.inventory);
  // a save from inside a wall (or out of bounds) respawns on the surface
  const px = Math.min(Math.max(d.player.x, 1), WORLD_X - 1);
  const pz = Math.min(Math.max(d.player.z, 1), WORLD_Z - 1);
  const py = Math.min(Math.max(d.player.y, 1), WORLD_Y + 4);
  state.player = { x: px, y: py, z: pz };
  return state;
}
