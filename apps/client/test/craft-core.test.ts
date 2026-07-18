import { describe, expect, it } from "vitest";
import { AIR, blockByKey, dropOf, blockById } from "../src/craft/blocks.js";
import {
  VoxelWorld,
  WORLD_X,
  WORLD_Z,
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
  CRAFT_RECIPES,
  addItem,
  canCraftRecipe,
  craftRecipe,
  countOf,
  sanitizeCounts,
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
    const cx = Math.floor(WORLD_X / 2);
    const cz = Math.floor(WORLD_Z / 2);
    expect(surfaceY(world, cx, cz)).toBeGreaterThan(3);
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
    for (const recipe of CRAFT_RECIPES) {
      for (const key of [...Object.keys(recipe.input), ...Object.keys(recipe.output)]) {
        expect(blockByKey(key), `unknown key ${key} in ${recipe.id}`).toBeDefined();
      }
    }
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
  it("round-trips edits, inventory and player through storage", () => {
    const storage = memoryStorage();
    const state = freshState(42);
    const cx = Math.floor(WORLD_X / 2);
    const cz = Math.floor(WORLD_Z / 2);
    const top = surfaceY(state.world, cx, cz);
    state.world.set(cx, top, cz, AIR); // mined the surface block
    state.world.set(cx, top + 3, cz, blockByKey("glass")!.id); // placed in air
    state.inventory = { dirt: 12, glass: 3 };
    state.player = { x: 11.2, y: 9.1, z: 10.7 };
    storage.setItem("craftyap-craft-save-v1", serializeCraft(state, 1000));

    const loaded = loadCraft(storage, 999);
    expect(loaded.seed).toBe(42);
    expect(loaded.world.get(cx, top, cz)).toBe(AIR);
    expect(blockById(loaded.world.get(cx, top + 3, cz))?.key).toBe("glass");
    expect(loaded.inventory).toEqual({ dirt: 12, glass: 3 });
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
