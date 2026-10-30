import {itemByKey,canStoreItem} from "./itemCatalog.js";
import { BLOCKS, isPlaceableItem, type BlockDef } from "./blocks.js";

/**
 * Inventory + hotbar loadout + recipes. Counts stay one pile per block key.
 * The hotbar is nine chosen blocks plus a fixed water bucket, and a kind sits
 * on one slot (assigning it elsewhere swaps).
 */

export type Counts = Record<string, number>;

/** Default hotbar order (slots 1–9, then 0 the water bucket). */
export const HOTBAR: string[] = [
  "dirt",
  "stone",
  "sand",
  "oak-log",
  "oak-planks",
  "stone-bricks",
  "glass",
  "glowstone",
  "gold-block",
  "water",
];

export const HOTBAR_SLOTS = HOTBAR.length;
/** Last slot is the endless bucket and cannot be reassigned. */
export const WATER_SLOT = HOTBAR_SLOTS - 1;
export const CLASS_HOTBAR_KEY = "craftyap-class-hotbar-v1";

/**
 * First education / classroom bar. Island keeps {@link HOTBAR} (the blocks
 * you can actually mine at the start). A saved bar always wins over this.
 */
export const FIELD_HOTBAR: string[] = [
  "white-wool",
  "red-bricks",
  "oak-planks",
  "glass",
  "glowstone",
  "flower-grass",
  "question-block",
  "red-mushroom",
  "ice",
  "water",
];

export type BlockGroup = "earth" | "wood" | "stone" | "ore" | "color" | "light" | "special" | "tools";

export const BLOCK_GROUPS: { id: BlockGroup | "all"; ko: string; en: string }[] = [
  { id: "all", ko: "전체", en: "All" },
  { id: "tools", ko: "도구", en: "Tools" },
  { id: "earth", ko: "땅", en: "Earth" },
  { id: "wood", ko: "나무", en: "Wood" },
  { id: "stone", ko: "돌", en: "Stone" },
  { id: "ore", ko: "광물", en: "Ores" },
  { id: "color", ko: "색", en: "Colours" },
  { id: "light", ko: "빛", en: "Light" },
  { id: "special", ko: "특수", en: "Special" },
];

const GROUP: Record<string, BlockGroup> = {
  "pickaxe-basic": "tools",
  grass: "earth",
  "flower-grass": "earth",
  dirt: "earth",
  sand: "earth",
  "red-sand": "earth",
  gravel: "earth",
  clay: "earth",
  snow: "earth",
  "oak-log": "wood",
  "oak-leaves": "wood",
  "dark-leaves": "wood",
  "oak-planks": "wood",
  "birch-log": "wood",
  "birch-planks": "wood",
  "dark-planks": "wood",
  bookshelf: "wood",
  stone: "stone",
  cobblestone: "stone",
  "mossy-cobblestone": "stone",
  "stone-bricks": "stone",
  "red-bricks": "stone",
  sandstone: "stone",
  terracotta: "stone",
  "cracked-stone-bricks": "stone",
  "coal-ore": "ore",
  "iron-ore": "ore",
  "gold-ore": "ore",
  "diamond-ore": "ore",
  "emerald-ore": "ore",
  "lapis-ore": "ore",
  "ruby-ore": "ore",
  "iron-block": "ore",
  "gold-block": "ore",
  "diamond-block": "ore",
  "white-wool": "color",
  "orange-wool": "color",
  "yellow-wool": "color",
  "green-wool": "color",
  "red-wool": "color",
  "blue-wool": "color",
  "purple-wool": "color",
  "pink-wool": "color",
  "black-wool": "color",
  glass: "light",
  glowstone: "light",
  ice: "light",
  obsidian: "special",
  hay: "special",
  sponge: "special",
  "brown-mushroom": "special",
  "red-mushroom": "special",
  "question-block": "special",
};

export function blockGroup(key: string): BlockGroup | undefined {
  return GROUP[key];
}

/** Bag order: category chips first (땅, 나무, 돌…), then the order listed in that category. */
const BAG_ORDER = new Map<string, number>();
{
  let n = 0;
  for (const group of BLOCK_GROUPS) {
    if (group.id === "all") continue;
    for (const [key, id] of Object.entries(GROUP)) {
      if (id === group.id) BAG_ORDER.set(key, n++);
    }
  }
}

export function blockBagOrder(key: string): number {
  return BAG_ORDER.get(key) ?? 9999;
}

export interface CraftRecipe {
  id: string;
  name: string;
  /** inputs → outputs, both as block-key counts */
  input: Counts;
  output: Counts;
}

