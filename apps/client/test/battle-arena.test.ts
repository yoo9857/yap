import { describe, it, expect } from "vitest";
import { generateIsland, surfaceY } from "../src/craft/voxelWorld.js";
import { pickArena } from "../src/battle/arena.js";
import { ZONE_PHASES, ZONE_START_RADIUS } from "../src/battle/zone.js";

/** Columns reachable from (sx,sz) by ≤ 1-block steps — the bots' hop. */
function reachable(world: ReturnType<typeof generateIsland>, sx: number, sz: number): Set<number> {
  const key = (x: number, z: number) => x + z * 1000;
  const seen = new Set([key(sx, sz)]);
  const stack: [number, number][] = [[sx, sz]];
  while (stack.length) {
    const [x, z] = stack.pop()!;
    const h = surfaceY(world, x, z);
    for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]] as const) {
      if (nx < 0 || nz < 0 || nx >= 160 || nz >= 160 || seen.has(key(nx, nz))) continue;
      const nh = surfaceY(world, nx, nz);
      if (nh <= 0 || Math.abs(nh - h) > 1) continue;
      seen.add(key(nx, nz));
      stack.push([nx, nz]);
    }
  }
  return seen;
}

describe("battle arena", () => {
  for (const seed of [12345, 777, 424242, 1]) {
    it(`puts the final circle on ground every spawn can walk to (seed ${seed})`, () => {
      const world = generateIsland(seed);
      const arena = pickArena(world, 8, ZONE_START_RADIUS * 0.82);
      expect(arena.spawns).toHaveLength(8);
      const from = reachable(world, Math.floor(arena.cx), Math.floor(arena.cz));
      const final = ZONE_PHASES.at(-1)!.to;
      for (let dz = -final; dz <= final; dz++)
        for (let dx = -final; dx <= final; dx++)
          expect(from.has(Math.floor(arena.cx) + dx + (Math.floor(arena.cz) + dz) * 1000)).toBe(true);
      for (const [x, z] of arena.spawns) {
        expect(from.has(Math.floor(x) + Math.floor(z) * 1000)).toBe(true);
        expect(Math.hypot(x - arena.cx, z - arena.cz)).toBeLessThan(ZONE_START_RADIUS);
      }
    });
  }
});
