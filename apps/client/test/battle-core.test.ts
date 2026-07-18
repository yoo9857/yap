import { describe, expect, it } from "vitest";
import { blockByKey } from "../src/craft/blocks.js";
import { VoxelWorld, WORLD_X, WORLD_Z } from "../src/craft/voxelWorld.js";
import {
  FIRE_RANGE,
  hasLineOfSight,
  rayHitsFighter,
  resolveShot,
  type Fighter,
} from "../src/battle/combat.js";
import {
  ZONE_PHASES,
  ZONE_START_RADIUS,
  insideZone,
  zoneNextEventIn,
  zoneRadiusAt,
  zoneTicksBetween,
} from "../src/battle/zone.js";
import { makeBot, stepBot, botFighter } from "../src/battle/bots.js";

const fighter = (x: number, y: number, z: number, hp = 3): Fighter => ({ x, y, z, hp });

describe("zone schedule", () => {
  it("holds, shrinks linearly, then holds the next radius", () => {
    expect(zoneRadiusAt(0)).toBe(ZONE_START_RADIUS);
    expect(zoneRadiusAt(11.9)).toBe(ZONE_START_RADIUS);
    const midShrink = zoneRadiusAt(12 + 5); // halfway through the first shrink
    expect(midShrink).toBeCloseTo((ZONE_START_RADIUS + ZONE_PHASES[0]!.to) / 2, 5);
    expect(zoneRadiusAt(22)).toBe(ZONE_PHASES[0]!.to);
    expect(zoneRadiusAt(9999)).toBe(ZONE_PHASES[ZONE_PHASES.length - 1]!.to);
  });

  it("counts damage ticks across boundaries only", () => {
    expect(zoneTicksBetween(0.5, 1.5)).toBe(0);
    expect(zoneTicksBetween(1.9, 2.1)).toBe(1);
    expect(zoneTicksBetween(0, 6.1)).toBe(3);
  });

  it("reports the next event countdown and eventual closure", () => {
    expect(zoneNextEventIn(0)!.label).toBe("closes-in");
    expect(zoneNextEventIn(12.5)!.label).toBe("shrinking");
    expect(zoneNextEventIn(9999)).toBeNull();
  });

  it("inside check is a plain disc", () => {
    expect(insideZone(0, 0, 0, 0, 5)).toBe(true);
    expect(insideZone(4, 4, 0, 0, 5)).toBe(false);
  });
});

describe("hitscan", () => {
  it("hits a fighter dead ahead and reports the entry distance", () => {
    const target = fighter(10, 0, 0);
    const d = rayHitsFighter(0, 1, 0, 1, 0, 0, target, FIRE_RANGE);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(10 - 0.3, 5); // AABB half-width
  });

  it("misses to the side and behind", () => {
    const target = fighter(10, 0, 3);
    expect(rayHitsFighter(0, 1, 0, 1, 0, 0, target, FIRE_RANGE)).toBeNull();
    expect(rayHitsFighter(0, 1, 0, -1, 0, 0, target, FIRE_RANGE)).toBeNull();
  });

  it("terrain shields fighters (wall between shooter and target)", () => {
    const world = new VoxelWorld();
    const stone = blockByKey("stone")!.id;
    for (let y = 0; y < 6; y++) world.set(5, y, 0, stone); // wall column at x=5
    const fighters = [fighter(0, 1, 0.5), fighter(10, 1, 0.5)];
    const shot = resolveShot(world, 0.5, 2.5, 0.5, 1, 0, 0, fighters, 0);
    expect(shot.kind).toBe("block");
  });

  it("closest live fighter wins; dead ones are ignored", () => {
    const world = new VoxelWorld();
    const fighters = [fighter(0, 0, 0.5), fighter(8, 0, 0.5, 0), fighter(14, 0, 0.5)];
    const shot = resolveShot(world, 0.5, 1.5, 0.5, 1, 0, 0, fighters, 0);
    expect(shot.kind).toBe("fighter");
    expect(shot.index).toBe(2); // the dead fighter at x=8 doesn't block
  });

  it("line of sight respects walls", () => {
    const world = new VoxelWorld();
    const stone = blockByKey("stone")!.id;
    expect(hasLineOfSight(world, fighter(0, 1, 0.5), fighter(10, 1, 0.5))).toBe(true);
    for (let y = 0; y < 8; y++) world.set(5, y, 0, stone);
    expect(hasLineOfSight(world, fighter(0.5, 1, 0.5), fighter(10.5, 1, 0.5))).toBe(false);
  });
});

describe("bots", () => {
  const flatWorld = () => {
    const world = new VoxelWorld();
    const stone = blockByKey("stone")!.id;
    for (let x = 0; x < WORLD_X; x++) for (let z = 0; z < WORLD_Z; z++) world.set(x, 3, z, stone);
    return world;
  };

  it("runs toward the zone center when caught outside", () => {
    const world = flatWorld();
    const bot = makeBot(1, 40.5, 4, 24.5);
    const fighters = [fighter(5, 4, 5), botFighter(bot)];
    const before = Math.hypot(bot.body.x - 24, bot.body.z - 24);
    for (let i = 0; i < 120; i++) {
      stepBot(world, bot, fighters, { cx: 24, cz: 24, radius: 6 }, 1 / 60, () => 0.5);
    }
    const after = Math.hypot(bot.body.x - 24, bot.body.z - 24);
    expect(after).toBeLessThan(before - 2);
  });

  it("fires at a visible enemy in range (deterministic rng)", () => {
    const world = flatWorld();
    const bot = makeBot(1, 24.5, 4, 24.5);
    bot.cooldown = 0;
    const enemy = fighter(30.5, 4, 24.5);
    const fighters = [enemy, botFighter(bot)];
    let shot = null;
    for (let i = 0; i < 240 && !shot; i++) {
      shot = stepBot(world, bot, fighters, { cx: 24, cz: 24, radius: 30 }, 1 / 60, () => 0.5);
    }
    expect(shot).not.toBeNull();
    if (!shot) return;
    expect(shot.shooter).toBe(1);
    // roughly toward +x
    expect(shot.dx).toBeGreaterThan(0.8);
  });

  it("dead bots do nothing", () => {
    const world = flatWorld();
    const bot = makeBot(1, 24.5, 4, 24.5);
    bot.hp = 0;
    const moved = stepBot(world, bot, [fighter(30, 4, 24)], { cx: 24, cz: 24, radius: 30 }, 1 / 60, () => 0.5);
    expect(moved).toBeNull();
  });
});
