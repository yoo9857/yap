import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CATALOG, furnitureDef } from "../src/craft/furniture/catalog/index.js";
import {
  footprintCenter,
  footprintOffsets,
  placedBounds,
  rayBox,
  rayPiece,
  rotateEuler,
  rotFacing,
  rotFromNormal,
} from "../src/craft/furniture/footprint.js";
import { FurnitureLayout, MAX_FURNITURE, RUG_TOP, type PlacementWorld } from "../src/craft/furniture/layout.js";
import type { PlacedFurniture } from "../src/craft/furniture/types.js";
import { freshState, loadCraft, saveCraft, type KeyValueStorage } from "../src/craft/craftSave.js";
import { stepBody, type Body } from "../src/craft/voxelBody.js";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { blockByKey } from "../src/craft/blocks.js";

/** A world of blocks given as "x,y,z" keys — floor at y = 0 unless told otherwise. */
function blocks(cells: Iterable<string> = []): PlacementWorld & { set: Set<string> } {
  const set = new Set(cells);
  return { set, isBlock: (x, y, z) => y === 0 || set.has(`${x},${y},${z}`) };
}

const piece = (kind: string, x: number, y: number, z: number, rot = 0, variant = 0): PlacedFurniture => ({ kind, x, y, z, rot, variant });

it("keeps unchanged furniture identities when a classroom snapshot arrives", () => {
  const layout = new FurnitureLayout();
  layout.add(piece("chair", 0, 1, 0));
  const seatedOn = layout.all()[0]!;
  layout.load([...layout.toJSON(), ["side-table", 4, 1, 0, 0, 0]], true);
  expect(layout.all()[0]).toBe(seatedOn);
  expect(layout.size).toBe(2);
  layout.load([["side-table", 4, 1, 0, 0, 0]], true);
  expect(layout.all()).not.toContain(seatedOn);
});

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("furniture footprint", () => {
  it("fills w×d×h distinct cells at every rotation, anchored at the origin", () => {
    for (const def of CATALOG) {
      const { w, d, h } = def.size;
      for (let rot = 0; rot < 4; rot++) {
        const cells = footprintOffsets(def, rot);
        expect(new Set(cells.map((c) => c.join())).size, `${def.key}@${rot}`).toBe(w * d * h);
        expect(cells.some(([x, y, z]) => x === 0 && y === 0 && z === 0)).toBe(true);
      }
    }
  });

  it("centres the model on exactly the cells that collide", () => {
    for (const def of CATALOG) {
      for (let rot = 0; rot < 4; rot++) {
        const floor = footprintOffsets(def, rot).filter(([, y]) => y === 0);
        const mx = floor.reduce((s, [x]) => s + x, 0) / floor.length + 0.5;
        const mz = floor.reduce((s, [, , z]) => s + z, 0) / floor.length + 0.5;
        const [cx, cz] = footprintCenter(def, rot);
        expect(cx, `${def.key}@${rot}`).toBeCloseTo(mx);
        expect(cz, `${def.key}@${rot}`).toBeCloseTo(mz);
      }
    }
  });

  it("turns the same way three.js does, so a 2-wide piece swings onto the right cells", () => {
    // three's rotation.y by +90° maps local +x to world −z.
    expect(footprintOffsets(furnitureDef("sofa"), 1).map((c) => c.join()).sort()).toEqual(["0,0,-1", "0,0,0"]);
  });

  it("faces the front at the player", () => {
    // looking along +z (yaw 0): the piece must face −z, back toward the eye
    expect(rotFacing(0)).toBe(2);
    expect(rotFacing(Math.PI)).toBe(0);
    expect(rotFacing(Math.PI / 2)).toBe(3);
    expect(rotFacing(-Math.PI / 2)).toBe(1);
  });

  it("hangs wall pieces facing out of the face that was hit, never on floors", () => {
    expect(rotFromNormal(0, 0, 1)).toBe(0);
    expect(rotFromNormal(1, 0, 0)).toBe(1);
    expect(rotFromNormal(0, 0, -1)).toBe(2);
    expect(rotFromNormal(-1, 0, 0)).toBe(3);
    expect(rotFromNormal(0, 1, 0)).toBeNull();
    expect(rotFromNormal(0, -1, 0)).toBeNull();
  });

  it("rotates parts exactly as three.js will draw them", () => {
    // Bounds (and so the catalog's fit test) use this three-free rotation; if
    // it drifted from three's Euler order, a turned part could pass the test
    // and still poke through a wall on screen.
    for (const r of [[0.3, -1.1, 2.0], [Math.PI / 2, 0, 0], [0, 0.4, -0.72]] as const) {
      const v = new THREE.Vector3(0.3, -0.2, 0.7).applyEuler(new THREE.Euler(...r));
      const mine = rotateEuler([0.3, -0.2, 0.7], r);
      expect(mine[0]).toBeCloseTo(v.x, 9);
      expect(mine[1]).toBeCloseTo(v.y, 9);
      expect(mine[2]).toBeCloseTo(v.z, 9);
    }
  });

  it("puts the placed box where the model is, and rays find it", () => {
    const def = furnitureDef("painting");
    // on a wall to the west of cell (5, 1, 5), facing +x
    const box = placedBounds(def, 5, 1, 5, rotFromNormal(1, 0, 0)!, 0);
    expect(box.min[0]).toBeCloseTo(5, 1); // flush with the wall face
    expect(box.max[0]).toBeLessThan(5.5);
    expect(rayBox(9, 1.6, 5.5, -1, 0, 0, box)).toBeGreaterThan(3);
    expect(rayBox(9, 1.6, 5.5, 1, 0, 0, box)).toBeNull();
    expect(rayBox(9, 3.5, 5.5, -1, 0, 0, box)).toBeNull();
  });
});

