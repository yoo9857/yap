import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AnimState } from "@robo/shared";

/**
 * Character = the CC0 "RobotExpressive" glTF (Tomás Laulhé / Don McCurdy,
 * public domain), served from /models/robot.glb. The model + its animation
 * clips load ONCE; every rig instance is a lightweight skeleton clone with
 * its own AnimationMixer (geometry/materials stay shared).
 *
 * Drop-in for the former procedural R6 rig: same public shape — `root` (a
 * Group with feet at the origin), `update(anim, planarSpeed, dt)`, and the
 * free `disposeRig(root)` — so tower players, remote ghosts and builder
 * workers need no changes.
 */

const MODEL_URL = "/models/robot.glb";
/** Meters, standing height (feet at y=0) — matches the old rig's ~1.8 m. */
const TARGET_HEIGHT = 1.9;

type Anim = AnimState | "carry" | "place";

/** Our states → RobotExpressive clip names (fuzzy-matched at bind time). */
const CLIP_FOR: Record<Anim, string> = {
  idle: "Idle",
  run: "Running",
  jump: "Jump",
  fall: "Jump",
  dead: "Death",
  carry: "Walking",
  place: "Idle",
};

interface LoadedModel {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

let loadPromise: Promise<LoadedModel | null> | null = null;
function loadModel(): Promise<LoadedModel | null> {
  if (!loadPromise) {
    loadPromise = new Promise((resolve) => {
      new GLTFLoader().load(
        MODEL_URL,
        (gltf) => resolve({ scene: gltf.scene, clips: gltf.animations }),
        undefined,
        () => resolve(null), // fetch/parse failed → rig stays empty, never throws
      );
    });
  }
  return loadPromise;
}

export class CharacterRig {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private wantClip = "Idle";
  private ready = false;

  // color args kept for signature compatibility; the glTF carries its own look
  constructor(_torsoColor?: number, _limbColor?: number, _legColor?: number) {
    void loadModel().then((loaded) => {
      if (!loaded) return;
      const model = cloneSkeleton(loaded.scene);

      // scale to TARGET_HEIGHT, then drop so the feet rest on y=0.
      // updateMatrixWorld first: the clone has no parent yet, so its world
      // matrices are stale and Box3.setFromObject would measure wrong.
      model.updateMatrixWorld(true);
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(model).getSize(size);
      const scale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
      model.scale.setScalar(scale);
      model.updateMatrixWorld(true);
      const grounded = new THREE.Box3().setFromObject(model);
      model.position.y -= grounded.min.y;

      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          // skinned meshes keep the source's rest-pose bounding volume, which
          // after scaling/animation no longer matches — the camera then culls
          // the body while its shadow (a separate light frustum) still shows.
          o.frustumCulled = false;
        }
      });
      this.root.add(model);

      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of loaded.clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
      this.ready = true;
      this.play(this.wantClip);
    });
  }

  private resolveAction(name: string): THREE.AnimationAction | null {
    const exact = this.actions.get(name);
    if (exact) return exact;
    // fuzzy: case-insensitive contains (robust to clip-name drift)
    const lower = name.toLowerCase();
    for (const [clipName, action] of this.actions) {
      if (clipName.toLowerCase().includes(lower)) return action;
    }
    return this.actions.values().next().value ?? null;
  }

  private play(name: string): void {
    const next = this.resolveAction(name);
    if (!next || next === this.current) return;
    next.reset().fadeIn(0.18).play();
    this.current?.fadeOut(0.18);
    this.current = next;
  }

  /** `planarSpeed` in m/s scales the walk/run cadence; `dt` real frame time. */
  update(anim: Anim, planarSpeed: number, dt: number): void {
    const clip = CLIP_FOR[anim] ?? "Idle";
    if (clip !== this.wantClip) {
      this.wantClip = clip;
      if (this.ready) this.play(clip);
    }
    if (this.current && (anim === "run" || anim === "carry")) {
      // faster movement → faster legs (RobotExpressive Running is tuned ~5 m/s)
      this.current.timeScale = Math.max(0.6, Math.min(2.2, planarSpeed / 4));
    } else if (this.current) {
      this.current.timeScale = 1;
    }
    this.mixer?.update(dt);
  }
}

/**
 * Frees per-instance extras (e.g. name-label sprites) added onto a rig root.
 * The robot's geometry/materials/textures are SHARED across all clones — never
 * disposed here, or every other character would break.
 */
export function disposeRig(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Sprite) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}
