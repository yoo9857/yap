import * as THREE from "three";
import { WATER_FALLING, isWater, waterHeight, waterLevel } from "@robo/shared";
import { SOLID_ID } from "./blocks.js";
import type { VoxelWorld } from "./voxelWorld.js";

type World = Pick<VoxelWorld, "get">;
type V3 = [number, number, number];
interface Node {
  id: number;
  p: V3; n: V3; grid: [number, number, number, number];
  wave: number; wet: number; foam: number; depth: number; flow: V3; impact: V3;
}
const CORNERS: V3[] = Array.from({ length: 8 }, (_, i) => [i & 1, i >> 1 & 1, i >> 2 & 1]);
const EDGES: [number, number, number][] = [];
for (let i = 0; i < 8; i++) for (let axis = 0; axis < 3; axis++)
  if (!(i & 1 << axis)) EDGES.push([i, i | 1 << axis, axis]);
const DIRECTIONS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const HORIZONTAL = [DIRECTIONS[0]!, DIRECTIONS[1]!, DIRECTIONS[4]!, DIRECTIONS[5]!];
const cellKey = (x: number, y: number, z: number) => ((y + 2) * 164 + z + 2) * 164 + x + 2;
const normalize = (n: V3): V3 => { const k = Math.hypot(...n); return k > 0.00001 ? [n[0] / k, n[1] / k, n[2] / k] : [0, 1, 0]; };
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Component-aware surface nets on the voxel-centre lattice. Every visible
 * boundary face references four globally defined nodes. The same node/edge
 * is identical in adjacent chunks: terrain edits cannot separate a lip, fall
 * and pool into independent transparent plates.
 *
 * Separate components in an ambiguous cube keep diagonally touching streams
 * apart. Solid-contact constraints keep the surface on walls/floors, while
 * unconstrained edges round off naturally. Curved edges are tessellated on
 * BOTH incident faces using the same tangent projection (no T-junctions).
 */
