/**
 * Water INSIDE shaped blocks ("waterlogging"). A triangle, corner, round,
 * half block or stairs fills only part of its cell; the rest can hold water.
 * The water a shaped cell holds lives in a layer BESIDE its block id (the
 * block id and shape stay what they are), and it is pure simulation state:
 * never saved — reloading re-flows it from the saved water around it.
 *
 * Water moves between two cells unless either cell's shape SEALS the face
 * they share. A face is sealed when the shape covers more than SEAL_COVER of
 * it: a ramp's back and floor, a half block's floor, a round block's top and
 * bottom (a disc covers 79 %), but never a ramp's triangular side (50 %) or a
 * stairs' side (75 %). So water flows into the open part of a shape, stops
 * at its walls, and sits on its floor.
 */

import { isFullCubeShape, isBlockShape, shapeIntersectsBox, type ShapePoint } from "./blockShapes.js";
import { FACE_NY, FACE_PY, faceBit, isWater } from "./fluid.js";

/** More than this much of a face covered = water cannot pass it. */
export const SEAL_COVER = 0.77;

/** Can a cell with this shape hold water beside its block? Every shape but a full cube. */
export const waterloggableShape = (shape: number): boolean => isBlockShape(shape) && !isFullCubeShape(shape);

/** Does this cell (block id + shape) keep its water in the side layer? Air and water cells hold
 *  water as their own id; a cube holds none. */
export const holdsWaterlog = (block: number, shape: number): boolean =>
  block !== 0 && !isWater(block) && waterloggableShape(shape);

const SAMPLES = 16;

/** How much of one face the shape covers, 0‒1 (sampled just inside the face). */
export function faceCover(shape: number, dx: number, dy: number, dz: number): number {
  const d = [dx, dy, dz], axis = d.findIndex((v) => v !== 0), [u, v] = [0, 1, 2].filter((i) => i !== axis) as [number, number];
  const depth = d[axis]! > 0 ? 1 - 0.01 : 0.01, h = 0.004;
  let hits = 0;
  for (let i = 0; i < SAMPLES; i++) for (let j = 0; j < SAMPLES; j++) {
    const p: ShapePoint = [0, 0, 0];
    p[axis] = depth; p[u] = (i + 0.5) / SAMPLES; p[v] = (j + 0.5) / SAMPLES;
    if (shapeIntersectsBox(shape, { min: [p[0] - h, p[1] - h, p[2] - h], max: [p[0] + h, p[1] + h, p[2] + h] })) hits++;
  }
  return hits / (SAMPLES * SAMPLES);
}

const DIRS: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The faces this shape seals, measured from the geometry by `faceCover` (16×16 samples per face,
 *  ~127k box tests for every shape: 160 ms). Used to check SHAPE_SEALS. */
export function computeShapeSeal(shape: number): number {
  if (!isBlockShape(shape) || isFullCubeShape(shape)) return 63;
  let mask = 0;
  for (const [dx, dy, dz] of DIRS) if (faceCover(shape, dx, dy, dz) > SEAL_COVER) mask |= faceBit(dx, dy, dz);
  return mask;
}

/** `computeShapeSeal` for every shape code 0..MAX_BLOCK_SHAPE, precomputed: measuring took 160 ms
 *  the first time (a server opening its first class paid it). test/waterlog.test.ts recomputes
 *  every entry; a new shape code must be appended here (the test says which). */
export const SHAPE_SEALS: readonly number[] = [
  63, 12, 40, 10, 24, 9, 36, 34, 40, 33, 20, 6, 36, 5, 24, 18, 20, 17, 63, 40, 10, 24, 9, 36, 34, 40, 33, 20, 6, 36, 5, 24,
  18, 20, 17, 8, 8, 8, 8, 32, 32, 32, 32, 4, 4, 4, 4, 16, 16, 16, 16, 8, 8, 8, 8, 32, 32, 32, 32, 4, 4, 4, 4, 16,
  16, 16, 16, 40, 10, 24, 9, 36, 34, 40, 33, 20, 6, 36, 5, 24, 18, 20, 17,
];

/** The faces this shape seals against water (FACE_* bits). Full cubes seal all six. */
export function shapeSeal(shape: number): number {
  return SHAPE_SEALS[shape] ?? computeShapeSeal(shape);
}

/**
 * Where the TOP of a shaped block is at each corner of its cell, for drawing the water it holds
 * as a film over the block instead of a cell-sized body around it: two bits per corner
 * (corner = x + 2·z; 1 = floor, 2 = half way, 3 = the cell's top). 0 = no profile: the shape does
 * not stand on its cell's floor (tipped, upside down), or its top is closed (a round).
 */
export function computeShapeProfile(shape: number): number {
  // a sealed top (a round) never takes water from above, which is the only water drawn as a film
  if (!waterloggableShape(shape) || (shapeSeal(shape) & FACE_NY) === 0 || (shapeSeal(shape) & FACE_PY) !== 0) return 0;
  let out = 0, full = true;
  for (let corner = 0; corner < 4; corner++) {
    const x = corner & 1 ? 0.96 : 0.04, z = corner & 2 ? 0.96 : 0.04, e = 0.02;
    const hit = (lo: number, hi: number) => shapeIntersectsBox(shape, { min: [x - e, lo, z - e], max: [x + e, hi, z + e] });
    const v = hit(0.8, 0.98) ? 2 : hit(0.3, 0.48) ? 1 : 0;
    if (v !== 2) full = false;
    out |= (v + 1) << (corner * 2);
  }
  return full ? 0 : out;
}

/** The mesher's mark for a shaped block that holds water WITHOUT a film (water standing at its
 *  own level in it): no corner heights, but water leaving it still runs off a block. Never a
 *  `shapeProfile` value (those give every corner 1‒3). */
export const WATER_HELD = 4;

let profiles: Uint8Array | null = null;
/** `computeShapeProfile`, cached for every shape code. */
export function shapeProfile(shape: number): number {
  if (!profiles) {
    profiles = new Uint8Array(256);
    for (let s = 0; s < 256; s++) profiles[s] = computeShapeProfile(s);
  }
  return profiles[shape & 255]!;
}
