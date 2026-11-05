import { CRAFT_RECIPES, type Counts, type CraftRecipe } from "./inventory.js";

/**
 * The 3×3 crafting grid, DOM-free. A grid is nine block keys, row-major,
 * "" for an empty cell. It is a stencil: putting a block on it takes nothing
 * from the bag, crafting spends the recipe's input. So closing the bag, a
 * reload or a crash can never lose items left "in the grid".
 *
 * Matching is Minecraft's shaped rule: the filled cells, cut to their
 * bounding box, must equal the recipe's shape exactly (empty cells included),
 * anywhere on the grid, as drawn or mirrored left-right.
 */

export const GRID_SIZE = 3;
export const GRID_CELLS = GRID_SIZE * GRID_SIZE;

export type CraftGrid = string[];

export function emptyGrid(): CraftGrid {
  return Array.from({ length: GRID_CELLS }, () => "");
}

/** A recipe's shape as rows of block keys ("" = empty). Throws on a malformed shape (the catalog test runs it on every recipe). */
export function shapeKeys(recipe: CraftRecipe): string[][] {
  const keys = Object.keys(recipe.input);
  const rows = recipe.shape.map((row) => [...row].map((ch) => {
    if (ch === ".") return "";
    const key = keys[ch.charCodeAt(0) - 97];
    if (!key || ch < "a" || ch > "z") throw new Error(`recipe ${recipe.id}: "${ch}" names no input`);
    return key;
  }));
  const width = rows[0]?.length ?? 0;
  if (rows.length < 1 || rows.length > GRID_SIZE || width < 1 || width > GRID_SIZE || rows.some((row) => row.length !== width)) {
    throw new Error(`recipe ${recipe.id}: shape must be a rectangle within ${GRID_SIZE}×${GRID_SIZE}`);
  }
  return rows;
}

/** The filled part of a grid as rows, or null when the grid is empty. */
function trim(grid: readonly string[]): string[][] | null {
  let top = GRID_SIZE, bottom = -1, left = GRID_SIZE, right = -1;
  for (let i = 0; i < GRID_CELLS; i++) {
    if (!grid[i]) continue;
    const r = Math.floor(i / GRID_SIZE), c = i % GRID_SIZE;
    top = Math.min(top, r); bottom = Math.max(bottom, r);
    left = Math.min(left, c); right = Math.max(right, c);
  }
  if (bottom < 0) return null;
  const rows: string[][] = [];
  for (let r = top; r <= bottom; r++) {
    const row: string[] = [];
    for (let c = left; c <= right; c++) row.push(grid[r * GRID_SIZE + c] ?? "");
    rows.push(row);
  }
  return rows;
}

function sameRows(a: string[][], b: string[][], mirror: boolean): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    const ra = a[r]!, rb = b[r]!;
    if (ra.length !== rb.length) return false;
    for (let c = 0; c < ra.length; c++) if (ra[c] !== rb[mirror ? rb.length - 1 - c : c]) return false;
  }
  return true;
}

const SHAPES = new Map<string, string[][]>();
function cachedShape(recipe: CraftRecipe): string[][] {
  let rows = SHAPES.get(recipe.id);
  if (!rows) SHAPES.set(recipe.id, (rows = shapeKeys(recipe)));
  return rows;
}

/**
 * Every recipe this grid makes, in catalog order. Usually one; a few shapes are
 * shared on purpose (one oak log → planks or a birch log, one white wool →
 * any colour) and the grid offers the choice.
 */
export function matchGrid(grid: readonly string[], recipes: readonly CraftRecipe[] = CRAFT_RECIPES): CraftRecipe[] {
  const rows = trim(grid);
  if (!rows) return [];
  return recipes.filter((recipe) => {
    const shape = cachedShape(recipe);
    return sameRows(rows, shape, false) || sameRows(rows, shape, true);
  });
}

/** Blocks the grid holds, counted (what one craft from it spends). */
export function gridCounts(grid: readonly string[]): Counts {
  const out: Counts = {};
  for (const key of grid) if (key) out[key] = (out[key] ?? 0) + 1;
  return out;
}

const sameCounts = (a: Counts, b: Counts): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((key) => a[key] === b[key]);
};

/**
 * Recipes whose ingredients are exactly on the grid but laid out in another
 * shape: "the right blocks — try another shape". Empty when the grid matches.
 */
export function nearMisses(grid: readonly string[], recipes: readonly CraftRecipe[] = CRAFT_RECIPES): CraftRecipe[] {
  const have = gridCounts(grid);
  if (Object.keys(have).length === 0 || matchGrid(grid, recipes).length > 0) return [];
  return recipes.filter((recipe) => sameCounts(recipe.input, have));
}

/** A grid holding this recipe's shape, centred (what the recipe book's "put on grid" does). */
export function stampRecipe(recipe: CraftRecipe): CraftGrid {
  const rows = cachedShape(recipe);
  const grid = emptyGrid();
  const top = Math.floor((GRID_SIZE - rows.length) / 2);
  const left = Math.floor((GRID_SIZE - rows[0]!.length) / 2);
  rows.forEach((row, r) => row.forEach((key, c) => { grid[(top + r) * GRID_SIZE + left + c] = key; }));
  return grid;
}