export function buildWaterGeometry(world: World, cells: readonly number[]): THREE.BufferGeometry | null {
  const cache = new Map<number, (Node | undefined)[]>();
  let sequence = 0;
  const attribute: Record<string, number[]> = { position: [], normal: [], aWave: [], aWet: [], aFoam: [],
    aDepth: [], aFlow: [], aImpact: [], aGrid: [] };
  const indices: number[] = [], vertexIndices = new Map<Node, number>();
  const edgeCache = new Map<number, Node | null>();
  const solid = (x: number, y: number, z: number) => SOLID_ID[world.get(x, y, z)] === 1;
  const deeplyInsideSolid = (p: V3) => {
    const x = Math.floor(p[0]), y = Math.floor(p[1]), z = Math.floor(p[2]);
    return solid(x, y, z) && p[0] - x > 0.002 && p[1] - y > 0.002 && p[2] - z > 0.002 &&
      p[0] - x < 0.998 && p[1] - y < 0.998 && p[2] - z < 0.998;
  };
  const depthCache = new Map<number, number>();
  const getDepth = (x: number, y: number, z: number) => {
    const key = cellKey(x, y, z), cached = depthCache.get(key);
    if (cached !== undefined) return cached;
    let d = waterHeight(world.get(x, y, z));
    for (let yy = y - 1; yy >= 0 && y - yy < 16 && isWater(world.get(x, yy, z)); yy--) d++;
    depthCache.set(key, d); return d;
  };
  const sampleCache = new Map<number, { depth: number; fx: number; fz: number; fall: number; impact: boolean }>();
  const sample = (x: number, y: number, z: number, id: number) => {
    const key = cellKey(x, y, z), cached = sampleCache.get(key);
    if (cached) return cached;
    let fx = 0, fz = 0;
    const level = waterLevel(id);
    for (const [sx, , sz] of HORIZONTAL) {
      const other = world.get(x + sx, y, z + sz);
      if (SOLID_ID[other] === 1) continue;
      const gradient = waterLevel(other) - level; fx += sx * gradient; fz += sz * gradient;
    }
    const below = world.get(x, y - 1, z);
    const impact = id === WATER_FALLING ? solid(x, y - 1, z) || isWater(below) && below !== WATER_FALLING
      : world.get(x, y + 1, z) === WATER_FALLING;
    const result = { depth: getDepth(x, y, z), fx, fz, fall: Number(id === WATER_FALLING), impact };
    sampleCache.set(key, result); return result;
  };
  const getNode = (cx: number, cy: number, cz: number, wx: number, wy: number, wz: number,
    ax: number, ay: number, az: number): Node => {
    const key = cellKey(cx, cy, cz);
    let groups = cache.get(key);
    if (!groups) {
      groups = new Array<Node | undefined>(64);
      const ids = CORNERS.map(([x, y, z]) => world.get(cx + x, cy + y, cz + z));
      let remaining = 0;
      for (let i = 0; i < 8; i++) if (isWater(ids[i]!)) remaining |= 1 << i;
      let air = 255 ^ remaining;
      const outsideGroups: number[] = [];
      while (air) {
        const queue = [31 - Math.clz32(air & -air)]; let mask = 0;
        for (let q = 0; q < queue.length; q++) {
          const i = queue[q]!; if (mask & 1 << i) continue; mask |= 1 << i;
          for (let axis = 0; axis < 3; axis++) { const j = i ^ 1 << axis; if (air & 1 << j && !(mask & 1 << j)) queue.push(j); }
        }
        outsideGroups.push(mask); air &= ~mask;
      }
      while (remaining) {
        const seed = 31 - Math.clz32(remaining & -remaining), queue = [seed];
        let mask = 0;
        for (let q = 0; q < queue.length; q++) {
          const i = queue[q]!;
          if (mask & 1 << i) continue;
          mask |= 1 << i;
          for (let axis = 0; axis < 3; axis++) { const j = i ^ 1 << axis; if (remaining & 1 << j && !(mask & 1 << j)) queue.push(j); }
        }
        remaining &= ~mask;
        for (const outsideMask of outsideGroups) {
        const points: V3[] = [], normal: V3 = [0, 0, 0], surfaceHeights: number[] = [];
        const constraints: (number | undefined)[] = [undefined, undefined, undefined];
        for (const [ia, ib, axis] of EDGES) {
          const wa = !!(mask & 1 << ia), wb = !!(mask & 1 << ib);
          if (wa === wb || isWater(ids[wa ? ib : ia]!)) continue;
          const wi = wa ? ia : ib, ai = wa ? ib : ia;
          if (!(outsideMask & 1 << ai)) continue;
          const a = CORNERS[wi]!, b = CORNERS[ai]!;
          const x = cx + a[0], y = cy + a[1], z = cz + a[2];
          const h = waterHeight(ids[wi]!, isWater(world.get(x, y + 1, z)));
          const p: V3 = [x + 0.5, y + h * 0.5, z + 0.5];
          const sign = b[axis]! - a[axis]!;
          if (axis === 1) p[1] = y + (sign > 0 ? h : 0);
          else p[axis] = p[axis]! + sign * 0.5;
          points.push(p);
          if (axis === 1 && sign > 0) surfaceHeights.push(p[1]);
          if (ids[ai] === 0 || axis === 1 && sign > 0 && h < 0.999) normal[axis] = normal[axis]! + sign;
          if (SOLID_ID[ids[ai]!] === 1) constraints[axis] = p[axis];
        }
        if (!points.length) continue;
        const p: V3 = [0, 0, 0];
        for (const point of points) for (let axis = 0; axis < 3; axis++) p[axis] = p[axis]! + point[axis]! / points.length;
        for (let axis = 0; axis < 3; axis++) if (constraints[axis] !== undefined) p[axis] = constraints[axis]!;
        // Contact with a vertical bank must not pull a flat pond down into
        // a deep artificial gutter. Keep its actual water level at the wall.
        if (normal[1] > 0 && normal[0] === 0 && normal[2] === 0 && surfaceHeights.length)
          p[1] = surfaceHeights.reduce((sum, h) => sum + h, 0) / surfaceHeights.length;
        if (deeplyInsideSolid(p)) {
          const safe = points.find((point) => !deeplyInsideSolid(point));
          if (safe) { p[0] = safe[0]; p[1] = safe[1]; p[2] = safe[2]; }
        }
        const n = normalize(normal);
        let count = 0, d = 0, fx = 0, fz = 0, falls = 0, foam = 0, ix = 0, iz = 0, impact = 0;
        const columns = new Set<number>();
        for (let i = 0; i < 8; i++) {
          const [dx, dy, dz] = CORNERS[i]!;
          if (isWater(ids[i]!) || SOLID_ID[ids[i]!] === 1) columns.add(dx * 2 + dz);
          if (!(mask & 1 << i)) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz, id = ids[i]!;
          const s = sample(x, y, z, id);
          count++; d += s.depth; falls += s.fall; fx += s.fx; fz += s.fz;
          if (s.impact) { ix += x + 0.5; iz += z + 0.5; impact++; }
        }
        const len = Math.hypot(fx, fz), scale = len ? Math.min(1, len / (count * 4)) / len : 0;
        foam = Math.min(1, impact / Math.max(1, count));
        const node: Node = { id: sequence++, p, n, grid: [cx, cy, cz, mask | outsideMask << 8], depth: d / count,
          wave: Math.max(0, n[1]) * Math.min(1, d / count * 3) * (1 - foam * 0.7),
          wet: columns.size / 4, foam, flow: [fx * scale, falls / count, fz * scale],
          impact: impact ? [ix / impact, iz / impact, Math.min(1, impact / 4)] : [0, 0, 0] };
        for (let i = 0; i < 8; i++) if (mask & 1 << i)
          for (let j = 0; j < 8; j++) if (outsideMask & 1 << j) groups[i * 8 + j] = node;
        }
      }
      cache.set(key, groups);
    }
    const i = (wx - cx) | (wy - cy) << 1 | (wz - cz) << 2;
    const j = (ax - cx) | (ay - cy) << 1 | (az - cz) << 2;
    const node = groups[i * 8 + j];
    if (!node) throw new Error("Missing connected water surface component");
    return node;
  };
  const blend = (a: Node, b: Node, p: V3, grid: Node["grid"]): Node => ({
    id: sequence++, p, grid, n: normalize(lerp3(a.n, b.n, 0.5)), flow: lerp3(a.flow, b.flow, 0.5),
    wave: (a.wave + b.wave) * 0.5, wet: (a.wet + b.wet) * 0.5, foam: (a.foam + b.foam) * 0.5,
    depth: (a.depth + b.depth) * 0.5,
    impact: a.impact[2] ? a.impact : b.impact,
  });
  const edgePoint = (a: Node, b: Node): Node | null => {
    if (dot(a.n, b.n) > 0.9995) return null;
    const key = Math.min(a.id, b.id) * 1000000 + Math.max(a.id, b.id);
    if (edgeCache.has(key)) return edgeCache.get(key)!;
    const mid = lerp3(a.p, b.p, 0.5);
    const da = dot([mid[0] - a.p[0], mid[1] - a.p[1], mid[2] - a.p[2]], a.n);
    const db = dot([mid[0] - b.p[0], mid[1] - b.p[1], mid[2] - b.p[2]], b.n);
    const p: V3 = [mid[0] - (a.n[0] * da + b.n[0] * db) * 0.4,
      mid[1] - (a.n[1] * da + b.n[1] * db) * 0.4, mid[2] - (a.n[2] * da + b.n[2] * db) * 0.4];
    const deviation = Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]);
    const node = deviation > 0.006 && deviation < 0.2 && !deeplyInsideSolid(p)
      ? blend(a, b, p, [(a.grid[0] + b.grid[0]) / 2, (a.grid[1] + b.grid[1]) / 2,
        (a.grid[2] + b.grid[2]) / 2, 512 + a.grid[3] + b.grid[3]]) : null;
    edgeCache.set(key, node); return node;
  };
  const emit = (v: Node): number => {
    const cached = vertexIndices.get(v); if (cached !== undefined) return cached;
    const i = attribute.position!.length / 3;
    attribute.position!.push(...v.p); attribute.normal!.push(...v.n); attribute.aGrid!.push(...v.grid);
    attribute.aWave!.push(v.wave); attribute.aWet!.push(v.wet); attribute.aFoam!.push(v.foam); attribute.aDepth!.push(v.depth);
    attribute.aFlow!.push(...v.flow);
    attribute.aImpact!.push(v.impact[0] * v.impact[2], v.impact[1] * v.impact[2], v.impact[2]);
    vertexIndices.set(v, i); return i;
  };
  const face = (nodes: Node[], reverse: boolean) => {
    if (reverse) nodes.reverse();
    const edges = nodes.map((a, i) => edgePoint(a, nodes[(i + 1) % 4]!));
    if (edges.every((edge) => !edge)) {
      indices.push(emit(nodes[0]!), emit(nodes[1]!), emit(nodes[2]!), emit(nodes[0]!), emit(nodes[2]!), emit(nodes[3]!));
      return;
    }
    const center = blend(blend(nodes[0]!, nodes[1]!, lerp3(nodes[0]!.p, nodes[1]!.p, 0.5), [0, 0, 0, 0]),
      blend(nodes[2]!, nodes[3]!, lerp3(nodes[2]!.p, nodes[3]!.p, 0.5), [0, 0, 0, 0]),
      [0, 0, 0], [0, 0, 0, 256]);
    for (const v of nodes) for (let axis = 0; axis < 3; axis++) {
      center.p[axis] = center.p[axis]! + v.p[axis]! / 4;
      center.grid[axis] = center.grid[axis]! + v.grid[axis]! / 4;
    }
    const perimeter: Node[] = [];
    for (let i = 0; i < 4; i++) { perimeter.push(nodes[i]!); if (edges[i]) perimeter.push(edges[i]!); }
    for (let i = 0; i < perimeter.length; i++) indices.push(emit(center), emit(perimeter[i]!), emit(perimeter[(i + 1) % perimeter.length]!));
  };
  for (let i = 0; i < cells.length; i += 3) {
    const x = cells[i]!, y = cells[i + 1]!, z = cells[i + 2]!;
    if (!isWater(world.get(x, y, z))) continue;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const other: V3 = [x, y, z]; other[axis] = other[axis]! + sign;
      const otherId = world.get(...other);
      const topGap = axis === 1 && sign > 0 && SOLID_ID[otherId] === 1 && waterHeight(world.get(x, y, z)) < 0.999;
      if (otherId !== 0 && !topGap) continue;
      const base: V3 = [x, y, z]; if (sign < 0) base[axis] = base[axis]! - 1;
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const coordinates: V3[] = [];
      for (const [a, b] of [[-1, -1], [0, -1], [0, 0], [-1, 0]]) {
        const c: V3 = [...base]; c[u] = c[u]! + a!; c[v] = c[v]! + b!; coordinates.push(c);
      }
      face(coordinates.map(([cx, cy, cz]) => getNode(cx, cy, cz, x, y, z, ...other)), sign < 0);
    }
  }
  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  const sizes: Record<string, number> = { position: 3, normal: 3, aFlow: 3, aImpact: 3, aGrid: 4 };
  for (const [name, values] of Object.entries(attribute)) geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, sizes[name] ?? 1));
  geometry.setIndex(indices);
  const p = geometry.getAttribute("position"), transitions = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) transitions.set([p.getX(i), p.getY(i), p.getZ(i), -100000], i * 4);
  geometry.setAttribute("aTransition", new THREE.BufferAttribute(transitions, 4));
  geometry.computeBoundingSphere(); geometry.boundingSphere!.radius += 0.08;
  return geometry;
}

