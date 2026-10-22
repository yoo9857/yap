import { z } from "zod";
import { AIR, blockById } from "./blocks.js";
import { sanitizeCounts, type Counts } from "./inventory.js";
import { isPetSpecies, type PetSpecies } from "../player/creatureRig.js";
import { VoxelWorld, WORLD_X, WORLD_Y, WORLD_Z, CRAFT_SPAWN, generateIsland, surfaceY } from "./voxelWorld.js";

/**
 * Craft-mode persistence. The world regenerates from its seed; only the
 * player's EDITS (a sparse diff of mined/placed cells) are stored, so the
 * save stays tiny no matter how long you play. Corrupt or hostile payloads
 * fall back to a fresh island — never a crash.
 */

const SAVE_KEY = "craftyap-craft-save-v1";

const saveSchema = z.object({
  // v1 saves have no `shapes` (all cubes); v2 adds the brick-shape diff
  v: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  seed: z.number().int(),
  /** [index, blockId] pairs — cells that differ from the generated island. */
  edits: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).max(200_000),
  /** [index, shapeId] pairs for non-cube bricks (round/slope). */
  shapes: z
    .array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]))
    .max(200_000)
    .optional(),
  inventory: z.record(z.string(), z.number()),
  player: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
  /** Adopted companion. Optional and loosely typed on the way in: every save
   *  written before the adoption panel existed has no pet, and an unknown
   *  string from a hand-edited payload falls back to the dog rather than
   *  failing the whole parse and wiping the island. */
  pet: z.string().optional(),
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
  pet: PetSpecies;
}

export function freshState(seed: number): CraftGameState {
  const world = generateIsland(seed);
  // Spawn on the outer south lawn, beyond the moat and gate approach, so the
  // whole academy silhouette is visible immediately instead of starting inside.
  const { x, z } = CRAFT_SPAWN;
  return {
    seed,
    world,
    inventory: {},
    player: { x, y: surfaceY(world, Math.floor(x), Math.floor(z)) + 1, z },
    pet: "dog",
  };
}

/** Generating the island (castle, town, ores) is costly; the autosave used to
 *  redo it every 5 s just to diff against. Keep the pristine cells per seed. */
const pristineCells = new Map<number, Uint8Array>();
/** Last diff per world, reused while the world's version hasn't moved. */
const diffCache = new WeakMap<VoxelWorld, { version: number; edits: [number, number][]; shapes: [number, number][] }>();

function diffWorld(state: CraftGameState): { edits: [number, number][]; shapes: [number, number][] } {
  const cached = diffCache.get(state.world);
  if (cached && cached.version === state.world.version) return cached;
  let pristine = pristineCells.get(state.seed);
  if (!pristine) pristineCells.set(state.seed, (pristine = generateIsland(state.seed).cells));
  const edits: [number, number][] = [];
  const shapes: [number, number][] = [];
  const { cells } = state.world;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== pristine[i]) edits.push([i, cells[i]!]);
    // pristine terrain is all cubes, so any non-zero shape is a player brick
    if (state.world.shapes[i] !== 0) shapes.push([i, state.world.shapes[i]!]);
  }
  const diff = { version: state.world.version, edits, shapes };
  diffCache.set(state.world, diff);
  return diff;
}

export function serializeCraft(state: CraftGameState, nowMs: number): string {
  const { edits, shapes } = diffWorld(state);
  return JSON.stringify({
    v: 3,
    seed: state.seed,
    edits,
    shapes,
    inventory: state.inventory,
    player: state.player,
    pet: state.pet,
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
  // v1/v2 packed an 80 x 56 x 80 grid. Decode its coordinates before
  // applying either block or shape edits to the expanded world.
  const remap = (index: number): number => {
    if (d.v === 3) return index;
    if (index >= 80 * WORLD_Y * 80) return cellCount;
    return VoxelWorld.index(index % 80, Math.floor(index / 6400), Math.floor(index / 80) % 80);
  };
  for (const [index, id] of d.edits) {
    const target = remap(index);
    if (target < cellCount && (id === AIR || blockById(id))) {
      state.world.cells[target] = id;
    }
  }
  for (const [index, shape] of d.shapes ?? []) {
    const target = remap(index);
    if (target < cellCount && shape <= 17) state.world.shapes[target] = shape;
  }
  state.inventory = sanitizeCounts(d.inventory);
  if (isPetSpecies(d.pet)) state.pet = d.pet;
  // a save from inside a wall (or out of bounds) respawns on the surface
  const px = Math.min(Math.max(d.player.x, 1), WORLD_X - 1);
  const pz = Math.min(Math.max(d.player.z, 1), WORLD_Z - 1);
  const py = Math.min(Math.max(d.player.y, 1), WORLD_Y + 4);
  state.player = { x: px, y: py, z: pz };

  // One-time migration for saves made before the academy was moved behind the
  // outer lawn. Only the exact old default spawn is relocated; a player who
  // deliberately built near the castle keeps their position untouched.
  const oldSpawnX = CRAFT_SPAWN.x;
  const oldSpawnZ = CRAFT_SPAWN.z - 10;
  if (Math.abs(px - oldSpawnX) < 0.01 && Math.abs(pz - oldSpawnZ) < 0.01) {
    const fresh = freshState(d.seed);
    state.player = fresh.player;
  }
  return state;
}
