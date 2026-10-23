/**
 * The furniture data model. Everything in the catalog is plain data of these
 * shapes — no three.js, no DOM — so the physics, the save, the panel and the
 * renderer can all read it, and `test/furniture-catalog.test.ts` can check
 * every entry without a browser.
 *
 * Adding a piece is adding one `FurnitureDef` to a file in `catalog/`. See
 * docs/FURNITURE.md for the conventions a def must follow.
 */

/**
 * Where a piece goes, which decides which cells it claims and what holds it up.
 *
 * - `floor`   — stands on blocks and fills its cells SOLIDLY (bodies collide).
 * - `rug`     — lies flat on blocks; walked over, and floor pieces stand on it.
 * - `surface` — a small thing that sits on a floor piece's top (`surface`
 *               height), or on bare ground. Never solid.
 * - `wall`    — hangs on the side face of a block, facing away from it.
 */
export type Placement = "floor" | "rug" | "surface" | "wall";

export type CategoryKey = "living" | "bedroom" | "kitchen" | "bath" | "lighting" | "decor" | "doors" | "outdoor";

export interface Category {
  key: CategoryKey;
  name: string;
  emoji: string;
}

/** A colour: a literal 0xRRGGBB, or the name of a palette slot. */
export type ColorRef = number | string;

/**
 * One brick of a model, in the piece's local space (metres): floor at y = 0,
 * centred on the footprint, front facing +z. See docs/FURNITURE.md for the
 * wall/surface/rug variants of that convention.
 */
export interface PartSpec {
  /**
   * - `box`  soft rounded brick (most of everything)
   * - `ball` smooth ellipsoid (faces, leaves, bulbs, cushions' puff)
   * - `cyl`  cylinder along its local y; `taper` makes it a cone or a bowl
   *          (poles, pots, lampshades, an opened parasol, round tops)
   * - `dome` upper half-ellipsoid with a flat closed base (canopies, lids)
   */
  shape: "box" | "ball" | "cyl" | "dome";
  color: ColorRef;
  /** Full extents [w, h, d] before rotation; for `cyl`, w and d are diameters. */
  size: readonly [number, number, number];
  /** Centre [x, y, z]. */
  at: readonly [number, number, number];
  /** Corner radius as a fraction of the smallest extent (boxes only). */
  soft?: number;
  /** `cyl` only: top radius ÷ bottom radius. 1 = straight, 0 = cone, >1 = bowl. */
  taper?: number;
  /** Euler rotation [x, y, z] in radians about the part's centre — a clock
   *  face (a `cyl` turned to face +z), a log lying down, a pitched roof. */
  rot?: readonly [number, number, number];
}

/** One colour variant: values for every slot the parts name. */
export interface Palette {
  name: string;
  colors: Readonly<Record<string, number>>;
}

export interface FurnitureDef {
  /** Persisted in saves — NEVER rename or reuse a key. Kebab-case. */
  key: string;
  /** Panel copy (Korean, like the rest of the education UI). */
  name: string;
  emoji: string;
  category: CategoryKey;
  placement: Placement;
  /** Cells before rotation: `w` across (local x), `d` deep (local z), `h` tall. */
  size: { w: number; d: number; h: number };
  /** Floor pieces only: height (m) of the top that `surface` pieces sit on. */
  surface?: number;
  /** Floor pieces you can SIT on (right click): height (m) of the seat. */
  seat?: number;
  parts: readonly PartSpec[];
  /** Colour variants; omitted = one look, and parts may use literals only.
   *  Variant indices are persisted, so only ever APPEND palettes. */
  palettes?: readonly Palette[];
  /**
   * Pieces that open and close (doors, gates, curtains): the model when OPEN.
   * A right click on the piece toggles it. An open floor piece stops being
   * solid — that is the point of a door — and the open model must stay inside
   * the same cells as the closed one.
   */
  openParts?: readonly PartSpec[];
}

/** One placed piece: kind, absolute anchor cell, quarter turns, variant. */
export interface PlacedFurniture {
  kind: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  variant: number;
  /** 1 = open, for pieces with `openParts`; omitted or 0 = closed. */
  state?: number;
}