describe("furniture layout: floor pieces", () => {
  it("places, reports, and removes a piece across all its cells", () => {
    const layout = new FurnitureLayout();
    const world = blocks();
    const v0 = layout.version;
    expect(layout.canPlace(piece("bookshelf", 3, 1, 5), world)).toBe(true);
    expect(layout.add(piece("bookshelf", 3, 1, 5))).toBe(true);
    expect(layout.version).toBeGreaterThan(v0);
    expect(layout.at("solid", 3, 2, 5)?.kind).toBe("bookshelf"); // two cells tall
    expect(layout.occupied(3, 3, 5)).toBe(false);
    layout.remove(layout.at("solid", 3, 2, 5)!);
    expect(layout.size).toBe(0);
    expect(layout.occupied(3, 1, 5)).toBe(false);
  });

  it("refuses overlaps, blocks, bodies, bad rotations and anything off the ground", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("chair", 0, 1, 0));
    expect(layout.canPlace(piece("sofa", -1, 1, 0), blocks())).toBe(false); // second cell on the chair
    expect(layout.canPlace(piece("sofa", 5, 1, 0), blocks(["6,1,0"]))).toBe(false); // into a block
    expect(layout.canPlace(piece("sofa", 5, 1, 0), { ...blocks(), hasBody: (x) => x === 6 })).toBe(false);
    expect(layout.canPlace(piece("sofa", 5, 2, 0), blocks())).toBe(false); // floating
    expect(layout.canPlace(piece("sofa", 5, 2, 0), blocks(["5,1,0"]))).toBe(false); // half on a ledge
    expect(layout.canPlace(piece("sofa", 5, 2, 0), blocks(["5,1,0", "6,1,0"]))).toBe(true);
    expect(layout.canPlace(piece("sofa", 5, 1, 0, 7), blocks())).toBe(false);
    expect(layout.canPlace(piece("sofa", 5, 1, 0, 0, 99), blocks())).toBe(false); // no such colour
  });

  it("stays put while any leg is supported, and lets go when none is", () => {
    const layout = new FurnitureLayout();
    const world = blocks(["0,1,0", "1,1,0"]);
    layout.add(piece("table", 0, 2, 0));
    world.set.delete("0,1,0");
    expect(layout.afterBlockRemoved(0, 1, 0, world)).toEqual([]);
    world.set.delete("1,1,0");
    expect(layout.afterBlockRemoved(1, 1, 0, world).map((p) => p.kind)).toEqual(["table"]);
  });
});

