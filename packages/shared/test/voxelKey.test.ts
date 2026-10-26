import { describe, expect, it } from "vitest";
import { voxelCoordinates, voxelKey } from "../src/voxelKey.js";

describe("compact voxel keys", () => {
  it("round-trips boundaries and distant field coordinates without collisions", () => {
    const keys = new Set<number | string>();
    for (const x of [-3_000_000, -2_097_152, -1_000_001, -1, 0, 1, 1_000_001, 2_097_151, 3_000_000])
      for (const y of [-129, -128, -1, 0, 55, 127, 128])
        for (const z of [-2_097_153, -1_000_001, -1, 0, 1, 1_000_001, 2_097_151]) {
          const key = voxelKey(x, y, z);
          expect(keys.has(key)).toBe(false); keys.add(key);
          expect(voxelCoordinates(key)).toEqual([x, y, z]);
          if (typeof key === "number") expect(Number.isSafeInteger(key)).toBe(true);
        }
  });
});
