import {partMass,wheelRadius,wheelGrip,springFactor,thrustForce,gyroFactor,wingArea,balloonLift} from "./customization.js";
import { Quaternion, Vector3 } from "three";
import type {
  RapierModule,
  RapierRigidBody,
  RapierWorld,
} from "../../physics/physics.js";
import type { DynamicRayCastVehicleController } from "@dimforge/rapier3d-compat";
import {
  surfaceY,
  WORLD_X,
  WORLD_Y,
  WORLD_Z,
  type VoxelWorld,
} from "../voxelWorld.js";
import {
  blueprintError,
  DIRECTIONS,
  usesSkylarkModel,
  PARTS,
  type Blueprint,
} from "./blueprint.js";
import {
  AIR,
  angleOfAttack,
  dragForce,
  panelForce,
  pointVelocity,
} from "./aero.js";
import {
  ASSIST,
  controlAxis,
  MachineFault,
  PHYSICS_RULES as RULES,
} from "./physicsRules.js";

export interface MachineInput {
  throttle: number;
  steer: number;
  lift: number;
  boost: boolean;
  brake: boolean;
  pitch: number;
  roll: number;
  /** Climb/descend request while assist flies the throttle: -1, 0 or 1. */
  vertical: number;
  /** Beginner autopilot: level the machine and hold altitude. */
  assist: boolean;
}
export const IDLE_INPUT: MachineInput = {
  throttle: 0,
  steer: 0,
  lift: 0,
  boost: false,
  brake: false,
  pitch: 0,
  roll: 0,
  vertical: 0,
  assist: false,
};

/** One compound rigid body per connected machine. Wheels use suspension rays;
 * thrusters apply force at their mounting point, so off-center thrust turns it. */
export class MachinePhysics {
  readonly world: RapierWorld;
  readonly body: RapierRigidBody;
  readonly wheels: DynamicRayCastVehicleController;
  readonly wheelParts: number[] = [];
  /** Wheels AHEAD of the cockpit steer (PARTS.wheel.detail), so steering doesn't depend on where
   *  the blueprint's origin happens to sit. */
  private readonly steerFromZ: number;
  private readonly terrain = new Map<string, RapierRigidBody>();
  private readonly rotation = new Quaternion();
  private readonly force = new Vector3();
  private readonly point = new Vector3();
  private readonly arm = new Vector3();
  private readonly flow = new Vector3();
  private readonly normal = new Vector3();
  private readonly scratch = new Vector3();
  private readonly gyro: boolean;
  private readonly gyroStrength:number;
  private readonly surfaces: number[] = [];
  /** Lift-thruster count and the throttle fraction that cancels gravity. */
  readonly liftThrusters: number;
  private readonly hoverBias: number;
  private readonly up = new Vector3();
  private readonly level = new Vector3();
  private chunkKey = "";
  /** Last-step telemetry for the HUD; not part of the simulation state. */
  private aeroLift = 0;
  private aeroAngle = 0;
  private hoverThrottle = 0;
  private grounded = false;

