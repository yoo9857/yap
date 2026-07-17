import * as THREE from "three";
import {
  CRUMBLE_GONE_S,
  CRUMBLE_SHAKE_S,
  SIM_DT,
  movingPlatformCenter,
  movingPlatformVelocity,
  type CrumblingPlatformDef,
  type MovingPlatformDef,
  type PlatformDef,
  type SolidPlatformDef,
} from "@robo/shared";
import type { PhysicsWorld, RapierCollider, RapierRigidBody } from "../physics/physics.js";
import type { InterpolatedTransform, InterpolationStore } from "../physics/interpolation.js";
import {
  CRACKED_MATERIAL,
  LAVA_MATERIAL,
  ROLE_COLORS,
  brickColorByIndex,
  brickMaterial,
} from "./materials.js";

export interface PlatformEntity {
  readonly def: PlatformDef;
  readonly collider: RapierCollider;
  readonly mesh: THREE.Object3D;
  /** Displacement of the platform surface during the current tick. */
  rideDelta(out: THREE.Vector3): THREE.Vector3;
  /** Instantaneous surface velocity (inherited when jumping off). */
  rideVelocity(out: THREE.Vector3): THREE.Vector3;
  /** Local player is standing on this platform this tick. */
  onStand(): void;
  fixedUpdate(tickTime: number): void;
  frameUpdate(alpha: number, timeSec: number): void;
  /** Full teardown — level rebuild (daily rollover) removes everything. */
  dispose(scene: THREE.Scene, physics: PhysicsWorld): void;
}

function disposeMesh(scene: THREE.Scene, mesh: THREE.Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose(); // materials are shared via the cache — keep them
}

/** One doodle tile per ~2 m so block textures REPEAT instead of stretching
 *  across big platforms (BoxGeometry faces map 0..1 by default). Repeats are
 *  rounded to WHOLE tiles per face — the tiles carry drawn ink borders, and a
 *  fractional repeat slices those borders mid-face (looks broken). */
const TILE_M = 2;
const wholeTiles = (m: number) => Math.max(1, Math.round(m / TILE_M));
function scaleBoxUVs(geo: THREE.BoxGeometry, sx: number, sy: number, sz: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims: [number, number][] = [
    [sz, sy],
    [sz, sy],
    [sx, sz],
    [sx, sz],
    [sx, sy],
    [sx, sy],
  ];
  for (let i = 0; i < uv.count; i++) {
    const d = dims[(i / 4) | 0]!;
    uv.setXY(i, uv.getX(i) * wholeTiles(d[0]), uv.getY(i) * wholeTiles(d[1]));
  }
  uv.needsUpdate = true;
}

function buildBoxMesh(def: PlatformDef, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
  scaleBoxUVs(geo, def.size[0], def.size[1], def.size[2]);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(def.center[0], def.center[1], def.center[2]);
  return mesh;
}

const ZERO_DELTA = (out: THREE.Vector3) => out.set(0, 0, 0);

// ---------------------------------------------------------------- solid

export class SolidPlatform implements PlatformEntity {
  readonly collider: RapierCollider;
  readonly mesh: THREE.Mesh;
  private readonly body: RapierRigidBody;
  private lavaMesh: THREE.Mesh | null = null;

  constructor(
    readonly def: SolidPlatformDef,
    scene: THREE.Scene,
    physics: PhysicsWorld,
  ) {
    const color =
      def.role === "normal" ? brickColorByIndex(def.colorIndex) : ROLE_COLORS[def.role];
    const mesh = buildBoxMesh(def, brickMaterial(color));
    scene.add(mesh);
    this.mesh = mesh;

    this.body = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.fixed().setTranslation(...def.center),
    );
    this.collider = physics.world.createCollider(
      physics.rapier.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2),
      this.body,
    );
    physics.register(this.collider, { kind: "platform", platformId: def.id });

    // lava brick: visual only — death is an analytic trigger, not a collision
    if (def.hazard) {
      const h = def.hazard;
      const lavaGeo = new THREE.BoxGeometry(h.size[0], h.size[1], h.size[2]);
      scaleBoxUVs(lavaGeo, h.size[0], h.size[1], h.size[2]);
      this.lavaMesh = new THREE.Mesh(lavaGeo, LAVA_MATERIAL);
      this.lavaMesh.position.set(h.center[0], h.center[1], h.center[2]);
      this.lavaMesh.castShadow = true;
      scene.add(this.lavaMesh);
    }
  }

  rideDelta = ZERO_DELTA;
  rideVelocity = ZERO_DELTA;
  onStand(): void {}
  fixedUpdate(): void {}
  frameUpdate(): void {}

  dispose(scene: THREE.Scene, physics: PhysicsWorld): void {
    disposeMesh(scene, this.mesh);
    if (this.lavaMesh) disposeMesh(scene, this.lavaMesh);
    physics.unregister(this.collider);
    physics.world.removeRigidBody(this.body);
  }
}

// ---------------------------------------------------------------- moving

