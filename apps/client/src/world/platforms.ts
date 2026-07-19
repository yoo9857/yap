import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CRUMBLE_GONE_S,
  CRUMBLE_SHAKE_S,
  SIM_DT,
  createRng,
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

// ---- LEGO toy-brick platforms ------------------------------------------------
// Same identity as the voxel modes, taken further: every obby platform is
// TESSELLATED from an assorted set of real LEGO piece shapes — 1×N and 2×N
// bricks, ㄴ/ㄱ corner (L) pieces, and round "O" pieces — packed deterministically
// so it reads as a genuine brick BUILD, not a uniform grid. Studs sit on a 1 m
// grid; same-piece cells fuse while piece boundaries keep a groove, so the
// individual pieces are legible. Colliders stay plain cuboids; this is the look.
const TARGET_BRICK = 0.7; // small cells → platforms are 3–4 studs across, so long 1×4 / 2×4 pieces fit
const AREA_FLAT = 40; // a huge slab (29 m baseplate) stays flat — tessellating it is overkill
const GAP2 = 0.05; // per-side inset → a groove between pieces
const OVER = 0.06; // per-side extend → same-piece cells fuse across the groove

type Cell = [number, number];
interface Piece {
  cells: Cell[]; // occupancy + one stud per cell; (0,0) is always the top-left anchor
  weight: number;
  round?: boolean; // 1×1 "O" → a round cylinder brick
}

/** All piece shapes + rotations that can be anchored at a row-major first-empty
 *  cell (top-left cell filled, nothing reaching up/left of the anchor). */
const PIECES: Piece[] = buildPieceSet();
function buildPieceSet(): Piece[] {
  // weights favour LONG and ROUND pieces and de-emphasise the plain square so
  // platforms don't read as a grid of 2×2s (user: "don't make everything square")
  const bases: Piece[] = [
    { cells: [[0, 0]], weight: 1 }, // 1×1
    { cells: [[0, 0]], weight: 5, round: true }, // O round 1×1
    { cells: [[0, 0], [1, 0]], weight: 6 }, // 1×2
    { cells: [[0, 0], [1, 0], [2, 0]], weight: 6 }, // 1×3
    { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], weight: 7 }, // 1×4 (long)
    { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], weight: 2 }, // 2×2 (square — rarer)
    { cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]], weight: 3 }, // 2×3
    { cells: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1]], weight: 5 }, // 2×4 (long)
    { cells: [[0, 0], [1, 0], [0, 1]], weight: 5 }, // ㄴ / ㄱ corner (L)
  ];
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    let cells = base.cells;
    for (let rot = 0; rot < (base.round ? 1 : 4); rot++) {
      // normalise to the bounding-box top-left
      const minX = Math.min(...cells.map((c) => c[0]));
      const minZ = Math.min(...cells.map((c) => c[1]));
      const norm = cells.map(([x, z]) => [x - minX, z - minZ] as Cell);
      const anchored = norm.some(([x, z]) => x === 0 && z === 0);
      const key = norm.map(([x, z]) => `${x},${z}`).sort().join("|");
      if (anchored && !seen.has(key)) {
        seen.add(key);
        out.push({ cells: norm, weight: base.weight, round: base.round });
      }
      cells = cells.map(([x, z]) => [z, -x] as Cell); // rotate 90°
    }
  }
  return out;
}

/** Deterministically pack an nx×nz cell grid with pieces; returns cell→pieceId
 *  and a round flag per piece. Same seed → same build (stable across rebuilds). */
function tessellate(nx: number, nz: number, seed: number): { cellPiece: Int32Array; round: boolean[] } {
  const rng = createRng((seed * 2654435761) >>> 0);
  const occ = new Uint8Array(nx * nz);
  const cellPiece = new Int32Array(nx * nz).fill(-1);
  const round: boolean[] = [];
  let pid = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      if (occ[z * nx + x]) continue;
      const fits = PIECES.filter((p) =>
        p.cells.every(([dx, dz]) => {
          const gx = x + dx, gz = z + dz;
          return gx >= 0 && gx < nx && gz >= 0 && gz < nz && !occ[gz * nx + gx];
        }),
      );
      const total = fits.reduce((s, p) => s + p.weight, 0);
      let r = rng.next() * total;
      let piece = fits[fits.length - 1]!;
      for (const p of fits) {
        r -= p.weight;
        if (r <= 0) {
          piece = p;
          break;
        }
      }
      for (const [dx, dz] of piece.cells) {
        occ[(z + dz) * nx + (x + dx)] = 1;
        cellPiece[(z + dz) * nx + (x + dx)] = pid;
      }
      round[pid] = !!piece.round;
      pid++;
    }
  }
  return { cellPiece, round };
}

/** Build the merged brick geometry for one platform footprint. */
function brickBuildGeometry(w: number, h: number, d: number, seed: number): THREE.BufferGeometry {
  const nx = Math.max(1, Math.round(w / TARGET_BRICK));
  const nz = Math.max(1, Math.round(d / TARGET_BRICK));
  const cw = w / nx;
  const cd = d / nz;
  const { cellPiece, round } = tessellate(nx, nz, seed);
  const studR = Math.min(cw, cd) * 0.17;
  const parts: THREE.BufferGeometry[] = [];
  const same = (i: number, j: number, pid: number) =>
    i >= 0 && i < nx && j >= 0 && j < nz && cellPiece[j * nx + i] === pid;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const pid = cellPiece[j * nx + i]!;
      const cx = -w / 2 + (i + 0.5) * cw;
      const cz = -d / 2 + (j + 0.5) * cd;
      if (round[pid]) {
        const rad = Math.min(cw, cd) / 2 - GAP2;
        const cyl = new THREE.CylinderGeometry(rad, rad, h, 16).toNonIndexed();
        cyl.translate(cx, 0, cz);
        parts.push(cyl);
      } else {
        // extend toward same-piece neighbours (fuse), inset toward others (seam)
        const minX = cx - cw / 2 + (same(i - 1, j, pid) ? -OVER : GAP2);
        const maxX = cx + cw / 2 - (same(i + 1, j, pid) ? -OVER : GAP2);
        const minZ = cz - cd / 2 + (same(i, j - 1, pid) ? -OVER : GAP2);
        const maxZ = cz + cd / 2 - (same(i, j + 1, pid) ? -OVER : GAP2);
        const bw = maxX - minX, bd = maxZ - minZ;
        const brick = new RoundedBoxGeometry(bw, h, bd, 2, Math.min(bw, h, bd) * 0.12);
        brick.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
        parts.push(brick);
      }
      const s = new THREE.CylinderGeometry(studR, studR * 1.06, 0.12, 12).toNonIndexed();
      s.translate(cx, h / 2 + 0.04, cz);
      parts.push(s);
    }
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged ?? new THREE.BoxGeometry(w, h, d);
}

function buildBoxGeometry(w: number, h: number, d: number, seed: number): THREE.BufferGeometry {
  if (w * d > AREA_FLAT) {
    const geo = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(geo, w, h, d);
    return geo;
  }
  return brickBuildGeometry(w, h, d, seed);
}

function buildBoxMesh(def: PlatformDef, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(
    buildBoxGeometry(def.size[0], def.size[1], def.size[2], def.id),
    material,
  );
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
      this.lavaMesh = new THREE.Mesh(
        buildBoxGeometry(h.size[0], h.size[1], h.size[2], def.id ^ 0x5a5a),
        LAVA_MATERIAL,
      );
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
