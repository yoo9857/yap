import * as THREE from "three";
import { mulberry32 } from "@robo/shared";
import type { Landmark } from "./landmarks.js";

/**
 * Cinematic camera director — documentary-style SHOTS that CUT between each
 * other, with ease-in-out motion and a subtle handheld sway.
 *
 * FRAMING GUARANTEE: every pose is computed against the monument's bounding
 * sphere and clamped to the fit distance for the current FOV/aspect, so the
 * WHOLE structure is always in frame — no shot can miss it, crop it in half,
 * or wander off while it is still being built. Variety comes from angle,
 * height and zoom, never from losing the subject.
 */

export type ShotName =
  | "wide"
  | "pushIn"
  | "craneRise"
  | "spiralUp"
  | "detailOrbit"
  | "frontier"
  | "flyby"
  | "lowTrack"
  | "topReveal"
  | "pullBack";

interface ShotContext {
  landmark: Landmark;
  /** Distance at which the whole monument exactly fits the frustum (m). */
  fitDist: number;
  /** Height of the construction frontier (m). */
  frontierY: number;
  /** Shot-local random in [0,1) — stable for the whole shot. */
  seed: number;
}

interface CameraPose {
  angle: number;
  /** Multiplier on fitDist — clamped ≥ MIN_FIT so nothing ever crops. */
  zoom: number;
  y: number;
  lookY: number;
}

/** Even the tightest shot keeps ~90% of the monument in frame. */
const MIN_FIT = 0.9;
const MAX_FIT = 1.5;

const easeInOut = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Each shot maps normalized time [0,1] → camera pose (zoom × fitDist). */
const SHOTS: Record<ShotName, (t: number, ctx: ShotContext) => CameraPose> = {
  /** The postcard: far, calm lateral drift. */
  wide: (t, { landmark, seed }) => ({
    angle: seed * Math.PI * 2 + t * 0.25,
    zoom: 1.3,
    y: landmark.heightM * 0.32 + 4,
    lookY: landmark.heightM * 0.48,
  }),

  /** Hero approach: dolly from far to a full-frame close-up. */
  pushIn: (t, { landmark, seed }) => {
    const e = easeInOut(t);
    return {
      angle: seed * Math.PI * 2 + t * 0.12,
      zoom: lerp(1.5, 0.95, e),
      y: lerp(landmark.heightM * 0.18 + 3, landmark.heightM * 0.3 + 3, e),
      lookY: landmark.heightM * 0.5,
    };
  },

  /** Crane/drone rise: the camera climbs, the monument stays whole. */
  craneRise: (t, { landmark, seed }) => ({
    angle: seed * Math.PI * 2 + t * 0.4,
    zoom: 1.05,
    y: lerp(landmark.heightM * 0.12 + 3, landmark.heightM * 0.95, easeInOut(t)),
    lookY: landmark.heightM * 0.5,
  }),

  /** Helicopter spiral: climbs while circling. */
  spiralUp: (t, { landmark, seed }) => ({
    angle: seed * Math.PI * 2 + t * 1.5,
    zoom: 1.12,
    y: lerp(landmark.heightM * 0.15 + 3, landmark.heightM * 0.9, easeInOut(t)),
    lookY: landmark.heightM * 0.5,
  }),

  /** Closest allowed orbit, camera riding at an upper-feature height. */
  detailOrbit: (t, { landmark, seed }) => ({
    angle: seed * Math.PI * 2 + t * 0.7,
    zoom: MIN_FIT,
    y: landmark.heightM * (0.5 + seed * 0.3),
    lookY: landmark.heightM * 0.5,
  }),

  /** Where the work happens: camera height follows the build frontier. */
  frontier: (t, { landmark, frontierY, seed }) => ({
    angle: seed * Math.PI * 2 + t * 0.5,
    zoom: 1.0,
    y: Math.min(Math.max(frontierY, landmark.heightM * 0.15), landmark.heightM * 0.85) + 3,
    lookY: landmark.heightM * 0.48,
  }),

  /** Passing fly-by: sweeping arc, closest at the middle of the pass. */
  flyby: (t, { landmark, seed }) => ({
    angle: seed * Math.PI * 2 + lerp(-0.8, 0.8, easeInOut(t)),
    zoom: lerp(1.35, 0.98, Math.sin(t * Math.PI)),
    y: lerp(landmark.heightM * 0.2 + 3, landmark.heightM * 0.55, easeInOut(t)),
    lookY: landmark.heightM * 0.45,
  }),

  /** Low orbit: near the ground plane but the whole monument still framed. */
  lowTrack: (t, { landmark, seed }) => ({
    angle: seed * Math.PI * 2 + lerp(-0.4, 0.4, t),
    zoom: 1.08,
    y: landmark.heightM * 0.14 + 3,
    lookY: landmark.heightM * 0.52,
  }),

  /** God view: high above, settling down to eye level. */
  topReveal: (t, { landmark, seed }) => {
    const e = easeInOut(t);
    return {
      angle: seed * Math.PI * 2 + t * 0.45,
      zoom: lerp(1.1, 1.25, e),
      y: lerp(landmark.heightM * 1.15 + 10, landmark.heightM * 0.45, e),
      lookY: lerp(landmark.heightM * 0.6, landmark.heightM * 0.45, e),
    };
  },

  /** Start at the closest full frame, pull back to reveal the whole scene. */
  pullBack: (t, { landmark, seed }) => {
    const e = easeInOut(t);
    return {
      angle: seed * Math.PI * 2 + t * 0.28,
      zoom: lerp(0.95, 1.45, e),
      y: lerp(landmark.heightM * 0.55, landmark.heightM * 0.3 + 4, e),
      lookY: landmark.heightM * 0.48,
    };
  },
};

