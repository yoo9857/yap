/**
 * LEGO piece shapes for the craft building palette. A piece is a small
 * footprint of grid cells stamped in one placement — the world stays a plain
 * 1×1 voxel grid (physics, render and save are unchanged), so a 1×3 bar is
 * simply three studded bricks in a row, an L-corner three cells in an L, etc.
 *
 * The anchor cell [0,0,0] sits at the aim's placement cell and is fixed under
 * rotation, so rotating never walks the piece off the block you're pointing at.
 *
 * (Round + slope pieces need their own per-cell geometry + a save-format bump;
 * those arrive in a later pass. This module covers the rectangular family.)
 */

/** Geometry family for a piece's cells (round/slope are single-cell shapes). */
export type PieceShape = "cube" | "round" | "slope";

export interface Piece {
  key: string;
  name: string;
  /** Local footprint cells (dx, dy, dz); [0,0,0] is the anchor. */
  cells: readonly (readonly [number, number, number])[];
  /** Whether R rotates it (footprint yaw, or slope facing). */
  rotatable: boolean;
  /** Per-cell brick geometry (defaults to cube). */
  shape?: PieceShape;
}

export const PIECES: readonly Piece[] = [
  { key: "1x1", name: "Brick 1×1", cells: [[0, 0, 0]], rotatable: false },
  { key: "1x2", name: "Bar 1×2", cells: [[0, 0, 0], [1, 0, 0]], rotatable: true },
  { key: "1x3", name: "Bar 1×3", cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], rotatable: true },
  { key: "corner", name: "Corner L", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], rotatable: true },
  { key: "2x2", name: "Plate 2×2", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], rotatable: true },
  { key: "round", name: "Round ○", cells: [[0, 0, 0]], rotatable: false, shape: "round" },
  { key: "slope", name: "Slope ◺", cells: [[0, 0, 0]], rotatable: true, shape: "slope" },
];

const wrap4 = (n: number): number => ((n % 4) + 4) % 4;
const nz0 = (n: number): number => (n === 0 ? 0 : n); // normalise −0 → 0

/**
 * Footprint cells rotated by yaw (about Y) then tilt (about X), 90° steps, with
 * the anchor [0,0,0] fixed. Yaw spins it flat; tilt tips it out of the ground
 * plane (so a 1×3 bar can stand up as a column). Matches `brickOrientation`.
 */
export function pieceCells(piece: Piece, yaw: number, tilt = 0): [number, number, number][] {
  const yr = wrap4(yaw);
  const tr = wrap4(tilt);
  return piece.cells.map(([x, y, z]) => {
    let cx = x, cy = y, cz = z;
    for (let i = 0; i < yr; i++) {
      const nx = cz; // +90° about Y: (x,z) → (z, −x)
      const nzz = -cx;
      cx = nx;
      cz = nzz;
    }
    for (let i = 0; i < tr; i++) {
      const ny = -cz; // +90° about X: (y,z) → (−z, y)
      const nzz = cy;
      cy = ny;
      cz = nzz;
    }
    return [nz0(cx), nz0(cy), nz0(cz)];
  });
}