  constructor(
    private readonly rapier: RapierModule,
    private readonly voxels: VoxelWorld,
    readonly blueprint: Blueprint,
    origin: { x: number; y: number; z: number },
  ) {
    const error = blueprintError(blueprint);
    if (error) throw new MachineFault("INVALID_BLUEPRINT", error);
    this.steerFromZ = blueprint.parts.find((p) => p.kind === "cockpit")?.cell[2] ?? 0;
    if (![origin.x, origin.y, origin.z].every(Number.isFinite))
      throw new MachineFault("INVALID_INPUT", "출발 위치가 올바르지 않습니다.");
    this.world = new rapier.World({ x: 0, y: -RULES.gravity, z: 0 });
    this.world.timestep = RULES.timestep;
    this.body = this.world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinearDamping(0.15)
        .setAngularDamping(0.5)
        .setCcdEnabled(true),
    );
    this.wheels = this.world.createVehicleController(this.body);
    this.wheels.indexUpAxis = 1;
    this.wheels.setIndexForwardAxis = 2;
    const skylark = usesSkylarkModel(blueprint);
    blueprint.parts.forEach((part, partIndex) => {
      const [x, y, z] = part.cell;
      const collider = rapier.ColliderDesc.cuboid(0.48, skylark && y === 0 ? 0.25 : 0.48, 0.48)
        .setTranslation(x, y, z)
        .setMass(partMass(part,PARTS[part.kind].mass))
        .setFriction(0.6)
        .setRestitution(0.05);
      if (part.kind === "wheel") collider.setSensor(true);
      this.world.createCollider(collider, this.body);
      if (part.kind !== "wheel") return;
      const i = this.wheelParts.length;
      this.wheelParts.push(partIndex);
      this.wheels.addWheel(
        { x, y, z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        RULES.suspensionLength,
        wheelRadius(part),
      );
      this.wheels.setWheelSuspensionStiffness(i, RULES.suspensionStiffness*springFactor(part));
      this.wheels.setWheelSuspensionCompression(i, RULES.suspensionCompression*Math.sqrt(springFactor(part)));
      this.wheels.setWheelSuspensionRelaxation(i, RULES.suspensionRelaxation*Math.sqrt(springFactor(part)));
      this.wheels.setWheelMaxSuspensionTravel(i, RULES.maxSuspensionTravel);
      this.wheels.setWheelMaxSuspensionForce(i, RULES.maxSuspensionForce);
      this.wheels.setWheelFrictionSlip(i, wheelGrip(part));
      this.wheels.setWheelSideFrictionStiffness(i, 1);
    });
    if (skylark) {
      // Blender skid soles at y=.0165, with the visual offset by -.5 m.
      for (const x of [-1.11, 1.11]) {
        this.world.createCollider(rapier.ColliderDesc.cuboid(.09, .055, 1.60)
          .setTranslation(x, -.4285, .20).setMass(0).setFriction(.6), this.body);
      }
    }
    this.gyro = blueprint.parts.some((p) => p.kind === "gyro");
    this.gyroStrength=Math.max(0,...blueprint.parts.filter(p=>p.kind==="gyro").map(gyroFactor));
    this.liftThrusters = blueprint.parts.filter(
      (p) => p.kind === "thruster" && p.direction === 0,
    ).length;
    // Feed-forward term for hover: the throttle fraction that exactly cancels
    // weight. Above 1 the build simply cannot hold itself up, and assist will
    // not pretend otherwise.
    const weight = this.body.mass() * RULES.gravity;
    this.hoverBias = this.liftThrusters
      ? weight / blueprint.parts.filter(p=>p.kind==="thruster"&&p.direction===0).reduce((n,p)=>n+thrustForce(p),0)
      : 0;
    blueprint.parts.forEach((part, index) => {
      if (part.kind === "wing" || part.kind === "balloon")
        this.surfaces.push(index);
    });
    this.updateTerrain();
    this.world.updateSceneQueries();
  }

