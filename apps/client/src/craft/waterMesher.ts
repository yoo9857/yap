// The water surface is meshed by the Rust engine (engine/crates/core/src/water_mesh.rs, through
// WASM) and nowhere else: in the water worker (waterWorker.ts), and on the main thread only as the
// worker's fallback and in tests. This file is the glue — the engine's flat array as a three.js
// geometry — plus the morph between two generations. (The TypeScript mesher this replaced,
// waterGeometry.ts, was removed on 2026-11-12: one implementation, the owner's call. The rules and
// their reasons are in docs/WATER.md and in water_mesh.rs.)
import * as THREE from "three";
import type { RustEngine } from "@robo/engine/browser";
import { WORLD_X, WORLD_Y, WORLD_Z } from "./voxelWorld.js";
import type { WaterWorkerResult } from "./waterWorkerTypes.js";

type V3 = [number, number, number];
export type WaterEngine = Pick<RustEngine, "water_mesh" | "draw_water_by_amount" | "draw_water_simple" | "WaterMesher">;
export interface WaterSource {
  get(x: number, y: number, z: number): number;
  /** The top of a shaped block holding water (waterlog.ts shapeProfile); 0 = none. */
  profile?(x: number, y: number, z: number): number;
}

let engine: WaterEngine | null = null;
let loading: Promise<boolean> | null = null;
let streams = false, finite = false, simple = true;
/** Hand over a started engine (tests: the Node build; the browser uses `loadWaterEngine`). */
export function setWaterEngine(e: WaterEngine | null): void { engine = e; }
export function hasWaterEngine(): boolean { return engine !== null; }
/** Fetch and start the engine on this thread (once). False if this browser cannot run it. */
export function loadWaterEngine(): Promise<boolean> {
  return loading ??= import("@robo/engine/browser").then((m) => m.loadRustEngine())
    .then((e) => { engine = e; return true; }, () => false);
}
/** Water in the AIR — a fall, the lip over an edge, a spring beside a wall — drawn as films and
 *  streams apart from the lying water (water_mesh.rs `draw_streams`). */
export function drawWaterAsStreams(on: boolean): void { streams = on; }
/** The simple, Minecraft-like water (the default: a box per cell whose top's corners are shared
 *  with its neighbours, falling water a whole cell) or the surface net with its films (false). */
export function drawWaterSimple(on: boolean): void { simple = on; }
/** Finite water: flowing ids are amounts and stand that high (fluid.ts drawWaterByAmount). */
export function drawWaterFinite(on: boolean): void { finite = on; }

const LAYOUT: [string, number][] = [["position", 3], ["normal", 3], ["aWave", 1], ["aWet", 1], ["aFoam", 1], ["aDepth", 1],
  ["aFlow", 3], ["aImpact", 3], ["aGrid", 4]];

/** The engine's array from `at` — [vertex count, index count, attributes…, indices] — as buffers:
 *  the attributes, the start-of-transition copy, the index and the bounding sphere. Null when
 *  nothing is drawn; throws where the surface has a missing component. */
function unpack(out: Float32Array, at: number): Pick<WaterWorkerResult, "attributes" | "index" | "sphere"> | null {
  const n = out[at]!, count = out[at + 1]!;
  if (n < 0) throw new Error("Missing connected water surface component");
  if (n === 0 || count === 0) return null;
  at += 2;
  const attributes: NonNullable<WaterWorkerResult["attributes"]> = {};
  for (const [name, size] of LAYOUT) {
    attributes[name] = { array: out.slice(at, at + n * size), itemSize: size }; at += n * size;
  }
  const indices = out.subarray(at, at + count);
  const index = n > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices);
  const position = attributes.position!.array, transitions = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) transitions.set([position[i * 3]!, position[i * 3 + 1]!, position[i * 3 + 2]!, -100000], i * 4);
  attributes.aTransition = { array: transitions, itemSize: 4 };
  const probe = new THREE.BufferGeometry();
  probe.setAttribute("position", new THREE.BufferAttribute(position, 3));
  probe.computeBoundingSphere();
  const s = probe.boundingSphere!;
  return { attributes, index, sphere: [s.center.x, s.center.y, s.center.z, s.radius + 0.08] };
}