export class MovingPlatform implements PlatformEntity {
  readonly collider: RapierCollider;
  readonly mesh: THREE.Mesh;
  private readonly body: RapierRigidBody;
  private readonly interp: InterpolatedTransform;
  private readonly interpStore: InterpolationStore;
  private readonly delta = new THREE.Vector3();
  private tickTime = 0;

  constructor(
    readonly def: MovingPlatformDef,
    scene: THREE.Scene,
    physics: PhysicsWorld,
    interpStore: InterpolationStore,
  ) {
    this.interpStore = interpStore;
    this.mesh = buildBoxMesh(def, brickMaterial(brickColorByIndex(def.colorIndex)));
    scene.add(this.mesh);

    const start = movingPlatformCenter(def, 0);
    this.body = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(...start),
    );
    this.collider = physics.world.createCollider(
      physics.rapier.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2),
      this.body,
    );
    physics.register(this.collider, { kind: "platform", platformId: def.id });

    this.interp = interpStore.create(new THREE.Vector3(...start));
    this.mesh.position.set(...start);
  }

  /**
   * Runs BEFORE the player's character-controller pass each tick.
   * Deliberately `setTranslation` (teleport), NOT setNextKinematicTranslation:
   * the latter gives the body an internal velocity that Rapier's character
   * controller partially — and unreliably — applies to riders on its own,
   * which double-carries against our explicit platformDelta and flings the
   * player off. With teleports the platform looks static to the KCC and the
   * explicit delta below is the single source of carry.
   */
  fixedUpdate(tickTime: number): void {
    this.tickTime = tickTime;
    const prev = movingPlatformCenter(this.def, tickTime - SIM_DT);
    const next = movingPlatformCenter(this.def, tickTime);
    this.delta.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    this.body.setTranslation({ x: next[0], y: next[1], z: next[2] }, true);
    this.interp.commit({ x: next[0], y: next[1], z: next[2] });
  }

  rideDelta(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.delta);
  }

  rideVelocity(out: THREE.Vector3): THREE.Vector3 {
    const v = movingPlatformVelocity(this.def, this.tickTime);
    return out.set(v[0], v[1], v[2]);
  }

  onStand(): void {}

  frameUpdate(alpha: number): void {
    this.interp.lerpedPosition(alpha, this.mesh.position);
  }

  dispose(scene: THREE.Scene, physics: PhysicsWorld): void {
    disposeMesh(scene, this.mesh);
    this.interpStore.remove(this.interp);
    physics.unregister(this.collider);
    physics.world.removeRigidBody(this.body);
  }
}

// ---------------------------------------------------------------- crumbling

type CrumbleState = "idle" | "shaking" | "gone";

export class CrumblingPlatform implements PlatformEntity {
  readonly collider: RapierCollider;
  readonly mesh: THREE.Mesh;
  private body: RapierRigidBody;
  private state: CrumbleState = "idle";
  private timer = 0;
  private readonly basePos: THREE.Vector3;
  /** Hook for effects/sfx — wired by the game layer. */
  onCollapse: ((center: THREE.Vector3) => void) | null = null;

  constructor(
    readonly def: CrumblingPlatformDef,
    scene: THREE.Scene,
    physics: PhysicsWorld,
  ) {
    // cracked stone: the visible warning that this brick collapses underfoot
    this.mesh = buildBoxMesh(def, CRACKED_MATERIAL);
    scene.add(this.mesh);
    this.basePos = this.mesh.position.clone();

    this.body = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.fixed().setTranslation(...def.center),
    );
    this.collider = physics.world.createCollider(
      physics.rapier.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2),
      this.body,
    );
    physics.register(this.collider, { kind: "platform", platformId: def.id });
  }

  rideDelta = ZERO_DELTA;
  rideVelocity = ZERO_DELTA;

  onStand(): void {
    if (this.state === "idle") {
      this.state = "shaking";
      this.timer = 0;
      this.onShake?.(this.basePos);
    }
  }

  /** Warning cue the moment the player steps on (legacy behavior). */
  onShake: ((center: THREE.Vector3) => void) | null = null;

  dispose(scene: THREE.Scene, physics: PhysicsWorld): void {
    disposeMesh(scene, this.mesh);
    physics.unregister(this.collider);
    physics.world.removeRigidBody(this.body);
  }

  fixedUpdate(): void {
    if (this.state === "idle") return;
    this.timer += SIM_DT;
    if (this.state === "shaking" && this.timer >= CRUMBLE_SHAKE_S) {
      this.state = "gone";
      this.timer = 0;
      this.collider.setEnabled(false);
      this.mesh.visible = false;
      this.onCollapse?.(this.basePos);
    } else if (this.state === "gone" && this.timer >= CRUMBLE_GONE_S) {
      this.state = "idle";
      this.timer = 0;
      this.collider.setEnabled(true);
      this.mesh.visible = true;
      this.mesh.position.copy(this.basePos);
    }
  }

  frameUpdate(_alpha: number, timeSec: number): void {
    if (this.state === "shaking") {
      this.mesh.position.set(
        this.basePos.x + Math.sin(timeSec * 55) * 0.05,
        this.basePos.y + Math.sin(timeSec * 71) * 0.03,
        this.basePos.z + Math.cos(timeSec * 63) * 0.05,
      );
    }
  }
}
