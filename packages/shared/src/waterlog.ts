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
import { faceBit, isWater } from "./fluid.js";

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
const sealTable: number[] = [];

/** The faces this shape seals against water (FACE_* bits). Full cubes seal all six. */
export function shapeSeal(shape: number): number {
  if (!isBlockShape(shape)) return 63;
  let mask = sealTable[shape];
  if (mask === undefined) {
    mask = 0;
    if (isFullCubeShape(shape)) mask = 63;
    else for (const [dx, dy, dz] of DIRS) if (faceCover(shape, dx, dy, dz) > SEAL_COVER) mask |= faceBit(dx, dy, dz);
    sealTable[shape] = mask;
  }
  return mask;
}
