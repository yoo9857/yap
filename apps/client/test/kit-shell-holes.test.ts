import { describe, expect, it } from "vitest";
import { kitCellsGeometry } from "../src/craft/kitShell.js";

/** Area of upward-facing triangles (the brick tops) — a missing triangle is a hole. */
function topArea(cells: [number, number, number][], solid: (x: number, y: number, z: number) => boolean): number {
  const g = kitCellsGeometry(cells, false, solid);
  const p = g.getAttribute("position");
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  let area = 0;
  const at = (i: number) => (idx ? idx.getX(i) : i);
  for (let i = 0; i < n; i += 3) {
    const a = at(i), b = at(i + 1), c = at(i + 2);
    const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
    const vx = p.getX(c) - p.getX(a), vy = p.getY(c) - p.getY(a), vz = p.getZ(c) - p.getZ(a);
    const ny = uz * vx - ux * vz; // y of the cross product
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
    if (len > 0 && ny / len > 0.99 && Math.min(p.getY(a), p.getY(b), p.getY(c)) > 0.9) area += len / 2;
  }
  return area;
}

/** Every layout of one material's cells next to OTHER solid cells (the "two different blocks" case). */
describe("brick tops have no holes beside a different block", () => {
  const layouts: [string, [number, number, number][], [number, number, number][]][] = [
    ["one cell, other block east", [[0, 0, 0]], [[1, 0, 0]]],
    ["one cell, others east and north", [[0, 0, 0]], [[1, 0, 0], [0, 0, 1]]],
    ["two in a row, other block at one end", [[0, 0, 0], [1, 0, 0]], [[2, 0, 0]]],
    ["two in a row, other block alongside one", [[0, 0, 0], [1, 0, 0]], [[0, 0, 1]]],
    ["L of three, other block in the elbow", [[0, 0, 0], [1, 0, 0], [0, 0, 1]], [[1, 0, 1]]],
    ["checker", [[0, 0, 0], [1, 0, 1]], [[1, 0, 0], [0, 0, 1]]],
    ["row with others on both sides", [[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[1, 0, 1], [1, 0, -1], [3, 0, 0]]],
  ];
  for (const [name, mine, others] of layouts) {
    it(name, () => {
      const solid = new Set([...mine, ...others].map((c) => c.join(",")));
      const area = topArea(mine, (x, y, z) => solid.has([x, y, z].join(",")));
      // each 1 m cell's top is ~1 m² (minus a bevel of a couple of cm at open edges)
      expect(area, `${name}: top area`).toBeGreaterThan(mine.length * 0.9);
    });
  }
});
