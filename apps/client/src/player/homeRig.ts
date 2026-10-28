import * as THREE from "three";
import type { AnimState } from "@robo/shared";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { HULL_LAYER, INK_LAYER } from "../render/inkOutline.js";
import { loadTexture } from "../render/textures.js";

export type HomeVariant = "mascot" | "blue" | "purple";
export type HomeAnim = AnimState | "carry" | "place" | "sit" | "wave";
export type HomeFace = "neutral" | "blink" | "happy" | "hurt" | "oh" | "dead";
export interface HomeAssets {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  faces: ReadonlyMap<string, THREE.Texture>;
}
const FACES: HomeFace[] = ["neutral", "blink", "happy", "hurt", "oh", "dead"];
const VARIANTS: HomeVariant[] = ["mascot", "blue", "purple"];
let assets: HomeAssets | null = null;
let pending: Promise<boolean> | null = null;
const disposers = new WeakMap<THREE.Object3D, () => void>();

/** Boot barrier: one model/texture download, shared geometry, independent skeletons. */
export function preloadHomeCharacter(): Promise<boolean> {
  pending ??= (async () => {
    const [gltf, loaded] = await Promise.all([
      new GLTFLoader().loadAsync("/models/home/home-v4.glb"),
      Promise.all(VARIANTS.flatMap((variant) => FACES.map(async (face) => {
        const texture = await loadTexture(`/textures/char/home/face-${variant}-${face}.png`);
        if (!texture) throw new Error(`Missing HOME face ${variant}/${face}`);
        texture.flipY = false;
        texture.needsUpdate = true;
        return [`${variant}/${face}`, texture] as const;
      }))),
    ]);
    const faces = new Map(loaded);
    const maps = new Set<THREE.Texture>();
    gltf.scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = (Array.isArray(node.material) ? node.material : [node.material]) as THREE.Material[];
      for (const material of materials) if (material instanceof THREE.MeshStandardMaterial) {
        if (material.map) maps.add(material.map);
        material.map = faces.get("mascot/neutral")!;
      }
    });
    for (const map of maps) map.dispose();
    assets = { scene: gltf.scene, animations: gltf.animations, faces };
    return true;
  })().catch((error: unknown) => {
    console.warn("HOME model unavailable; using the built-in character.", error);
    return false;
  });
  return pending;
}

export function createHomeRig(variant: HomeVariant): HomeRig | null {
  return assets ? new HomeRig(assets, variant) : null;
}
export function disposeHomeRig(root: THREE.Object3D): void { disposers.get(root)?.(); }

// Skinned hull for WebXR / ink=0. The normal renderer uses the shared screen-space ink pass.
const hullMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { width: { value: 0.014 }, opacity: { value: 1 } },
  vertexShader: `
#include <common>
#include <skinning_pars_vertex>
uniform float width;
void main() {
#include <beginnormal_vertex>
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
  transformed += normalize(objectNormal) * width;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}`,
  fragmentShader: "uniform float opacity; void main(){gl_FragColor=vec4(0.09,0.09,0.12,opacity);}",
});

/** Renderer-only adapter. Callers retain ownership of root position and yaw. */
export class HomeRig {
  readonly root = new THREE.Group();
  private readonly toy = new THREE.Group();
  private readonly model: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly solids: THREE.SkinnedMesh[] = [];
  private readonly ownedMaterials = new Set<THREE.Material>();
  private current: THREE.AnimationAction | undefined;
  private previous: HomeAnim = "idle";
  private lastY = 0;
  private landTime = 0;
  private idleTime = 4 + Math.random() * 4;
  private idleMotion = "Idle";
  private idleIndex = 0;
  private blinkTime = 2 + Math.random() * 3;
  private blinkLength = 0;
  private squash = 0;
  private squashVelocity = 0;
  private disposed = false;
  private readonly hulls: THREE.SkinnedMesh[] = [];

