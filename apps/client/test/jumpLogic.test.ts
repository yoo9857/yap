import { describe, expect, it } from "vitest";
import { COYOTE_TICKS, JUMP_BUFFER_TICKS } from "@robo/shared";
import { createJumpState, updateJump } from "../src/player/jumpLogic.js";

describe("jumpLogic", () => {
  it("jumps immediately when grounded and pressed", () => {
    const s = createJumpState();
    expect(updateJump(s, 10, true, true)).toBe(true);
  });

  it("does not jump in the air without coyote window", () => {
    const s = createJumpState();
    expect(updateJump(s, 100, false, true)).toBe(false);
  });

  it("allows a coyote jump shortly after leaving the ground", () => {
    const s = createJumpState();
    updateJump(s, 10, true, false); // on ground
    // walked off the edge; press within the coyote window
    expect(updateJump(s, 10 + COYOTE_TICKS, false, true)).toBe(true);
  });

  it("rejects a jump after the coyote window closes", () => {
    const s = createJumpState();
    updateJump(s, 10, true, false);
    expect(updateJump(s, 10 + COYOTE_TICKS + 1, false, true)).toBe(false);
  });

  it("buffers a press made shortly before landing", () => {
    const s = createJumpState();
    updateJump(s, 10, false, true); // press mid-air
    let jumped = false;
    for (let t = 11; t <= 10 + JUMP_BUFFER_TICKS; t++) {
      jumped ||= updateJump(s, t, t === 10 + JUMP_BUFFER_TICKS, false); // land on last tick
    }
    expect(jumped).toBe(true);
  });

  it("expires a press held too long before landing", () => {
    const s = createJumpState();
    updateJump(s, 10, false, true);
    expect(updateJump(s, 10 + JUMP_BUFFER_TICKS + 1, true, false)).toBe(false);
  });

  it("fires at most one jump per press", () => {
    const s = createJumpState();
    expect(updateJump(s, 10, true, true)).toBe(true);
    // still grounded next tick (step not applied yet) — must not double-fire
    expect(updateJump(s, 11, true, false)).toBe(false);
  });

  it("does not allow two jumps from one ground contact (no double coyote)", () => {
    const s = createJumpState();
    expect(updateJump(s, 10, true, true)).toBe(true);
    expect(updateJump(s, 12, false, true)).toBe(false);
  });
});
