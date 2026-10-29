import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { MAX_SOLID_ID, PLAYER_SOLID_IDS, WATER, isPlayerBlock } from "@robo/shared";
import { AIR, BLOCKS, blockByKey, dropOf, blockById, isPlaceableItem } from "../src/craft/blocks.js";
import {
  VoxelWorld,
  WORLD_X,
  WORLD_Z,
  CASTLE_CENTER,
  generateIsland,
  surfaceY,
} from "../src/craft/voxelWorld.js";
import {
  stepBody,
  overlapsVoxel,
  wishFromInput,
  BODY_HEIGHT,
  type Body,
} from "../src/craft/voxelBody.js";
import {
  BLOCK_GROUPS,
  CRAFT_RECIPES,
  HOTBAR,
  addItem,
  assignHotbar,
  craftBatch,
  FIELD_HOTBAR,
  blockBagOrder,
  blockGroup,
  canCraftRecipe,
  clearHotbarSlot,
  countOf,
  craftRecipe,
  defaultHotbar,
  ensureFieldStacks,
  placeableBlocks,
  sanitizeCounts,
  sanitizeHotbar,
} from "../src/craft/inventory.js";
import { freshState, loadCraft, serializeCraft } from "../src/craft/craftSave.js";

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe("island generation", () => {
  it("is deterministic per seed and varies across seeds", () => {
    const a = generateIsland(7);
    const b = generateIsland(7);
    const c = generateIsland(8);
    expect(Buffer.from(a.cells).equals(Buffer.from(b.cells))).toBe(true);
    expect(Buffer.from(a.cells).equals(Buffer.from(c.cells))).toBe(false);
  });

  it("builds a walkable island: bedrock floor, grass surface, some ores and trees", () => {
    const world = generateIsland(20260718);
    const counts = new Map<number, number>();
    for (const cell of world.cells) counts.set(cell, (counts.get(cell) ?? 0) + 1);
    const n = (key: string) => counts.get(blockByKey(key)!.id) ?? 0;
    expect(n("bedrock")).toBeGreaterThan(200);
    expect(n("grass")).toBeGreaterThan(200);
    expect(n("stone")).toBeGreaterThan(1000);
    expect(n("coal-ore")).toBeGreaterThan(5);
    expect(n("oak-log")).toBeGreaterThan(3);
    expect(surfaceY(world, CASTLE_CENTER, CASTLE_CENTER)).toBeGreaterThan(3);
  });

  it("connects the old castle to open mainland and accessible factory interiors", () => {
    for (const seed of [1, 42, 20260718]) {
      const world = generateIsland(seed);
      let previous = surfaceY(world, 40, 79);
      for (let z = 80; z <= 94; z++) {
        const top = surfaceY(world, 40, z);
        expect(Math.abs(top - previous)).toBeLessThanOrEqual(1);
        previous = top;
      }
      for (let x = 43; x <= 148; x++) expect(surfaceY(world, x, 94)).toBe(12);
      for (const [x, z] of [[106, 87], [134, 87], [106, 113], [134, 113]]) {
        expect(world.isSolid(x!, 12, z!)).toBe(true);
        expect(world.get(x!, 13, z!)).toBe(AIR);
        expect(world.get(x!, 14, z!)).toBe(AIR);
      }
      let meadow = 0;
      for (let x = 10; x < 95; x++) for (let z = 100; z < 125; z++) {
        if (world.get(x, surfaceY(world, x, z), z) === blockByKey("grass")!.id) meadow++;
      }
      expect(meadow).toBeGreaterThan(1500);
    }
  });
});

describe("voxel raycast", () => {
  it("hits the first solid cell and reports the cell before it", () => {
    const world = new VoxelWorld();
    world.set(5, 3, 5, blockByKey("stone")!.id);
    const hit = world.raycast(2.5, 3.5, 5.5, 1, 0, 0, 10);
    expect(hit).not.toBeNull();
    expect(hit!.voxel).toEqual([5, 3, 5]);
    expect(hit!.before).toEqual([4, 3, 5]);
    expect(hit!.dist).toBeCloseTo(2.5, 5); // entered the voxel face at x=5
  });

  it("misses when nothing is in reach", () => {
    const world = new VoxelWorld();
    world.set(20, 3, 5, blockByKey("stone")!.id);
    expect(world.raycast(2.5, 3.5, 5.5, 1, 0, 0, 6)).toBeNull();
  });
});

