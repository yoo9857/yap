import * as THREE from "three";
import type { RustEngine } from "../engine/rustEngine.js";

/**
 * `kitCellsGeometry(cells, false, joined)` (kitShell.ts) on the Rust engine: the same float32
 * attributes bit for bit (`test/rust-kit.test.ts`). `joined` is asked once per cell of the cells'
 * box grown by one (every neighbour the shell looks at) and handed over as a mask, so Rust never
 * calls back into JavaScript. Returns null if Rust met an open contour (the TypeScript throws).
 */
export function kitCellsGeometryRust(engine: RustEngine, cells: readonly (readonly [number, number, number])[], joined: (x: number, y: number, z: number) => boolean): THREE.BufferGeometry | null {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const flat = new Int32Array(cells.length * 3);
  for (let i = 0; i < cells.length; i++) {
    const [x, y, z] = cells[i]!;
    flat[i * 3] = x; flat[i * 3 + 1] = y; flat[i * 3 + 2] = z;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  x0--; y0--; z0--; x1++; y1++; z1++;
  const sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1;
  const mask = new Uint8Array(sx * sy * sz);
  for (let y = 0, i = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++, i++) mask[i] = joined(x0 + x, y0 + y, z0 + z) ? 1 : 0;
  return fromPacked(engine.kit_cells_geometry(flat, mask, x0, y0, z0, sx, sy, sz));
}

/** [count, misses, positions, normals, colours, uvs] → a BufferGeometry like kitCellsGeometry's. */
function fromPacked(out: Float32Array): THREE.BufferGeometry | null {
  const n = out[0]!;
  if (n < 0 || out[1] !== 0) return null;
  let at = 2;
  const take = (size: number) => { const a = out.subarray(at, at + n * size); at += n * size; return a; };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(take(3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(take(3), 3));
  g.setAttribute("color", new THREE.BufferAttribute(take(3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(take(2), 2));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
