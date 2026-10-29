import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bonkEye } from "@robo/shared";
import { applyHitFlash, hitTint } from "../src/player/hitTint.js";
import { POSTURE_EYE } from "../src/craft/posture.js";
import { stepBody, type Body } from "../src/craft/voxelBody.js";
import { VoxelWorld, WORLD_X, WORLD_Z } from "../src/craft/voxelWorld.js";
import { blockByKey } from "../src/craft/blocks.js";

describe("tap feedback", () => {
  it("washes a colour toward red without throwing away its hue", () => {
    const clean = hitTint({ r: 1, g: 1, b: 1 }, 0);
    expect(clean).toEqual({ r: 1, g: 1, b: 1 });
    const hit = hitTint({ r: 0.98, g: 0.84, b: 0.11 }, 1);
    expect(hit.r).toBeGreaterThan(0.98);
    expect(hit.g).toBeLessThan(0.84);
    expect(hit.b).toBeLessThan(0.11);
    expect(hit.g).toBeGreaterThan(0.4);
  });

  it("recolors the worn material while a tap shows, then puts it back", () => {
    const root = new THREE.Group();
    const calm = new THREE.MeshStandardMaterial({ color: 0xf9d71c });
    calm.emissive.set(0xffffff);
    const id = calm.id;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), calm);
    root.add(mesh);
    applyHitFlash(root, 1);
    expect(mesh.material).toBe(calm);
    expect(calm.color.g).toBeLessThan(0.84);
    expect(calm.emissive.g).toBeLessThan(1);
    expect(calm.id).toBe(id);
    applyHitFlash(root, 0);
    expect(calm.color.getHex()).toBe(0xf9d71c);
    expect(calm.emissive.getHex()).toBe(0xffffff);
    expect(calm.emissiveIntensity).toBe(1);
    expect(calm.id).toBe(id);
    mesh.geometry.dispose();
    calm.dispose();
  });

  it("keeps the tap's eye level on the same numbers as the posture", () => {
    expect(bonkEye("idle")).toBe(POSTURE_EYE.stand);
    expect(bonkEye("run")).toBe(POSTURE_EYE.stand);
    expect(bonkEye("jump")).toBe(POSTURE_EYE.stand);
    expect(bonkEye("sit")).toBe(POSTURE_EYE.sit);
    expect(bonkEye("lie")).toBe(POSTURE_EYE.lie);
    expect(bonkEye("crawl")).toBe(POSTURE_EYE.crawl);
  });

  it("moves a standing body along a shove and forgets it when the shove is gone", () => {
    const world = new VoxelWorld();
    const stone = blockByKey("stone")!.id;
    for (let x = 0; x < WORLD_X; x++) for (let z = 0; z < WORLD_Z; z++) world.set(x, 3, z, stone);
    const body: Body = { x: 10.5, y: 4, z: 10.5, vx: 0, vy: 0, vz: 0, grounded: true };
    stepBody(world, body, 1 / 60, 0, 0, false, 6, 0);
    expect(body.x).toBeGreaterThan(10.55);
    expect(body.z).toBeCloseTo(10.5, 5);
    const landed = body.x;
    stepBody(world, body, 1 / 60, 0, 0, false);
    expect(body.x).toBeCloseTo(landed, 5);
  });
});