describe("voxel body physics", () => {
  const flatWorld = () => {
    const world = new VoxelWorld();
    const stone = blockByKey("stone")!.id;
    for (let x = 0; x < WORLD_X; x++) for (let z = 0; z < WORLD_Z; z++) world.set(x, 3, z, stone);
    return world;
  };
  const makeBody = (y: number): Body => ({ x: 10.5, y, z: 10.5, vx: 0, vy: 0, vz: 0, grounded: false });

  it("falls onto the floor and lands exactly, even from tunnelling heights", () => {
    const world = flatWorld();
    const body = makeBody(25);
    for (let i = 0; i < 600; i++) stepBody(world, body, 1 / 60, 0, 0, false);
    expect(body.y).toBeCloseTo(4, 3);
    expect(body.grounded).toBe(true);
  });

  it("walls block horizontal movement", () => {
    const world = flatWorld();
    const stone = blockByKey("stone")!.id;
    for (let y = 4; y < 8; y++) world.set(12, y, 10, stone);
    const body = makeBody(4);
    body.grounded = true;
    for (let i = 0; i < 240; i++) stepBody(world, body, 1 / 60, 1, 0, false);
    // contact resolution: flush against the wall face (12 − half-width 0.3,
    // ± the collision EPS)
    expect(body.x).toBeCloseTo(11.7, 2);
  });

  it("does NOT auto-climb a 1-block ledge — walking into it just stops (jump to climb)", () => {
    const world = flatWorld(); // floor at y=3, top surface y=4
    const stone = blockByKey("stone")!.id;
    for (let x = 12; x < WORLD_X; x++) for (let z = 0; z < WORLD_X; z++) world.set(x, 4, z, stone);
    const body = makeBody(4);
    body.grounded = true;
    for (let i = 0; i < 240; i++) stepBody(world, body, 1 / 60, 1, 0, false);
    expect(body.x).toBeLessThan(11.75); // stopped flush at the ledge face
    expect(body.y).toBeCloseTo(4, 1); // stayed at ground level — no teleport up
  });

  it("clears a 1-block ledge WHEN jumping", () => {
    const world = flatWorld();
    const stone = blockByKey("stone")!.id;
    for (let x = 12; x < WORLD_X; x++) for (let z = 0; z < WORLD_X; z++) world.set(x, 4, z, stone);
    const body = makeBody(4);
    body.grounded = true;
    // hold forward and tap jump repeatedly until we're up on the ledge
    for (let i = 0; i < 400; i++) stepBody(world, body, 1 / 60, 1, 0, body.grounded);
    expect(body.x).toBeGreaterThan(12.5);
    expect(body.y).toBeGreaterThan(4.9); // now standing on the raised floor
  });

  it("jumps about two blocks high and comes back down", () => {
    const world = flatWorld();
    const body = makeBody(4);
    body.grounded = true;
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      stepBody(world, body, 1 / 60, 0, 0, i === 0);
      peak = Math.max(peak, body.y - 4);
    }
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(2.2);
    expect(body.grounded).toBe(true);
  });

  it("W/A/S/D map to camera-relative directions (D goes screen-right)", () => {
    // yaw 0: camera looks +z, screen-right is -x
    expect(wishFromInput(0, 1, 0)[1]).toBeCloseTo(1); // W → +z
    expect(wishFromInput(0, 0, 1)[0]).toBeCloseTo(-1); // D → -x
    expect(wishFromInput(0, 0, -1)[0]).toBeCloseTo(1); // A → +x
    // yaw 90° (looking +x): D must go +z
    const d = wishFromInput(Math.PI / 2, 0, 1);
    expect(d[0]).toBeCloseTo(0);
    expect(d[1]).toBeCloseTo(1);
    // diagonals stay unit length
    const diag = wishFromInput(0.7, 1, 1);
    expect(Math.hypot(diag[0], diag[1])).toBeCloseTo(1);
  });

  it("placement overlap check protects the player's own cells", () => {
    const body = makeBody(4);
    expect(overlapsVoxel(body, 10, 4, 10)).toBe(true);
    expect(overlapsVoxel(body, 10, Math.ceil(4 + BODY_HEIGHT), 10)).toBe(false);
    expect(overlapsVoxel(body, 13, 4, 10)).toBe(false);
  });
});

