import { KIT_CUBE, ROUND, kitSlopeShape, cornerShape } from "./shapes.js";
/** Unit-grid construction footprints. Old persisted shape codes remain separate from this palette. */
/** Geometry family for a piece's cells (round/slope are single-cell shapes). */
export type PieceShape = "cube" | "round" | "slope" | "cornerSlope";
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
export const PIECES: readonly Piece[] = [
    { key: "1x1", name: "Brick 1×1", ko: "블록 1×1", cells: [[0, 0, 0]], rotatable: false },
    { key: "1x2", name: "Bar 1×2", ko: "막대 1×2", cells: [[0, 0, 0], [1, 0, 0]], rotatable: true },
    { key: "1x3", name: "Bar 1×3", ko: "막대 1×3", cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], rotatable: true },
    { key: "corner", name: "Corner L", ko: "L자 모서리", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], rotatable: true },
    { key: "2x2", name: "Plate 2×2", ko: "판 2×2", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], rotatable: true },
    { key: "round", name: "Round ○", ko: "둥근 기둥 ○", cells: [[0, 0, 0]], rotatable: false, shape: "round" },
    { key: "slope", name: "Slope ◺", ko: "경사 ◺", cells: [[0, 0, 0]], rotatable: true, shape: "slope" },
    { key: "1x4", name: "Bar 1×4", ko: "긴 블록 1×4", cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], rotatable: true },
    { key: "2x3", name: "Plate 2×3", ko: "조립판 2×3", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [0, 0, 2], [1, 0, 2]], rotatable: true },
    { key: "2x4", name: "Plate 2×4", ko: "조립판 2×4", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [0, 0, 2], [1, 0, 2], [0, 0, 3], [1, 0, 3]], rotatable: true },
    { key: "corner-long", name: "Long corner L", ko: "긴 모서리 L", cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1]], rotatable: true },
    { key: "corner-slope", name: "Corner ramp", ko: "모서리 경사", cells: [[0, 0, 0]], rotatable: true, shape: "cornerSlope" },
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
export function pieceShape(piece: Piece, yaw: number, tilt: number): number { return piece.shape === "round" ? ROUND : piece.shape === "slope" ? kitSlopeShape(yaw, tilt) : piece.shape === "cornerSlope" ? cornerShape(yaw, tilt) : KIT_CUBE; }
export const MAX_PIECE_CELLS = Math.max(...PIECES.map(p => p.cells.length));
