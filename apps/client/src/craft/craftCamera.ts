import * as THREE from "three";
import type { VoxelWorld } from "./voxelWorld.js";
import { settings } from "../ui/settings.js";
import { effectiveFov } from "../render/display.js";

/**
 * Craft-mode camera rig — the whole "feel" lives here:
 *
 * - over-the-shoulder third person (offset eases away in tight spaces)
 * - 5-ray spherical occlusion probe so corners never clip into rock
 * - zoom snaps IN through walls, eases back OUT (tight spaces feel deliberate)
 * - first-person toggle for precise mining
 * - dynamic FOV: subtle widen while running (callers pass walk as false)
 * - micro screen-shake impulses (block breaks, hard landings)
 *
 * Every transition is frame-rate independent (exponential easing).
 */

/** The field of view comes from the settings (default 70); running widens it by this much. */
const RUN_FOV_EXTRA = 5.5;
// pulled back toward the jump-map (tower) camera distance so the character and
// bricks read at the SAME scale across modes — craft/battle looked zoomed-in
// (oversized) at the old 4.4 m over-the-shoulder distance. Mining reach is
// measured from the player, so a farther camera doesn't shorten it.
const MAX_DIST = 8;
const MIN_DIST = 0.55;
const SHOULDER = 0.28;
const WALL_MARGIN = 0.32;
/** The closest the camera may ever be to what it is looking past: a little
 *  more than the near plane (0.1 m), so a wall is never cut open on screen. */
const HARD_MARGIN = 0.14;
/** Height kept above the floor when the camera is lifted over it (looking up). */
const FLOOR_CLEAR = 0.35;
/** Half-size of the box kept clear of blocks around the camera: the near plane's corner
 *  reach (0.1 m near, 75° fov, widescreen ≈ 0.16 m) — the screen never opens a block. */
