// World generation on the Rust engine (world.rs) must build EXACTLY the island generateIsland
// builds: every cell, for several seeds (the island, the castle, the mainland town, trees, ores).
import { loadRustEngineSync } from "@robo/engine/node";
import { describe, expect, it } from "vitest";
import { generateIsland } from "../src/craft/voxelWorld.js";

const engine = loadRustEngineSync();

describe("world generation: Rust = TypeScript (generateIsland)", () => {
  for (const seed of [20260718, 12345, 1, 0, 987654321, 4294967295, -77, 2 ** 31 + 5]) { // 20260718: the game's default island
    it(`seed ${seed}`, () => {
      const ts = generateIsland(seed).cells;
      const rs = engine.generate_island(seed);
      expect(rs.length).toBe(ts.length);
      let diff = -1;
      for (let i = 0; i < ts.length; i++) if (ts[i] !== rs[i]) { diff = i; break; }
      expect(diff, diff < 0 ? "" : `first difference at cell ${diff}: ts ${ts[diff]} rust ${rs[diff]}`).toBe(-1);
    });
  }
});
