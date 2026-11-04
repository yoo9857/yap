// The brick shell on the Rust engine (`kit.rs`) must equal kitShell.ts's `kitCellsGeometry(cells,
// false, joined)` BIT FOR BIT: every float32 of positions, normals, colours and UVs, in order.
// Random blobs of cells (holes, overhangs, stacks) inside a world of other solid cubes (joined).
import { loadRustEngineSync } from "@robo/engine/node";
import { describe, expect, it } from "vitest";
import { kitCellsGeometry } from "../src/craft/kitShell.js";
import { kitCellsGeometryRust } from "../src/craft/kitRust.js";

const engine = loadRustEngineSync();

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function bitsEqual(a: ArrayLike<number>, b: ArrayLike<number>, label: string) {
  expect(b.length, `${label} length`).toBe(a.length);
  const fa = new Float32Array(a), fb = new Float32Array(b);
  const ua = new Uint32Array(fa.buffer), ub = new Uint32Array(fb.buffer);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) throw new Error(`${label}[${i}]: ts ${fa[i]} rust ${fb[i]}`);
}

function scene(seed: number) {
  const r = rng(seed);
  const cells: [number, number, number][] = [];
  const own = new Set<string>(), other = new Set<string>();
  const ox = Math.floor(r() * 140), oz = Math.floor(r() * 140), oy = 2 + Math.floor(r() * 30);
  const fill = 0.25 + r() * 0.6, h = 1 + Math.floor(r() * 5);
  for (let y = 0; y < h; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const k = `${ox + x},${oy + y},${oz + z}`;
    const v = r();
    if (v < fill) { cells.push([ox + x, oy + y, oz + z]); own.add(k); }
    else if (v < fill + 0.15) other.add(k); // a different block: joined, not part of this shell
  }
  // neighbours outside the chunk and above/below
  for (let i = 0; i < 40; i++) other.add(`${ox - 1 + Math.floor(r() * 18)},${oy - 1 + Math.floor(r() * (h + 2))},${oz - 1 + Math.floor(r() * 18)}`);
  const joined = (x: number, y: number, z: number) => own.has(`${x},${y},${z}`) || other.has(`${x},${y},${z}`);
  return { cells, joined };
}

describe("brick shells: Rust = TypeScript (kitCellsGeometry)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => {
      const { cells, joined } = scene(seed);
      if (cells.length === 0) return;
      const ts = kitCellsGeometry(cells, false, joined);
      const rs = kitCellsGeometryRust(engine, cells, joined);
      expect(rs, "Rust built a shell").not.toBeNull();
      for (const name of ["position", "normal", "color", "uv"] as const) bitsEqual(ts.getAttribute(name).array, rs!.getAttribute(name).array, name);
    });
  }

  it("single cells, lines, rings and a hollow box", () => {
    const shapes: [number, number, number][][] = [
      [[5, 3, 5]],
      [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]],
      [[0, 1, 0], [1, 1, 0], [2, 1, 0], [0, 1, 1], [2, 1, 1], [0, 1, 2], [1, 1, 2], [2, 1, 2]],
    ];
    const box: [number, number, number][] = [];
    for (let y = 0; y < 4; y++) for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) if (y === 0 || y === 3 || x === 0 || x === 5 || z === 0 || z === 5) box.push([x + 20, y + 10, z + 30]);
    shapes.push(box);
    for (const cells of shapes) {
      const set = new Set(cells.map((c) => c.join(",")));
      const joined = (x: number, y: number, z: number) => set.has(`${x},${y},${z}`);
      const ts = kitCellsGeometry(cells, false, joined), rs = kitCellsGeometryRust(engine, cells, joined)!;
      for (const name of ["position", "normal", "color", "uv"] as const) bitsEqual(ts.getAttribute(name).array, rs.getAttribute(name).array, name);
    }
  });
});
