import { z } from "zod";
import { furnitureDef, isFurnitureKind, variantCount } from "./catalog/index.js";
import { footprintOffsets, frontOf, localBounds } from "./footprint.js";
import type { FurnitureDef, Placement, PlacedFurniture } from "./types.js";

/**
 * What has been placed, and the rules for placing it. No three.js, no DOM;
 * unit-tested in `test/furniture-layout.test.ts`.
 *
 * Positions are ABSOLUTE cells. On the island that is the grid; in the
 * education field the grid scrolls, so callers convert with the window's
 * origin — the same convention the classroom wire uses, and the reason a
 * scroll never has to touch the layout.
 *
 * A cell holds up to one piece per LAYER, which is how a rug lies under a
 * sofa, a vase stands on a table and a painting hangs over a bed:
 *
 * | layer     | placement | solid to bodies | shares a cell with   |
 * |-----------|-----------|-----------------|----------------------|
 * | `solid`   | floor     | yes             | rug                  |
 * | `rug`     | rug       | no              | solid, surface, wall |
 * | `surface` | surface   | no              | its host, rug, wall  |
 * | `wall`    | wall      | no              | rug, surface         |
 */

export type Layer = "solid" | "rug" | "surface" | "wall";

const LAYER_OF: Record<Placement, Layer> = { floor: "solid", rug: "rug", surface: "surface", wall: "wall" };
export const layerOf = (def: FurnitureDef): Layer => LAYER_OF[def.placement];

/** Layers a new piece of each layer must find empty in every cell it fills. */
const EXCLUDES: Record<Layer, readonly Layer[]> = {
  solid: ["solid", "surface", "wall"],
  rug: ["rug"],
  surface: ["surface"],
  wall: ["wall", "solid"],
};

/**
 * Why a placement is refused — the controller turns it into a toast, because
 * a right click that silently does nothing teaches a child nothing.
 */
export type PlaceVerdict =
  | "ok"
  | "limit" // MAX_FURNITURE reached
  | "invalid" // junk kind / rotation / colour, or outside the world's height
  | "occupied" // another piece already fills a cell on this layer
  | "blocked" // a block fills a cell
  | "body" // the player stands there
  | "floating" // nothing underneath to stand on
  | "no-wall" // a wall piece with no block behind it
  | "no-top"; // a surface piece aimed at furniture that has no top

/** What the layout needs from the world, in ABSOLUTE cells. */
export interface PlacementWorld {
  /** The cell holds a block (something to stand on or hang from). */
  isBlock(x: number, y: number, z: number): boolean;
  /** A body stands in the cell; only solid pieces are refused there. */
  hasBody?(x: number, y: number, z: number): boolean;
}

/** Hard cap on placed pieces — keeps a hostile save (and the instance
 *  buffers) bounded. Far beyond what a child furnishes by hand. */
export const MAX_FURNITURE = 3000;
/** Rugs are modelled at most this thick (catalog-tested) — and no thinner, or
 *  the floor bricks' studs (10 cm above the cell floor) poke through. Small pieces set
 *  straight on a rug stand on top of it instead of sinking into the pile. */
export const RUG_TOP = 0.14;
/** Same vertical range as the voxel world. */
const MAX_Y = 56;

/** How a piece is stored: `[kind, x, y, z, rot, variant, state?]`. Saves
 *  written before colour variants have no sixth entry (variant 0); the seventh
 *  is written only for an OPEN door/gate/curtain, so closed pieces — nearly all
 *  of them — cost nothing extra. */
export type FurnitureTuple =
  | [string, number, number, number, number, number]
  | [string, number, number, number, number, number, number];

const int = z.number().int();
const tupleSchema = z.union([
  z.tuple([z.string(), int, int, int, int, int, int]),
  z.tuple([z.string(), int, int, int, int, int]),
  z.tuple([z.string(), int, int, int, int]),
]);

/** Loose on purpose: entries are checked one by one in `load`, so a single
 *  bad tuple cannot fail the parse of the whole save around it. No length cap
 *  HERE either: this schema sits inside the island/field save schemas, and an
 *  over-long list would fail THEIR parse and cost the player the whole world.
 *  `load` (via `add`) stops at MAX_FURNITURE instead. */