export const CRAFT_RECIPES: CraftRecipe[] = [
  { id: "planks", name: "Oak Planks", input: { "oak-log": 1 }, output: { "oak-planks": 4 } },
  { id: "bricks", name: "Stone Bricks", input: { stone: 4 }, output: { "stone-bricks": 4 } },
  { id: "glass", name: "Glass", input: { sand: 4 }, output: { glass: 4 } },
  { id: "glowstone", name: "Glowstone", input: { "coal-ore": 1, "oak-log": 1 }, output: { glowstone: 2 } },
  { id: "iron", name: "Iron Block", input: { "iron-ore": 4 }, output: { "iron-block": 1 } },
  { id: "gold", name: "Gold Block", input: { "gold-ore": 4 }, output: { "gold-block": 1 } },
  { id: "diamond", name: "Diamond Block", input: { "diamond-ore": 4 }, output: { "diamond-block": 1 } },
  { id: "grass", name: "Grass", input: { dirt: 1, "oak-leaves": 1 }, output: { grass: 1 } },
  { id: "cobble", name: "Cobblestone", input: { stone: 4 }, output: { cobblestone: 4 } },
  { id: "mossy", name: "Mossy Cobblestone", input: { cobblestone: 1, "oak-leaves": 1 }, output: { "mossy-cobblestone": 1 } },
  { id: "clay", name: "Clay", input: { dirt: 4 }, output: { clay: 4 } },
  { id: "red-bricks", name: "Red Bricks", input: { clay: 4 }, output: { "red-bricks": 4 } },
  { id: "terracotta", name: "Terracotta", input: { clay: 4 }, output: { terracotta: 4 } },
  { id: "sandstone", name: "Sandstone", input: { sand: 4 }, output: { sandstone: 4 } },
  { id: "red-sand", name: "Red Sand", input: { sand: 4 }, output: { "red-sand": 4 } },
  { id: "gravel", name: "Gravel", input: { stone: 4 }, output: { gravel: 4 } },
  { id: "cracked", name: "Cracked Stone Bricks", input: { "stone-bricks": 4 }, output: { "cracked-stone-bricks": 4 } },
  { id: "birch-log", name: "Birch Log", input: { "oak-log": 1 }, output: { "birch-log": 1 } },
  { id: "birch-planks", name: "Birch Planks", input: { "birch-log": 1 }, output: { "birch-planks": 4 } },
  { id: "dark-planks", name: "Dark Planks", input: { "oak-planks": 1 }, output: { "dark-planks": 1 } },
  { id: "bookshelf", name: "Bookshelf", input: { "oak-planks": 3 }, output: { bookshelf: 1 } },
  { id: "ice", name: "Ice", input: { glass: 1 }, output: { ice: 1 } },
  { id: "snow", name: "Snow", input: { ice: 1 }, output: { snow: 1 } },
  { id: "hay", name: "Hay", input: { "oak-leaves": 4 }, output: { hay: 1 } },
  { id: "sponge", name: "Sponge", input: { sand: 4, glowstone: 1 }, output: { sponge: 1 } },
  { id: "obsidian", name: "Obsidian", input: { "coal-ore": 4, stone: 4 }, output: { obsidian: 1 } },
  { id: "white-wool", name: "White Wool", input: { "oak-leaves": 2 }, output: { "white-wool": 4 } },
  { id: "wool-orange", name: "Orange Wool", input: { "white-wool": 1 }, output: { "orange-wool": 1 } },
  { id: "wool-yellow", name: "Yellow Wool", input: { "white-wool": 1 }, output: { "yellow-wool": 1 } },
  { id: "wool-green", name: "Green Wool", input: { "white-wool": 1 }, output: { "green-wool": 1 } },
  { id: "wool-red", name: "Red Wool", input: { "white-wool": 1 }, output: { "red-wool": 1 } },
  { id: "wool-blue", name: "Blue Wool", input: { "white-wool": 1 }, output: { "blue-wool": 1 } },
  { id: "wool-purple", name: "Purple Wool", input: { "white-wool": 1 }, output: { "purple-wool": 1 } },
  { id: "wool-pink", name: "Pink Wool", input: { "white-wool": 1 }, output: { "pink-wool": 1 } },
  { id: "wool-black", name: "Black Wool", input: { "white-wool": 1 }, output: { "black-wool": 1 } },
  { id: "emerald", name: "Emerald Ore", input: { "iron-ore": 1, stone: 1 }, output: { "emerald-ore": 1 } },
  { id: "lapis", name: "Lapis Ore", input: { "gold-ore": 1, stone: 1 }, output: { "lapis-ore": 1 } },
  { id: "ruby", name: "Ruby Ore", input: { "diamond-ore": 1, stone: 1 }, output: { "ruby-ore": 1 } },
  { id: "flower-grass", name: "Flower Grass", input: { grass: 1, "white-wool": 1 }, output: { "flower-grass": 1 } },
  { id: "dark-leaves", name: "Dark Leaves", input: { "oak-leaves": 1 }, output: { "dark-leaves": 1 } },
  { id: "brown-mushroom", name: "Brown Mushroom", input: { dirt: 1, hay: 1 }, output: { "brown-mushroom": 2 } },
  { id: "red-mushroom", name: "Red Mushroom", input: { "brown-mushroom": 1, "red-wool": 1 }, output: { "red-mushroom": 1 } },
  { id: "question-block", name: "Question Block", input: { "gold-block": 1, glowstone: 1 }, output: { "question-block": 1 } },
];

