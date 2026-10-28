import { describe, expect, it } from "vitest";
import { LOCK_SETTLE_MS, SPIKE_PX, lookDelta } from "../src/input/mouseLook.js";

describe("lookDelta", () => {
  it("passes ordinary movement through", () => {
    expect(lookDelta(12, -7, 1000)).toEqual([12, -7]);
    expect(lookDelta(-SPIKE_PX, SPIKE_PX, 1000)).toEqual([-SPIKE_PX, SPIKE_PX]);
  });

  it("ignores the cursor's jump right after the mouse is captured", () => {
    expect(lookDelta(0, 640, 5)).toBeNull();
    expect(lookDelta(3, 2, LOCK_SETTLE_MS - 1)).toBeNull();
    expect(lookDelta(3, 2, LOCK_SETTLE_MS)).toEqual([3, 2]);
  });

  it("drops a spike instead of clamping it into a whip", () => {
    expect(lookDelta(SPIKE_PX + 1, 0, 1000)).toBeNull();
    expect(lookDelta(0, -900, 1000)).toBeNull();
  });

  it("drops non-finite input", () => {
    expect(lookDelta(Number.NaN, 1, 1000)).toBeNull();
    expect(lookDelta(1, Number.POSITIVE_INFINITY, 1000)).toBeNull();
  });
});