describe("furniture layout: rugs, surfaces and walls share cells", () => {
  it("lays a rug under a sofa, in either order, but not two rugs on each other", () => {
    const a = new FurnitureLayout();
    expect(a.add(piece("rug", 0, 1, 0))).toBe(true);
    expect(a.canPlace(piece("sofa", 0, 1, 0), blocks())).toBe(true);
    expect(a.canPlace(piece("bath-mat", 1, 1, 1), blocks())).toBe(false);
    const b = new FurnitureLayout();
    b.add(piece("sofa", 0, 1, 0));
    expect(b.canPlace(piece("rug", 0, 1, 0), blocks())).toBe(true);
    expect(b.occupied(0, 1, 0)).toBe(true);
    b.add(piece("rug", 0, 1, 0));
    // a rug is not solid: the cell next to the sofa is still walkable
    expect(b.occupied(0, 1, 1)).toBe(false);
  });

  it("stands a vase on a table at the table's height, and on bare ground at 0", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("table", 0, 1, 0));
    const onTable = piece("vase", 1, 1, 0);
    expect(layout.canPlace(onTable, blocks())).toBe(true);
    layout.add(onTable);
    expect(layout.elevation(onTable)).toBeCloseTo(furnitureDef("table").surface!);
    const onGround = piece("vase", 4, 1, 4);
    layout.add(onGround);
    expect(layout.elevation(onGround)).toBe(0);
    const onRug = piece("teddy", 7, 1, 7);
    layout.add(piece("rug", 7, 1, 7));
    layout.add(onRug);
    expect(layout.elevation(onRug)).toBe(RUG_TOP);
  });

  it("refuses a surface piece on furniture with no top, or in mid-air", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("chair", 0, 1, 0));
    expect(layout.canPlace(piece("vase", 0, 1, 0), blocks())).toBe(false);
    expect(layout.canPlace(piece("vase", 3, 3, 3), blocks())).toBe(false);
  });

  it("takes what stood on a piece away with it", () => {
    const layout = new FurnitureLayout();
    const table = piece("table", 0, 1, 0);
    layout.add(table);
    layout.add(piece("vase", 0, 1, 0));
    layout.add(piece("candles", 1, 1, 0));
    const removed = layout.remove(layout.at("solid", 0, 1, 0)!);
    expect(removed.map((p) => p.kind).sort()).toEqual(["candles", "table", "vase"]);
    expect(layout.size).toBe(0);
  });

  it("refuses to put a table over a vase standing on the ground", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("vase", 0, 1, 0));
    expect(layout.canPlace(piece("table", 0, 1, 0), blocks())).toBe(false);
  });

  it("hangs a picture only with a wall right behind every cell", () => {
    const layout = new FurnitureLayout();
    const rot = rotFromNormal(0, 0, 1)!; // facing +z, wall at z - 1
    const wall = blocks(["0,2,-1", "1,2,-1"]);
    expect(layout.canPlace(piece("painting", 0, 2, 0, rot), wall)).toBe(true);
    expect(layout.canPlace(piece("painting", 0, 2, 0, rot), blocks())).toBe(false);
    // the big one spans two cells: both need wall
    const big = piece("big-painting", 0, 2, 0, rot);
    expect(layout.cellsOf(big).map((c) => c.join()).sort()).toEqual(["0,2,0", "1,2,0"]);
    expect(layout.canPlace(big, wall)).toBe(true);
    expect(layout.canPlace(big, blocks(["0,2,-1"]))).toBe(false);
  });

  it("drops a picture when its wall is mined away, and only then", () => {
    const layout = new FurnitureLayout();
    const world = blocks(["0,2,-1"]);
    layout.add(piece("clock", 0, 2, 0, rotFromNormal(0, 0, 1)!));
    world.set.add("5,2,5");
    world.set.delete("5,2,5");
    expect(layout.afterBlockRemoved(5, 2, 5, world)).toEqual([]);
    world.set.delete("0,2,-1");
    expect(layout.afterBlockRemoved(0, 2, -1, world).map((p) => p.kind)).toEqual(["clock"]);
  });

  it("will not hang a picture inside a bookshelf, nor push a sofa into a picture", () => {
    const layout = new FurnitureLayout();
    const wall = blocks(["0,1,-1", "0,2,-1", "1,1,-1"]);
    layout.add(piece("bookshelf", 0, 1, 0));
    expect(layout.canPlace(piece("painting", 0, 2, 0, 0), wall)).toBe(false);
    const other = new FurnitureLayout();
    other.add(piece("painting", 1, 1, 0, 0));
    expect(other.canPlace(piece("sofa", 0, 1, 0), wall)).toBe(false);
  });
});

