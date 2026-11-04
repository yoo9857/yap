import { describe, expect, it } from "vitest";
import { slabShape, stairsShape } from "@robo/shared";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { stepBody, type Body } from "../src/craft/voxelBody.js";

function ground(): VoxelWorld {
  const w = new VoxelWorld();
  for (let x = 4; x <= 14; x++) for (let z = 4; z <= 14; z++) w.set(x, 0, z, 3);
  return w;
}
const body = (): Body => ({ x: 8.5, y: 1, z: 11.5, vx: 0, vy: 0, vz: 0, grounded: true });
/** Walk toward −z, no jumping, until the body's centre passes `untilZ` (or two seconds). */
const walk = (w: VoxelWorld, b: Body, untilZ: number) => { for (let i = 0; i < 120 && b.z > untilZ; i++) stepBody(w, b, 1 / 60, 0, -1, false); };

describe("walking up half blocks and stairs (no jump)", () => {
  it("walks onto a half block", () => {
    const w = ground();
    w.setShaped(8, 1, 9, 3, slabShape(0, 0));
    const b = body();
    walk(w, b, 9.5); // centre over the half block
    expect(b.z).toBeLessThan(9.6);
    expect(b.y).toBeCloseTo(1.5, 2);
  });

  it("climbs a staircase of stairs blocks, one step at a time", () => {
    const w = ground();
    // a flight going up toward −z: each stairs block's high back half faces −z
    w.setShaped(8, 1, 9, 3, stairsShape(0, 0));
    w.setShaped(8, 1, 8, 3, 18); w.setShaped(8, 2, 8, 3, stairsShape(0, 0));
    w.setShaped(8, 1, 7, 3, 18); w.setShaped(8, 2, 7, 3, 18);
    const b = body();
    let biggestRise = 0;
    for (let i = 0; i < 180 && b.z > 7.5; i++) {
      const y = b.y;
      stepBody(w, b, 1 / 60, 0, -1, false);
      biggestRise = Math.max(biggestRise, b.y - y);
    }
    expect(b.y).toBeCloseTo(3, 2); // up onto the landing, two blocks higher, without a jump
    expect(b.z).toBeLessThan(7.6);
    expect(biggestRise).toBeLessThanOrEqual(0.52); // half a block at a time, never a whole one
  });

  it("still stops at a whole block: that one is a jump", () => {
    const w = ground();
    w.set(8, 1, 9, 3);
    const b = body();
    walk(w, b, 9.5);
    expect(b.y).toBeCloseTo(1, 2);
    expect(b.z).toBeGreaterThan(10);
  });

  it("does not step up in mid-air (only a body that stood on the ground)", () => {
    const w = ground();
    w.setShaped(8, 1, 9, 3, slabShape(0, 0));
    const b = { ...body(), y: 1.2, grounded: false, vy: 0 };
    stepBody(w, b, 1 / 60, 0, -1, false);
    expect(b.grounded).toBe(false);
  });
});
