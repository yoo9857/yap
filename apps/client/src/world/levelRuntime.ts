import * as THREE from "three";
import type { LevelDef } from "@robo/shared";
import type { PhysicsWorld } from "../physics/physics.js";
import type { InterpolationStore } from "../physics/interpolation.js";
import {
  CrumblingPlatform,
  MovingPlatform,
  SolidPlatform,
  type PlatformEntity,
} from "./platforms.js";

const PAD_INACTIVE = new THREE.MeshStandardMaterial({
  color: 0x9aa2ab,
  emissive: 0x30c8ff,
  emissiveIntensity: 0.15,
});
const PAD_ACTIVE = new THREE.MeshStandardMaterial({
  color: 0x3ddc64,
  emissive: 0x3ddc64,
  emissiveIntensity: 0.8,
});
const PAD_GOAL = new THREE.MeshStandardMaterial({
  color: 0xffd21c,
  emissive: 0xffb400,
  emissiveIntensity: 0.7,
});

/**
 * Instantiates a LevelDef into the scene + physics world and owns every
 * platform entity for per-tick updates.
 */
export class LevelRuntime {
  readonly entities: PlatformEntity[] = [];
  readonly byId = new Map<number, PlatformEntity>();
  readonly crumbling: CrumblingPlatform[] = [];
  private readonly checkpointPads: THREE.Mesh[] = [];
  private goalPad: THREE.Mesh;

  constructor(
    readonly level: LevelDef,
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    interpStore: InterpolationStore,
  ) {
    for (const def of level.platforms) {
      let entity: PlatformEntity;
      switch (def.kind) {
        case "solid":
          entity = new SolidPlatform(def, scene, physics);
          break;
        case "moving":
          entity = new MovingPlatform(def, scene, physics, interpStore);
          break;
        case "crumbling": {
          const c = new CrumblingPlatform(def, scene, physics);
          this.crumbling.push(c);
          entity = c;
          break;
        }
      }
      this.entities.push(entity);
      this.byId.set(def.id, entity);
    }

    // checkpoint sensor pads: neon cylinders sitting on their platforms
    for (const cp of level.checkpoints) {
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(cp.radius, cp.radius, 0.12, 32),
        PAD_INACTIVE,
      );
      pad.position.set(cp.center[0], cp.center[1] + 0.06, cp.center[2]);
      pad.receiveShadow = true;
      scene.add(pad);
      this.checkpointPads[cp.index] = pad;
    }

    // golden goal pad on the winner platform
    this.goalPad = new THREE.Mesh(
      new THREE.CylinderGeometry(level.goal.radius, level.goal.radius, 0.15, 40),
      PAD_GOAL,
    );
    this.goalPad.position.set(
      level.goal.center[0],
      level.goal.center[1] + 0.08,
      level.goal.center[2],
    );
    scene.add(this.goalPad);
  }

  /** Tear the whole level out of the scene + physics (daily rebuild). */
  dispose(): void {
    for (const e of this.entities) e.dispose(this.scene, this.physics);
    this.entities.length = 0;
    this.byId.clear();
    this.crumbling.length = 0;
    for (const pad of this.checkpointPads) {
      if (!pad) continue;
      this.scene.remove(pad);
      pad.geometry.dispose();
    }
    this.checkpointPads.length = 0;
    this.scene.remove(this.goalPad);
    this.goalPad.geometry.dispose();
  }

  setCheckpointActive(index: number): void {
    const pad = this.checkpointPads[index];
    if (pad) pad.material = PAD_ACTIVE;
  }

  resetCheckpoints(): void {
    for (const pad of this.checkpointPads) {
      if (pad) pad.material = PAD_INACTIVE;
    }
  }

  /** Platforms move BEFORE the character controller runs — strict tick order. */
  fixedUpdate(tickTime: number): void {
    for (const e of this.entities) e.fixedUpdate(tickTime);
  }

  frameUpdate(alpha: number, timeSec: number): void {
    for (const e of this.entities) e.frameUpdate(alpha, timeSec);
  }
}
