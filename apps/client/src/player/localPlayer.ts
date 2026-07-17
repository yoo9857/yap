import * as THREE from "three";
import {
  MOVE_SPEED,
  SIM_DT,
  isFiniteVec3,
  type AnimState,
  type Vec3,
} from "@robo/shared";
import type { PhysicsWorld } from "../physics/physics.js";
import type { InterpolatedTransform, InterpolationStore } from "../physics/interpolation.js";
import type { LevelRuntime } from "../world/levelRuntime.js";
import { TriggerField } from "../world/triggers.js";
import { CharacterController } from "./controller.js";
import { createJumpState, resetJumpState, updateJump } from "./jumpLogic.js";
import { CharacterRig, disposeRig } from "./rig.js";
import type { InputFrame } from "../input/inputState.js";

export type DeathCause = "kill-plane" | "hazard" | "reset";

export interface PlayerEvents {
  onJump?(): void;
  onLand?(): void;
  onDeath?(cause: DeathCause): void;
  onRespawn?(): void;
  onCheckpoint?(index: number): void;
  onGoal?(): void;
  onGoalBlocked?(): void;
}

const DEATH_PAUSE_S = 1.0;
const HEAD_OFFSET = new THREE.Vector3(0, 1.5, 0);

export class LocalPlayer {
  status: "alive" | "dead" | "finished" = "alive";
  checkpoint = -1;
  falls = 0;
  anim: AnimState = "idle";

