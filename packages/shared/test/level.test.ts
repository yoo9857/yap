import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED,
  LEVEL_SECTIONS,
  generateLevel,
  movingPlatformCenter,
  vec3DistXZ,
} from "../src/index.js";

const level = generateLevel(DEFAULT_SEED);
const bricks = level.platforms.filter((p) => !(p.kind === "solid" && p.role === "ground"));

describe("generateLevel", () => {
  it("is deterministic for the same seed", () => {
    expect(generateLevel(DEFAULT_SEED)).toEqual(level);
  });

  it("differs for a different seed", () => {
    expect(generateLevel(DEFAULT_SEED + 1)).not.toEqual(level);
  });

  it("has the expected structure", () => {
    const sectionPlatforms = LEVEL_SECTIONS.reduce((n, s) => n + s.count, 0);
    // baseplate + bricks + one pad per section (last pad = winner)
    expect(level.platforms).toHaveLength(1 + sectionPlatforms + LEVEL_SECTIONS.length);
    expect(level.checkpoints).toHaveLength(LEVEL_SECTIONS.length - 1);
    expect(level.totalStages).toBe(LEVEL_SECTIONS.length);
    expect(level.platforms.filter((p) => p.kind === "solid" && p.role === "winner")).toHaveLength(1);
    expect(level.summitHeight).toBeGreaterThan(60);
    expect(level.minFinishSeconds).toBeGreaterThan(10);
  });

  it("keeps every platform inside the world column", () => {
    for (const p of level.platforms) {
      expect(Math.abs(p.center[0])).toBeLessThanOrEqual(12);
      expect(Math.abs(p.center[2])).toBeLessThanOrEqual(12);
      if (p.kind === "moving") {
        const reach = Math.abs(p.center[p.axis === "x" ? 0 : 2]) + p.amplitude;
        expect(reach).toBeLessThanOrEqual(12.5);
      }
    }
  });

  it("keeps every consecutive gap inside the jump envelope", () => {
    for (let i = 1; i < bricks.length; i++) {
      const prev = bricks[i - 1]!;
      const cur = bricks[i]!;
      const dy = cur.center[1] - prev.center[1];
      expect(dy).toBeGreaterThan(1.8);
      expect(dy).toBeLessThan(2.7);
      // center-to-center planar distance never exceeds the generator's dMax
      expect(vec3DistXZ(prev.center, cur.center)).toBeLessThanOrEqual(6.126);
    }
  });

  it("gives long-gap moving platforms a swing that closes the gap", () => {
    for (let i = 1; i < bricks.length; i++) {
      const cur = bricks[i]!;
      if (cur.kind !== "moving") continue;
      const prev = bricks[i - 1]!;
      // at some phase of the swing the platform must come within reach (~3.2 m
      // edge-to-edge; half-widths ≥ 1.18 m each side → centers within ~5.6 m)
      let nearest = Infinity;
      for (let t = 0; t < 8; t += 0.05) {
        nearest = Math.min(nearest, vec3DistXZ(prev.center, movingPlatformCenter(cur, t)));
      }
      expect(nearest).toBeLessThanOrEqual(5.6);
    }
  });

  it("puts hazards only on wide solid platforms, standing on their top", () => {
    for (const p of level.platforms) {
      if (p.kind !== "solid" || !p.hazard) continue;
      expect(p.size[0]).toBeGreaterThanOrEqual(3.125);
      const platformTop = p.center[1] + p.size[1] / 2;
      expect(p.hazard.center[1]).toBeCloseTo(platformTop + p.hazard.size[1] / 2, 5);
    }
  });
});