const NEAR_CLEAR = 0.22; // covers 21:9 at the running fov (corner reach ≈ 0.20 m)
/** Corner-probe spread — roughly the near-plane half-extent at MAX_DIST. */
const PROBE = 0.28;
/** Centre + four corners; hoisted so the per-frame probe allocates nothing. */
const PROBES: readonly (readonly [number, number])[] = [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class CraftCamera {
  firstPerson = false;

  private dist = MAX_DIST;
  private shoulder = 0;
  private fov = settings.fov;
  private shakeAmp = 0;
  private shakeTime = 0;

  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly probeDir = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** Impulse shake (amplitude in meters, decays in ~0.3 s). */
  addShake(amp: number): void {
    this.shakeAmp = Math.min(0.14, this.shakeAmp + amp);
  }

  /**
   * The eye is inside a block: look from the nearest free point straight ABOVE OR BELOW it,
   * never sideways. Mining and building aim from the body's own eye (same x/z), so a pivot
   * moved sideways put the crosshair on one block while the dig landed on another, and the
   * view jumped as if the player had moved. `bodyEyeY` (the unsmoothed eye, where the body
   * physically fits) is tried first: the smoothed eye only lags into a block after a step.
   */
  private freePivot(world: VoxelWorld, eye: THREE.Vector3, bodyEyeY?: number): void {
    const free = (y: number) => !world.isBlocked(Math.floor(eye.x), Math.floor(y), Math.floor(eye.z));
    if (bodyEyeY !== undefined && Number.isFinite(bodyEyeY) && free(bodyEyeY)) { this.pivot.y = bodyEyeY; return; }
    for (let k = 1; k <= 6; k++) {
      for (const dy of [k * 0.25, -k * 0.25]) {
        if (free(eye.y + dy)) { this.pivot.y = eye.y + dy; return; }
      }
    }
  }

  /** Does a box of NEAR_CLEAR around `p` touch a block (or solid furniture)? */
  private readonly los = new THREE.Vector3();

  /** A ray hit that entered its block through the top face: the floor, not a wall or a ceiling. */
  private static isFloorHit(hit: { voxel: [number, number, number]; before: [number, number, number] }): boolean {
    return hit.before[1] === hit.voxel[1] + 1 && hit.before[0] === hit.voxel[0] && hit.before[2] === hit.voxel[2];
  }

  /**
   * The top of the ground under (or around) a point: if the point is inside the ground, the first
   * free cell above it; otherwise the first solid cell a few below. -Infinity when there is none
   * close by (open air, a cliff edge) — nothing to lift over.
   */
  private floorUnder(world: VoxelWorld, p: THREE.Vector3): number {
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    let y = Math.floor(p.y);
    if (world.isBlocked(x, y, z)) {
      for (let i = 0; i < 8 && world.isBlocked(x, y, z); i++) y++;
      return y;
    }
    for (let i = 0; i < 3; i++) {
      if (world.isBlocked(x, y - 1, z)) return y;
      y--;
    }
    return -Infinity;
  }

  private boxBlocked(world: VoxelWorld, p: THREE.Vector3): boolean {
    for (const dx of [-NEAR_CLEAR, NEAR_CLEAR]) for (const dy of [-NEAR_CLEAR, NEAR_CLEAR]) for (const dz of [-NEAR_CLEAR, NEAR_CLEAR]) {
      if (world.isBlocked(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz))) return true;
    }
    return false;
  }

  /** Current distance behind the pivot (debug/perf probes). */
  get distance(): number {
    return this.dist;
  }

  toggleView(): void {
    this.firstPerson = !this.firstPerson;
  }

  /**
   * Position the camera for this frame. Returns the robot's target opacity
   * (0 in first person / point-blank, 1 at full distance).
   */
  update(
    world: VoxelWorld,
    eye: THREE.Vector3,
    yaw: number,
    pitch: number,
    running: boolean,
    dt: number,
    /** The body's unsmoothed eye height: the escape when the smoothed eye lags into a block. */
    bodyEyeY?: number,
  ): number {
    const ease = (rate: number) => 1 - Math.pow(rate, dt);
    this.dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    this.right.set(-Math.cos(yaw), 0, Math.sin(yaw));
    this.up.crossVectors(this.right, this.dir).normalize();

    // shoulder collapses in first person and scales away with lost distance
    const distRatio = this.dist / MAX_DIST;
    const wantShoulder = this.firstPerson ? 0 : SHOULDER * Math.min(1, distRatio * 1.4);
    this.shoulder += (wantShoulder - this.shoulder) * ease(0.005);

    // shoulder pivot must itself stay out of walls
    this.pivot.copy(eye);
    // The eye itself can be inside a block — the body squeezed into a gap, a block placed
    // over the head, a crawl under a ledge. Every probe below would then start inside the
    // block and the camera would open it from within (de2). Look from the nearest free
    // spot instead: straight up first (a head through a ceiling), then the sides.
    if (!this.firstPerson && world.isBlocked(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z))) this.freePivot(world, eye, bodyEyeY);
    if (this.shoulder > 1e-3) {
      const side = world.raycast(eye.x, eye.y, eye.z, this.right.x, this.right.y, this.right.z, this.shoulder + 0.2);
      const allowed = side ? Math.max(0, side.dist - 0.2) : this.shoulder;
      this.pivot.addScaledVector(this.right, Math.min(this.shoulder, allowed));
    }

    // occlusion: probe the center ray + 4 corner rays, keep the tightest
    let wantDist = this.firstPerson ? 0 : MAX_DIST;
    // first person needs no wall limit — the camera is heading into the head
    let hardLimit = MAX_DIST;
    let floorTop = -Infinity;
    if (!this.firstPerson) {
      let clear = MAX_DIST;
      for (const [sx, sy] of PROBES) {
        this.probeDir
          .copy(this.dir)
          .multiplyScalar(-1)
          .addScaledVector(this.right, sx * (PROBE / MAX_DIST))
          .addScaledVector(this.up, sy * (PROBE / MAX_DIST))
          .normalize();
        const hit = world.raycast(
          this.pivot.x, this.pivot.y, this.pivot.z,
          this.probeDir.x, this.probeDir.y, this.probeDir.z,
          MAX_DIST,
        );
        // the GROUND does not pull the camera in: looking up, the probes behind run down into it,
        // and the camera came in (fading the robot) and out again with every jump — a flicker.
        // A hit entered through a block's top face is floor; the camera is lifted over it below.
        if (hit && CraftCamera.isFloorHit(hit)) floorTop = Math.max(floorTop, hit.voxel[1] + 1);
        else if (hit) clear = Math.min(clear, hit.dist);
      }
      // MIN_DIST is a preference, never a reason to sit inside the wall: with the back
      // against a wall the camera comes all the way in (the robot fades out) instead
      hardLimit = Math.max(0, clear - HARD_MARGIN);
      wantDist = Math.min(Math.max(MIN_DIST, clear - WALL_MARGIN), hardLimit);
    }
    // In FAST but smooth, out slowly. Snapping straight in made the camera
    // jump whenever a corner probe flickered between hitting and missing —
    // rubbing along a wall it lurched in and crept out several times a
    // second. The hard limit is what keeps it from ever passing through the
    // wall; inside that, it may glide.
    if (wantDist < this.dist) this.dist += (wantDist - this.dist) * ease(1e-7);
    else this.dist += (wantDist - this.dist) * ease(0.01);
    this.dist = Math.min(this.dist, hardLimit);

    // dynamic FOV — a touch wider on the move
    const wantFov = running && !this.firstPerson ? settings.fov + RUN_FOV_EXTRA : settings.fov;
    this.fov += (wantFov - this.fov) * ease(0.02);
    // narrower than 4:3 (a phone held upright) keeps a 4:3 horizontal view (display.ts)
    const drawnFov = effectiveFov(this.fov, this.camera.aspect);
    if (Math.abs(this.camera.fov - drawnFov) > 0.01) {
      this.camera.fov = drawnFov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(this.pivot).addScaledVector(this.dir, -this.dist);
    if (!this.firstPerson && this.camera.position.y < 0.35) this.camera.position.y = 0.35;
    // over the floor, not into it: the full distance kept, the camera just above the ground the probes
    // hit (a bridge or a storey, not the ground far below it) or the ground in its own column
    if (!this.firstPerson) {
      const floor = Math.max(floorTop, this.floorUnder(world, this.camera.position));
      if (this.camera.position.y < floor + FLOOR_CLEAR) this.camera.position.y = Math.min(floor + FLOOR_CLEAR, this.pivot.y);
      // A floor hit ends a probe there, so nothing behind it was checked (a room's wall beyond its
      // floor): the line from the head to the camera must be clear, or the camera comes in to it.
      this.los.copy(this.camera.position).sub(this.pivot);
      const len = this.los.length();
      if (len > 1e-3) {
        this.los.divideScalar(len);
        const hit = world.raycast(this.pivot.x, this.pivot.y, this.pivot.z, this.los.x, this.los.y, this.los.z, len);
        if (hit) {
          const keep = Math.max(0, hit.dist - HARD_MARGIN);
          this.camera.position.copy(this.pivot).addScaledVector(this.los, keep);
          this.dist = Math.min(this.dist, keep);
        }
      }
    }
    this.look.copy(this.pivot).addScaledVector(this.dir, 3);
    this.camera.lookAt(this.look);

    // micro shake, decaying fast — applied in camera space so it never aims
    if (this.shakeAmp > 0.0005) {
      this.shakeTime += dt;
      const t = this.shakeTime;
      this.camera.position
        .addScaledVector(this.right, Math.sin(t * 37) * this.shakeAmp)
        .addScaledVector(this.up, Math.cos(t * 29) * this.shakeAmp * 0.7);
      this.shakeAmp *= Math.pow(0.0005, dt);
    } else {
      this.shakeAmp = 0;
    }

    // The near plane is ~0.28 m wide: the rays above only look along the view line, so
    // grazing a wall (or a shake) could still put the edge of the screen inside a block
    // and slice it open. Last word: a small box around the camera must be clear of
    // blocks, else the camera slides in toward the pivot until it is.
    if (!this.firstPerson && this.boxBlocked(world, this.camera.position)) {
      const shakeX = this.camera.position.x - (this.pivot.x - this.dir.x * this.dist);
      const shakeY = this.camera.position.y - (this.pivot.y - this.dir.y * this.dist);
      const shakeZ = this.camera.position.z - (this.pivot.z - this.dir.z * this.dist);
      let d = this.dist;
      while (d > 0) {
        d = Math.max(0, d - 0.04);
        this.camera.position.set(this.pivot.x - this.dir.x * d + shakeX, this.pivot.y - this.dir.y * d + shakeY, this.pivot.z - this.dir.z * d + shakeZ);
        if (!this.boxBlocked(world, this.camera.position)) break;
      }
      if (this.boxBlocked(world, this.camera.position)) this.camera.position.copy(this.pivot); // nowhere clear: the head
      this.dist = d;
    }

    // Fade the robot out as the camera closes in — also while gliding into
    // first person, so V is a move into the head, not a cut with a vanishing
    // robot. By the camera's REAL distance from the head: lifted over the floor it can be close
    // while `dist` is long (looking straight up), and far while `dist` is long — the usual case.
    const real = this.firstPerson ? this.dist : Math.min(this.dist, this.camera.position.distanceTo(this.pivot));
    return Math.min(1, Math.max(0, (real - 0.9) / 0.9));
  }
}