  constructor(private readonly source: HomeAssets, private readonly variant: HomeVariant) {
    this.root.name = "HOME";
    this.root.userData.characterModel = "HOME-v4";
    this.model = clone(source.scene);
    this.root.add(this.toy); this.toy.add(this.model);
    this.model.traverse((node) => { if (node instanceof THREE.SkinnedMesh) this.solids.push(node as THREE.SkinnedMesh); });
    for (const mesh of this.solids) {
      const sourceMaterial = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      const material = sourceMaterial.clone();
      material.map = source.faces.get(`${variant}/neutral`)!;
      material.roughness = 0.9; material.metalness = 0;
      mesh.material = material; this.ownedMaterials.add(material);
      mesh.layers.enable(INK_LAYER);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      const hull = new THREE.SkinnedMesh(mesh.geometry, hullMaterial);
      hull.name = "HOME XR outline"; hull.layers.set(HULL_LAYER); hull.frustumCulled = false;
      hull.bindMode = mesh.bindMode; hull.bind(mesh.skeleton, mesh.bindMatrix);
      hull.bindMatrixInverse.copy(mesh.bindMatrixInverse);
      hull.onBeforeRender = () => {
        const current = hull.material;
        current.uniforms.opacity!.value = current.opacity;
      };
      mesh.add(hull); this.hulls.push(hull);
    }
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of source.animations) this.actions.set(clip.name.replace(/^HOME_/, ""), this.mixer.clipAction(clip));
    this.play("Idle", 0);
    if (this.current) this.current.time = Math.random() * this.current.getClip().duration;
    this.mixer.update(0);
    disposers.set(this.root, () => this.dispose());
  }

  pop(impulse: number): void { if (Number.isFinite(impulse)) this.squashVelocity += impulse; }

  private play(name: string, fade = 0.16): void {
    const next = this.actions.get(name) ?? this.actions.get("Idle");
    if (!next || next === this.current) return;
    const old = this.current;
    const gait = ["Walk", "Run", "Carry"];
    const phase = old && gait.includes(old.getClip().name.replace(/^HOME_/, "")) && gait.includes(name)
      ? old.time / old.getClip().duration : 0;
    old?.fadeOut(fade);
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
    next.time = phase * next.getClip().duration;
    if (old && fade > 0) next.fadeIn(fade);
    this.current = next;
    this.root.userData.homeMotion = name;
  }

  private expression(face: HomeFace): void {
    const map = this.source.faces.get(`${this.variant}/${face}`) ?? this.source.faces.get(`${this.variant}/neutral`)!;
    for (const mesh of this.solids) {
      // Cameras may clone the material for first-person fading. Keep updating that active material.
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (material.map !== map) material.map = map;
    }
  }

  update(anim: HomeAnim, planarSpeed: number, dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.05);
    const speed = Number.isFinite(planarSpeed) ? Math.max(0, planarSpeed) : 0;
    const wasAir = this.previous === "jump" || this.previous === "fall";
    const airborne = anim === "jump" || anim === "fall";
    if (wasAir && !airborne && anim !== "dead" && anim !== "sit") { this.landTime = 0.22; this.pop(-2.2); }
    this.landTime = Math.max(0, this.landTime - dt);
    let motion = "Idle";
    if (anim === "sit") motion = "Sit";
    else if (anim === "place") motion = "Place";
    else if (anim === "carry") motion = speed > 0.15 ? "Carry" : "Hold";
    else if (anim === "wave") motion = "Wave";
    else if (airborne) motion = anim === "fall" || this.root.position.y < this.lastY - 0.001 ? "Fall" : "Jump";
    else if (this.landTime > 0) motion = "Land";
    else if (anim === "run" && speed > 0.15) motion = speed < 2.4 ? "Walk" : "Run";
    else if (anim !== "dead") {
      this.idleTime -= dt;
      if (this.idleTime <= 0) {
        if (this.idleMotion === "Idle") {
          this.idleMotion = this.idleIndex++ % 2 ? "IdleShift" : "IdleLook";
          this.idleTime = this.actions.get(this.idleMotion)?.getClip().duration ?? 3.6;
        } else { this.idleMotion = "Idle"; this.idleTime = 5 + Math.random() * 4; }
      }
      motion = this.idleMotion;
    }
    if (motion !== "Idle" && motion !== "IdleLook" && motion !== "IdleShift") { this.idleMotion = "Idle"; this.idleTime = 4.5; }
    this.play(motion, motion.startsWith("Idle") ? 0.28 : motion === "Land" ? 0.08 : 0.16);
    let rate = 1;
    if (motion === "Walk") rate = THREE.MathUtils.clamp(speed / 1.6, 0.65, 1.45);
    else if (motion === "Run") rate = THREE.MathUtils.clamp(speed / 4.6 * 1.15, 0.8, 1.8);
    else if (motion === "Carry") rate = THREE.MathUtils.clamp(speed / 2, 0.65, 1.6);
    this.current?.setEffectiveTimeScale(rate);
    this.mixer.update(dt);
    this.blinkTime -= dt; this.blinkLength = Math.max(0, this.blinkLength - dt);
    if (this.blinkTime <= 0) { this.blinkLength = 0.12; this.blinkTime = 2.4 + Math.random() * 3.7; }
    this.expression(anim === "dead" ? "dead" : airborne ? "oh" : this.blinkLength > 0 ? "blink" : "neutral");
    const targetTilt = anim === "dead" ? Math.PI / 2 : 0;
    this.toy.rotation.z = THREE.MathUtils.damp(this.toy.rotation.z, targetTilt, anim === "dead" ? 8 : 12, dt);
    this.toy.position.y = anim === "dead" ? 0.74 * Math.sin(this.toy.rotation.z) : 0;
    const h = Math.min(dt, 1 / 30);
    this.squashVelocity += (-190 * this.squash - 15 * this.squashVelocity) * h;
    this.squash = THREE.MathUtils.clamp(this.squash + this.squashVelocity * h, -0.32, 0.4);
    const sy = 1 + this.squash, sxz = 1 / Math.sqrt(sy);
    this.toy.scale.set(sxz, sy, sxz);
    this.previous = anim; this.lastY = this.root.position.y;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
    const skeletons = new Set(this.solids.map((mesh) => mesh.skeleton));
    for (const skeleton of skeletons) skeleton.dispose();
    for (const mesh of this.solids) {
      const material = mesh.material as THREE.Material;
      if (!this.ownedMaterials.has(material)) material.dispose();
    }
    for (const material of this.ownedMaterials) material.dispose();
    for (const hull of this.hulls) if (hull.material !== hullMaterial) (hull.material as THREE.Material).dispose();
    disposers.delete(this.root);
  }
}
