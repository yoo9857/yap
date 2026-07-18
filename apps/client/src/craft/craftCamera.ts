import * as THREE from "three";
import type { VoxelWorld } from "./voxelWorld.js";

/**
 * Craft-mode camera rig — the whole "feel" lives here:
 *
 * - over-the-shoulder third person (offset eases away in tight spaces)
 * - 5-ray spherical occlusion probe so corners never clip into rock
 * - zoom snaps IN through walls, eases back OUT (tight spaces feel deliberate)
 * - first-person toggle for precise mining
 * - dynamic FOV: subtle widen while running
 * - micro screen-shake impulses (block breaks, hard landings)
 *
 * Every transition is frame-rate independent (exponential easing).
 */

const BASE_FOV = 70;
const MOVE_FOV = 75.5;
const MAX_DIST = 4.4;
const MIN_DIST = 0.55;
const SHOULDER = 0.55;
const WALL_MARGIN = 0.32;
/** Corner-probe spread — roughly the near-plane half-extent at MAX_DIST. */
const PROBE = 0.28;

export class CraftCamera {
  firstPerson = false;

  private dist = MAX_DIST;
  private shoulder = 0;
  private fov = BASE_FOV;
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
    moving: boolean,
    dt: number,
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
    if (this.shoulder > 1e-3) {
      const side = world.raycast(eye.x, eye.y, eye.z, this.right.x, this.right.y, this.right.z, this.shoulder + 0.2);
      const allowed = side ? Math.max(0, side.dist - 0.2) : this.shoulder;
      this.pivot.addScaledVector(this.right, Math.min(this.shoulder, allowed));
    }

    // occlusion: probe the center ray + 4 corner rays, keep the tightest
    let wantDist = this.firstPerson ? 0 : MAX_DIST;
    if (!this.firstPerson) {
      let clear = MAX_DIST;
      for (const [sx, sy] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
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
        if (hit) clear = Math.min(clear, hit.dist);
      }
      wantDist = Math.max(MIN_DIST, clear - WALL_MARGIN);
    }
    // snap in (never clip), ease out (no pumping when hugging walls)
    this.dist = wantDist < this.dist ? wantDist : this.dist + (wantDist - this.dist) * ease(0.01);

    // dynamic FOV — a touch wider on the move
    const wantFov = moving && !this.firstPerson ? MOVE_FOV : BASE_FOV;
    this.fov += (wantFov - this.fov) * ease(0.02);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(this.pivot).addScaledVector(this.dir, -this.dist);
    if (!this.firstPerson && this.camera.position.y < 0.35) this.camera.position.y = 0.35;
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

    if (this.firstPerson) return 0;
    // fade the robot out as the camera closes in (no visibility pop)
    return Math.min(1, Math.max(0, (this.dist - 0.9) / 0.9));
  }
}