export const furnitureSaveSchema = z.array(z.unknown());

/** Numeric cell key: no string building in the collision hot path, and
 *  negative field coordinates are fine within ±2^20. */
const OFF = 1 << 20;
/** Furthest a piece may sit from the origin: inside `cellKey`'s range with
 *  room to spare for a footprint. A hostile save outside it is dropped. */
const MAX_COORD = OFF - 16;
const cellKey = (x: number, y: number, z: number): number => ((x + OFF) * 2 * OFF + (z + OFF)) * 64 + y;

export class FurnitureLayout {
  private readonly items: PlacedFurniture[] = [];
  private readonly layers: Record<Layer, Map<number, PlacedFurniture>> = {
    solid: new Map(),
    rug: new Map(),
    surface: new Map(),
    wall: new Map(),
  };
  /** Bumped on every add/remove; lets the renderer and the saver skip work. */
  version = 0;

  get size(): number {
    return this.items.length;
  }

  all(): readonly PlacedFurniture[] {
    return this.items;
  }

  at(layer: Layer, x: number, y: number, z: number): PlacedFurniture | undefined {
    if (this.items.length === 0) return undefined;
    return this.layers[layer].get(cellKey(x, y, z));
  }

  /** Solid furniture fills this cell — the collision query (hot path). An
   *  OPEN door is still there, but you walk through it. */
  occupied(x: number, y: number, z: number): boolean {
    if (this.items.length === 0) return false;
    const item = this.layers.solid.get(cellKey(x, y, z));
    return item !== undefined && item.state !== 1;
  }

  /**
   * Open or close a door/gate/curtain. Closing is refused while the player
   * stands in a solid piece's cells — it would shut them inside it. Returns
   * what happened: "ok", "body" (refused), or "fixed" (not a piece that opens).
   */
  toggle(item: PlacedFurniture, world: PlacementWorld): "ok" | "body" | "fixed" {
    const def = furnitureDef(item.kind);
    if (!def.openParts || !this.items.includes(item)) return "fixed";
    const closing = item.state === 1;
    if (closing && def.placement === "floor" && this.cellsOf(item).some(([x, y, z]) => world.hasBody?.(x, y, z))) return "body";
    if (closing) delete item.state;
    else item.state = 1;
    this.version++;
    return "ok";
  }

  /** Any piece at all in this cell — a block may not be placed into it. */
  anyAt(x: number, y: number, z: number): boolean {
    if (this.items.length === 0) return false;
    const key = cellKey(x, y, z);
    return this.layers.solid.has(key) || this.layers.rug.has(key) || this.layers.surface.has(key) || this.layers.wall.has(key);
  }

  /**
   * Would a block placed in this cell cut through furniture? Everything
   * `anyAt` says, plus a small piece standing on a tall host in the cell
   * BELOW: a teddy on a stove (0.95 m) reaches 1.5 m, well into this cell.
   */
  blocksBlock(x: number, y: number, z: number): boolean {
    if (this.anyAt(x, y, z)) return true;
    const below = this.at("surface", x, y - 1, z);
    return below !== undefined && this.spillsUp(below);
  }

  /** Does this surface piece's model rise past the top of its own cell? */
  private spillsUp(p: PlacedFurniture): boolean {
    return this.elevation(p) + localBounds(furnitureDef(p.kind)).max[1] > 1.02;
  }

  /** Absolute cells this piece fills (or would fill). */
  cellsOf(p: Pick<PlacedFurniture, "kind" | "x" | "y" | "z" | "rot">): [number, number, number][] {
    return footprintOffsets(furnitureDef(p.kind), p.rot).map(([dx, dy, dz]) => [p.x + dx, p.y + dy, p.z + dz]);
  }

  /**
   * How high above its cell floor a piece's model stands: the host's top for a
   * surface piece on furniture, the pile of a rug it stands on, else 0.
   */
  elevation(p: PlacedFurniture): number {
    if (furnitureDef(p.kind).placement !== "surface") return 0;
    const host = this.at("solid", p.x, p.y, p.z);
    if (host) return furnitureDef(host.kind).surface ?? 0;
    return this.at("rug", p.x, p.y, p.z) ? RUG_TOP : 0;
  }

