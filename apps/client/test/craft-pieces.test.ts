import { describe, expect, it } from "vitest";
import { PIECES, pieceCells, type Piece } from "../src/craft/pieces.js";

const byKey = (k: string): Piece => PIECES.find((p) => p.key === k)!;

describe("craft pieces", () => {
  it("exposes the rectangular family plus round + slope", () => {
    expect(PIECES.map((p) => p.key)).toEqual(["1x1", "1x2", "1x3", "corner", "2x2", "round", "slope"]);
  });

  it("tags round + slope with their geometry", () => {
    expect(byKey("round").shape).toBe("round");
    expect(byKey("slope").shape).toBe("slope");
    // rectangular pieces default to cube (no shape tag)
    expect(byKey("1x2").shape).toBeUndefined();
  });

  it("keeps 1×1 a single anchor cell that never rotates", () => {
    expect(byKey("1x1").rotatable).toBe(false);
    for (const rot of [0, 1, 2, 3]) {
      expect(pieceCells(byKey("1x1"), rot)).toEqual([[0, 0, 0]]);
    }
  });

  it("rotates a 1×2 bar around the fixed anchor", () => {
    expect(pieceCells(byKey("1x2"), 0)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    // (x,z) → (z, −x): [1,0,0] → [0,0,−1]
    expect(pieceCells(byKey("1x2"), 1)).toEqual([
      [0, 0, 0],
      [0, 0, -1],
    ]);
  });

  it("returns four distinct orientations for the L-corner and wraps at 4", () => {
    const seen = new Set([0, 1, 2, 3].map((r) => JSON.stringify(pieceCells(byKey("corner"), r))));
    expect(seen.size).toBe(4);
    expect(pieceCells(byKey("corner"), 4)).toEqual(pieceCells(byKey("corner"), 0));
    // negative rotation is normalised too
    expect(pieceCells(byKey("corner"), -1)).toEqual(pieceCells(byKey("corner"), 3));
  });

  it("tips a horizontal 1×3 bar into a vertical column (yaw + tilt)", () => {
    // flat along +X
    expect(pieceCells(byKey("1x3"), 0, 0)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    // yaw 1 (→ along −Z) then tilt 1 (tip up) ⇒ a column up +Y
    expect(pieceCells(byKey("1x3"), 1, 1)).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
    ]);
  });

  it("keeps the anchor cell at the origin under every rotation", () => {
    for (const piece of PIECES) {
      for (const rot of [0, 1, 2, 3]) {
        expect(pieceCells(piece, rot)).toContainEqual([0, 0, 0]);
      }
    }
  });
});
