import { KIT_CUBE, ROUND, kitSlopeShape, cornerShape, slabShape, stairsShape } from "./shapes.js";
/** Unit-grid construction footprints. Old persisted shape codes remain separate from this palette. */
/** Geometry family for a piece's cells (round/slope are single-cell shapes). */
export type PieceShape = "cube" | "round" | "slope" | "cornerSlope" | "slab" | "stairs";
export interface Piece {
    key: string;
    name: string;
    /** Korean display name; `name` is the English one. */
    ko: string;
    /** Local footprint cells (dx, dy, dz); [0,0,0] is the anchor. */
    cells: readonly (readonly [
        number,
        number,
        number
    ])[];
    /** Whether R rotates it (footprint yaw, or slope facing). */
    rotatable: boolean;
    /** Per-cell brick geometry (defaults to cube). */
    shape?: PieceShape;
}
/**
 * One cell each, six shapes (owner's palette, 2026-11-04): the multi-cell bars, plates and L pieces
 * are gone — building is shape by shape. Keys are stable (only appended); blocks already placed
 * with an old piece are plain cells and stay. R turns, T tips, Shift+R resets.
 */
export const PIECES: readonly Piece[] = [
    { key: "1x1", name: "Square", ko: "네모형", cells: [[0, 0, 0]], rotatable: false },
    { key: "slope", name: "Triangle", ko: "삼각형", cells: [[0, 0, 0]], rotatable: true, shape: "slope" },
    { key: "corner-slope", name: "Corner", ko: "모서리형", cells: [[0, 0, 0]], rotatable: true, shape: "cornerSlope" },
    { key: "round", name: "Round", ko: "원형", cells: [[0, 0, 0]], rotatable: false, shape: "round" },
    { key: "slab", name: "Half block", ko: "반블록형", cells: [[0, 0, 0]], rotatable: true, shape: "slab" },
    { key: "stairs", name: "Stairs", ko: "계단형", cells: [[0, 0, 0]], rotatable: true, shape: "stairs" },
];
const wrap4 = (n: number): number => ((n % 4) + 4) % 4;
const nz0 = (n: number): number => (n === 0 ? 0 : n); // normalise −0 → 0
/**
 * Footprint cells rotated by yaw (about Y) then tilt (about X), 90° steps, with
 * the anchor [0,0,0] fixed. Yaw spins it flat; tilt tips it out of the ground
 * plane (so a 1×3 bar can stand up as a column). Matches `brickOrientation`.
 */
export function pieceCells(piece: Piece, yaw: number, tilt = 0): [
    number,
    number,
    number
][] {
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
/** Persisted geometry for new construction, independent of the material colour. */
export function pieceShape(piece: Piece, yaw: number, tilt: number): number { return piece.shape === "round" ? ROUND : piece.shape === "slope" ? kitSlopeShape(yaw, tilt) : piece.shape === "cornerSlope" ? cornerShape(yaw, tilt) : piece.shape === "slab" ? slabShape(yaw, tilt) : piece.shape === "stairs" ? stairsShape(yaw, tilt) : KIT_CUBE; }
export const MAX_PIECE_CELLS = Math.max(...PIECES.map(p => p.cells.length));