  readonly controller: CharacterController;
  readonly rig = new CharacterRig();
  private readonly interp: InterpolatedTransform;
  private readonly triggers: TriggerField;
  private readonly jumpState = createJumpState();
  private readonly rideDelta = new THREE.Vector3();
  private readonly rideVelocity = new THREE.Vector3();
  private facingYaw = 0;
  private deadTimer = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
    interpStore: InterpolationStore,
    private readonly level: LevelRuntime,
    private readonly events: PlayerEvents = {},
  ) {
    this.triggers = new TriggerField(level.level);
    this.controller = new CharacterController(physics, level.level.spawn);
    this.interp = interpStore.create(new THREE.Vector3(...level.level.spawn));
    scene.add(this.rig.root);
  }

  /** Runs after platforms set their kinematic targets, before physics.step(). */
  fixedUpdate(input: InputFrame, cameraYaw: number, tick: number): void {
    if (this.status === "dead") {
      this.deadTimer -= SIM_DT;
      if (this.deadTimer <= 0) this.respawn();
      return;
    }
    if (input.respawnPressed && this.status === "alive") {
      this.die("reset");
      return;
    }

    // camera-relative wish velocity
    const fx = -Math.sin(cameraYaw);
    const fz = -Math.cos(cameraYaw);
    const rx = Math.cos(cameraYaw);
    const rz = -Math.sin(cameraYaw);
    let wishX = fx * input.moveZ + rx * input.moveX;
    let wishZ = fz * input.moveZ + rz * input.moveX;
    const len = Math.hypot(wishX, wishZ);
    if (len > 1) {
      wishX /= len;
      wishZ /= len;
    }

    // what are we standing on? (pre-move positions — platforms haven't stepped yet)
    this.rideDelta.set(0, 0, 0);
    this.rideVelocity.set(0, 0, 0);
    const platformId = this.controller.standingOnPlatformId();
    if (platformId !== null) {
      const entity = this.level.byId.get(platformId);
      if (entity) {
        entity.onStand(); // crumbling platforms start their local FSM here
        entity.rideDelta(this.rideDelta);
        entity.rideVelocity(this.rideVelocity);
      }
    }

    const doJump = updateJump(this.jumpState, tick, this.controller.grounded, input.jumpPressed);
    if (doJump) this.events.onJump?.();

    this.controller.preStep({
      wishVelX: wishX * MOVE_SPEED,
      wishVelZ: wishZ * MOVE_SPEED,
      doJump,
      jumpHeld: input.jumpHeld,
      platformDelta: this.rideDelta,
      platformVelocity: this.rideVelocity,
    });
    if (this.controller.consumeLanded()) this.events.onLand?.();

    // face where we're moving
    const vel = this.controller.velocity;
    if (Math.hypot(vel.x, vel.z) > 0.8) {
      this.facingYaw = Math.atan2(vel.x, vel.z);
    }
  }

  /** Runs after physics.step(): triggers, watchdog, interpolation commit. */
  postStep(): void {
    const feet = this.controller.feetPosition();

    // NaN watchdog: a physics blowup must never propagate
    if (!isFiniteVec3(feet) || !isFiniteVec3([...this.controller.velocity.toArray()] as Vec3)) {
      console.error("[watchdog] non-finite player state — teleporting to checkpoint", feet);
      this.controller.teleportToFeet(this.triggers.respawnPoint(this.checkpoint));
      this.interp.reset(new THREE.Vector3(...this.controller.feetPosition()), this.facingYaw);
      return;
    }

    if (this.status === "alive") {
      const hit = this.triggers.check(feet, this.checkpoint);
      if (hit) {
        switch (hit.kind) {
          case "death":
            this.die(hit.cause);
            break;
          case "checkpoint":
            this.checkpoint = hit.index;
            this.level.setCheckpointActive(hit.index);
            this.events.onCheckpoint?.(hit.index);
            break;
          case "goal":
            this.status = "finished";
            this.events.onGoal?.();
            break;
          case "goal-blocked":
            this.events.onGoalBlocked?.();
            break;
        }
      }
    }

    this.updateAnim();
    this.interp.commit(
      { x: feet[0], y: feet[1], z: feet[2] },
      this.facingYaw,
    );
  }

  frameUpdate(alpha: number, frameDt: number): void {
    this.interp.lerpedPosition(alpha, this.rig.root.position);
    this.rig.root.rotation.y = this.interp.lerpedYaw(alpha);
    const vel = this.controller.velocity;
    this.rig.update(this.anim, Math.hypot(vel.x, vel.z), frameDt);
  }

  /** Interpolated head position for the camera. */
  headPosition(alpha: number, out: THREE.Vector3): THREE.Vector3 {
    return this.interp.lerpedPosition(alpha, out).add(HEAD_OFFSET);
  }

  get yaw(): number {
    return this.facingYaw;
  }

  /** Server said our position is implausible — snap back, no questions. */
  applyCorrection(feet: Vec3): void {
    this.controller.teleportToFeet(feet);
    this.interp.reset(new THREE.Vector3(...feet), this.facingYaw);
  }

  private updateAnim(): void {
    if (this.status === "dead") {
      this.anim = "dead";
      return;
    }
    const vel = this.controller.velocity;
    if (this.controller.grounded) {
      this.anim = Math.hypot(vel.x, vel.z) > 0.5 ? "run" : "idle";
    } else {
      this.anim = vel.y > 1 ? "jump" : "fall";
    }
  }

  private die(cause: DeathCause): void {
    if (this.status !== "alive") return;
    this.status = "dead";
    this.falls++;
    this.deadTimer = DEATH_PAUSE_S;
    this.anim = "dead";
    this.controller.velocity.set(0, 0, 0);
    this.events.onDeath?.(cause);
  }

  private respawn(): void {
    const feet = this.triggers.respawnPoint(this.checkpoint);
    this.controller.teleportToFeet(feet);
    resetJumpState(this.jumpState);
    this.status = "alive";
    this.anim = "idle";
    this.interp.reset(new THREE.Vector3(...feet), this.facingYaw);
    this.events.onRespawn?.();
  }

  /** Teardown for level rebuild (daily rollover). */
  dispose(scene: THREE.Scene, interpStore: InterpolationStore): void {
    scene.remove(this.rig.root);
    disposeRig(this.rig.root);
    interpStore.remove(this.interp);
    this.controller.dispose();
  }

  /** Full run reset (new game from title screen). */
  resetRun(): void {
    this.checkpoint = -1;
    this.falls = 0;
    this.status = "alive";
    this.level.resetCheckpoints();
    const feet = this.triggers.respawnPoint(-1);
    this.controller.teleportToFeet(feet);
    resetJumpState(this.jumpState);
    this.interp.reset(new THREE.Vector3(...feet), 0);
    this.facingYaw = 0;
  }
}
