import type { FurnitureDef } from "./types.js";

/**
 * Pure geometry shared by placement, rendering and aiming: which cells a piece
 * fills, where its model goes, which way it faces, and its bounding box.
 * Unit-tested; the renderer and the rules must agree on all of it or a sofa
 * hangs half outside its collider.
 */

/**
 * Rotate a cell offset by `rot` quarter turns the same way three.js turns an
 * object by `rot * 90°` about +y: (x, z) → (z, −x). Keeping the two in step is
 * what makes the model land exactly on the cells that collide.
 */
export function turn(x: number, z: number, rot: number): [number, number] {
  let a = x;
  let b = z;
  for (let i = 0; i < (rot & 3); i++) [a, b] = [b, -a];
  // -0 would leak into keys and comparisons as a distinct-looking value
  return [a + 0, b + 0];
}

/** Every cell a piece fills, as offsets from its anchor. */
export function footprintOffsets(def: FurnitureDef, rot: number): [number, number, number][] {
  const { w, d, h } = def.size;
  const out: [number, number, number][] = [];
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < d; j++) {
      const [ox, oz] = turn(i, j, rot);
      for (let k = 0; k < h; k++) out.push([ox, k, oz]);
    }
  }
  return out;
}

/**
 * Where the model's origin goes, relative to the anchor cell's min corner:
 * the centre of the footprint, at floor level. Models are built centred on
 * their footprint, so turning one about this point covers exactly the cells
 * `footprintOffsets` lists.
 */
export function footprintCenter(def: FurnitureDef, rot: number): [number, number] {
  const [cx, cz] = turn((def.size.w - 1) / 2, (def.size.d - 1) / 2, rot);
  return [cx + 0.5, cz + 0.5];
}

/** The direction a piece's front faces after `rot` turns (local +z). */
export const frontOf = (rot: number): [number, number] => turn(0, 1, rot);

/**
 * The quarter turn that points a piece's front at the player: placing a sofa
 * should never leave its back to you. `yaw` is the player's view yaw (they
 * look along (sin yaw, cos yaw)).
 */
export function rotFacing(yaw: number): number {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let best = 0;
  let bestDot = -Infinity;
  for (let rot = 0; rot < 4; rot++) {
    const [x, z] = frontOf(rot);
    const dot = x * fx + z * fz;
    if (dot > bestDot) {
      bestDot = dot;
      best = rot;
    }
  }
  return best;
}

/**
 * Wall pieces face away from the block they hang on. Given the hit face's
 * normal (the empty cell minus the wall cell), the turn that faces it; null
 * when the face is a floor or ceiling, where nothing hangs.
 */
export function rotFromNormal(nx: number, ny: number, nz: number): number | null {
  if (ny !== 0) return null;
  for (let rot = 0; rot < 4; rot++) {
    const [x, z] = frontOf(rot);
    if (x === nx && z === nz) return rot;
  }
  return null;
}

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

const localCache = new WeakMap<FurnitureDef, Box>();

/**
 * Rotate a point by Euler angles the way three.js does for its default 'XYZ'
 * order (the matrix is Rx·Ry·Rz, so z is applied first). Kept here, three-free,
 * so bounds and tests agree with what the renderer draws.
 */
export function rotateEuler(v: readonly [number, number, number], r: readonly [number, number, number]): [number, number, number] {
  let [x, y, z] = v;
  const [rx, ry, rz] = r;
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}

/** The model's bounding box in its own space, from its parts (a rotated part
 *  contributes the box around its eight turned corners — conservative for
 *  round shapes, exact for bricks). */
export function localBounds(def: FurnitureDef): Box {
  let box = localCache.get(def);
  if (box) return box;
  box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  // both looks of a door/gate/curtain: aiming and the fit test cover either
  for (const p of [...def.parts, ...(def.openParts ?? [])]) {
    const [hw, hh, hd] = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const corner: [number, number, number] = [sx * hw, sy * hh, sz * hd];
          const [cx, cy, cz] = p.rot ? rotateEuler(corner, p.rot) : corner;
          const at = [p.at[0] + cx, p.at[1] + cy, p.at[2] + cz];
          for (let a = 0; a < 3; a++) {
            box.min[a] = Math.min(box.min[a]!, at[a]!);
            box.max[a] = Math.max(box.max[a]!, at[a]!);
          }
        }
      }
    }
  }
  localCache.set(def, box);
  return box;
}

