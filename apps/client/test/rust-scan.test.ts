// The chunk scan on the Rust engine (scan.rs) must draw EXACTLY what VoxelView.scanChunk draws:
// two views of the same random world — one on TypeScript, one on Rust — must end up with the same
// meshes in every chunk, near and far: shells, shaped bricks (instance matrices), seam backing,
// far merged meshes (attributes and material groups) and studs. Worlds mix every shape family,
// see-through blocks, grass under blocks, water, cells hidden by mining/falling, and the field's
// ground beyond the window.
import { loadRustEngineSync } from "@robo/engine/node";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CUBE, KIT_CUBE, ROUND, WATER, cornerShape, kitSlopeShape, slabShape, stairsShape } from "@robo/shared";
import { VoxelWorld, WORLD_X, WORLD_Z } from "../src/craft/voxelWorld.js";
import { VoxelView } from "../src/craft/voxelView.js";
import { blockByKey } from "../src/craft/blocks.js";

vi.mock("../src/render/textures.js", () => ({ loadTexture: () => Promise.resolve(null) }));
const engine = loadRustEngineSync();

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const id = (k: string) => blockByKey(k)!.id;
const BLOCKS = ["stone", "dirt", "grass", "flower-grass", "oak-planks", "oak-log", "glass", "sand", "stone-bricks", "gold-block"].filter((k) => blockByKey(k)).map(id);
const SHAPES = [CUBE, KIT_CUBE, KIT_CUBE, KIT_CUBE, ROUND, kitSlopeShape(0, 0), kitSlopeShape(1, 2), cornerShape(2, 0), slabShape(0, 0), slabShape(1, 2), stairsShape(3, 0), stairsShape(0, 2)];

function world(seed: number, field: boolean): { world: VoxelWorld; hide: [number, number, number][] } {
  const r = rng(seed), w = new VoxelWorld();
  const ground = id("grass"), dirt = id("dirt"), stone = id("stone");
  // a band of the window around a chunk corner (so chunk borders and the window edge are crossed)
  const ox = field ? 0 : 40, oz = field ? 0 : 40;
  for (let x = ox; x < ox + 40; x++) for (let z = oz; z < oz + 40; z++) {
    w.set(x, 0, z, stone); w.set(x, 1, z, dirt); w.set(x, 2, z, ground);
  }
  const hide: [number, number, number][] = [];
  for (let i = 0; i < 700; i++) {
    const x = ox + Math.floor(r() * 40), z = oz + Math.floor(r() * 40), y = 3 + Math.floor(r() * 6);
    const v = r();
    if (v < 0.06) w.set(x, y, z, WATER);
    else if (v < 0.1) { w.set(x, 2, z, 0); } // holes in the ground
    else w.setShaped(x, y, z, BLOCKS[Math.floor(r() * BLOCKS.length)]!, SHAPES[Math.floor(r() * SHAPES.length)]!);
    if (r() < 0.01) hide.push([x, y, z]);
  }
  if (field) w.outsideColumn = new Uint8Array([stone, dirt, ground]);
  return { world: w, hide };
}

type Chunks = Map<number, { meshes: Map<number, THREE.InstancedMesh>; far: THREE.Mesh | null; backing: THREE.Mesh | null; studs: Map<number, number[]> }>;
function snapshot(view: VoxelView): unknown[] {
  const chunks = (view as unknown as { chunks: Chunks }).chunks;
  const out: unknown[] = [];
  const attrs = (g: THREE.BufferGeometry) => Object.fromEntries(Object.entries(g.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, a]) => [k, Array.from(new Uint32Array(new Float32Array(a.array as ArrayLike<number>).buffer))]));
  for (const cid of [...chunks.keys()].sort((a, b) => a - b)) {
    const c = chunks.get(cid)!;
    out.push({
      cid,
      near: [...c.meshes].map(([k, m]) => ({ k, count: m.count, matrix: Array.from(m.instanceMatrix.array), shell: m.geometry.userData.cosmetic ? null : attrs(m.geometry) })),
      backing: c.backing ? attrs(c.backing.geometry) : null,
      far: c.far ? { attrs: attrs(c.far.geometry), groups: c.far.geometry.groups } : null,
      studs: [...c.studs],
    });
  }
  return out;
}

function both(seed: number, field: boolean, eye: THREE.Vector3 | undefined) {
  const { world: w, hide } = world(seed, field);
  const views = [null, engine].map((rust) => {
    const scene = new THREE.Scene(), view = new VoxelView(scene, { catalogTextures: false });
    view.useRustShells(rust);
    if (hide.length) { view.setMiningHidden(hide[0]!); view.setFallingHidden(hide.slice(1)); }
    view.update(w, eye);
    return view;
  });
  const used = views[1] as unknown as { rustScanner: unknown; rustScanOff: boolean };
  expect(used.rustScanner, "the Rust scan ran").not.toBeNull();
  expect(used.rustScanOff, "and never fell back").toBe(false);
  const ts = snapshot(views[0]!), rs = snapshot(views[1]!);
  for (const v of views) v.dispose();
  return { ts, rs };
}

describe("chunk scan: Rust = TypeScript (scanChunk)", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const field = seed % 2 === 0;
    it(`seed ${seed} (${field ? "field edge" : "island"}): near forms`, () => {
      const { ts, rs } = both(seed, field, undefined);
      expect(ts.length).toBeGreaterThan(0);
      expect(rs).toEqual(ts);
    });
    it(`seed ${seed} (${field ? "field edge" : "island"}): far forms`, () => {
      const { ts, rs } = both(seed, field, new THREE.Vector3(WORLD_X / 2, 40, WORLD_Z + 400));
      expect((ts as { far: unknown }[]).some((c) => c.far), "the scene must have far chunks").toBe(true);
      expect(rs).toEqual(ts);
    });
  }
});
