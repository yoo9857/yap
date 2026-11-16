import * as THREE from "three";
import { PLAZA_SPAWN } from "@robo/shared";
import { PhysicsWorld, type RapierModule, type RapierCollider, type RapierRigidBody } from "../physics/physics.js";

export interface PlazaCollision {
  units: "metres"; upAxis: "Y";
  boxes: { name: string; min: number[]; max: number[] }[];
  meshes?: { vertices: number[][]; triangles: number[][]; replacesBoxPrefix?: string }[];
}

/** Metres, 0.6 m capsule width, 1.8 m height; the model is never scaled to a voxel grid. */
export class PlazaPhysics {
  readonly physics: PhysicsWorld;
  readonly collider: RapierCollider;
  readonly body: RapierRigidBody;
  private readonly cc: import("@dimforge/rapier3d-compat").KinematicCharacterController;
  readonly feet = new THREE.Vector3(...PLAZA_SPAWN);
  readonly velocity = new THREE.Vector3();
  grounded = false;
  constructor(rapier: RapierModule, data: PlazaCollision) {
    if (data.units !== "metres" || data.upAxis !== "Y") throw new Error("Invalid plaza coordinate system");
    this.physics = new PhysicsWorld(rapier);
    const replaces = data.meshes?.flatMap(m => m.replacesBoxPrefix ? [m.replacesBoxPrefix] : []) ?? [];
    for (const box of data.boxes) {
      if (replaces.some(prefix => box.name.startsWith(prefix))) continue;
      const [a, b] = [box.min, box.max];
      const descriptor = rapier.ColliderDesc.cuboid((b[0]! - a[0]!) / 2, (b[1]! - a[1]!) / 2, (b[2]! - a[2]!) / 2)
        .setTranslation((a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2);
      this.physics.world.createCollider(descriptor);
    }
    for (const mesh of data.meshes ?? []) {
      this.physics.world.createCollider(rapier.ColliderDesc.trimesh(new Float32Array(mesh.vertices.flat()), new Uint32Array(mesh.triangles.flat())));
    }
    this.body = this.physics.world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PLAZA_SPAWN[1] + .9, PLAZA_SPAWN[2]));
    this.collider = this.physics.world.createCollider(rapier.ColliderDesc.capsule(.6, .3), this.body);
    this.cc = this.physics.world.createCharacterController(.015);
    this.cc.enableAutostep(.32, .18, true); this.cc.enableSnapToGround(.28);
    this.cc.setMaxSlopeClimbAngle(Math.PI / 4); this.cc.setMinSlopeSlideAngle(Math.PI / 3.6);
    this.physics.step();
  }
  teleport(position: readonly number[]): void {
    this.body.setTranslation({ x: position[0]!, y: position[1]! + .9, z: position[2]! }, true);
    this.body.setNextKinematicTranslation({ x: position[0]!, y: position[1]! + .9, z: position[2]! });
    this.feet.set(position[0]!, position[1]!, position[2]!); this.velocity.set(0, 0, 0); this.grounded = false;
  }
  step(x: number, z: number, jump: boolean): void {
    const dt = 1 / 60, blend = 1 - Math.exp(-18 * dt);
    this.velocity.x += (x - this.velocity.x) * blend; this.velocity.z += (z - this.velocity.z) * blend;
    this.velocity.y = jump && this.grounded ? 7 : Math.max(-28, this.velocity.y - 22 * dt);
    this.cc.computeColliderMovement(this.collider, { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt });
    const moved = this.cc.computedMovement(), current = this.body.translation();
    this.body.setNextKinematicTranslation({ x: current.x + moved.x, y: current.y + moved.y, z: current.z + moved.z });
    this.grounded = this.cc.computedGrounded(); if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
    this.physics.step(); const next = this.body.translation(); this.feet.set(next.x, next.y - .9, next.z);
  }
  dispose(): void { this.physics.world.removeCharacterController(this.cc); this.physics.world.free(); }
}