describe("inventory + recipes", () => {
  it("crafts when affordable, consumes inputs, yields outputs", () => {
    const counts = {};
    addItem(counts, "oak-log", 2);
    const planks = CRAFT_RECIPES.find((r) => r.id === "planks")!;
    expect(canCraftRecipe(counts, planks)).toBe(true);
    expect(craftRecipe(counts, planks)).toBe(true);
    expect(countOf(counts, "oak-log")).toBe(1);
    expect(countOf(counts, "oak-planks")).toBe(4);
  });

  it("refuses unaffordable crafts without side effects", () => {
    const counts = { stone: 3 };
    const bricks = CRAFT_RECIPES.find((r) => r.id === "bricks")!;
    expect(craftRecipe(counts, bricks)).toBe(false);
    expect(countOf(counts, "stone")).toBe(3);
  });

  it("every recipe input/output uses known block keys", () => {
    expect(new Set(CRAFT_RECIPES.map((recipe) => recipe.id)).size).toBe(CRAFT_RECIPES.length);
    for (const recipe of CRAFT_RECIPES) {
      for (const key of [...Object.keys(recipe.input), ...Object.keys(recipe.output)]) {
        expect(blockByKey(key), `unknown key ${key} in ${recipe.id}`).toBeDefined();
        expect(isPlaceableItem(blockByKey(key)!), key).toBe(true);
      }
    }
  });

  it("catalog ids are unique, placeable, and match the shared classroom gate", () => {
    const ids = BLOCKS.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BLOCKS.map((block) => block.key)).size).toBe(BLOCKS.length);
    expect(blockByKey("white-wool")!.id).toBe(29);
    expect(blockByKey("ruby-ore")!.id).toBe(58);
    expect(blockByKey("question-block")!.id).toBe(MAX_SOLID_ID);
    for (const def of BLOCKS) {
      expect(existsSync(`public/textures/blocks/${def.texture}.png`), def.texture).toBe(true);
      if (def.fluid) expect(def.id).toBe(WATER);
      else expect(PLAYER_SOLID_IDS.has(def.id), def.key).toBe(true);
    }
    for (const id of PLAYER_SOLID_IDS) {
      const def = blockById(id);
      expect(def, `missing catalog row ${id}`).toBeDefined();
      expect(def!.fluid).not.toBe(true);
    }
    for (let id = 20; id <= 28; id++) expect(isPlayerBlock(id)).toBe(false);
    expect(isPlayerBlock(0)).toBe(true);
    expect(isPlayerBlock(WATER)).toBe(true);
    expect(isPlayerBlock(MAX_SOLID_ID + 1)).toBe(false);
    for (const def of placeableBlocks()) expect(blockGroup(def.key), def.key).toBeDefined();
    const order = placeableBlocks().map((def) => blockBagOrder(def.key));
    expect(new Set(order).size).toBe(order.length);
    expect(blockBagOrder("snow")).toBeLessThan(blockBagOrder("oak-log"));
    expect(blockBagOrder("bookshelf")).toBeLessThan(blockBagOrder("stone"));
    expect(blockBagOrder("black-wool")).toBeLessThan(blockBagOrder("glass"));
    expect(blockBagOrder("ice")).toBeLessThan(blockBagOrder("question-block"));
    for (const group of BLOCK_GROUPS) {
      if (group.id === "all") continue;
      expect(placeableBlocks().some((def) => blockGroup(def.key) === group.id)).toBe(true);
    }
  });

  it("loads a hotbar, rejects illegal slots, and keeps the water bucket", () => {
    const hostile = sanitizeHotbar(["bedrock", "nope", "glass", "water"]);
    expect(hostile[0]).toBe("");
    expect(hostile[1]).toBe("");
    expect(hostile[2]).toBe("glass");
    expect(hostile[3]).toBe("");
    expect(hostile[9]).toBe("water");
    expect(sanitizeHotbar(undefined)).toEqual(HOTBAR);
    const bar = defaultHotbar();
    expect(assignHotbar(bar, 9, "dirt")).toBe(false);
    expect(assignHotbar(bar, 0, "white-wool")).toBe(true);
    expect(bar[0]).toBe("white-wool");
    expect(assignHotbar(bar, 2, "white-wool")).toBe(true);
    expect(bar[2]).toBe("white-wool");
    expect(bar[0]).toBe("sand");
    bar[4] = "";
    expect(assignHotbar(bar, 4, "white-wool")).toBe(true);
    expect(bar[4]).toBe("white-wool");
    expect(bar[2]).toBe("");
    expect(FIELD_HOTBAR).toHaveLength(10);
    expect(FIELD_HOTBAR[9]).toBe("water");
    expect(new Set(FIELD_HOTBAR).size).toBe(FIELD_HOTBAR.length);
    expect(clearHotbarSlot(bar, 0)).toBe(true);
    expect(bar[0]).toBe("");
    expect(clearHotbarSlot(bar, 9)).toBe(false);
    const stacks = ensureFieldStacks({ dirt: 3, water: 9 });
    expect(stacks.dirt).toBe(3);
    expect(stacks["white-wool"]).toBe(999);
    expect(stacks.bedrock).toBeUndefined();
    expect(stacks.water).toBeUndefined();
  });

  it("dyes wool from leaves", () => {
    const counts = {};
    addItem(counts, "oak-leaves", 2);
    const wool = CRAFT_RECIPES.find((recipe) => recipe.id === "white-wool")!;
    expect(craftRecipe(counts, wool)).toBe(true);
    expect(countOf(counts, "oak-leaves")).toBe(0);
    expect(countOf(counts, "white-wool")).toBe(4);
    const red = CRAFT_RECIPES.find((recipe) => recipe.id === "wool-red")!;
    expect(craftRecipe(counts, red)).toBe(true);
    expect(countOf(counts, "red-wool")).toBe(1);
    expect(countOf(counts, "white-wool")).toBe(3);
    const leaves = CRAFT_RECIPES.find((recipe) => recipe.id === "dark-leaves")!;
    addItem(counts, "oak-leaves", 3);
    expect(craftBatch(counts, leaves, 16)).toBe(3);
    expect(countOf(counts, "dark-leaves")).toBe(3);
    expect(craftBatch(counts, leaves, 16)).toBe(0);
  });

  it("sanitizes hostile inventories", () => {
    expect(sanitizeCounts({ dirt: 3.9, hax: 99, stone: -5, glass: Infinity })).toEqual({ dirt: 3 });
  });

  it("mined drops map to real items (grass → dirt)", () => {
    expect(dropOf(blockByKey("grass")!)).toBe("dirt");
    expect(blockByKey(dropOf(blockByKey("coal-ore")!))).toBeDefined();
  });
});

