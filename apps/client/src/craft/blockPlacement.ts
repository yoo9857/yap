import type { VoxelWorld } from "./voxelWorld.js";
import { overlapsShapedVoxel, type Body } from "./voxelBody.js";
import { pieceCells, pieceShape, type Piece } from "./pieces.js";
export interface PiecePlan {
    shape: number;
    cells: [
        number,
        number,
        number
    ][];
    cost: number;
}
/** A single plan is used for both preview and placement: the whole piece succeeds or fails. */
export function planPiecePlacement(world: VoxelWorld, body: Body, piece: Piece, yaw: number, tilt: number, anchor: readonly [
    number,
    number,
    number
], available: number, blocked: (x: number, y: number, z: number) => boolean): PiecePlan | null {
    const cells = pieceCells(piece, yaw, tilt).map(([x, y, z]): [
        number,
        number,
        number
    ] => [anchor[0] + x, anchor[1] + y, anchor[2] + z]);
    const shape = pieceShape(piece, yaw, tilt);
    if (available < cells.length)
        return null;
    for (const [x, y, z] of cells)
        if (!world.inBounds(x, y, z) || !world.isReplaceable(x, y, z) || blocked(x, y, z) || overlapsShapedVoxel(body, x, y, z, shape))
            return null;
    return { shape, cells, cost: cells.length };
}
