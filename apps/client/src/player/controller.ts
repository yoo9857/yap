import * as THREE from "three";
import {
  AIR_ACCEL,
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  GRAVITY,
  GROUND_ACCEL,
  JUMP_RELEASE_CLAMP,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  SIM_DT,
  type Vec3,
} from "@robo/shared";
import type { PhysicsWorld, RapierCollider, RapierRigidBody } from "../physics/physics.js";

export interface MoveCommand {
  /** Desired planar velocity in m/s (already camera-relative). */
  wishVelX: number;
  wishVelZ: number;
  doJump: boolean;
  jumpHeld: boolean;
  /** Displacement of the platform under our feet this tick. */
  platformDelta: THREE.Vector3;
  /** Its instantaneous velocity — inherited as momentum when jumping. */
  platformVelocity: THREE.Vector3;
}

const CAPSULE_CENTER_OFFSET = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;

/**
 * Rapier KinematicCharacterController wrapper. Kinematic (not dynamic) so the
 * platformer feel — exact accel curves, jump apex, variable jump — never goes
 * through the constraint solver. Order per tick: platforms have already set
 * their kinematic targets; we compute collide-and-slide movement INCLUDING
 * the platform carry, then the world steps once.
 */
export class CharacterController {
  readonly velocity = new THREE.Vector3();
  readonly body: RapierRigidBody;
  readonly collider: RapierCollider;
  grounded = false;
  private readonly cc: import("@dimforge/rapier3d-compat").KinematicCharacterController;
  private readonly desired = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    spawnFeet: Vec3,
  ) {
    this.body = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawnFeet[0],
        spawnFeet[1] + CAPSULE_CENTER_OFFSET,
        spawnFeet[2],
      ),
    );
    this.collider = physics.world.createCollider(
      physics.rapier.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS),
      this.body,
    );
    physics.register(this.collider, { kind: "player" });

    this.cc = physics.world.createCharacterController(0.02);
    this.cc.enableAutostep(0.3, 0.2, true);
    this.cc.enableSnapToGround(0.3);
    this.cc.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
    this.cc.setMinSlopeSlideAngle((50 * Math.PI) / 180);
  }

  /** Capsule center (pre-step authoritative position). */
  centerPosition(): { x: number; y: number; z: number } {
    return this.body.translation();
  }

  feetPosition(): Vec3 {
    const t = this.body.translation();
    return [t.x, t.y - CAPSULE_CENTER_OFFSET, t.z];
  }

  teleportToFeet(feet: Vec3): void {
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    const center = { x: feet[0], y: feet[1] + CAPSULE_CENTER_OFFSET, z: feet[2] };
    this.body.setTranslation(center, true);
    this.body.setNextKinematicTranslation(center);
  }

  /**
   * Integrate velocity, run the KCC collide-and-slide, and queue the body's
   * next kinematic position. Runs BEFORE physics.step().
   */
  preStep(cmd: MoveCommand): void {
    const vel = this.velocity;

    // planar: exponential approach to wish velocity (prototype accel curve)
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const blend = Math.min(1, (accel * SIM_DT) / MOVE_SPEED);
    vel.x += (cmd.wishVelX - vel.x) * blend;
    vel.z += (cmd.wishVelZ - vel.z) * blend;

    // vertical
    if (cmd.doJump) {
      vel.y = JUMP_VELOCITY;
      // momentum carry-over when leaping off a moving platform
      vel.x += cmd.platformVelocity.x;
      vel.z += cmd.platformVelocity.z;
      this.grounded = false;
    } else {
      vel.y = Math.max(vel.y - GRAVITY * SIM_DT, -MAX_FALL_SPEED);
    }
    // variable jump height: releasing the button caps upward speed
    if (!cmd.jumpHeld && vel.y > JUMP_RELEASE_CLAMP) {
      vel.y = JUMP_RELEASE_CLAMP;
    }

    // Collide-and-slide over the player's OWN motion only; the platform carry
    // is applied verbatim on top. Platforms are teleported (zero internal
    // velocity), so the KCC never adds its own partial carry — the explicit
    // delta is the single source of ride movement and velocity reconstruction
    // below stays feedback-free.
    this.desired.set(vel.x * SIM_DT, vel.y * SIM_DT, vel.z * SIM_DT);

    this.cc.computeColliderMovement(this.collider, this.desired);
    const corrected = this.cc.computedMovement();
    const pos = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: pos.x + corrected.x + cmd.platformDelta.x,
      y: pos.y + corrected.y + cmd.platformDelta.y,
      z: pos.z + corrected.z + cmd.platformDelta.z,
    });

    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();

    if (import.meta.env.DEV) {
      this.trace.push({
        dx: this.desired.x,
        cx: corrected.x,
        dy: this.desired.y,
        cy: corrected.y,
        pdx: cmd.platformDelta.x,
        g: this.grounded,
      });
      if (this.trace.length > 300) this.trace.shift();
    }

    // velocity fixups from the collide-and-slide result (own motion only)
    vel.x = corrected.x / SIM_DT;
    vel.z = corrected.z / SIM_DT;
    if (this.grounded && vel.y < 0) {
      vel.y = -1; // keep light ground contact so snap/grounded stays stable
    } else if (!this.grounded && vel.y > 0 && corrected.y < this.desired.y - 1e-4) {
      vel.y = 0; // bonked a ceiling
    }
    if (!wasGrounded && this.grounded) this.justLanded = true;
  }

  /** Set by preStep on the tick the capsule regains ground contact. */
  justLanded = false;

  /** DEV-only per-tick trace ring buffer for movement debugging. */
  readonly trace: { dx: number; cx: number; dy: number; cy: number; pdx: number; g: boolean }[] =
    [];

  consumeLanded(): boolean {
    const v = this.justLanded;
    this.justLanded = false;
    return v;
  }

  dispose(): void {
    this.physics.unregister(this.collider);
    this.physics.world.removeCharacterController(this.cc);
    this.physics.world.removeRigidBody(this.body);
  }

  /**
   * What platform is directly under our feet (pre-move positions). Sampled at
   * the capsule bottom center plus four planar offsets so standing near an
   * edge — common while riding a moving platform — never loses the contact.
   */
  standingOnPlatformId(): number | null {
    if (!this.grounded) return null;
    const t = this.body.translation();
    const originY = t.y - CAPSULE_HALF_HEIGHT;
    const reach = CAPSULE_RADIUS + 0.45;
    const r = CAPSULE_RADIUS * 0.8;
    const offsets: [number, number][] = [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ];
    for (const [ox, oz] of offsets) {
      const hit = this.physics.castDown(
        { x: t.x + ox, y: originY, z: t.z + oz },
        reach,
        this.collider,
      );
      if (hit && hit.tag.kind === "platform") return hit.tag.platformId;
    }
    return null;
  }
}