describe("doors, gates and curtains", () => {
  it("opens to let you through and closes solid again", () => {
    const layout = new FurnitureLayout();
    const door = piece("door", 0, 1, 0);
    layout.add(door);
    const item = layout.at("solid", 0, 1, 0)!;
    expect(layout.occupied(0, 1, 0)).toBe(true);
    expect(layout.occupied(0, 2, 0)).toBe(true);
    expect(layout.toggle(item, blocks())).toBe("ok");
    expect(layout.occupied(0, 1, 0)).toBe(false);
    expect(layout.occupied(0, 2, 0)).toBe(false);
    // still there for everything else: no block, no other piece in its cells
    expect(layout.blocksBlock(0, 1, 0)).toBe(true);
    expect(layout.canPlace(piece("chair", 0, 1, 0), blocks())).toBe(false);
    expect(layout.toggle(item, blocks())).toBe("ok");
    expect(layout.occupied(0, 1, 0)).toBe(true);
  });

  it("refuses to close on the player standing in the doorway", () => {
    const layout = new FurnitureLayout();
    layout.add({ ...piece("door", 0, 1, 0), state: 1 });
    const item = layout.at("solid", 0, 1, 0)!;
    expect(layout.toggle(item, { ...blocks(), hasBody: (x, y, z) => x === 0 && y === 1 && z === 0 })).toBe("body");
    expect(item.state).toBe(1);
  });

  it("will not toggle something that does not open", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("sofa", 0, 1, 0));
    expect(layout.toggle(layout.at("solid", 0, 1, 0)!, blocks())).toBe("fixed");
  });

  it("remembers open doors in the save, and only those", () => {
    const layout = new FurnitureLayout();
    layout.add({ ...piece("door", 0, 1, 0), state: 1 });
    layout.add(piece("door", 3, 1, 0));
    expect(layout.toJSON()).toEqual([
      ["door", 0, 1, 0, 0, 0, 1],
      ["door", 3, 1, 0, 0, 0],
    ]);
    const copy = new FurnitureLayout();
    copy.load([...layout.toJSON(), ["sofa", 9, 1, 9, 0, 0, 1]]); // a sofa cannot be "open"
    expect(copy.toJSON()).toEqual([
      ["door", 0, 1, 0, 0, 0, 1],
      ["door", 3, 1, 0, 0, 0],
      ["sofa", 9, 1, 9, 0, 0],
    ]);
  });
});

describe("aiming at pieces part by part", () => {
  const door = furnitureDef("door");
  // a door at cell (0, 1, 0), unturned: its leaf hangs at the back of the cell
  const shoot = (open: boolean, x: number, y: number) => rayPiece(door, open, 0, 1, 0, 0, 0, x, y, -3, 0, 0, 1);

  it("hits a closed door anywhere across the doorway", () => {
    expect(shoot(false, 0.5, 2)).not.toBeNull();
  });

  it("lets the ray through an OPEN doorway, but still hits its post and leaf", () => {
    expect(shoot(true, 0.5, 2)).toBeNull(); // straight through the middle
    expect(shoot(true, 0.04, 2)).not.toBeNull(); // the hinge-side post / swung leaf
    expect(shoot(true, 0.5, 2.95)).not.toBeNull(); // the lintel
  });

  it("misses a chair in the air between its legs", () => {
    const chair = furnitureDef("chair");
    // level with the legs, through the gap between the front two
    expect(rayPiece(chair, false, 0, 1, 0, 0, 0, 0.5, 1.2, 3, 0, 0, -1)).toBeNull();
    // level with the seat it is solid
    expect(rayPiece(chair, false, 0, 1, 0, 0, 0, 0.5, 1.5, 3, 0, 0, -1)).not.toBeNull();
  });

  it("follows the piece's quarter turns", () => {
    // turned a quarter, the door faces +x: a ray along +x now crosses it
    expect(rayPiece(door, false, 0, 1, 0, 1, 0, -3, 2, 0.5, 1, 0, 0)).not.toBeNull();
  });
});

describe("tall pieces on tall hosts", () => {
  it("keeps blocks out of the cell a raised piece reaches into", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("stove", 0, 1, 0));
    layout.add(piece("teddy", 0, 1, 0)); // 0.95 m host + 0.57 m bear
    expect(layout.blocksBlock(0, 2, 0)).toBe(true);
    // a short piece on a low table does not
    layout.add(piece("coffee-table", 5, 1, 0));
    layout.add(piece("succulent", 5, 1, 0));
    expect(layout.blocksBlock(5, 2, 0)).toBe(false);
  });

  it("will not stand a tall piece on a host with a block right above it", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("stove", 0, 1, 0));
    expect(layout.check(piece("teddy", 0, 1, 0), blocks(["0,2,0"]))).toBe("blocked");
    expect(layout.check(piece("teddy", 0, 1, 0), blocks())).toBe("ok");
  });
});