/** One chunk from the worker's `WaterMesher.chunk`: [min y, max y, then as `unpack`]. */
export function resultFromRust(id: number, out: Float32Array, transfers: Transferable[]): WaterWorkerResult {
  const result: WaterWorkerResult = { id, minY: out[0]!, maxY: out[1]!, attributes: null, index: null, sphere: null };
  const parts = unpack(out, 2);
  if (!parts) return result;
  Object.assign(result, parts);
  for (const a of Object.values(result.attributes!)) transfers.push(a.array.buffer);
  transfers.push(result.index!.buffer);
  return result;
}

export function geometryFromResult(result: Pick<WaterWorkerResult, "attributes" | "index" | "sphere">): THREE.BufferGeometry | null {
  if (!result.attributes || !result.index || !result.sphere) return null;
  const geometry = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(result.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize));
  geometry.setIndex(new THREE.BufferAttribute(result.index, 1));
  const [x, y, z, r] = result.sphere;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, y, z), r);
  return geometry;
}

let grid: Uint8Array | null = null, marks: Uint8Array | null = null;
const NONE = new Uint8Array(0);
/**
 * The water surface over `cells` (flat x, y, z), on THIS thread: the worker's fallback and the
 * tests. The engine reads a whole grid, so the columns round the cells are copied into one first
 * (a scratch grid, cleared again after). Needs `setWaterEngine` / `loadWaterEngine` first.
 */
export function buildWaterGeometry(world: WaterSource, cells: readonly number[]): THREE.BufferGeometry | null {
  if (!engine) throw new Error("the water engine is not loaded");
  if (!cells.length) return null;
  let x0 = WORLD_X, x1 = -1, z0 = WORLD_Z, z1 = -1;
  for (let i = 0; i < cells.length; i += 3) {
    x0 = Math.min(x0, cells[i]!); x1 = Math.max(x1, cells[i]!); z0 = Math.min(z0, cells[i + 2]!); z1 = Math.max(z1, cells[i + 2]!);
  }
  x0 = Math.max(0, x0 - 3); x1 = Math.min(WORLD_X - 1, x1 + 3); z0 = Math.max(0, z0 - 3); z1 = Math.min(WORLD_Z - 1, z1 + 3);
  grid ??= new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z);
  const profile = world.profile ? marks ??= new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z) : null;
  const outside = new Uint8Array(WORLD_Y);
  for (let y = 0; y < WORLD_Y; y++) {
    outside[y] = world.get(-1, y, -1);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const i = (y * WORLD_Z + z) * WORLD_X + x;
      grid[i] = world.get(x, y, z);
      if (profile) profile[i] = world.profile!(x, y, z);
    }
  }
  let out: Float32Array;
  try {
    engine.draw_water_by_amount(finite); engine.draw_water_simple(simple);
    out = engine.water_mesh(grid, outside, Int32Array.from(cells), profile ?? NONE, streams);
  } finally {
    for (let y = 0; y < WORLD_Y; y++) for (let z = z0; z <= z1; z++) {
      const i = (y * WORLD_Z + z) * WORLD_X;
      grid.fill(0, i + x0, i + x1 + 1); profile?.fill(0, i + x0, i + x1 + 1);
    }
  }
  const parts = unpack(out, 0);
  return parts ? geometryFromResult(parts) : null;
}

/** Match stable component/edge keys, including a field scroll, and preserve
 *  the displayed position if another edit interrupts an active transition. */
export function prepareWaterTransition(next: THREE.BufferGeometry, previous: THREE.BufferGeometry | null,
  offsetX: number, offsetZ: number, time: number, animate = true): void {
  // Fresh geometry already has its final position in aTransition. Under an
  // exceptional generation, skip interpolation for ALL neighbours together.
  if (!previous || !animate) return;
  const old = new Map<number | string, V3>();
  const nodeKey = (g: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, dx: number, dz: number) => {
    const x = (g.getX(i) + dx) * 4 + 1024, y = g.getY(i) * 4 + 128, z = (g.getZ(i) + dz) * 4 + 1024, tag = g.getW(i);
    return x >= 0 && x < 4096 && z >= 0 && z < 4096 && y >= 0 && y < 512 && tag < 262144
      ? ((x * 4096 + z) * 512 + y) * 262144 + tag : `${x},${y},${z},${tag}`;
  };
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