/**
 * The model's box in world cells: turned by `rot`, its origin at the anchor
 * cell + `footprintCenter`, lifted by `elevation` (a surface piece's host top).
 */
export function placedBounds(def: FurnitureDef, ax: number, ay: number, az: number, rot: number, elevation: number): Box {
  const local = localBounds(def);
  const [cx, cz] = footprintCenter(def, rot);
  const [x0, z0] = turn(local.min[0], local.min[2], rot);
  const [x1, z1] = turn(local.max[0], local.max[2], rot);
  return {
    min: [ax + cx + Math.min(x0, x1), ay + elevation + local.min[1], az + cz + Math.min(z0, z1)],
    max: [ax + cx + Math.max(x0, x1), ay + elevation + local.max[1], az + cz + Math.max(z0, z1)],
  };
}

/** Slab test: distance along a (unit) ray to the box, or null on a miss. */
export function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: Box,
): number | null {
  let near = 0;
  let far = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    const da = d[a]!;
    if (Math.abs(da) < 1e-9) {
      if (o[a]! < box.min[a]! || o[a]! > box.max[a]!) return null;
      continue;
    }
    let t0 = (box.min[a]! - o[a]!) / da;
    let t1 = (box.max[a]! - o[a]!) / da;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  return near;
}

const partBoxCache = new WeakMap<FurnitureDef, { closed: Box[]; open: Box[] }>();

/** One local-space box per part (a turned part: the box round its corners). */
function partBoxes(def: FurnitureDef, open: boolean): Box[] {
  let cached = partBoxCache.get(def);
  if (!cached) {
    const boxesOf = (parts: FurnitureDef["parts"]): Box[] =>
      parts.map((p) => {
        const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        const [hw, hh, hd] = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
              const corner: [number, number, number] = [sx * hw, sy * hh, sz * hd];
              const [cx, cy, cz] = p.rot ? rotateEuler(corner, p.rot) : corner;
              const at = [p.at[0] + cx, p.at[1] + cy, p.at[2] + cz];
              for (let a = 0; a < 3; a++) {
                box.min[a] = Math.min(box.min[a]!, at[a]!);
                box.max[a] = Math.max(box.max[a]!, at[a]!);
              }
            }
          }
        }
        return box;
      });
    cached = { closed: boxesOf(def.parts), open: boxesOf(def.openParts ?? def.parts) };
    partBoxCache.set(def, cached);
  }
  return open ? cached.open : cached.closed;
}

/**
 * Distance along a unit ray to the nearest PART of a placed piece, or null.
 * The ray is brought into the piece's own space (undoing its quarter turns and
 * lift) and tested against each part, so an open door is hit on its posts,
 * lintel and leaf — not across the empty doorway — and a chair is not hit in
 * the air between its legs. Hits from inside a part (t = 0) are ignored: an
 * eye inside a wall lamp's shade would otherwise "aim" at it in every direction.
 */
export function rayPiece(
  def: FurnitureDef,
  open: boolean,
  ax: number, ay: number, az: number,
  rot: number,
  elevation: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number | null {
  const [cx, cz] = footprintCenter(def, rot);
  const back = (4 - (rot & 3)) & 3;
  const [lox, loz] = turn(ox - (ax + cx), oz - (az + cz), back);
  const [ldx, ldz] = turn(dx, dz, back);
  const loy = oy - (ay + elevation);
  let best: number | null = null;
  for (const box of partBoxes(def, open)) {
    const t = rayBox(lox, loy, loz, ldx, dy, ldz, box);
    if (t !== null && t > 1e-4 && (best === null || t < best)) best = t;
  }
  return best;
}