  private valid(p: PlacedFurniture): boolean {
    if (!isFurnitureKind(p.kind)) return false;
    if (![p.x, p.y, p.z, p.rot, p.variant].every(Number.isInteger)) return false;
    if (Math.abs(p.x) > MAX_COORD || Math.abs(p.z) > MAX_COORD) return false;
    if (p.rot < 0 || p.rot > 3) return false;
    const def = furnitureDef(p.kind);
    if (p.state !== undefined && p.state !== 0 && !(p.state === 1 && def.openParts)) return false;
    return p.variant >= 0 && p.variant < variantCount(def);
  }

  /** Inside the world's height in every cell. */
  private inRange(cells: readonly [number, number, number][]): boolean {
    return cells.every(([, y]) => y >= 0 && y < MAX_Y);
  }

  /** Free of the layers this piece's own layer excludes, in every cell. */
  private layersFree(p: PlacedFurniture, cells: readonly [number, number, number][]): boolean {
    const excludes = EXCLUDES[layerOf(furnitureDef(p.kind))];
    for (const [x, y, z] of cells) {
      const key = cellKey(x, y, z);
      for (const layer of excludes) if (this.layers[layer].has(key)) return false;
    }
    return true;
  }

  /**
   * Can this piece go here? All-or-nothing, like a LEGO piece: nothing lands
   * half-placed, floating, or inside a block.
   *
   * - floor:   every cell empty and clear of bodies; EVERY bottom cell on a block.
   * - rug:     every cell empty; every cell on a block.
   * - surface: on a host with a `surface` top, or on bare ground (block below).
   * - wall:    every cell empty; every cell with a block right behind it.
   */
  canPlace(p: PlacedFurniture, world: PlacementWorld): boolean {
    return this.check(p, world) === "ok";
  }

  /** `canPlace`, with the reason when the answer is no. */
  check(p: PlacedFurniture, world: PlacementWorld): PlaceVerdict {
    if (this.items.length >= MAX_FURNITURE) return "limit";
    if (!this.valid(p)) return "invalid";
    const def = furnitureDef(p.kind);
    const cells = this.cellsOf(p);
    if (!this.inRange(cells)) return "invalid";
    if (!this.layersFree(p, cells)) return "occupied";
    for (const [x, y, z] of cells) {
      const host = def.placement === "surface" ? this.at("solid", x, y, z) : undefined;
      if (host) {
        if (furnitureDef(host.kind).surface === undefined) return "no-top";
        // raised by its host, a tall piece reaches into the cell above
        if (this.spillsUp(p) && world.isBlock(x, y + 1, z)) return "blocked";
        continue; // the host's own cell: it is not empty, and need not be
      }
      if (world.isBlock(x, y, z)) return "blocked";
      switch (def.placement) {
        case "floor":
          if (world.hasBody?.(x, y, z)) return "body";
          if (y === p.y && !world.isBlock(x, y - 1, z)) return "floating";
          break;
        case "rug":
        case "surface":
          if (!world.isBlock(x, y - 1, z)) return "floating";
          break;
        case "wall": {
          const [fx, fz] = frontOf(p.rot);
          if (!world.isBlock(x - fx, y, z - fz)) return "no-wall";
          break;
        }
      }
    }
    return "ok";
  }

  /** Add without world checks (loading, or after `canPlace`). Refuses only
   *  junk and layer clashes, which is all a save can be trusted for. */
  add(p: PlacedFurniture, preserveIdentity = false): boolean {
    if (this.items.length >= MAX_FURNITURE || !this.valid(p)) return false;
    const cells = this.cellsOf(p);
    if (!this.inRange(cells) || !this.layersFree(p, cells)) return false;
    const item: PlacedFurniture = preserveIdentity ? p : { kind: p.kind, x: p.x, y: p.y, z: p.z, rot: p.rot, variant: p.variant };
    if (p.state === 1) item.state = 1;
    const layer = this.layers[layerOf(furnitureDef(item.kind))];
    this.items.push(item);
    for (const [x, y, z] of cells) layer.set(cellKey(x, y, z), item);
    this.version++;
    return true;
  }

