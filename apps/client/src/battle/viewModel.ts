import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * First-person weapon viewmodel — rides the camera and renders ON TOP of the
 * world (depthTest off, high renderOrder) so it never clips into walls. It
 * lives in the scene and is placed in the camera's local space by hand each
 * frame (the camera isn't part of the scene graph).
 *
 * A chunky doodle blaster is built procedurally as an INSTANT fallback; the
 * CC0 "Scifi Pistol" glb (Quaternius, public domain) then loads and swaps in
 * without touching the recoil / bob / muzzle-flash rig.
 */

const HAND_OFFSET = new THREE.Vector3(0.2, -0.22, -0.62);
/** Toe-in so the barrel visually converges on the crosshair (where shots
 *  actually go) instead of pointing parallel-forward off to the side. */
const CONVERGE_YAW = 0.16;
const CONVERGE_PITCH = 0.05;
const WEAPON_URL = "/models/blaster.glb";
/** Longest model dimension is scaled to this (meters) in view space. */
const WEAPON_LENGTH = 0.5;
/** Orientation of the loaded model so its barrel points into the scene (-z).
 *  This model's barrel runs along its local +x, so a +90° yaw aims it forward. */
const WEAPON_ROT = new THREE.Euler(0, Math.PI / 2, 0);

function doodleMat(color: number, emissive = 0): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color });
  m.fog = false;
  m.depthTest = false;
  m.depthWrite = false;
  if (emissive) {
    m.emissive = new THREE.Color(emissive);
    m.emissiveIntensity = 1;
  }
  return m;
}

export class ViewModel {
  private readonly group = new THREE.Group();
  private readonly placeholder = new THREE.Group();
  private readonly muzzle: THREE.Mesh;
  private recoil = 0; // 0..1, spring-decayed
  private bobPhase = 0;
  private flashLeft = 0;
  private swayX = 0;
  private swayY = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.4), doodleMat(0x2f7de1));
    body.renderOrder = 999;
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.34), doodleMat(0x1f2a44));
    barrel.position.set(0, 0.02, -0.34);
    barrel.renderOrder = 999;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, 0.1), doodleMat(0x1f1f1f));
    grip.position.set(0, -0.16, 0.12);
    grip.rotation.x = 0.3;
    grip.renderOrder = 999;
    const accent = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.12), doodleMat(0xffd21c));
    accent.position.set(0, 0.09, 0.02);
    accent.renderOrder = 999;

    // muzzle flash — a bright star that pops for a few frames on fire
    this.muzzle = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.34),
      doodleMat(0xffe36b, 0xffe36b),
    );
    (this.muzzle.material as THREE.MeshLambertMaterial).transparent = true;
    this.muzzle.position.set(0, 0.02, -0.56);
    this.muzzle.renderOrder = 1000;
    this.muzzle.visible = false;

    for (const part of [body, barrel, grip, accent]) {
      part.frustumCulled = false;
      this.placeholder.add(part);
    }
    this.muzzle.frustumCulled = false;
    this.group.add(this.placeholder, this.muzzle);
    this.group.renderOrder = 999;
    scene.add(this.group);

    this.loadWeapon();
  }

  /** Load the CC0 pistol glb and swap out the placeholder; keeps the rig. */
  private loadWeapon(): void {
    new GLTFLoader().load(
      WEAPON_URL,
      (gltf) => {
        const model = gltf.scene;
        model.rotation.copy(WEAPON_ROT);
        model.updateMatrixWorld(true);
        // fit: scale longest dimension to WEAPON_LENGTH, recenter on origin
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        const scale = WEAPON_LENGTH / Math.max(size.x, size.y, size.z, 1e-3);
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));
        const overlay = (m: THREE.Material) => {
          m.depthTest = false;
          m.depthWrite = false;
          (m as THREE.Material & { fog?: boolean }).fog = false;
        };
        model.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.frustumCulled = false;
          o.renderOrder = 999;
          const material = o.material as THREE.Material | THREE.Material[];
          if (Array.isArray(material)) material.forEach(overlay);
          else overlay(material);
        });
        this.group.remove(this.placeholder);
        this.group.add(model);
      },
      undefined,
      () => {
        /* fetch/parse failed — the procedural placeholder stays */
      },
    );
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Trigger pull: kick the recoil spring + flash the muzzle. */
  fire(): void {
    this.recoil = 1;
    this.flashLeft = 0.05;
    this.muzzle.rotation.z = Math.random() * Math.PI; // vary the flash
  }

  update(dt: number, moving: boolean): void {
    if (!this.group.visible) return;
    this.camera.updateMatrixWorld();

    // recoil spring back toward 0
    this.recoil *= Math.pow(0.0009, dt);
    if (this.recoil < 0.002) this.recoil = 0;

    // walk bob + a hair of idle sway
    this.bobPhase += dt * (moving ? 11 : 2.2);
    const bobAmp = moving ? 0.02 : 0.005;
    const bobX = Math.cos(this.bobPhase) * bobAmp;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmp;
    // ease the sway so direction changes aren't instant
    this.swayX += (bobX - this.swayX) * (1 - Math.pow(0.02, dt));
    this.swayY += (bobY - this.swayY) * (1 - Math.pow(0.02, dt));

    // place in camera-local space, then push back along +z (toward the eye)
    // and dip the nose up for the recoil
    const local = HAND_OFFSET.clone();
    local.x += this.swayX;
    local.y += this.swayY;
    local.z += this.recoil * 0.13;
    this.group.position.copy(local).applyMatrix4(this.camera.matrixWorld);
    this.group.quaternion.copy(this.camera.quaternion);
    // converge toward the crosshair + recoil kick (all in camera-local axes)
    this.group.rotateY(CONVERGE_YAW);
    this.group.rotateX(CONVERGE_PITCH + this.recoil * 0.35);

    // muzzle flash lifetime
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      this.muzzle.visible = true;
      const k = Math.max(0, this.flashLeft / 0.05);
      this.muzzle.scale.setScalar(0.6 + k * 0.8);
      (this.muzzle.material as THREE.MeshLambertMaterial).opacity = k;
    } else {
      this.muzzle.visible = false;
    }
  }
}
