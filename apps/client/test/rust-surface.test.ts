// Block surfaces on the Rust engine (surface.rs) must equal blockMaterials.ts: the family of every
// catalog block (surfaceStyle) and every byte of every family's colour / normal / roughness map.
import { loadRustEngineSync } from "@robo/engine/node";
import { describe, expect, it, vi } from "vitest";
import { createMaterialMaps, surfaceStyle } from "../src/craft/blockMaterials.js";
import { BLOCKS } from "../src/craft/blocks.js";

vi.mock("../src/render/textures.js", () => ({ loadTexture: () => Promise.resolve(null) }));
vi.mock("../src/craft/generatedBlockTextures.js", () => ({ GENERATED_BLOCK_TEXTURES: {} }));
const engine = loadRustEngineSync();
const FAMILIES = ["coat", "snow", "grass", "dirt", "gem", "ore", "wood", "wool", "sand", "metal", "glass", "stone", "grass-side"] as const;

describe("block surfaces: Rust = TypeScript (blockMaterials.ts)", () => {
  it("every catalog block has the same surface family", () => {
    for (const b of [...BLOCKS.map((d) => d.key), "coat"]) expect(engine.surface_family(b), b).toBe(surfaceStyle(b).family);
  });
  for (const family of FAMILIES) {
    it(`${family}: colour, normal and roughness maps byte for byte`, () => {
      const ts = createMaterialMaps(family, 128);
      const rs = engine.material_maps(family, 128);
      const n = 128 * 128 * 4;
      const parts = [["colour", ts.map], ["normal", ts.normal], ["roughness", ts.roughness]] as const;
      parts.forEach(([name, tex], k) => {
        const a = tex.image.data as Uint8Array, b = rs.subarray(k * n, (k + 1) * n);
        let diff = -1;
        for (let i = 0; i < n; i++) if (a[i] !== b[i]) { diff = i; break; }
        expect(diff, diff < 0 ? "" : `${name}[${diff}]: ts ${a[diff]} rust ${b[diff]}`).toBe(-1);
      });
    });
  }
});
