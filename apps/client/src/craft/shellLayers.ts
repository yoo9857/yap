import * as THREE from "three";
import { kitFootprintGeometry } from "./kitShell.js";

/**
 * A block's joined shell in one chunk, built a LAYER at a time and remembered.
 *
 * `kitCellsGeometry` builds the shell of every y-layer and joins them; a layer depends only on its
 * own cells, on what is joined beside them, and on what stands directly over and under them. So
 * when one cell changes — a block mined, set down, or swapped for its cracked copy while it is
 * being dug — only that layer and the ones above and below change: the rest of the shell is the
 * same numbers as before.
 *
 * Why it matters: digging swaps the aimed block for a cracked copy (the chunk is rebuilt so the
 * whole block is gone from the shell), swaps it back when the aim moves on, and rebuilds once more
 * when it breaks. At the island's castle one such rebuild made every stone brick of the chunk again,
 * 44–50 ms each (2026-11-16: "sweeping the view while breaking blocks at the castle lags badly").
 *
 * The result is bit for bit what `kitCellsGeometry(cells, false, joined)` gives
 * (test/shell-layers.test.ts), so the Rust twin and its parity test are untouched.
 */
export interface ShellLayer {
  /** The layer's cells as x, z pairs in list order: a remembered layer is reused only for the same cells. */
  xz: Int16Array;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  uv: Float32Array;
}

export interface LayeredShell {
  geometry: THREE.BufferGeometry;
  /** Every layer of this build, to hand back next time. */
  layers: Map<number, ShellLayer>;
  /** How many layers had to be made (the others were remembered). */
  made: number;
}

const sameCells = (a: Int16Array, b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * @param list   the block's exposed full-cube cells in the chunk: x, y, z, x, y, z, …
 * @param joined is (x, y, z) a solid full cube the shell runs on into (any block)?
 * @param remembered the layers of the previous build of this same block and chunk, or null
 * @param dirty  the layers whose surroundings changed since then (a changed cell's own layer and
 *               the ones above and below); null = nothing is known, make everything
 */
export function layeredShell(
  list: readonly number[],
  joined: (x: number, y: number, z: number) => boolean,
  remembered: ReadonlyMap<number, ShellLayer> | null,
  dirty: ReadonlySet<number> | null,
): LayeredShell {
  // layers in the order their y first appears, cells in list order: the order kitCellsGeometry joins them in
  const byY = new Map<number, number[]>();
  for (let i = 0; i < list.length; i += 3) {
    const y = list[i + 1]!;
    let xz = byY.get(y);
    if (!xz) byY.set(y, (xz = []));
    xz.push(list[i]!, list[i + 2]!);
  }
  // "is one of THIS shell's cells directly over / under?": kitCellsGeometry asks its own cells first
  const sets = new Map<number, Set<number>>();
  const own = (x: number, y: number, z: number): boolean => {
    let set = sets.get(y);
    if (!set) {
      set = new Set();
      const xz = byY.get(y);
      if (xz) for (let i = 0; i < xz.length; i += 2) set.add(xz[i]! * 65536 + xz[i + 1]!);
      sets.set(y, set);
    }
    return set.has(x * 65536 + z);
  };
  const layers = new Map<number, ShellLayer>();
  let made = 0, vertices = 0;
  for (const [y, xz] of byY) {
    let layer = remembered && dirty && !dirty.has(y) ? remembered.get(y) : undefined;
    if (layer && !sameCells(layer.xz, xz)) layer = undefined;
    if (!layer) {
      const cells: [number, number][] = [];
      for (let i = 0; i < xz.length; i += 2) cells.push([xz[i]!, xz[i + 1]!]);
      const g = kitFootprintGeometry(cells, (x, z) => joined(x, y, z), (x, z, dy) => own(x, y + dy, z) || joined(x, y + dy, z));
      g.translate(0, y, 0);
      layer = {
        xz: Int16Array.from(xz),
        position: g.getAttribute("position").array as Float32Array,
        normal: g.getAttribute("normal").array as Float32Array,
        color: g.getAttribute("color").array as Float32Array,
        uv: g.getAttribute("uv").array as Float32Array,
      };
      g.dispose();
      made++;
    }
    layers.set(y, layer);
    vertices += layer.position.length / 3;
  }
  const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), color = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2);
  let at = 0;
  for (const layer of layers.values()) {
    position.set(layer.position, at * 3);
    normal.set(layer.normal, at * 3);
    color.set(layer.color, at * 3);
    uv.set(layer.uv, at * 2);
    at += layer.position.length / 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, layers, made };
}
