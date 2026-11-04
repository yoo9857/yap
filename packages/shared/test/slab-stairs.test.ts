import { describe, expect, it } from "vitest";
import { SLAB_BASE, STAIRS_BASE, MAX_BLOCK_SHAPE, CORNER_BASE, slabShape, stairsShape, blockShapeFamily, shapeIntersectsBox, raycastBlockShape, rampHeight, holdsFurniture, isBlockShape } from "../src/blockShapes.js";
import { decodeClassClient } from "../src/protocol/classroom.js";

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ min: [x0, y0, z0] as [number, number, number], max: [x1, y1, z1] as [number, number, number] });

describe("half block and stairs", () => {
  it("are appended after every older code, in 16 orientations each, and cross the classroom wire", () => {
    expect(SLAB_BASE).toBe(CORNER_BASE + 16);
    expect(STAIRS_BASE).toBe(SLAB_BASE + 16);
    expect(MAX_BLOCK_SHAPE).toBe(STAIRS_BASE + 15);
    for (let yaw = 0; yaw < 4; yaw++) for (let tilt = 0; tilt < 4; tilt++) {
      for (const [shape, family] of [[slabShape(yaw, tilt), "slab"], [stairsShape(yaw, tilt), "stairs"]] as const) {
        expect(isBlockShape(shape)).toBe(true);
        expect(blockShapeFamily(shape)).toBe(family);
        expect(decodeClassClient(JSON.stringify({ t: "k-edit", edits: [[2, 4, 3, 3, shape]] }))).not.toBeNull();
      }
    }
  });

  it("a half block fills the lower half; upside down, the upper half", () => {
    expect(shapeIntersectsBox(slabShape(0, 0), box(0.2, 0.1, 0.2, 0.8, 0.4, 0.8))).toBe(true);
    expect(shapeIntersectsBox(slabShape(0, 0), box(0.2, 0.55, 0.2, 0.8, 0.9, 0.8))).toBe(false);
    expect(shapeIntersectsBox(slabShape(0, 2), box(0.2, 0.55, 0.2, 0.8, 0.9, 0.8))).toBe(true);
    expect(shapeIntersectsBox(slabShape(0, 2), box(0.2, 0.1, 0.2, 0.8, 0.4, 0.8))).toBe(false);
  });

  it("stairs: a full lower step, and an upper step only at the back — which turns with yaw", () => {
    const s = stairsShape(0, 0);
    expect(shapeIntersectsBox(s, box(0.4, 0.1, 0.7, 0.6, 0.4, 0.9))).toBe(true); // lower step, front
    expect(shapeIntersectsBox(s, box(0.4, 0.6, 0.1, 0.6, 0.9, 0.3))).toBe(true); // upper step, back (−z)
    expect(shapeIntersectsBox(s, box(0.4, 0.6, 0.7, 0.6, 0.9, 0.9))).toBe(false); // the open front corner
    const turned = stairsShape(2, 0);
    expect(shapeIntersectsBox(turned, box(0.4, 0.6, 0.7, 0.6, 0.9, 0.9))).toBe(true);
    expect(shapeIntersectsBox(turned, box(0.4, 0.6, 0.1, 0.6, 0.9, 0.3))).toBe(false);
  });

  it("rays hit what is drawn: over the stairs' open corner they reach the riser, from above the tread", () => {
    const s = stairsShape(0, 0);
    const riser = raycastBlockShape(s, [0.5, 0.75, 1.5], [0, 0, -1], 3); // level with the upper step, from the front
    expect(riser?.distance).toBeCloseTo(1.0, 5); // passes the open half, hits z = 0.5
    expect(riser?.normal[2]).toBeCloseTo(1, 5);
    const tread = raycastBlockShape(s, [0.5, 2, 0.75], [0, -1, 0], 3); // from above the front half
    expect(tread?.distance).toBeCloseTo(1.5, 5); // lands on y = 0.5
    expect(raycastBlockShape(slabShape(0, 0), [0.5, 0.75, 1.5], [0, 0, -1], 3)).toBeNull(); // above a half block
  });

  it("are stepped up, not slid up like a ramp; furniture stands only on a whole top", () => {
    expect(rampHeight(slabShape(0, 0), 0.5, 0.5)).toBeNull();
    expect(rampHeight(stairsShape(0, 0), 0.5, 0.5)).toBeNull();
    expect(holdsFurniture(slabShape(0, 0))).toBe(false);
    expect(holdsFurniture(stairsShape(1, 0))).toBe(false);
    expect(holdsFurniture(slabShape(3, 2))).toBe(true); // upside down: the top is the whole cell
    expect(holdsFurniture(0)).toBe(true);
    expect(holdsFurniture(CORNER_BASE)).toBe(true); // older shapes keep their rule
  });
});
