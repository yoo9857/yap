// Brick shell speed, TypeScript vs Rust, on terrain-like chunks (RUST_BENCH=1, `pnpm engine:bench`).
import { loadRustEngineSync } from "@robo/engine/node";
import { describe, expect, it } from "vitest";
import { kitCellsGeometry } from "../src/craft/kitShell.js";
import { kitCellsGeometryRust } from "../src/craft/kitRust.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe.skipIf(!process.env.RUST_BENCH)("brick shells: speed", () => {
  it("terrain chunks (two bumpy layers, 16x16)", () => {
    const engine = loadRustEngineSync();
    const scenes = Array.from({ length: 30 }, (_, s) => {
      const r = rng(s), cells: [number, number, number][] = [], own = new Uint8Array(18 * 18 * 10);
      const at = (x: number, y: number, z: number) => ((y + 1) * 18 + z + 1) * 18 + x + 1;
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const top = 3 + Math.floor(r() * 3);
        for (let y = top - 1; y <= top; y++) { cells.push([x, y, z]); own[at(x, y, z)] = 1; }
      }
      const joined = (x: number, y: number, z: number) => y < 2 || (x >= -1 && x <= 16 && z >= -1 && z <= 16 && y >= -1 && y <= 8 && own[at(x, y, z)] === 1);
      return { cells, joined };
    });
    const time = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };
    for (const s of scenes) { kitCellsGeometry(s.cells, false, s.joined); kitCellsGeometryRust(engine, s.cells, s.joined); } // warm up
    const ts = time(() => { for (const s of scenes) kitCellsGeometry(s.cells, false, s.joined); });
    const rs = time(() => { for (const s of scenes) kitCellsGeometryRust(engine, s.cells, s.joined); });
    console.log(`brick shells per chunk: TypeScript ${(ts / scenes.length).toFixed(2)} ms, Rust ${(rs / scenes.length).toFixed(2)} ms (${(ts / rs).toFixed(1)}x)`);
    expect(rs).toBeLessThan(ts);
  }, 120_000);
});
