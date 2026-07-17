import { GRAVITY, SIM_DT } from "@robo/shared";

export type RapierModule = typeof import("@dimforge/rapier3d-compat");
export type RapierWorld = import("@dimforge/rapier3d-compat").World;
export type RapierRigidBody = import("@dimforge/rapier3d-compat").RigidBody;
export type RapierCollider = import("@dimforge/rapier3d-compat").Collider;

/** What a collider belongs to — resolved via handle after raycasts. */
export type ColliderTag =
  | { kind: "ground" }
  | { kind: "platform"; platformId: number }
  | { kind: "player" };

/**
 * Thin wrapper around the Rapier world: fixed timestep pinned to SIM_DT,
 * exactly one step() per fixed tick, and a collider-handle → tag registry.
 * Sensor-style triggers (checkpoints/hazards/goal) are checked analytically
 * in plain code, not through physics events.
 */
export class PhysicsWorld {
  readonly world: RapierWorld;
  private readonly tags = new Map<number, ColliderTag>();

  constructor(readonly rapier: RapierModule) {
    this.world = new rapier.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = SIM_DT;
  }

  step(): void {
    this.world.step();
  }

  register(collider: RapierCollider, tag: ColliderTag): void {
    this.tags.set(collider.handle, tag);
  }

  unregister(collider: RapierCollider): void {
    this.tags.delete(collider.handle);
  }

  tagOf(colliderHandle: number): ColliderTag | undefined {
    return this.tags.get(colliderHandle);
  }

  /**
   * Raycast straight down from `origin`; returns the first non-player hit
   * within `maxDist`, or null. Used to find what the character stands on.
   */
  castDown(
    origin: { x: number; y: number; z: number },
    maxDist: number,
    exclude?: RapierCollider,
  ): { tag: ColliderTag; distance: number } | null {
    const ray = new this.rapier.Ray(origin, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, maxDist, true, undefined, undefined, exclude);
    if (!hit) return null;
    const tag = this.tags.get(hit.collider.handle);
    if (!tag || tag.kind === "player") return null;
    return { tag, distance: hit.timeOfImpact };
  }
}
