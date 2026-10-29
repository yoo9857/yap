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
vi.mock("../src/player/faceCanvas.js", async () => {
  const T = await import("three");
  return { faceBitmap: vi.fn(), FaceCanvas: class {
    readonly texture = new T.Texture();
    set(face: string): void { this.texture.userData.face = face; }
    play(name: string, end = "neutral"): void { this.texture.userData.face = end; this.texture.userData.sequence = name; }
    update(): void {} dispose(): void { this.texture.dispose(); }
  }};
});
let assets: HomeAssets;
beforeAll(async () => {
  const raw = await readFile(new URL("../public/models/characters/HOME/HOME.glb", import.meta.url));
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
  assets = { scene: gltf.scene, animations: gltf.animations, character: "HOME", faces: {sequences:{}} };
});
function solid(rig: HomeRig): THREE.SkinnedMesh {
  const mesh = rig.root.getObjectsByProperty("type", "SkinnedMesh").find((node) => node.name !== "Character XR outline");
  if (!(mesh instanceof THREE.SkinnedMesh)) throw new Error("Missing HOME skin");
  return mesh as THREE.SkinnedMesh;
}

describe("shipped HOME character", () => {
  it("contains every gameplay clip and a small valid skin", () => {
    expect(new Set(assets.animations.map((clip) => clip.name))).toEqual(new Set(["Idle", "IdleShift", "IdleLook", "Walk", "Run", "Wave", "Jump", "Fall", "Land", "Carry", "Hold", "Place", "Sit", "Hop", "Cheer", "Interact", "Hit", "Sleep", "Dead", "LieDown", "Lie", "StandUp", "CrawlEnter", "CrawlIdle", "Crawl", "CrawlExit", "SitDown", "SitToStand", "LieToCrawl", "CrawlToLie", "SitToLie", "LieToSit", "SitToCrawl", "CrawlToSit", "Takeoff", "CrawlReach", "Swim", "SwimIdle"]));
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
    expect(faded.map?.userData.face).toBe("dead"); expect(faded.opacity).toBe(0.25);
    expect((bm.material as THREE.MeshStandardMaterial).map).not.toBe(faded.map);
    const freeSharedGeometry = vi.fn(); am.geometry.addEventListener("dispose", freeSharedGeometry);
    disposeHomeRig(a.root); expect(freeSharedGeometry).not.toHaveBeenCalled();
    b.update("run", 2.7, 1 / 60); expect(b.root.userData.homeMotion).toBe("Walk");
    b.update("run", 5.2, 1 / 60); expect(b.root.userData.homeMotion).toBe("Run");
    disposeHomeRig(b.root); am.geometry.removeEventListener("dispose", freeSharedGeometry);
  });

  it("preserves caller-owned position/yaw through every game state and malformed frame input", () => {
    const rig = new HomeRig(assets, "purple"); rig.root.position.set(8, 3, -4); rig.root.rotation.y = 1.2;
    const states: HomeAnim[] = ["idle", "run", "carry", "place", "sit", "jump", "fall", "idle", "wave", "dead", "idle", "lie", "idle", "crawl", "run"];
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
    rig.root.position.y = 2; rig.update("jump", 2, 1 / 60); expect(rig.root.userData.homeMotion).toBe("Takeoff");
    rig.root.position.y = 1.8; rig.update("jump", 2, 1 / 60); expect(rig.root.userData.homeMotion).toBe("Fall");
    rig.root.position.y = 0; rig.update("run", 4.6, 1 / 60); expect(rig.root.userData.homeMotion).toBe("Land");
    for (let i = 0; i < 20; i++) rig.update("run", 4.6, 1 / 60);
    expect(rig.root.userData.homeMotion).toBe("Run");
    disposeHomeRig(rig.root);
  });
});

