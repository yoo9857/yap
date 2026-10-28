import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HomeRig, disposeHomeRig, type HomeAssets, type HomeAnim } from "../src/player/homeRig.js";

interface GltfDocument {
  images?: unknown[];
  textures?: unknown[];
  samplers?: unknown[];
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: unknown; metallicRoughnessTexture?: unknown }; normalTexture?: unknown; occlusionTexture?: unknown; emissiveTexture?: unknown }[];
}
let assets: HomeAssets;
beforeAll(async () => {
  const raw = await readFile(new URL("../public/models/home/home-v4.glb", import.meta.url));
  const oldLength = raw.readUInt32LE(12);
  const doc = JSON.parse(raw.subarray(20, 20 + oldLength).toString()) as GltfDocument;
  // Keep the shipped geometry/skin/clips; image decoding needs a browser and is tested in the live game.
  delete doc.images; delete doc.textures; delete doc.samplers;
  for (const mat of doc.materials ?? []) {
    if (mat.pbrMetallicRoughness) { delete mat.pbrMetallicRoughness.baseColorTexture; delete mat.pbrMetallicRoughness.metallicRoughnessTexture; }
    delete mat.normalTexture; delete mat.occlusionTexture; delete mat.emissiveTexture;
  }
  let json = JSON.stringify(doc); while (Buffer.byteLength(json) % 4) json += " ";
  const body = raw.subarray(20 + oldLength);
  const result = Buffer.alloc(20 + Buffer.byteLength(json) + body.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(Buffer.byteLength(json), 12); result.writeUInt32LE(0x4e4f534a, 16);
  result.write(json, 20); body.copy(result, 20 + Buffer.byteLength(json));
  const buffer = new ArrayBuffer(result.length); new Uint8Array(buffer).set(result);
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  const faces = new Map<string, THREE.Texture>();
  for (const variant of ["mascot", "blue", "purple"]) for (const face of ["neutral", "blink", "happy", "hurt", "oh", "dead"]) faces.set(`${variant}/${face}`, new THREE.Texture());
  assets = { scene: gltf.scene, animations: gltf.animations, faces };
});
function solid(rig: HomeRig): THREE.SkinnedMesh {
  const mesh = rig.root.getObjectsByProperty("type", "SkinnedMesh").find((node) => node.name !== "HOME XR outline");
  if (!(mesh instanceof THREE.SkinnedMesh)) throw new Error("Missing HOME skin");
  return mesh as THREE.SkinnedMesh;
}

describe("shipped HOME character", () => {
  it("contains every gameplay clip and a small valid skin", () => {
    expect(new Set(assets.animations.map((clip) => clip.name))).toEqual(new Set(["Idle", "IdleShift", "IdleLook", "Walk", "Run", "Wave", "Jump", "Fall", "Land", "Carry", "Hold", "Place", "Sit"].map((name) => `HOME_${name}`)));
    const rig = new HomeRig(assets, "mascot"); const mesh = solid(rig);
    expect(mesh.geometry.index!.count / 3).toBeLessThan(3000);
    expect(mesh.geometry.getAttribute("skinWeight").count).toBe(mesh.geometry.getAttribute("position").count);
    rig.root.updateMatrixWorld(true);
    mesh.computeBoundingBox(); expect(mesh.boundingBox.min.y).toBeGreaterThan(-0.001);
    disposeHomeRig(rig.root);
  });

  it("shares geometry but keeps skeletons, expressions and camera opacity independent", () => {
    const a = new HomeRig(assets, "mascot"), b = new HomeRig(assets, "blue");
    const am = solid(a), bm = solid(b);
    expect(am.geometry).toBe(bm.geometry); expect(am.skeleton).not.toBe(bm.skeleton);
    expect(am.material).not.toBe(bm.material);
    const faded = (am.material as THREE.MeshStandardMaterial).clone(); faded.opacity = 0.25; faded.transparent = true; am.material = faded;
    a.update("dead", 0, 1 / 60); b.update("idle", 0, 1 / 60);
    expect(faded.map).toBe(assets.faces.get("mascot/dead")); expect(faded.opacity).toBe(0.25);
    expect((bm.material as THREE.MeshStandardMaterial).map).not.toBe(faded.map);
    const freeSharedGeometry = vi.fn(); am.geometry.addEventListener("dispose", freeSharedGeometry);
    disposeHomeRig(a.root); expect(freeSharedGeometry).not.toHaveBeenCalled();
    b.update("run", 4.6, 1 / 60); expect(b.root.userData.homeMotion).toBe("Run");
    disposeHomeRig(b.root); am.geometry.removeEventListener("dispose", freeSharedGeometry);
  });

  it("preserves caller-owned position/yaw through every game state and malformed frame input", () => {
    const rig = new HomeRig(assets, "purple"); rig.root.position.set(8, 3, -4); rig.root.rotation.y = 1.2;
    const states: HomeAnim[] = ["idle", "run", "carry", "place", "sit", "jump", "fall", "idle", "wave", "dead", "idle"];
    for (const state of states) for (let i = 0; i < 30; i++) {
      rig.update(state, state === "run" || state === "carry" ? 4.6 : 0, 1 / 60);
      rig.root.updateMatrixWorld(true);
      expect(rig.root.position.toArray()).toEqual([8, 3, -4]); expect(rig.root.rotation.y).toBe(1.2);
      rig.root.traverse((node) => { expect(node.matrixWorld.elements.every(Number.isFinite)).toBe(true); });
    }
    rig.update("run", Number.NaN, Number.NaN); rig.update("idle", 0, -1);
    expect(rig.root.position.toArray()).toEqual([8, 3, -4]);
    disposeHomeRig(rig.root);
  });

  it("keeps the short arms and feet moving during sustained jump and fall states", () => {
    const rig = new HomeRig(assets, "mascot"); const mesh = solid(rig);
    for (const state of ["jump", "fall"] as const) {
      for (let i = 0; i < 30; i++) rig.update(state, 0, 1 / 60);
      rig.root.updateMatrixWorld(true);
      const first = Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, index) => mesh.getVertexPosition(index, new THREE.Vector3()).clone());
      for (let i = 0; i < 9; i++) rig.update(state, 0, 1 / 60);
      rig.root.updateMatrixWorld(true);
      let movement = 0;
      for (let i = 0; i < first.length; i++) movement = Math.max(movement, mesh.getVertexPosition(i, new THREE.Vector3()).distanceTo(first[i]!));
      expect(movement).toBeGreaterThan(0.008);
    }
    disposeHomeRig(rig.root);
  });

  it("detects descent and plays a brief landing before returning to locomotion", () => {
    const rig = new HomeRig(assets, "mascot");
    rig.root.position.y = 2; rig.update("jump", 2, 1 / 60); expect(rig.root.userData.homeMotion).toBe("Jump");
    rig.root.position.y = 1.8; rig.update("jump", 2, 1 / 60); expect(rig.root.userData.homeMotion).toBe("Fall");
    rig.root.position.y = 0; rig.update("run", 4.6, 1 / 60); expect(rig.root.userData.homeMotion).toBe("Land");
    for (let i = 0; i < 20; i++) rig.update("run", 4.6, 1 / 60);
    expect(rig.root.userData.homeMotion).toBe("Run");
    disposeHomeRig(rig.root);
  });
});
