import { describe, expect, it } from "vitest";
import { kitCellsGeometry } from "../src/craft/kitShell.js";
import { layeredShell, type ShellLayer } from "../src/craft/shellLayers.js";

/**
 * A chunk's joined shell remembered layer by layer (shellLayers.ts) must be, to the bit, the shell
 * kitCellsGeometry builds whole — after any run of single-cell changes, with only the changed
 * cell's layer and the ones above and below made again.
 */
const random = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;

function world(seed: number, fill: number) {
  const rng = random(seed), solid = new Set<number>(), id = (x: number, y: number, z: number) => (y * 32 + z) * 32 + x;
  for (let y = 0; y < 7; y++) for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) if (rng() < fill) solid.add(id(x, y, z));
  const joined = (x: number, y: number, z: number) => x >= 0 && z >= 0 && y >= 0 && x < 32 && z < 32 && solid.has(id(x, y, z));
  // the view lists a block's cells in scan order (x, then z, then y) and only those with an open side
  const list = (): number[] => {
    const out: number[] = [];
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < 7; y++) {
      if (!solid.has(id(x, y, z))) continue;
      const open = !joined(x + 1, y, z) || !joined(x - 1, y, z) || !joined(x, y + 1, z) || !joined(x, y - 1, z) || !joined(x, y, z + 1) || !joined(x, y, z - 1);
      if (open) out.push(x, y, z);
    }
    return out;
  };
  return { solid, id, joined, list, rng };
}

const whole = (list: number[], joined: (x: number, y: number, z: number) => boolean) => {
  const cells: [number, number, number][] = [];
  for (let i = 0; i < list.length; i += 3) cells.push([list[i]!, list[i + 1]!, list[i + 2]!]);
  return kitCellsGeometry(cells, false, joined);
};
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const equal = (a: ReturnType<typeof whole>, b: ReturnType<typeof whole>): boolean =>
  (["position", "normal", "color", "uv"] as const).every((name) => same(a.getAttribute(name).array, b.getAttribute(name).array));

describe("a joined shell built a layer at a time", () => {
  it("is the whole shell, bit for bit, on random worlds", () => {
    for (const [seed, fill] of [[1, 0.9], [2, 0.6], [3, 0.35], [4, 1]] as const) {
      const w = world(seed, fill), list = w.list();
      expect(equal(layeredShell(list, w.joined, null, null).geometry, whole(list, w.joined)), `seed ${seed}`).toBe(true);
    }
  });

  it("stays the whole shell through a run of single-cell changes, making at most three layers each", () => {
    const w = world(7, 0.85);
    let remembered: Map<number, ShellLayer> | null = layeredShell(w.list(), w.joined, null, null).layers;
    for (let step = 0; step < 24; step++) {
      const x = Math.floor(w.rng() * 12), y = Math.floor(w.rng() * 7), z = Math.floor(w.rng() * 12), cell = w.id(x, y, z);
      if (w.solid.has(cell)) w.solid.delete(cell); else w.solid.add(cell); // mined, or set down
      const list = w.list(), built = layeredShell(list, w.joined, remembered, new Set([y - 1, y, y + 1]));
      expect(equal(built.geometry, whole(list, w.joined)), `step ${step} at ${x},${y},${z}`).toBe(true);
      expect(built.made).toBeLessThanOrEqual(3);
      remembered = built.layers;
    }
  }, 60_000);

  it("makes everything again when nothing is known of what changed", () => {
    const w = world(9, 0.8), list = w.list(), first = layeredShell(list, w.joined, null, null);
    expect(layeredShell(list, w.joined, first.layers, null).made).toBe(first.layers.size);
    expect(layeredShell(list, w.joined, first.layers, new Set()).made).toBe(0);
  });
});
