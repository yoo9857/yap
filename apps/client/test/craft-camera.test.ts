import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CraftCamera } from "../src/craft/craftCamera.js";
import { VoxelWorld } from "../src/craft/voxelWorld.js";

/** A flat floor with a wall: solid cells x = 10, y 1..5, every z. */
function world(): VoxelWorld {
  const w = new VoxelWorld();
  for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) w.set(x, 0, z, 3);
  for (let y = 1; y <= 5; y++) for (let z = 0; z < 30; z++) w.set(10, y, z, 3);
  return w;
}

/** Is any corner of the near plane's footprint (±r around the camera) inside a block? */
function clipsBlock(w: VoxelWorld, p: THREE.Vector3, r = 0.15): boolean {
  for (const dx of [-r, 0, r]) for (const dy of [-r, 0, r]) for (const dz of [-r, 0, r]) {
    if (w.isSolid(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz))) return true;
  }
  return false;
}

function settle(cam: CraftCamera, w: VoxelWorld, eye: THREE.Vector3, yaw: number, pitch: number, frames = 120) {
  for (let i = 0; i < frames; i++) cam.update(w, eye, yaw, pitch, false, 1 / 60);
}

describe("craft camera never opens a block on screen", () => {
  it("back against a wall: the camera comes in instead of sitting inside the wall", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    // standing 0.35 m from the wall at x = 10 (its face at x = 10), looking away from it (-x)
    const eye = new THREE.Vector3(9.65, 2.6, 15);
    settle(cam, w, eye, -Math.PI / 2, 0);
    expect(clipsBlock(w, three.position)).toBe(false);
    expect(three.position.x).toBeLessThan(10 - 0.15);
  });

  it("sliding along a wall at a grazing angle keeps the screen's edge out of it", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    for (const yaw of [Math.PI * 0.02, Math.PI * 0.06, -Math.PI * 0.04, Math.PI * 0.1]) {
      for (const gap of [0.4, 0.6, 0.9]) {
        const eye = new THREE.Vector3(10 - gap, 2.6, 15);
        settle(cam, w, eye, yaw, -0.2, 60);
        expect(clipsBlock(w, three.position), `yaw ${yaw.toFixed(2)} gap ${gap}`).toBe(false);
      }
    }
  });

  it("a hard screen shake beside a wall does not push the camera into it", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(9.5, 2.6, 15);
    for (let i = 0; i < 90; i++) {
      if (i % 10 === 0) cam.addShake(0.14);
      cam.update(w, eye, Math.PI * 0.05, -0.1, false, 1 / 60);
      expect(clipsBlock(w, three.position)).toBe(false);
    }
  });

  it("in the open the camera stays at its full distance", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    settle(cam, w, new THREE.Vector3(20, 2.6, 15), Math.PI / 2, -0.2, 400);
    expect(cam.distance).toBeGreaterThan(7.5);
  });
});

describe("de2: down in a one-cell pit, looking down past the rim", () => {
  it("no yaw or steep pitch puts the near plane into the rim bricks", () => {
    const w = new VoxelWorld();
    // ground 0..3 solid; a 1×1 pit at (15, 3, 15) one cell deep; a 1-high step beside it
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) for (let y = 0; y <= 3; y++) w.set(x, y, z, 3);
    w.set(15, 3, 15, 0);
    for (let z = 12; z < 18; z++) w.set(17, 4, z, 3);
    const three = new THREE.PerspectiveCamera(75.5, 21 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(15.5, 3 + 1.5, 15.5); // feet on the pit floor
    for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 8) {
      for (const pitch of [-0.4, -0.8, -1.2]) {
        settle(cam, w, eye, yaw, pitch, 40);
        expect(clipsBlock(w, three.position, 0.2), `yaw ${yaw.toFixed(2)} pitch ${pitch}`).toBe(false);
      }
    }
  });
});