  private updateTerrain(): void {
    const p = this.body.translation();
    const cx = Math.floor(p.x / 16),
      cz = Math.floor(p.z / 16);
    const chunkKey = `${cx},${cz}`;
    if (chunkKey === this.chunkKey) return;
    this.chunkKey = chunkKey;
    const needed = new Set<string>();
    for (let z = cz - 1; z <= cz + 1; z++)
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (!this.voxels.outsideColumn && (x < 0 || z < 0 || x * 16 >= WORLD_X || z * 16 >= WORLD_Z)) continue;
        const key = `${x},${z}`;
        needed.add(key);
        if (this.terrain.has(key)) continue;
        const body = this.world.createRigidBody(
          this.rapier.RigidBodyDesc.fixed(),
        );
        this.terrain.set(key, body);
        // Merge identical adjacent voxel columns into boxes, preserving caves,
        // doorways and edited terrain instead of approximating it with a heightmap.
        for (let iz = z * 16; iz < (z + 1) * 16; iz++) {
          let runX = x * 16,
            previous = "",
            spans: [number, number][] = [];
          const flush = (end: number) => {
            for (const [bottom, top] of spans) {
              this.world.createCollider(
                this.rapier.ColliderDesc.cuboid(
                  (end - runX) / 2,
                  (top - bottom) / 2,
                  0.5,
                )
                  .setTranslation(
                    (end + runX) / 2,
                    (top + bottom) / 2,
                    iz + 0.5,
                  )
                  .setFriction(0.8),
                body,
              );
            }
          };
          for (let ix = x * 16; ix <= (x + 1) * 16; ix++) {
            const current: [number, number][] = [];
            if (ix < (x + 1) * 16) {
              for (let y = 0; y < WORLD_Y; ) {
                // isBlocked, not isSolid: furniture is solid to machines too,
                // or a test drive would plough straight through a sofa
                if (!this.voxels.isBlocked(ix, y, iz)) {
                  y++;
                  continue;
                }
                const bottom = y++;
                while (y < WORLD_Y && this.voxels.isBlocked(ix, y, iz)) y++;
                current.push([bottom, y]);
              }
            }
            const signature = JSON.stringify(current);
            if (signature !== previous) {
              flush(ix);
              runX = ix;
              spans = current;
              previous = signature;
            }
          }
        }
      }
    for (const [key, body] of this.terrain)
      if (!needed.has(key)) {
        this.world.removeRigidBody(body);
        this.terrain.delete(key);
      }
  }

  step(input: MachineInput): void {
    input = {
      ...input,
      throttle: controlAxis(input.throttle),
      steer: controlAxis(input.steer),
      lift: controlAxis(input.lift, true),
      pitch: controlAxis(input.pitch),
      roll: controlAxis(input.roll),
      vertical: controlAxis(input.vertical),
    };
    this.updateTerrain();
    this.world.updateSceneQueries();
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const p = this.body.translation(),
      q = this.body.rotation();
    this.rotation.set(q.x, q.y, q.z, q.w);
    const speed = this.body.linvel();
    const magnitude = Math.hypot(speed.x, speed.y, speed.z);
    for (let i = 0; i < this.wheelParts.length; i++) {
      const part = this.blueprint.parts[this.wheelParts[i]!]!;
      this.wheels.setWheelEngineForce(
        i,
        magnitude < RULES.poweredSpeedLimit
          ? input.throttle * RULES.wheelForce * RULES.wheelRadius / wheelRadius(part)
          : 0,
      );
      this.wheels.setWheelBrake(
        i,
        input.brake ? 30 : input.throttle === 0 ? 0.8 : 0,
      );
      this.wheels.setWheelSteering(
        i,
        part.cell[2] > this.steerFromZ ? input.steer * RULES.steeringAngle : 0,
      );
    }
    this.wheels.updateVehicle(
      RULES.timestep,
      this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      (collider) => collider.parent()?.handle !== this.body.handle,
    );
    this.grounded = this.wheelParts.some((_, i) =>
      this.wheels.wheelIsInContact(i),
    );
    this.hoverThrottle = this.hoverAssist(input, speed.y);
    for (const part of this.blueprint.parts) {
      if (part.kind !== "thruster") continue;
      const activation =
        part.direction === 0
          ? Math.max(input.lift, this.hoverThrottle)
          : input.boost
            ? 1
            : 0;
      if (!activation) continue;
      this.force
        .fromArray(DIRECTIONS[part.direction]!.vector)
        .applyQuaternion(this.rotation)
        .multiplyScalar(thrustForce(part) * activation);
      this.point.fromArray(part.cell).applyQuaternion(this.rotation).add(p);
      this.body.addForceAtPoint(this.force, this.point, true);
    }
    this.applyAerodynamics();
    if (this.gyro) {
      const angular = this.body.angvel();
      // Assist aims the gyro at an attitude. Open-loop pitch torque never
      // stops while the key is held, and that is what loops the plane.
      const hold = this.attitudeHold(input);
      this.force
        .set(
          hold ? 0 : input.pitch * RULES.gyroPitchTorque,
          input.steer * RULES.gyroYawTorque,
          hold ? 0 : input.roll * RULES.gyroRollTorque,
        )
        .applyQuaternion(this.rotation);
      this.force.multiplyScalar(this.gyroStrength);
      this.force.x -= angular.x * RULES.gyroDamping*this.gyroStrength;
      this.force.y -= angular.y * RULES.gyroDamping*this.gyroStrength;
      this.force.z -= angular.z * RULES.gyroDamping*this.gyroStrength;
      if (hold) {
        // body up × target up. Length is sin(error), so it fades out as the
        // machine arrives. Target is world up when the stick is free.
        this.up.set(0, 1, 0).applyQuaternion(this.rotation);
        // Nose-up still gets the full stick: that angle makes lift, and
        // easing it while sinking would throw the save away. Nose-down
        // eases off once the sink says the wings are pushing down.
        const pitch =
          input.pitch > 0
            ? input.pitch * this.pitchAuthority(speed.y, this.forwardSpeed(speed))
            : input.pitch;
        this.desiredUp(pitch, input.roll, this.scratch);
        this.level.crossVectors(this.up, this.scratch);
        this.force.addScaledVector(this.level, ASSIST.levelTorque*this.gyroStrength);
        this.force.x -= angular.x * ASSIST.levelDamping*this.gyroStrength;
        this.force.z -= angular.z * ASSIST.levelDamping*this.gyroStrength;
      }
      this.body.addTorque(this.force, true);
    }
    this.world.step();
    const state = this.snapshot();
    if (
      ![
        ...Object.values(state.position),
        ...Object.values(state.rotation),
        state.speed,
      ].every(Number.isFinite)
    ) {
      throw new MachineFault(
        "NON_FINITE_STATE",
        "물리 계산이 불안정해 시험을 중단했습니다.",
      );
    }
  }

  /**
   * Wings and balloons are the same rule as thrusters: a force at a mounting
   * point, so where you bolt them decides whether the machine lifts or tumbles.
   * Flow is the velocity of that point (v + ω × r), not the body's velocity,
   * which is what lets a tail surface damp a spin.
   */
  private applyAerodynamics(): void {
    this.aeroLift = 0;
    this.aeroAngle = 0;
    if (!this.surfaces.length) return;
    const linear = this.body.linvel(),
      angular = this.body.angvel(),
      com = this.body.worldCom(),
      origin = this.body.translation();
    for (const index of this.surfaces) {
      const part = this.blueprint.parts[index]!;
      this.point
        .fromArray(part.cell)
        .applyQuaternion(this.rotation)
        .add(origin);
      this.arm.copy(this.point).sub(com);
      pointVelocity(linear, angular, this.arm, this.flow);
      if (part.kind === "balloon") {
        dragForce(this.flow, AIR.balloonArea*(balloonLift(part)/AIR.balloonLift)**(2/3), AIR.balloonDrag, this.force);
        this.force.y += balloonLift(part);
      } else {
        this.normal
          .fromArray(DIRECTIONS[part.direction]!.vector)
          .applyQuaternion(this.rotation);
        panelForce(
          this.flow,
          this.normal,
          wingArea(part),
          AIR.wingNormalCoefficient,
          this.force,
        );
        this.aeroAngle = Math.max(
          this.aeroAngle,
          Math.abs(angleOfAttack(this.flow, this.normal)),
        );
        this.force.add(
          dragForce(
            this.flow,
            wingArea(part) * 0.12,
            AIR.wingEdgeDrag,
            this.scratch,
          ),
        );
      }
      this.aeroLift += this.force.y;
      this.body.addForceAtPoint(this.force, this.point, true);
    }
  }

  /**
   * Assist flies pitch and roll as a limited attitude, using the gyro the
   * machine already has. Off the wheels only: a car must sit on its slope.
   * Past levelLimit with the stick released, a finished roll is left alone.
   * While the stick is held, keep aiming at the target even past that limit,
   * or a bump turns the hold back into the tumble it exists to prevent.
   */
  private attitudeHold(input: MachineInput): boolean {
    if (!input.assist || this.grounded || !this.gyro) return false;
    const commanded =
      Math.abs(input.pitch) > 0.01 || Math.abs(input.roll) > 0.01;
    this.up.set(0, 1, 0).applyQuaternion(this.rotation);
    const tilt = Math.acos(Math.max(-1, Math.min(1, this.up.y)));
    return commanded || tilt < ASSIST.levelLimit;
  }

  /** How much of a nose-down stick the gyro should still chase.
   * 1 at a hover. Fades as forward speed climbs or the machine starts to
   * sink, because a steep nose turns the glider's wings into downforce. */
  private pitchAuthority(verticalSpeed: number, forward: number): number {
    const drop = -verticalSpeed - ASSIST.pitchEase;
    const sink =
      drop <= 0 || ASSIST.pitchEaseSpan <= 0
        ? 1
        : Math.max(0, 1 - drop / ASSIST.pitchEaseSpan);
    const fast =
      ASSIST.pitchSpeedSpan <= 0
        ? 1
        : Math.max(0, 1 - Math.max(0, forward - ASSIST.pitchSpeed) / ASSIST.pitchSpeedSpan);
    return Math.min(sink, fast);
  }

  /** Speed along the level nose. Negative when the machine is backing up. */
  private forwardSpeed(velocity: { x: number; y: number; z: number }): number {
    const nose = this.flow.set(0, 0, 1).applyQuaternion(this.rotation);
    nose.y = 0;
    const span = Math.hypot(nose.x, nose.z);
    if (span < 1e-6) return 0;
    return (velocity.x * nose.x + velocity.z * nose.z) / span;
  }

  /**
   * Where the top of the machine should point, in the world.
   * The axes are the LEVEL nose and right — the body's yaw only. Building
   * them from the tilted body makes the target chase the tilt and loop.
   * +pitch (ArrowUp) tips the top toward the nose, so lift leans forward.
   * +roll (Q) tips the top toward the body's left, matching raw +Z torque.
   */
  private desiredUp(pitch: number, roll: number, out: Vector3): Vector3 {
    const nose = this.point.set(0, 0, 1).applyQuaternion(this.rotation);
    nose.y = 0;
    if (nose.lengthSq() < 1e-6) nose.set(0, 0, 1);
    else nose.normalize();
    // right = world up × nose. A nose of +Z gives right +X.
    const right = this.arm.set(nose.z, 0, -nose.x);
    const x = -Math.sin(roll * ASSIST.stickAngle);
    const z = Math.sin(pitch * ASSIST.stickAngle);
    const rest = 1 - x * x - z * z;
    const y = rest > 0 ? Math.sqrt(rest) : 0;
    return out.set(0, y, 0).addScaledVector(right, x).addScaledVector(nose, z);
  }

  /**
   * Auto-throttle for the lift thrusters: feed-forward to cancel weight, plus
   * a proportional term on the error between the requested climb rate and the
   * real one. Returns 0 whenever the pilot is on the stick or there is nothing
   * to throttle, so a build that cannot lift itself still falls.
   */
  private hoverAssist(input: MachineInput, verticalSpeed: number): number {
    if (!input.assist || !this.liftThrusters || input.lift > 0) return 0;
    if (this.grounded && input.vertical <= 0) return 0;
    const target =
      input.vertical > 0
        ? ASSIST.climbRate
        : input.vertical < 0
          ? ASSIST.descendRate
          : 0;
    const throttle =
      this.hoverBias + (target - verticalSpeed) * ASSIST.hoverGain;
    return Math.max(0, Math.min(1, throttle));
  }

  /** Top face of the terrain column under the machine: cells occupy [y, y+1),
   * so the walkable surface is one above the highest solid cell. */
  private groundHeight(x: number, z: number): number {
    const ix = Math.floor(x),
      iz = Math.floor(z);
    if (!this.voxels.outsideColumn && (ix < 0 || iz < 0 || ix >= WORLD_X || iz >= WORLD_Z)) return 0;
    return surfaceY(this.voxels, ix, iz) + 1;
  }

  snapshot() {
    const p = this.body.translation(),
      v = this.body.linvel(),
      w = this.body.angvel(),
      q = this.body.rotation();
    return {
      rulesRevision: RULES.revision,
      position: { ...p },
      rotation: { ...q },
      velocity: { ...v },
      speed: Math.hypot(v.x, v.y, v.z),
      spin: Math.hypot(w.x, w.y, w.z),
      mass: this.body.mass(),
      altitude: p.y - this.groundHeight(p.x, p.z),
      aeroLift: this.aeroLift,
      aeroAngle: this.aeroAngle,
      hoverThrottle: this.hoverThrottle,
      liftThrusters: this.liftThrusters,
      /** 1 means the lift thrusters can exactly carry the weight at full throttle. */
      hoverBias: this.hoverBias,
      canHover: this.liftThrusters > 0 && this.hoverBias <= 1,
      canLevel: this.gyro,
      wheels: this.wheelParts.length,
      contacts: this.wheelParts.filter((_, i) =>
        this.wheels.wheelIsInContact(i),
      ).length,
    };
  }

  /** Put the machine back at the start without rebuilding the world. */
  respawn(origin: { x: number; y: number; z: number }): void {
    if (![origin.x, origin.y, origin.z].every(Number.isFinite))
      throw new MachineFault("INVALID_INPUT", "복귀 위치가 올바르지 않습니다.");
    this.body.setTranslation(origin, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.updateTerrain();
    this.world.updateSceneQueries();
  }

  dispose(): void {
    this.world.free();
  }
}