export function countOf(counts: Counts, key: string): number {
  return counts[key] ?? 0;
}

export function addItem(counts: Counts, key: string, n = 1): void {
  const def = itemByKey(key);
  if (!def || !canStoreItem(key) || !Number.isFinite(n) || n <= 0) return;
  counts[key] = Math.min(countOf(counts, key) + Math.floor(n), def.maxStack);
}

export function removeItem(counts: Counts, key: string, n = 1): boolean {
  if (countOf(counts, key) < n) return false;
  counts[key] = countOf(counts, key) - n;
  return true;
}

export function canCraftRecipe(counts: Counts, recipe: CraftRecipe): boolean {
  return Object.entries(recipe.input).every(([key, n]) => countOf(counts, key) >= n);
}

/** Attempt a craft; mutates and returns true on success. */
export function craftRecipe(counts: Counts, recipe: CraftRecipe): boolean {
  if (!canCraftRecipe(counts, recipe)) return false;
  for (const [key, n] of Object.entries(recipe.input)) counts[key] = countOf(counts, key) - n;
  for (const [key, n] of Object.entries(recipe.output)) addItem(counts, key, n);
  return true;
}

/** Craft up to `times` (capped at 16). Returns how many crafts succeeded. */
export function craftBatch(counts: Counts, recipe: CraftRecipe, times: number): number {
  const cap = Math.max(0, Math.min(16, Math.floor(times)));
  let made = 0;
  for (let i = 0; i < cap; i++) {
    if (!craftRecipe(counts, recipe)) break;
    made++;
  }
  return made;
}

function canHold(key: string): boolean {
  return canStoreItem(key);
}

/** Sanitize a loaded record: placeable keys, integer counts, clamped. */
export function sanitizeCounts(raw: Record<string, unknown>): Counts {
  const out: Counts = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!canHold(key)) continue;
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
    if (n > 0) out[key] = Math.min(n, itemByKey(key)!.maxStack);
  }
  return out;
}

export function defaultHotbar(): string[] {
  return [...HOTBAR];
}

export function fieldStarterHotbar(): string[] {
  return [...FIELD_HOTBAR];
}

/**
 * A loaded hotbar. Missing entirely → the default bar. A present array is
 * trusted slot by slot: illegal keys become empty, and a short array keeps
 * the default only for the slots it does not mention. Slot 0 (index 9) is
 * always water.
 */
export function sanitizeHotbar(raw: unknown): string[] {
  const out = defaultHotbar();
  if (!Array.isArray(raw)) return out;
  const limit = Math.min(raw.length, WATER_SLOT);
  for (let i = 0; i < limit; i++) {
    const key: unknown = raw[i];
    if (key === "") {
      out[i] = "";
      continue;
    }
    out[i] = typeof key === "string" && canHold(key) ? key : "";
  }
  out[WATER_SLOT] = "water";
  return out;
}

/**
 * Put `key` on `slot`. A block already sitting on another slot swaps with it,
 * so loading the bar never leaves two copies or throws the other block away.
 */
export function assignHotbar(hotbar: string[], slot: number, key: string): boolean {
  if (slot < 0 || slot >= WATER_SLOT || !canHold(key)) return false;
  const existing = hotbar.indexOf(key);
  if (existing >= 0 && existing < WATER_SLOT && existing !== slot) {
    hotbar[existing] = hotbar[slot] ?? "";
  }
  hotbar[slot] = key;
  hotbar[WATER_SLOT] = "water";
  return true;
}

export function clearHotbarSlot(hotbar: string[], slot: number): boolean {
  if (slot < 0 || slot >= WATER_SLOT) return false;
  hotbar[slot] = "";
  return true;
}

/** Education stacks: every placeable block the save does not already mention. */
export function ensureFieldStacks(counts: Counts): Counts {
  const out = sanitizeCounts(counts);
  for (const key of Object.keys(GROUP)) {
    if (out[key] === undefined) out[key] = Math.min(999, itemByKey(key)?.maxStack ?? 9999);
  }
  return out;
}

export function readStoredHotbar(
  storage: { getItem(key: string): string | null },
  key: string,
  fallback: () => string[] = defaultHotbar,
): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback();
    return sanitizeHotbar(JSON.parse(raw));
  } catch {
    return fallback();
  }
}

/** Placeable defs in catalog order, for the bag grid. */
export function placeableBlocks(): BlockDef[] {
  return BLOCKS.filter(isPlaceableItem);
}
