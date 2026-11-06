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

describe("de2: the eye itself inside a block (the body squeezed into a gap)", () => {
  it("the camera looks from the nearest free spot instead of opening the block", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) w.set(x, 0, z, 3);
    w.set(15, 2, 15, 2); // a brick right where the head is
    const three = new THREE.PerspectiveCamera(75.5, 21 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(15.5, 2.5, 15.5); // inside that brick
    for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 4) {
      settle(cam, w, eye, yaw, -0.6, 40);
      expect(clipsBlock(w, three.position, 0.2), `yaw ${yaw.toFixed(2)}`).toBe(false);
    }
  });
});

describe("the escape never moves the view sideways (aim and view stay on one line)", () => {
  it("an eye inside a block only moves up or down; x/z of the pivot stay the body's", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) w.set(x, 0, z, 3);
    w.set(15, 2, 15, 2);
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(15.5, 2.5, 15.5);
    // first person: the camera sits on the pivot, so its x/z must be the eye's
    cam.toggleView();
    for (let i = 0; i < 30; i++) cam.update(w, eye, 0.3, -0.4, false, 1 / 60, 1.55 + 1);
    cam.toggleView();
    settle(cam, w, eye, 0.3, -0.4, 60);
    // third person: the camera sits on the line behind the pivot — the pivot's x/z are the eye's,
    // so the camera lies on the view ray through the eye column (no sideways jump)
    const back = new THREE.Vector3(Math.sin(0.3) * Math.cos(-0.4), 0, Math.cos(0.3) * Math.cos(-0.4)).normalize();
    const off = new THREE.Vector3(three.position.x - eye.x, 0, three.position.z - eye.z);
    const side = Math.abs(off.x * back.z - off.z * back.x);
    expect(side).toBeLessThan(0.3 + 1e-6); // only the normal over-the-shoulder offset (≤ 0.28 m)
  });

  it("the body's own eye is used when the smoothed eye lags into a block", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) w.set(x, 0, z, 3);
    w.set(15, 1, 15, 3); // a step the body just climbed onto: smoothed eye still inside it
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    // third person, level look: the camera height is the pivot height
    for (let i = 0; i < 30; i++) cam.update(w, new THREE.Vector3(15.5, 1.6, 15.5), 0, 0, false, 1 / 60, 3.55);
    expect(three.position.y).toBeCloseTo(3.55, 1);
  });

});

describe("looking up over the ground: the camera rides over the floor instead of diving in", () => {
  it("looking up over open ground keeps the full distance (no fade), lifted over the floor", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(20.5, 2.6, 15.5); // floor top at y = 1, wall far away
    settle(cam, w, eye, 0, 0.6);
    const opacity = cam.update(w, eye, 0, 0.6, false, 1 / 60);
    expect(opacity).toBeGreaterThan(0.99);
    expect(three.position.y).toBeGreaterThanOrEqual(1 + 0.3);
    expect(clipsBlock(w, three.position, 0.1)).toBe(false);
  });

  it("jumping while looking up does not pulse the robot's fade (the flicker)", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(20.5, 2.6, 15.5);
    settle(cam, w, eye, 0, 0.6);
    let min = 1;
    for (let i = 0; i < 120; i++) {
      eye.y = 2.6 + Math.abs(Math.sin(i / 12)) * 1.2; // a few jumps
      min = Math.min(min, cam.update(w, eye, 0, 0.6, false, 1 / 60));
    }
    expect(min).toBeGreaterThan(0.99);
  });

  it("looking straight up still fades the robot (the camera really is at its feet)", () => {
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(20.5, 2.6, 15.5);
    settle(cam, w, eye, 0, 1.5);
    expect(cam.update(w, eye, 0, 1.5, false, 1 / 60)).toBeLessThan(0.75);
    expect(clipsBlock(w, three.position, 0.1)).toBe(false);
  });

  it("in a room, looking up never puts the camera outside the wall behind (the floor no longer hides it)", () => {
    // floor y=0 everywhere; the player stands at x=13 facing +x, the wall at x=10 is 3 m behind
    const w = world();
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(13.5, 2.6, 15.5);
    const yaw = Math.PI / 2; // looking +x: the camera sits toward -x, toward the wall
    settle(cam, w, eye, yaw, 0.6);
    cam.update(w, eye, yaw, 0.6, false, 1 / 60);
    expect(three.position.x).toBeGreaterThan(11); // stays on our side of the wall
    expect(clipsBlock(w, three.position, 0.1)).toBe(false);
  });

  it("on a one-block-thick bridge, looking down-and-back never puts the camera under the deck", () => {
    const w = new VoxelWorld();
    for (let x = 0; x < 40; x++) for (let z = 10; z < 22; z++) w.set(x, 6, z, 3); // a deck at y = 6, air below
    const three = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const cam = new CraftCamera(three);
    const eye = new THREE.Vector3(20.5, 8.6, 15.5); // standing on the deck (top at y = 7)
    settle(cam, w, eye, 0, 1.0);
    cam.update(w, eye, 0, 1.0, false, 1 / 60);
    expect(three.position.y).toBeGreaterThanOrEqual(7); // above the deck, not in the air beneath it
    expect(clipsBlock(w, three.position, 0.1)).toBe(false);
  });
});