const ALL_SHOTS: ShotName[] = [
  "wide",
  "pushIn",
  "craneRise",
  "spiralUp",
  "detailOrbit",
  "frontier",
  "flyby",
  "lowTrack",
  "topReveal",
  "pullBack",
];

const SHOT_DURATION_S: Record<ShotName, number> = {
  wide: 12,
  pushIn: 10,
  craneRise: 12,
  spiralUp: 12,
  detailOrbit: 9,
  frontier: 10,
  flyby: 8,
  lowTrack: 9,
  topReveal: 10,
  pullBack: 10,
};

export class CameraDirector {
  private deck: ShotName[] = [];
  private current: ShotName = "pushIn";
  private shotElapsed = 0;
  private currentLandmarkId: string | null = null;
  /** Session-random: every visit gets different camerawork (재미유도). */
  private rng: () => number = mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  private seed = 0;
  private pinned: ShotName | null = null;
  private swayT = Math.random() * 100;

  /** Pin one shot type (parade, screenshots, tests). Pass null to release.
   *  Idempotent: re-pinning the same shot must NOT reset its clock — callers
   *  pin every frame, and a per-frame reset froze the shot at t=0. */
  pin(shot: ShotName | null): void {
    if (this.pinned === shot) return;
    this.pinned = shot;
    this.shotElapsed = 0;
  }

  get currentShot(): ShotName {
    return this.pinned ?? this.current;
  }

  /** Shuffled deck: all 10 shots in random order, no immediate repeats. */
  private drawShot(): ShotName {
    if (this.deck.length === 0) {
      this.deck = [...ALL_SHOTS];
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j]!, this.deck[i]!];
      }
      // never show the same shot twice in a row across reshuffles
      if (this.deck[this.deck.length - 1] === this.current && this.deck.length > 1) {
        [this.deck[0], this.deck[this.deck.length - 1]] = [
          this.deck[this.deck.length - 1]!,
          this.deck[0]!,
        ];
      }
    }
    return this.deck.pop()!;
  }

  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    landmark: Landmark,
    frontierY: number,
  ): void {
    if (landmark.id !== this.currentLandmarkId) {
      // new monument: fresh deck, but always open on a hero shot
      this.currentLandmarkId = landmark.id;
      this.deck = [];
      this.current = this.rng() < 0.5 ? "pushIn" : "spiralUp";
      this.shotElapsed = 0;
      this.seed = this.rng();
    }

    const shot = this.currentShot;
    const duration = SHOT_DURATION_S[shot];
    this.shotElapsed += dt;
    this.swayT += dt;
    if (this.shotElapsed >= duration && !this.pinned) {
      this.shotElapsed = 0;
      this.current = this.drawShot();
      this.seed = this.rng(); // fresh framing for the next shot — a CUT
    }

    // bounding-sphere fit distance for the CURRENT frustum (fov + aspect);
    // poses aim at the sphere center, so tan-fit + margin is safe and keeps
    // the monument satisfyingly large in frame
    const h = landmark.heightM;
    const sphereR = Math.hypot(h * 0.55, landmark.radiusM);
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const fitDist = (sphereR / Math.tan(Math.min(halfV, halfH))) * 1.08;

    const t = Math.min(1, this.shotElapsed / duration);
    const pose = SHOTS[this.currentShot](t, {
      landmark,
      fitDist,
      frontierY,
      seed: this.seed,
    });

    const dist = fitDist * Math.min(Math.max(pose.zoom, MIN_FIT), MAX_FIT);

    // subtle handheld sway — alive, not sterile (scaled to shot distance)
    const sway = Math.min(dist * 0.002, 0.8);
    const sx = Math.sin(this.swayT * 0.53) * sway + Math.sin(this.swayT * 1.31) * sway * 0.4;
    const sy = Math.cos(this.swayT * 0.41) * sway * 0.6;
    const sz = Math.cos(this.swayT * 0.67) * sway;

    camera.position.set(
      Math.cos(pose.angle) * dist + sx,
      Math.max(2.5, pose.y) + sy,
      Math.sin(pose.angle) * dist + sz,
    );
    camera.lookAt(sx * 0.3, pose.lookY + sy * 0.3, sz * 0.3);
  }
}
