import * as THREE from "three";
import { lerpAngle } from "@robo/shared";

/**
 * Prev/curr transform pair for one rendered entity. Every moving visual —
 * player AND platforms — renders from the same interpolation scheme; mixing
 * interpolated and live poses is what causes ride jitter.
 */
export class InterpolatedTransform {
  readonly prev = new THREE.Vector3();
  readonly curr = new THREE.Vector3();
  private prevYaw = 0;
  private currYaw = 0;

  reset(pos: THREE.Vector3, yaw = 0): void {
    this.prev.copy(pos);
    this.curr.copy(pos);
    this.prevYaw = yaw;
    this.currYaw = yaw;
  }

  /** Call at the START of each fixed tick, before anything moves. */
  beginTick(): void {
    this.prev.copy(this.curr);
    this.prevYaw = this.currYaw;
  }

  /** Call after the physics step with the new authoritative pose. */
  commit(pos: { x: number; y: number; z: number }, yaw?: number): void {
    this.curr.set(pos.x, pos.y, pos.z);
    if (yaw !== undefined) this.currYaw = yaw;
  }

  lerpedPosition(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    return out.lerpVectors(this.prev, this.curr, alpha);
  }

  lerpedYaw(alpha: number): number {
    return lerpAngle(this.prevYaw, this.currYaw, alpha);
  }
}

/** Registry so the loop can shift every prev←curr in one call per tick. */
export class InterpolationStore {
  private readonly items = new Set<InterpolatedTransform>();

  create(pos?: THREE.Vector3, yaw = 0): InterpolatedTransform {
    const t = new InterpolatedTransform();
    if (pos) t.reset(pos, yaw);
    this.items.add(t);
    return t;
  }

  remove(t: InterpolatedTransform): void {
    this.items.delete(t);
  }

  beginTick(): void {
    for (const t of this.items) t.beginTick();
  }
}