describe("furniture saves", () => {
  it("round-trips through JSON and drops junk entry by entry", () => {
    const layout = new FurnitureLayout();
    layout.add(piece("bed", -40, 4, 900, 3, 2));
    const copy = new FurnitureLayout();
    copy.load([
      ...layout.toJSON(),
      ["throne", 0, 4, 0, 0, 0], // unknown kind
      ["toString", 0, 4, 0, 0], // inherited member
      ["chair", 1.5, 4, 0, 0], // not a cell
      ["chair", 0, 4, 0, 9], // bad rotation
      ["chair", 0, -3, 0, 0], // below the world
      ["chair", -40, 4, 900, 0], // overlaps the bed
      "garbage",
      ["plant", 10, 4, 10, 1], // a save from before colour variants
      ["sofa", 20, 4, 20, 0, 77], // a colour that does not exist reads as the default
    ]);
    expect(copy.toJSON()).toEqual([
      ["bed", -40, 4, 900, 3, 2],
      ["plant", 10, 4, 10, 1, 0],
      ["sofa", 20, 4, 20, 0, 0],
    ]);
  });

  it("ignores a non-array payload rather than throwing, and caps an oversized one", () => {
    const layout = new FurnitureLayout();
    for (const junk of [undefined, null, 42, "x", { 0: ["chair", 0, 0, 0, 0] }]) {
      expect(() => layout.load(junk)).not.toThrow();
      expect(layout.size).toBe(0);
    }
    layout.load(Array.from({ length: MAX_FURNITURE + 50 }, (_, i) => ["chair", i, 4, 0, 0]));
    expect(layout.size).toBe(MAX_FURNITURE);
  });

  it("drops pieces at absurd coordinates instead of drawing them at infinity", () => {
    const layout = new FurnitureLayout();
    layout.load([
      ["chair", 2 ** 21, 4, 0, 0],
      ["chair", 0, 4, -1e300, 0],
      ["chair", 5, 4, 5, 0],
    ]);
    expect(layout.toJSON()).toEqual([["chair", 5, 4, 5, 0, 0]]);
  });

  it("never costs the island its save, however much furniture a hostile save lists", () => {
    const storage = memoryStorage();
    const state = freshState(20260718);
    state.inventory = { stone: 7 };
    saveCraft(state, storage, Date.now());
    const raw = JSON.parse(storage.getItem("craftyap-craft-save-v1")!) as { furniture?: unknown };
    raw.furniture = Array.from({ length: MAX_FURNITURE + 10 }, (_, i) => ["chair", i % 150, 12, Math.floor(i / 150), 0]);
    storage.setItem("craftyap-craft-save-v1", JSON.stringify(raw));
    const loaded = loadCraft(storage, 20260718);
    expect(loaded.inventory).toEqual({ stone: 7 });
    expect(loaded.furniture.size).toBe(MAX_FURNITURE);
  });

  it("survives a craft save round trip", () => {
    const storage = memoryStorage();
    const state = freshState(20260718);
    state.furniture.add(piece("sofa", 40, 12, 70, 1, 3));
    saveCraft(state, storage, Date.now());
    expect(loadCraft(storage, 20260718).furniture.toJSON()).toEqual([["sofa", 40, 12, 70, 1, 3]]);
  });
});

describe("furniture in the voxel world", () => {
  it("is solid to bodies without counting as a block", () => {
    const world = new VoxelWorld();
    const stone = blockByKey("stone")!.id;
    for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) world.set(x, 0, z, stone);
    const layout = new FurnitureLayout();
    layout.add(piece("bookshelf", 10, 1, 5));
    layout.add(piece("rug", 7, 1, 5));
    world.propSolid = (x, y, z) => layout.occupied(x, y, z);

    // The renderer culls faces with isSolid, so furniture must stay out of it.
    expect(world.isSolid(10, 1, 5)).toBe(false);
    expect(world.isBlocked(10, 1, 5)).toBe(true);

    // walks over the rug, into the shelf, and stops
    const body: Body = { x: 6.5, y: 1, z: 5.5, vx: 0, vy: 0, vz: 0, grounded: true };
    for (let i = 0; i < 120; i++) stepBody(world, body, 1 / 60, 1, 0, false);
    expect(body.x).toBeLessThan(10);
    expect(body.x).toBeGreaterThan(9.5);

    // the aim ray stops at it only when asked to
    expect(world.raycast(6.5, 1.5, 5.5, 1, 0, 0, 8)?.voxel ?? null).toBeNull();
    expect(world.raycast(6.5, 1.5, 5.5, 1, 0, 0, 8, true)?.voxel).toEqual([10, 1, 5]);
  });
});