  /**
   * Remove a piece, and anything standing on it (a vase on a table goes with
   * the table rather than hang in the air). Returns everything removed.
   */
  remove(item: PlacedFurniture): PlacedFurniture[] {
    const i = this.items.indexOf(item);
    if (i < 0) return [];
    this.items.splice(i, 1);
    const layer = this.layers[layerOf(furnitureDef(item.kind))];
    const cells = this.cellsOf(item);
    for (const [x, y, z] of cells) layer.delete(cellKey(x, y, z));
    this.version++;
    const removed = [item];
    if (layerOf(furnitureDef(item.kind)) === "solid") {
      for (const [x, y, z] of cells) {
        const riding = this.at("surface", x, y, z);
        if (riding) removed.push(...this.remove(riding));
      }
    }
    return removed;
  }

  /** Does something still hold this piece up? One leg/edge/bracket is enough. */
  supported(item: PlacedFurniture, world: PlacementWorld): boolean {
    const def = furnitureDef(item.kind);
    const cells = this.cellsOf(item);
    switch (def.placement) {
      case "floor":
      case "rug":
        return cells.some(([x, y, z]) => y === item.y && world.isBlock(x, y - 1, z));
      case "surface":
        return cells.some(([x, y, z]) => this.at("solid", x, y, z) !== undefined || world.isBlock(x, y - 1, z));
      case "wall": {
        const [fx, fz] = frontOf(item.rot);
        return cells.some(([x, y, z]) => world.isBlock(x - fx, y, z - fz));
      }
    }
  }

  /**
   * A block at (x, y, z) was removed: put away whatever it was holding up —
   * pieces standing on it, and pieces hanging on any of its four sides —
   * unless something else still holds them. Returns everything removed.
   */
  afterBlockRemoved(x: number, y: number, z: number, world: PlacementWorld): PlacedFurniture[] {
    const candidates = new Set<PlacedFurniture>();
    const collect = (cx: number, cy: number, cz: number, layers: readonly Layer[]) => {
      for (const layer of layers) {
        const item = this.at(layer, cx, cy, cz);
        if (item) candidates.add(item);
      }
    };
    collect(x, y + 1, z, ["solid", "rug", "surface"]);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) collect(x + dx, y, z + dz, ["wall"]);
    const removed: PlacedFurniture[] = [];
    for (const item of candidates) {
      if (this.items.includes(item) && !this.supported(item, world)) removed.push(...this.remove(item));
    }
    return removed;
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items.length = 0;
    for (const layer of Object.values(this.layers)) layer.clear();
    this.version++;
  }

  toJSON(): FurnitureTuple[] {
    return this.items.map((p): FurnitureTuple =>
      p.state === 1 ? [p.kind, p.x, p.y, p.z, p.rot, p.variant, 1] : [p.kind, p.x, p.y, p.z, p.rot, p.variant],
    );
  }

  /** Restore from a save. Anything malformed is dropped piece by piece — a
   *  bad entry never costs the rest of the room (or the island). */
  load(raw: unknown, preserveIdentity = false): void {
    const identity = (p: PlacedFurniture) => JSON.stringify([p.kind, p.x, p.y, p.z, p.rot, p.variant, p.state ?? 0]);
    const previous = new Map(preserveIdentity ? this.items.map((p) => [identity(p), p]) : []);
    this.clear();
    const parsed = furnitureSaveSchema.safeParse(raw);
    if (!parsed.success) return;
    for (const entry of parsed.data) {
      const tuple = tupleSchema.safeParse(entry);
      if (!tuple.success) continue;
      const [kind, x, y, z, rot, variant = 0, state = 0] = tuple.data;
      if (!isFurnitureKind(kind)) continue;
      // A variant from a palette list that has since shrunk (it never should —
      // palettes are append-only) degrades to the default look, not to nothing.
      const v = variant < variantCount(furnitureDef(kind)) && variant >= 0 ? variant : 0;
      // an "open" flag on a piece that no longer opens just reads as closed
      const open = state === 1 && furnitureDef(kind).openParts !== undefined;
      const item: PlacedFurniture = open ? { kind, x, y, z, rot, variant: v, state: 1 } : { kind, x, y, z, rot, variant: v };
      this.add(previous.get(identity(item)) ?? item, preserveIdentity);
    }
  }
}
