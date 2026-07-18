import { blockByKey } from "./blocks.js";

/**
 * Inventory + recipes — pure logic. Item keys are block keys; counts live in
 * a plain record. The hotbar is the fixed list of placeable block kinds; a
 * slot is active when you own at least one of it.
 */

export type Counts = Record<string, number>;

/** Slot order shown in the hotbar (1–9). */
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
];

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
];

export function countOf(counts: Counts, key: string): number {
  return counts[key] ?? 0;
}

export function addItem(counts: Counts, key: string, n = 1): void {
  if (!blockByKey(key)) return; // unknown key from a stale save — ignore
  counts[key] = Math.min(countOf(counts, key) + n, 9999);
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

/** Sanitize a loaded record: known keys, integer counts, clamped. */
export function sanitizeCounts(raw: Record<string, unknown>): Counts {
  const out: Counts = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!blockByKey(key)) continue;
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
    if (n > 0) out[key] = Math.min(n, 9999);
  }
  return out;
}
