import { describe, expect, it } from "vitest";
import { CRAFT_RECIPES, type CraftRecipe } from "../src/craft/inventory.js";
import { emptyGrid, gridCounts, matchGrid, nearMisses, shapeKeys, stampRecipe } from "../src/craft/craftGrid.js";
import { itemByKey } from "../src/craft/itemCatalog.js";

const recipe = (id: string): CraftRecipe => CRAFT_RECIPES.find((entry) => entry.id === id)!;
/** Rows like "S.S" with a legend → a 9-cell grid. */
function grid(rows: string[], legend: Record<string, string>): string[] {
  const out = emptyGrid();
  rows.forEach((row, r) => [...row].forEach((ch, c) => { out[r * 3 + c] = ch === "." ? "" : legend[ch]!; }));
  return out;
}
const ids = (list: CraftRecipe[]): string[] => list.map((entry) => entry.id);

describe("recipe shapes (catalog)", () => {
  it("every recipe has a shape whose cells add up to its input", () => {
    for (const entry of CRAFT_RECIPES) {
      const cells = shapeKeys(entry).flat().filter(Boolean);
      const counted: Record<string, number> = {};
      for (const key of cells) counted[key] = (counted[key] ?? 0) + 1;
      expect(counted, entry.id).toEqual(entry.input);
      for (const key of Object.keys(entry.input)) expect(itemByKey(key), `${entry.id}: ${key}`).toBeTruthy();
    }
  });

  it("shapes are trimmed (no empty outer row or column)", () => {
    for (const entry of CRAFT_RECIPES) {
      const rows = shapeKeys(entry);
      expect(rows[0]!.some(Boolean) && rows.at(-1)!.some(Boolean), entry.id).toBe(true);
      expect(rows.some((row) => row[0]) && rows.some((row) => row.at(-1)), entry.id).toBe(true);
    }
  });

  it("every recipe is reachable: its own stamp matches it", () => {
    for (const entry of CRAFT_RECIPES) expect(ids(matchGrid(stampRecipe(entry))), entry.id).toContain(entry.id);
  });

  it("only one-block shapes are shared (the grid offers a choice there, nowhere else)", () => {
    for (const entry of CRAFT_RECIPES) {
      const all = matchGrid(stampRecipe(entry));
      if (all.length > 1) expect(entry.shape, `${ids(all).join(",")}`).toEqual(["a"]);
    }
    expect(ids(matchGrid(stampRecipe(recipe("planks"))))).toEqual(["planks", "birch-log"]);
    expect(matchGrid(stampRecipe(recipe("white-wool")))).toHaveLength(1);
    expect(matchGrid(grid(["W"], { W: "white-wool" }))).toHaveLength(8);
  });

  it("a malformed shape is refused", () => {
    const bad = (shape: string[]): CraftRecipe => ({ id: "x", name: "X", input: { stone: 1 }, output: { stone: 1 }, shape });
    expect(() => shapeKeys(bad(["b"]))).toThrow();
    expect(() => shapeKeys(bad(["aa", "a"]))).toThrow();
    expect(() => shapeKeys(bad(["aaaa"]))).toThrow();
    expect(() => shapeKeys(bad([]))).toThrow();
  });
});

describe("matchGrid", () => {
  const S = { S: "stone" };
  it("the same four stones make different blocks by shape", () => {
    expect(ids(matchGrid(grid(["SS.", "SS.", "..."], S)))).toEqual(["bricks"]);
    expect(ids(matchGrid(grid([".S.", "S.S", ".S."], S)))).toEqual(["cobble"]);
    expect(ids(matchGrid(grid(["S.S", "...", "S.S"], S)))).toEqual(["gravel"]);
  });

  it("a shape matches anywhere on the grid", () => {
    expect(ids(matchGrid(grid(["...", ".SS", ".SS"], S)))).toEqual(["bricks"]);
    expect(ids(matchGrid(grid(["...", "...", "..L"], { L: "oak-log" })))).toEqual(["planks", "birch-log"]);
  });

  it("a shape matches mirrored but not upside down", () => {
    // obsidian is symmetric; a two-high stack is not: coal over log is glowstone, log over coal is nothing
    expect(ids(matchGrid(grid(["C..", "L..", "..."], { C: "coal-ore", L: "oak-log" })))).toEqual(["glowstone"]);
    expect(matchGrid(grid(["L..", "C..", "..."], { C: "coal-ore", L: "oak-log" }))).toEqual([]);
    const lopsided: CraftRecipe = { id: "l", name: "L", input: { stone: 2, sand: 1 }, output: { gravel: 1 }, shape: ["aa", "b."] };
    expect(ids(matchGrid(grid(["SS.", "D..", "..."], { S: "stone", D: "sand" }), [lopsided]))).toEqual(["l"]);
    expect(ids(matchGrid(grid(["SS.", ".D.", "..."], { S: "stone", D: "sand" }), [lopsided]))).toEqual(["l"]);
    expect(matchGrid(grid(["D..", "SS.", "..."], { S: "stone", D: "sand" }), [lopsided])).toEqual([]);
  });

  it("an extra block, a gap or a wrong block breaks the match", () => {
    expect(matchGrid(grid(["SS.", "SS.", "S.."], S))).toEqual([]);
    expect(matchGrid(grid(["S.S", "S.S", "..."], S))).toEqual([]);
    expect(matchGrid(grid(["SS.", "SD.", "..."], { S: "stone", D: "sand" }))).toEqual([]);
    expect(matchGrid(emptyGrid())).toEqual([]);
  });

  it("garbage cells never match and never throw", () => {
    expect(matchGrid(["nope", "", "", "", "", "", "", "", ""])).toEqual([]);
    expect(matchGrid([])).toEqual([]);
  });
});

describe("nearMisses + gridCounts", () => {
  it("right blocks in the wrong shape name what they could make", () => {
    const line = grid(["SSS", "S..", "..."], { S: "stone" });
    expect(matchGrid(line)).toEqual([]);
    expect(ids(nearMisses(line))).toEqual(["bricks", "cobble", "gravel"]);
    expect(gridCounts(line)).toEqual({ stone: 4 });
  });

  it("no near miss once it matches, or for blocks that make nothing", () => {
    expect(nearMisses(stampRecipe(recipe("bricks")))).toEqual([]);
    expect(nearMisses(grid(["G"], { G: "glowstone" }))).toEqual([]);
    expect(nearMisses(emptyGrid())).toEqual([]);
  });

  it("a stamp is centred and holds exactly the recipe's input", () => {
    expect(stampRecipe(recipe("planks"))).toEqual(["", "", "", "", "oak-log", "", "", "", ""]);
    for (const entry of CRAFT_RECIPES) expect(gridCounts(stampRecipe(entry)), entry.id).toEqual(entry.input);
  });
});