describe("craft save", () => {
  it("round-trips construction cubes, rotated ramps and corners without remapping older shapes", () => {
    const state = freshState(42), storage = memoryStorage();
    for (const [index,shape] of [0,17,18,34,50].entries()) state.world.setShaped(10+index,40,10,3,shape);
    storage.setItem("craftyap-craft-save-v1", serializeCraft(state,1000));
    const loaded = loadCraft(storage,999);
    for (const [index,shape] of [0,17,18,34,50].entries()) {
      expect(loaded.world.get(10+index,40,10)).toBe(3);
      expect(loaded.world.getShape(10+index,40,10)).toBe(shape);
    }
  });

  it("reloads a large legitimate water build written by the serializer", () => {
    const state = freshState(42), storage = memoryStorage();
    for (let i = 0; i < 200_001; i++) {
      state.world.set(i % WORLD_X, 40 + Math.floor(i / (WORLD_X * WORLD_Z)), Math.floor(i / WORLD_X) % WORLD_Z, 19);
    }
    storage.setItem("craftyap-craft-save-v1", serializeCraft(state, 1000));
    const loaded = loadCraft(storage, 999);
    expect(loaded.seed).toBe(42);
    expect(Buffer.from(loaded.world.cells).equals(Buffer.from(state.world.cells))).toBe(true);
  });

  it("migrates legacy block and shape indices without moving player buildings", () => {
    for (const v of [1, 2]) {
      const storage = memoryStorage();
      const legacyIndex = (20 * 80 + 32) * 80 + 25;
      storage.setItem("craftyap-craft-save-v1", JSON.stringify({
        v, seed: 42, edits: [[legacyIndex, blockByKey("glass")!.id]],
        shapes: v === 2 ? [[legacyIndex, 1]] : [], inventory: { stone: 4 },
        player: { x: 25.5, y: 21, z: 32.5 }, savedAtMs: 1,
      }));
      const loaded = loadCraft(storage, 1);
      expect(loaded.world.get(25, 20, 32)).toBe(blockByKey("glass")!.id);
      expect(loaded.world.getShape(25, 20, 32)).toBe(v === 2 ? 1 : 0);
      expect(loaded.player).toEqual({ x: 25.5, y: 21, z: 32.5 });
      storage.setItem("craftyap-craft-save-v1", serializeCraft(loaded, 2));
      const reloaded = loadCraft(storage, 1);
      expect(Buffer.from(reloaded.world.cells).equals(Buffer.from(loaded.world.cells))).toBe(true);
      expect(Buffer.from(reloaded.world.shapes).equals(Buffer.from(loaded.world.shapes))).toBe(true);
    }
  });
  it("round-trips edits, inventory and player through storage", () => {
    const storage = memoryStorage();
    const state = freshState(42);
    const cx = Math.floor(WORLD_X / 2);
    const cz = Math.floor(WORLD_Z / 2);
    const top = surfaceY(state.world, cx, cz);
    state.world.set(cx, top, cz, AIR); // mined the surface block
    state.world.set(cx, top + 3, cz, blockByKey("glass")!.id); // placed in air
    state.inventory = { dirt: 12, glass: 3 };
    state.hotbar = defaultHotbar();
    state.hotbar[0] = "red-wool";
    state.hotbar[1] = "";
    state.player = { x: 11.2, y: 9.1, z: 10.7 };
    storage.setItem("craftyap-craft-save-v1", serializeCraft(state, 1000));

    const loaded = loadCraft(storage, 999);
    expect(loaded.seed).toBe(42);
    expect(loaded.world.get(cx, top, cz)).toBe(AIR);
    expect(blockById(loaded.world.get(cx, top + 3, cz))?.key).toBe("glass");
    expect(loaded.inventory).toEqual({ dirt: 12, glass: 3 });
    expect(loaded.hotbar[0]).toBe("red-wool");
    expect(loaded.hotbar[1]).toBe("");
    expect(loaded.hotbar[9]).toBe("water");
    expect(loaded.player.x).toBeCloseTo(11.2, 5);
    // untouched cells still match the generated island
    const pristine = generateIsland(42);
    let diffs = 0;
    for (let i = 0; i < pristine.cells.length; i++) {
      if (pristine.cells[i] !== loaded.world.cells[i]) diffs++;
    }
    expect(diffs).toBe(2);
  });

  it("falls back to a fresh island on corrupt or hostile saves", () => {
    const storage = memoryStorage();
    storage.setItem("craftyap-craft-save-v1", "{not json");
    expect(loadCraft(storage, 5).seed).toBe(5);
    storage.setItem(
      "craftyap-craft-save-v1",
      JSON.stringify({ v: 1, seed: 1, edits: [[999999999, 250]], inventory: {}, player: { x: 1, y: 1, z: 1 }, savedAtMs: 1 }),
    );
    const loaded = loadCraft(storage, 5);
    expect(loaded.seed).toBe(1); // valid schema → loads, hostile edit ignored
    const pristine = generateIsland(1);
    expect(Buffer.from(loaded.world.cells).equals(Buffer.from(pristine.cells))).toBe(true);
  });
});