/** Match stable component/edge keys, including a field scroll, and preserve
 *  the displayed position if another edit interrupts an active transition. */
export function prepareWaterTransition(next: THREE.BufferGeometry, previous: THREE.BufferGeometry | null,
  offsetX: number, offsetZ: number, time: number): void {
  const old = new Map<string, V3>();
  const nodeKey = (g: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, dx: number, dz: number) =>
    `${g.getX(i) + dx},${g.getY(i)},${g.getZ(i) + dz},${g.getW(i)}`;
  if (previous) {
    const p = previous.getAttribute("position"), grid = previous.getAttribute("aGrid"), t = previous.getAttribute("aTransition");
    for (let i = 0; i < p.count; i++) {
      const age = THREE.MathUtils.clamp((time - t.getW(i)) / 0.18, 0, 1), k = age * age * (3 - 2 * age);
      old.set(nodeKey(grid, i, offsetX, offsetZ), [
        THREE.MathUtils.lerp(t.getX(i), p.getX(i), k) + offsetX,
        THREE.MathUtils.lerp(t.getY(i), p.getY(i), k), THREE.MathUtils.lerp(t.getZ(i), p.getZ(i), k) + offsetZ]);
    }
  }
  const p = next.getAttribute("position"), grid = next.getAttribute("aGrid"), t = next.getAttribute("aTransition");
  let travel = 0;
  for (let i = 0; i < p.count; i++) {
    const before = old.get(nodeKey(grid, i, 0, 0)) ?? [p.getX(i), p.getY(i), p.getZ(i)];
    t.setXYZW(i, before[0], before[1], before[2], time);
    travel = Math.max(travel, Math.hypot(before[0] - p.getX(i), before[1] - p.getY(i), before[2] - p.getZ(i)));
  }
  t.needsUpdate = true;
  if (next.boundingSphere) next.boundingSphere.radius += travel;
}
