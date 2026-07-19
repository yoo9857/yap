import { describe, expect, it } from "vitest";
import {
  CHARACTER_HEIGHT,
  DAILY_EPOCH_DATE,
  DEFAULT_SEED,
  LEVEL_SECTIONS,
  dailySeed,
  generateLevel,
  movingPlatformCenter,
  vec3DistXZ,
  type Vec3,
} from "../src/index.js";

const level = generateLevel(DEFAULT_SEED);
const NUM_SECTIONS = LEVEL_SECTIONS.length;
const bricks = level.platforms.filter((p) => !(p.kind === "solid" && p.role === "ground"));

type Plat = (typeof level.platforms)[number];
const halfXZ = (p: Plat) => Math.max(p.size[0], p.size[2]) / 2;

/**
 * Can you stand on `parent` and jump up onto a platform centred at `childCenter`
 * (half-extent `childHalf`) sitting one hop above? Edge-based, not centre-based:
 * a wide target (checkpoint / winner pad) is a forgiving landing you approach by
 * its edge, so a larger centre distance is fine; a same-size target needs real
 * horizontal offset so you're not jumping into its underside (a stacked platform
 * blocks the climb — the reported bug).
 */
const JUMP_DY_MAX = 3.0; // a hop never rises more than this (physics headroom)
function climbable(childCenter: Vec3, childHalf: number, parent: Plat): boolean {
  const dy = childCenter[1] - parent.center[1];
  if (dy < 1.8 || dy > JUMP_DY_MAX) return false;
  const d = vec3DistXZ(childCenter, parent.center);
  const halfP = halfXZ(parent);
  const maxD = halfP + childHalf + 1.7; // edge-to-edge jump reach
  const minD = childHalf > halfP + 0.5 ? childHalf - halfP + 0.6 : 2.3;
  return d >= minD && d <= maxD;
}

/** Is there any platform one legal hop below `p` you can climb from? */
function hasReachableParent(p: Plat, platforms: readonly Plat[]): boolean {
  const half = halfXZ(p);
  const phases = p.kind === "moving" ? 80 : 1;
  for (let s = 0; s < phases; s++) {
    const c = p.kind === "moving" ? movingPlatformCenter(p, s * 0.1) : p.center;
    for (const q of platforms) {
      if (q !== p && climbable(c, half, q)) return true;
    }
  }
  return false;
}

