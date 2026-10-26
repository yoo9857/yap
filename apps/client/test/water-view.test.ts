import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATER, flowingWater } from "@robo/shared";
import { VoxelView } from "../src/craft/voxelView.js";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { WaterSim } from "../src/craft/waterSim.js";
import { FieldWindow } from "../src/craft/fieldWorld.js";

vi.mock("../src/render/textures.js", () => ({ loadTexture: () => Promise.resolve(null) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const meshes = (scene: THREE.Scene): THREE.Mesh[] => scene.children.filter((object): object is THREE.Mesh =>
  object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial &&
  object.material.customProgramCacheKey() === "craft-water-continuous-3");
const flush = (view: VoxelView, world: VoxelWorld, eye: THREE.Vector3) => {
  for (let i = 0; i < 150 && (view.waterStats().queued || view.waterStats().pending); i++) view.update(world, eye);
  expect(view.waterStats().queued + view.waterStats().pending).toBe(0);
};

describe("water mesh generations", () => {
  it("resumes banked water after leaving and returning to the field window", () => {
    const field = new FieldWindow(), view = new VoxelView(new THREE.Scene());
    const sim = new WaterSim(field.world, view, field);
    field.world.set(80, 4, 80, WATER); sim.touch(80, 4, 80);
    field.recenter({ x: 256, z: 80 });
    for (let i = 0; i < 20; i++) sim.update(0.25);
    field.recenter({ x: -96, z: 80 });
    expect(field.world.get(80, 4, 80)).toBe(WATER);
    for (let i = 0; i < 20 && field.world.get(81, 4, 80) === 0; i++) sim.update(0.25);
    expect(field.world.get(81, 4, 80)).toBe(flowingWater(1));
    view.dispose();
  });

  it("starts a restored source even when the save has no flowing cells yet", () => {
    const world = new VoxelWorld(), view = new VoxelView(new THREE.Scene());
    for (let x = 14; x <= 18; x++) for (let z = 14; z <= 18; z++) world.set(x, 0, z, 3);
    world.set(16, 1, 16, WATER);
    const sim = new WaterSim(world, view, null); sim.wakeAll();
    for (let i = 0; i < 20 && world.get(17, 1, 16) === 0; i++) sim.update(0.25);
    expect(world.get(17, 1, 16)).toBe(flowingWater(1));
    view.dispose();
  });
  it("recovers from a worker failure using the bounded synchronous fallback", () => {
    const workers: { onerror: ((event: Event) => unknown) | null; terminated: boolean }[] = [];
    const world = new VoxelWorld(), scene = new THREE.Scene(), view = new VoxelView(scene), eye = new THREE.Vector3(16, 3, 16);
    world.set(16, 0, 16, 3); world.set(16, 1, 16, WATER); view.update(world, eye);
    const before = meshes(scene)[0]!.geometry;
    vi.stubGlobal("Worker", class {
      onerror: ((event: Event) => unknown) | null = null;
      onmessage = null;
      terminated = false;
      constructor() { workers.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    });
    world.set(16, 1, 16, flowingWater(4)); view.markWaterDirty(16, 1, 16); view.update(world, eye);
    expect(view.waterStats().worker).toBe(true);
    workers[0]!.onerror?.(new Event("error"));
    flush(view, world, eye);
    expect(view.waterStats().worker).toBe(false);
    expect(workers[0]!.terminated).toBe(true);
    expect(meshes(scene)[0]!.geometry).not.toBe(before);
    view.dispose();
  });
  it("loads saved water in the worker and recovers even before the first mesh exists", () => {
    let fail: (() => void) | null = null;
    vi.stubGlobal("Worker", class {
      onmessage = null;
      set onerror(callback: () => void) { fail = callback; }
      postMessage() {}
      terminate() {}
    });
    const world = new VoxelWorld(), scene = new THREE.Scene(), view = new VoxelView(scene), eye = new THREE.Vector3(16, 3, 16);
    world.set(16, 1, 16, WATER); view.update(world, eye);
    expect(meshes(scene)).toHaveLength(0);
    expect(view.waterStats().pending).toBeGreaterThan(0);
    (fail as unknown as () => void)(); flush(view, world, eye);
    expect(meshes(scene)).toHaveLength(1);
    view.dispose();
  });
  it("wakes a dense saved pool in slices without losing its last source", () => {
    const world = new VoxelWorld(), view = new VoxelView(new THREE.Scene());
    for (let y = 1; y <= 10; y++) for (let z = 16; z < 48; z++) for (let x = 16; x < 48; x++) world.set(x, y, z, WATER);
    world.set(150, 45, 150, WATER);
    const sim = new WaterSim(world, view, null); sim.wakeAll(); sim.update(0);
    expect(sim.stats().pending).toBeLessThanOrEqual(256 * 7);
    for (let i = 0; i < 100 && sim.stats().waking; i++) sim.update(0);
    expect(sim.stats().waking).toBe(false);
    for (let i = 0; i < 100 && world.get(150, 44, 150) === 0; i++) sim.update(0.25);
    expect(world.get(150, 44, 150)).not.toBe(0);
    view.dispose();
  });
  it("does not skip a source exactly where the activation time budget expires", () => {
    const world = new VoxelWorld(), view = new VoxelView(new THREE.Scene()), sim = new WaterSim(world, view, null);
    world.set(0, 0, 0, 3); world.set(0, 1, 0, WATER); // index 25,600: a scan checkpoint
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => ++calls < 27 ? 0 : 2);
    sim.wakeAll(); sim.update(0); sim.update(0.25);
    expect(world.get(1, 1, 0)).toBe(flowingWater(1));
    view.dispose();
  });
  it("keeps old neighbours intact until the whole new generation is ready", () => {
    const world = new VoxelWorld(), scene = new THREE.Scene(), view = new VoxelView(scene);
    const eye = new THREE.Vector3(16, 3, 16);
    world.set(15, 0, 16, 3); world.set(16, 0, 16, 3);
    world.set(15, 1, 16, WATER); world.set(16, 1, 16, flowingWater(3));
    view.update(world, eye);
    const before = meshes(scene).map((mesh) => [mesh, mesh.geometry] as const);
    expect(before).toHaveLength(2);
    world.set(16, 1, 16, WATER);
    view.markWaterDirty(16, 1, 16);
    // Deterministically exhaust the build budget after one chunk.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 3);
    view.update(world, eye);
    expect(view.waterStats().pending).toBeGreaterThan(0);
    for (const [mesh, geometry] of before) expect(mesh.geometry).toBe(geometry);
    flush(view, world, eye);
    for (const [mesh, geometry] of before) expect(mesh.geometry).not.toBe(geometry);
    expect(meshes(scene)).toHaveLength(2); // meshes/materials reused, no duplicates
    view.dispose();
    expect(meshes(scene)).toHaveLength(0);
  });

  it("uses a frozen snapshot while newer flow changes wait for the next generation", () => {
    const world = new VoxelWorld(), scene = new THREE.Scene(), view = new VoxelView(scene);
    const eye = new THREE.Vector3(16, 3, 16);
    for (const x of [15, 16]) { world.set(x, 0, 16, 3); world.set(x, 1, 16, flowingWater(4)); }
    view.update(world, eye);
    world.set(15, 1, 16, WATER); view.markWaterDirty(15, 1, 16);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 3);
    view.update(world, eye);
    world.set(16, 1, 16, 0); view.markWaterDirty(16, 1, 16);
    flush(view, world, eye);
    expect(meshes(scene)).toHaveLength(1);
    view.dispose();
  });

  it("releases staged geometry when the field scrolls and rebuilds in the new grid", () => {
    const world = new VoxelWorld(), scene = new THREE.Scene(), view = new VoxelView(scene);
    const eye = new THREE.Vector3(80, 3, 80);
    world.set(80, 0, 80, 3); world.set(80, 1, 80, WATER);
    view.update(world, eye);
    view.markWaterDirty(80, 1, 80);
    view.shift(32, 0);
    world.set(80, 1, 80, 0); world.set(48, 0, 80, 3); world.set(48, 1, 80, WATER);
    view.markWaterDirty(48, 1, 80);
    const nextEye = new THREE.Vector3(48, 3, 80);
    for (let i = 0; i < 100; i++) view.update(world, nextEye);
    flush(view, world, nextEye);
    const water = meshes(scene);
    expect(water).toHaveLength(1);
    const p = water[0]!.geometry.getAttribute("position");
    const xs = Array.from({ length: p.count }, (_, i) => p.getX(i) + water[0]!.position.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(48);
    expect(Math.max(...xs)).toBeLessThanOrEqual(49);
    expect(Math.min(...xs)).toBeLessThan(48.5);
    expect(Math.max(...xs)).toBeGreaterThan(48.5);
    view.dispose();
  });
});
