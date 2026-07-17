import * as THREE from "three";
import { BRICK_COLORS, lerp } from "@robo/shared";
import { CharacterRig, disposeRig } from "../player/rig.js";
import {
  MAX_VISUAL_WORKERS,
  WALK_DISTANCE_M,
  walkSpeed,
  type BuilderState,
} from "./state.js";

interface VisualWorker {
  rig: CharacterRig;
  brick: THREE.Mesh;
  /** Angle (around the monument, pile at 0) of the current delivery spot. */
  workA: number;
  /** Angle the return leg started from (last delivery spot). */
  homeA: number;
  prevP: number;
}

/**
 * Maps the pure sim's per-worker cycle progress onto walking R6 rigs:
 * pile (pick-up bow) → walk AROUND the monument to the spot where the next
 * blocks actually land (the frontier's ground projection) CARRYING the block
 * → placing bow → the block is tossed onto the blueprint (BlockFlights) →
 * walk back empty. Beyond MAX_VISUAL_WORKERS the sim still counts them; we
 * just don't draw a crowd (the HUD shows the real number).
 */
export class WorkersView {
  private readonly workers: VisualWorker[] = [];
  private readonly brickGeo = new THREE.BoxGeometry(0.42, 0.3, 0.42);

  constructor(private readonly scene: THREE.Scene) {}

  private ensureCount(n: number): void {
    while (this.workers.length < n) {
      const i = this.workers.length;
      const rig = new CharacterRig(0xf5802b, 0xf9d71c, 0x3a3f47); // builder crew colors
      this.scene.add(rig.root);
      const brick = new THREE.Mesh(
        this.brickGeo,
        new THREE.MeshStandardMaterial({
          color: BRICK_COLORS[i % BRICK_COLORS.length],
          roughness: 0.7,
        }),
      );
      brick.castShadow = true;
      brick.visible = false;
      rig.root.add(brick);
      // between the outstretched hands (arms pivot y=1.18, reach ~0.55 forward)
      brick.position.set(0, 1.14, 0.52);
      this.workers.push({ rig, brick, workA: 0, homeA: 0, prevP: 0 });
    }
    while (this.workers.length > n) {
      const w = this.workers.pop()!;
      this.scene.remove(w.rig.root);
      disposeRig(w.rig.root);
    }
  }

  /** World position of worker `i`'s carried brick (launch anchor), or null
   *  if that worker isn't drawn (beyond the visual cap or before the first
   *  update). */
  launchAnchor(i: number, out: THREE.Vector3): THREE.Vector3 | null {
    const w = this.workers[i];
    if (!w) return null;
    w.rig.root.updateMatrixWorld();
    return w.brick.getWorldPosition(out);
  }

  /**
   * `siteRadius` = current landmark footprint edge in meters. `frontier` =
   * world position where the next blocks appear (null during the completion
   * parade, when the sim already builds a monument the camera can't see).
   */
  update(
    state: BuilderState,
    frameDt: number,
    siteRadius: number,
    frontier: THREE.Vector3 | null,
  ): void {
    this.ensureCount(Math.min(state.workers, MAX_VISUAL_WORKERS));
    const siteR = siteRadius + 0.6;
    const pileR = siteR + WALK_DISTANCE_M;
    const speed = walkSpeed(state);
    const fixed = state.crane ? 0.75 : 1.5;
    const walkT = WALK_DISTANCE_M / speed;
    const cycle = 2 * walkT + fixed;
    // cycle phases (fractions): walk-to-pile, pick, walk-to-spot, place
    const fWalk = walkT / cycle;
    const fPick = (fixed * (2 / 3)) / cycle;

    // Where the blocks actually land, as an angle around the monument
    // (pile sits at angle 0). Workers can only detour as far as a brisk
    // walk covers within the sim's fixed leg time — on huge monuments they
    // head toward the frontier's side and the toss crosses the rest.
    const targetA = frontier ? Math.atan2(frontier.z, frontier.x) : 0;
    const maxLegSpeed = Math.max(speed * 2.5, 8);
    const maxA = Math.max(0, maxLegSpeed * walkT - WALK_DISTANCE_M) / Math.max(siteR, 1);

    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i]!;
      const p = state.workerProgress[i] ?? 0;
      // keep the crew spread out — angular lanes at both endpoints
      const laneA = ((i - (this.workers.length - 1) / 2) * 0.9) / Math.max(siteR, 3);

      // leg transitions (progress is monotonic within a cycle)
      if (p < w.prevP) w.homeA = w.workA; // wrapped: delivery done, walk home
      if (w.prevP < fWalk + fPick && p >= fWalk + fPick) {
        // picking is done — commit THIS delivery's spot from the live frontier
        const a = Math.sign(targetA) * Math.min(Math.abs(targetA), maxA, Math.PI * 0.9);
        w.workA = a + laneA;
      }
      w.prevP = p;

      let ang: number;
      let rad: number;
      let carrying = false;
      let walking = false;
      let pose: "run" | "carry" | "place" = "run";

      if (p < fWalk) {
        // walk home from the last delivery spot, empty-handed
        const t = p / fWalk;
        ang = lerp(w.homeA, laneA, t);
        rad = lerp(siteR, pileR, t);
        walking = true;
        pose = "run";
      } else if (p < fWalk + fPick) {
        // bow at the pile to pick the next block up
        ang = laneA;
        rad = pileR;
        pose = "place";
      } else if (p < 2 * fWalk + fPick) {
        // carry it around the monument to where it will actually sit
        const t = (p - fWalk - fPick) / fWalk;
        ang = lerp(laneA, w.workA, t);
        rad = lerp(pileR, siteR, t);
        carrying = true;
        walking = true;
        pose = "carry";
      } else {
        // set it down at the spot — BlockFlights takes over on the wrap
        ang = w.workA;
        rad = siteR;
        carrying = true;
        pose = "place";
      }

      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      const prev = w.rig.root.position;
      if (walking) {
        // face where we're headed
        const dx = x - prev.x;
        const dz = z - prev.z;
        if (dx * dx + dz * dz > 1e-8) w.rig.root.rotation.y = Math.atan2(dx, dz);
      } else if (pose === "place" && carrying) {
        w.rig.root.rotation.y = Math.atan2(-x, -z); // face the monument
      } else {
        w.rig.root.rotation.y = Math.atan2(x, z); // face the pile, outward
      }
      w.rig.root.position.set(x, 0, z);
      w.brick.visible = carrying;
      w.rig.update(pose === "run" && !walking ? "idle" : pose, walking ? speed : 0, frameDt);
    }
  }

  dispose(): void {
    this.ensureCount(0);
    this.brickGeo.dispose();
  }
}
