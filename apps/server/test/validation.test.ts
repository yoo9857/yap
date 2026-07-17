import { describe, expect, it } from "vitest";
import { DEFAULT_SEED, generateLevel, type ClientMove, type Vec3 } from "@robo/shared";
import {
  applyRespawn,
  createValidationState,
  validateCheckpoint,
  validateFinish,
  validateMove,
} from "../src/game/validation.js";

const level = generateLevel(DEFAULT_SEED);

function move(pos: Vec3, seq = 0): ClientMove {
  return { t: "c-move", seq, pos, vel: [0, 0, 0], yaw: 0, anim: "run", grounded: true };
}

function freshState() {
  return createValidationState(level.spawn);
}

describe("validateMove", () => {
  it("accepts the first state near spawn", () => {
    const s = freshState();
    expect(validateMove(s, move([1, 0.2, 1]), 1000, level).ok).toBe(true);
  });

  it("rejects a first state far from spawn (no more join-teleport)", () => {
    const s = freshState();
    expect(validateMove(s, move([5, 30, 2]), 1000, level)).toEqual({
      ok: false,
      reason: "far-from-respawn",
    });
  });

  it("rejects out-of-world positions", () => {
    const s = freshState();
    expect(validateMove(s, move([40, 5, 0]), 1000, level)).toEqual({
      ok: false,
      reason: "out-of-world",
    });
    expect(validateMove(s, move([0, -30, 0]), 1000, level)).toEqual({
      ok: false,
      reason: "out-of-world",
    });
  });

  it("accepts normal running speed", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    // 6.9 m/s for 50 ms ≈ 0.35 m
    expect(validateMove(s, move([0.35, 0, 0]), 1050, level).ok).toBe(true);
  });

  it("rejects a planar teleport", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    expect(validateMove(s, move([10, 0, 0]), 1050, level)).toEqual({
      ok: false,
      reason: "too-fast-planar",
    });
  });

  it("rejects flying (impossible upward speed)", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    expect(validateMove(s, move([0, 30, 0]), 1050, level)).toEqual({
      ok: false,
      reason: "too-fast-vertical",
    });
  });

  it("tolerates a lag burst (stale positions, long elapsed)", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    // 400 ms gap then a position 3 m away — fine at running speed
    expect(validateMove(s, move([3, 0, 0]), 1400, level).ok).toBe(true);
  });

  it("keeps rejecting from the last ACCEPTED state", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    expect(validateMove(s, move([10, 0, 0]), 1050, level).ok).toBe(false);
    // still 10 m from the last accepted pos — a cheater can't ratchet forward
    expect(validateMove(s, move([10, 0, 0]), 1100, level).ok).toBe(false);
  });

  it("death respawn teleports back to spawn when no checkpoint reached", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    applyRespawn(s, "death", level); // no checkpoint yet → anchor = spawn
    expect(validateMove(s, move(level.spawn), 1050, level).ok).toBe(true);
  });

  it("BLOCKS the respawn-spam flight exploit (teleport forward is rejected)", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    // cheat attempt: die, then report a position UP the tower
    applyRespawn(s, "death", level); // no checkpoint yet → anchor = spawn
    const cp1 = level.checkpoints[1]!;
    expect(validateMove(s, move(cp1.center), 1050, level)).toEqual({
      ok: false,
      reason: "far-from-respawn",
    });
    // and repeating the respawn doesn't move the anchor forward either
    applyRespawn(s, "death", level);
    expect(validateMove(s, move(cp1.center), 1100, level).ok).toBe(false);
  });

  it("death respawn anchors at the reached checkpoint, not beyond", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    // grant checkpoint 0 legitimately via state
    const cp0 = level.checkpoints[0]!;
    s.checkpoint = 0;
    applyRespawn(s, "death", level);
    expect(validateMove(s, move(cp0.center), 1050, level).ok).toBe(true);
    // but checkpoint 1 is out of reach from that anchor
    const s2 = freshState();
    validateMove(s2, move([0, 0, 0]), 2000, level);
    s2.checkpoint = 0;
    applyRespawn(s2, "death", level);
    expect(validateMove(s2, move(level.checkpoints[1]!.center), 2050, level).ok).toBe(false);
  });
});

describe("checkpoint & finish", () => {
  /** Test helper: legitimately anchor the player at a position. */
  function anchorAt(s: ReturnType<typeof freshState>, pos: Vec3, nowMs: number) {
    s.anchor = [...pos];
    return validateMove(s, move(pos), nowMs, level);
  }

  it("requires checkpoints in order and in proximity", () => {
    const s = freshState();
    const cp0 = level.checkpoints[0]!;
    anchorAt(s, cp0.center, 1000);
    expect(validateCheckpoint(s, 1, level)).toBe(false); // skipped 0
    expect(validateCheckpoint(s, 0, level)).toBe(true);
    expect(validateCheckpoint(s, 0, level)).toBe(false); // repeat
  });

  it("rejects a checkpoint claimed from far away", () => {
    const s = freshState();
    validateMove(s, move([0, 0, 0]), 1000, level);
    expect(validateCheckpoint(s, 0, level)).toBe(false);
  });

  it("rejects finish without all checkpoints", () => {
    const s = freshState();
    anchorAt(s, level.goal.center, 1000);
    expect(validateFinish(s, 2000, level).ok).toBe(false);
  });

  it("rejects an impossibly fast finish and accepts a legit one", () => {
    const s = freshState();
    let now = 1000;
    validateMove(s, move([2, 0, 0]), now, level); // starts the run clock
    for (const cp of level.checkpoints) {
      now += 20_000;
      anchorAt(s, cp.center, now);
      expect(validateCheckpoint(s, cp.index, level)).toBe(true);
    }
    now += 20_000;
    anchorAt(s, level.goal.center, now);

    const tooFast = validateFinish(s, 1000 + level.minFinishSeconds * 1000 - 1, level);
    expect(tooFast.ok).toBe(false);

    const legit = validateFinish(s, now, level);
    expect(legit.ok).toBe(true);
    if (legit.ok) expect(legit.timeMs).toBe(now - 1000);
  });

  it("restart resets run state and re-anchors at spawn", () => {
    const s = freshState();
    validateMove(s, move([2, 0, 0]), 1000, level);
    s.checkpoint = 0;
    applyRespawn(s, "restart", level);
    expect(s.checkpoint).toBe(-1);
    expect(s.runStartedAtMs).toBeNull();
    expect(validateMove(s, move([8, 30, 0]), 1100, level).ok).toBe(false);
    expect(validateMove(s, move(level.spawn), 1150, level).ok).toBe(true);
  });
});