describe("posture and emote playback", () => {
  it("finishes entering crawl, alternates limbs while moving, and stands up with an exit clip", () => {
    const rig = new HomeRig(assets,"mascot");
    rig.update("crawl",0,1/60);expect(rig.root.userData.homeMotion).toBe("CrawlEnter");
    for(let i=0;i<45;i++)rig.update("crawl",0,1/60);
    expect(rig.root.userData.homeMotion).toBe("CrawlIdle");
    rig.update("crawl",1.25,1/60);expect(rig.root.userData.homeMotion).toBe("Crawl");
    rig.update("idle",0,1/60);expect(rig.root.userData.homeMotion).toBe("CrawlExit");
    for(let i=0;i<45;i++)rig.update("idle",0,1/60);
    expect(rig.root.userData.homeMotion).toBe("Idle");disposeHomeRig(rig.root);
  });

  it("deduplicates repeated emote packets and replays a new sequence",()=>{
    const a=new HomeRig(assets,"mascot"), b=new HomeRig(assets,"mascot");
    for(const r of [a,b]){r.setEmote("wave",10);for(let i=0;i<50;i++)r.update("idle",0,1/60);}
    a.setEmote("wave",10);a.update("idle",0,1/60);b.update("idle",0,1/60);
    const arm=(r:HomeRig)=>solid(r).skeleton.bones.find(b=>b.name.startsWith("upper_arm"))!;
    expect(arm(a).quaternion.clone().normalize().angleTo(arm(b).quaternion.clone().normalize())).toBeLessThan(.00001);
    a.setEmote("wave",11);a.update("idle",0,1/60);b.update("idle",0,1/60);
    expect(arm(a).quaternion.clone().normalize().angleTo(arm(b).quaternion.clone().normalize())).toBeGreaterThan(.01);
    disposeHomeRig(a.root);disposeHomeRig(b.root);
  });
  it("keeps an exit playing through idle/run changes and uses the direct low-pose bridge",()=>{
    const r=new HomeRig(assets,"mascot");for(let i=0;i<60;i++)r.update("lie",0,1/60);
    r.update("crawl",0,1/60);expect(r.root.userData.homeMotion).toBe("LieToCrawl");
    for(let i=0;i<82;i++)r.update("crawl",0,1/60);
    r.update("idle",0,1/60);r.update("run",4.6,1/60);
    expect(r.root.userData.homeMotion).toBe("CrawlExit");expect(r.postureBusy).toBe(true);
    for(let i=0;i<60;i++)r.update("run",4.6,1/60);
    expect(r.postureBusy).toBe(false);expect(r.root.userData.homeMotion).toBe("Run");disposeHomeRig(r.root);
  });
  it("waves while running without changing the leg pose, then releases the gesture",()=>{
    const random=vi.spyOn(Math,"random").mockReturnValue(.25);
    const a=new HomeRig(assets,"mascot"),b=new HomeRig(assets,"mascot");random.mockRestore();
    for(let i=0;i<25;i++){a.update("run",3.2,1/60);b.update("run",3.2,1/60);}
    a.setEmote("wave",3);
    for(let i=0;i<35;i++){a.update("run",3.2,1/60);b.update("run",3.2,1/60);}
    expect(a.root.userData.upperMotion).toBe("Upper/Wave");
    const bones=solid(a).skeleton.bones,other=solid(b).skeleton.bones;
    for(let i=0;i<bones.length;i++)if(/^(thigh|shin|foot|toe)/.test(bones[i]!.name)){
      expect(bones[i]!.quaternion.clone().normalize().angleTo(other[i]!.quaternion.clone().normalize())).toBeLessThan(.00001);
      expect(bones[i]!.position.distanceTo(other[i]!.position)).toBeLessThan(.00001);
    }
    const arm=bones.findIndex(n=>n.name.startsWith("upper_arm"));expect(bones[arm]!.quaternion.angleTo(other[arm]!.quaternion)).toBeGreaterThan(.05);
    for(let i=0;i<150;i++)a.update("run",3.2,1/60);
    expect(a.root.userData.upperMotion).toBe("");disposeHomeRig(a.root);disposeHomeRig(b.root);
  });
  it("uses the whole elapsed frame at 10 FPS and selects swimming instead of running",()=>{
    const a=new HomeRig(assets,"mascot"),b=new HomeRig(assets,"mascot");
    for(let i=0;i<6;i++)a.update("crawl",0,.1);
    for(let i=0;i<36;i++)b.update("crawl",0,1/60);
    const bones=solid(a).skeleton.bones,other=solid(b).skeleton.bones;
    for(let i=0;i<bones.length;i++)expect(bones[i]!.position.distanceTo(other[i]!.position)).toBeLessThan(.00001);
    a.update("idle",0,.1,{swimming:true});for(let i=0;i<10;i++)a.update("idle",0,.1,{swimming:true});
    expect(a.root.userData.homeMotion).toBe("SwimIdle");a.update("run",2,.1,{swimming:true});expect(a.root.userData.homeMotion).toBe("Swim");
    disposeHomeRig(a.root);disposeHomeRig(b.root);
  });
});



describe("mixed-pose contact",()=>{
 it("keeps low transitions and a crawling reach above the floor",()=>{
  const r=new HomeRig(assets,"mascot");const mesh=solid(r),point=new THREE.Vector3();let lowest=0;
  const sample=()=>{r.root.updateMatrixWorld(true);for(let i=0;i<mesh.geometry.getAttribute("position").count;i++){mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld);lowest=Math.min(lowest,point.y);}};
  for(let i=0;i<65;i++){r.update("lie",0,1/60);sample();}
  for(let i=0;i<88;i++){r.update("crawl",0,1/60);sample();}
  r.performAction("interact",9,true);
  for(let i=0;i<150;i++){r.update("crawl",1.25,1/60);sample();}
  expect(r.root.userData.upperMotion).toBe("Upper/CrawlReach");
  expect(lowest).toBeGreaterThan(-.015);disposeHomeRig(r.root);
 });
});
