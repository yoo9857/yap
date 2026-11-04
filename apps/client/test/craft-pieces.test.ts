import { describe, expect, it } from "vitest";
import { KIT_CUBE, ROUND, blockShapeFamily, shapeYaw, shapeTilt } from "@robo/shared";
import { PIECES, pieceCells, pieceShape, MAX_PIECE_CELLS, type Piece } from "../src/craft/pieces.js";

const byKey = (k: string): Piece => PIECES.find((p) => p.key === k)!;
/** Multi-cell footprints are no longer in the palette, but the rotation maths still serves any
 *  footprint (tools, future pieces): pinned with pieces defined here. */
const bar3: Piece = { key: "t-bar3", name: "bar", ko: "막대", cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], rotatable: true };
const ell: Piece = { key: "t-ell", name: "L", ko: "L", cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], rotatable: true };

describe("craft pieces", () => {
  it("offers six one-cell shapes: square, triangle, corner, round, half block, stairs", () => {
    expect(PIECES.map((p) => p.key)).toEqual(["1x1", "slope", "corner-slope", "round", "slab", "stairs"]);
    expect(PIECES.map((p) => p.ko)).toEqual(["네모형", "삼각형", "모서리형", "원형", "반블록형", "계단형"]);
    for (const piece of PIECES) expect(piece.cells).toEqual([[0, 0, 0]]);
    expect(MAX_PIECE_CELLS).toBe(1);
  });

  it("maps every piece to its stored shape, turned by yaw and tipped by tilt", () => {
    expect(pieceShape(byKey("1x1"), 2, 1)).toBe(KIT_CUBE);
    expect(pieceShape(byKey("round"), 2, 1)).toBe(ROUND);
    for (const [key, family] of [["slope", "slope"], ["corner-slope", "corner"], ["slab", "slab"], ["stairs", "stairs"]] as const) {
      for (let yaw = 0; yaw < 4; yaw++) for (let tilt = 0; tilt < 4; tilt++) {
        const shape = pieceShape(byKey(key), yaw, tilt);
        expect(blockShapeFamily(shape)).toBe(family);
        expect([shapeYaw(shape), shapeTilt(shape)]).toEqual([yaw, tilt]);
      }
    }
  });

  it("rotates a footprint around the fixed anchor and wraps at 4", () => {
    expect(pieceCells(bar3, 1)).toEqual([[0, 0, 0], [0, 0, -1], [0, 0, -2]]);
    const seen = new Set([0, 1, 2, 3].map((r) => JSON.stringify(pieceCells(ell, r))));
    expect(seen.size).toBe(4);
    expect(pieceCells(ell, 4)).toEqual(pieceCells(ell, 0));
    expect(pieceCells(ell, -1)).toEqual(pieceCells(ell, 3));
  });

  it("tips a horizontal bar into a vertical column (yaw + tilt)", () => {
    expect(pieceCells(bar3, 1, 1)).toEqual([[0, 0, 0], [0, 1, 0], [0, 2, 0]]);
  });

  it("keeps the anchor cell at the origin under every rotation", () => {
    for (const piece of [...PIECES, bar3, ell]) for (const rot of [0, 1, 2, 3]) expect(pieceCells(piece, rot)).toContainEqual([0, 0, 0]);
  });
});