describe("generateLevel", () => {
  it("is deterministic for the same seed", () => {
    expect(generateLevel(DEFAULT_SEED)).toEqual(level);
  });

  it("differs for a different seed", () => {
    expect(generateLevel(DEFAULT_SEED + 1)).not.toEqual(level);
  });

  it("has the expected spine structure", () => {
    const ground = level.platforms.filter((p) => p.kind === "solid" && p.role === "ground");
    const checkpointPads = level.platforms.filter((p) => p.kind === "solid" && p.role === "checkpoint");
    const winner = level.platforms.filter((p) => p.kind === "solid" && p.role === "winner");
    expect(ground).toHaveLength(1);
    expect(winner).toHaveLength(1);
    expect(checkpointPads).toHaveLength(NUM_SECTIONS - 1);
    expect(level.checkpoints).toHaveLength(NUM_SECTIONS - 1);
    expect(level.totalStages).toBe(NUM_SECTIONS);
    expect(level.summitHeight).toBeGreaterThan(60);
    expect(level.minFinishSeconds).toBeGreaterThan(10);
  });

  it("builds multiple parallel routes per section (a fuller tower)", () => {
    // 3 low + 4 high routes → each section has far more bricks than its step
    // count; the whole tower is several times the single-route platform total
    const sectionSteps = LEVEL_SECTIONS.reduce((n, s) => n + s.count, 0);
    const laneBricks = bricks.filter((p) => !(p.kind === "solid" && p.role === "checkpoint") && !(p.kind === "solid" && p.role === "winner"));
    expect(laneBricks.length).toBeGreaterThan(sectionSteps * 2.5);
  });

  it("keeps every platform inside the world column", () => {
    for (const p of level.platforms) {
      expect(Math.abs(p.center[0])).toBeLessThanOrEqual(14.5);
      expect(Math.abs(p.center[2])).toBeLessThanOrEqual(14.5);
      if (p.kind === "moving") {
        const reach = Math.abs(p.center[p.axis === "x" ? 0 : 2]) + p.amplitude;
        expect(reach).toBeLessThanOrEqual(16);
      }
    }
  });

  it("makes every brick and pad reachable from a platform one hop below", () => {
    for (const p of bricks) {
      expect(hasReachableParent(p, level.platforms), `platform ${p.id} (${p.kind}) is stranded`).toBe(
        true,
      );
    }
  });

  it("stays fully climbable across many seeds (no stacked/overhead platforms)", () => {
    // the whole point of the multi-route rewrite: lanes zig-zag so no platform
    // is directly above another. Verify it holds for the daily seed space.
    // the REAL seed space: daily seeds are hashes of the date string, so test
    // the actual towers players climb — ~4 years of dailies — plus some raw
    // small seeds for good measure.
    const seeds: number[] = [1966443862]; // the daily seed that first exposed a stranded pad
    for (let s = 1; s < 100; s++) seeds.push(s);
    const DAY = 86_400_000;
    const epochDay = Math.floor(Date.parse(`${DAILY_EPOCH_DATE}T00:00:00Z`) / DAY);
    for (let d = 0; d < 1500; d++) {
      const dateStr = new Date((epochDay + d) * DAY).toISOString().slice(0, 10);
      seeds.push(dailySeed(dateStr));
    }
    const fails: string[] = [];
    for (const seed of seeds) {
      const lvl = generateLevel(seed);
      const idx = new Map(lvl.platforms.map((p, i) => [p, i]));
      for (const p of lvl.platforms) {
        // the baseplate is the floor — everything else (bricks AND pads) must be
        // reachable one hop from below
        if (p.kind === "solid" && p.role === "ground") continue;
        const ok = hasReachableParent(p, lvl.platforms);
        if (!ok) {
          const band = lvl.platforms
            .filter((q) => q !== p && p.center[1] - q.center[1] >= 1.8 && p.center[1] - q.center[1] <= JUMP_DY_MAX)
            .map((q) => `${idx.get(q)}:${vec3DistXZ(p.center, q.center).toFixed(2)}(h${halfXZ(q).toFixed(1)})`);
          fails.push(
            `seed ${seed} plat#${idx.get(p)} (${p.kind} h${halfXZ(p).toFixed(1)}) y=${p.center[1].toFixed(1)} band=[${band.join(",")}]`,
          );
        }
      }
    }
    if (fails.length) console.log("STRANDED:\n" + fails.slice(0, 20).join("\n"));
    expect(fails).toHaveLength(0);
  });

  it("never overhangs a platform within head height (no head-catch)", () => {
    // the capsule is CHARACTER_HEIGHT tall; standing on P, the head reaches
    // P.top + height. No other platform's UNDERSIDE may sit in that band while
    // overlapping P horizontally, or the head catches (the reported bug). Because
    // every platform shares the one height ladder (rungs ≥ 2.45 m apart), the
    // smallest gap clears the head — assert it across the daily seed space.
    const THICK = 0.55;
    const seeds = [DEFAULT_SEED, 1966443862, 7, 42, 100, 500, 2134072957];
    for (const seed of seeds) {
      const lvl = generateLevel(seed);
      for (const p of lvl.platforms) {
        const pTop = p.center[1] + THICK / 2;
        for (const q of lvl.platforms) {
          if (q === p) continue;
          const qBottom = q.center[1] - THICK / 2;
          if (qBottom <= pTop + 0.15 || qBottom >= pTop + CHARACTER_HEIGHT) continue;
          const d = vec3DistXZ(p.center, q.center);
          const overlap = d < halfXZ(p) + halfXZ(q) - 0.05;
          expect(
            overlap,
            `seed ${seed}: platform ${q.id} overhangs ${p.id} at head height (gap ${(qBottom - pTop).toFixed(2)}m)`,
          ).toBe(false);
        }
      }
    }
  });

  it("puts hazards only on wide solid platforms, standing on their top", () => {
    for (const p of level.platforms) {
      if (p.kind !== "solid" || !p.hazard) continue;
      expect(p.size[0]).toBeGreaterThanOrEqual(2.35);
      const platformTop = p.center[1] + p.size[1] / 2;
      expect(p.hazard.center[1]).toBeCloseTo(platformTop + p.hazard.size[1] / 2, 5);
    }
  });
});
