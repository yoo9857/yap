/**
 * Robo Builder in VR: where the viewer STANDS, and nothing else.
 *
 * The flat-screen `CameraDirector` flies the camera — push-ins, spirals, crane
 * rises. In a headset that same motion is the single most reliable way to make
 * someone sick: the eyes report travel the inner ear never felt. So VR gets its
 * own director with a hard rule set:
 *
 *  - The viewpoint NEVER moves while visible. Every change is a cut.
 *  - Every cut is hidden behind a fade to black (the "blinder"), because a hard
 *    teleport still reads as a lurch if you can see it happen.
 *  - Only YAW is applied. Pitch/roll on a rig tilts the horizon against gravity,
 *    which is nausea in its purest form — the viewer looks up with their own neck.
 *  - A viewpoint's pose is frozen when it is entered. The build frontier climbs
 *    continuously, and following it would be slow vertical drift: sickening, and
 *    invisible as motion until it has already made you queasy.
 *
 * Pure module (no three, no DOM) so all of the above is unit-testable.
 */

/**
 * There is deliberately no "above the summit" station. The build runs bottom-up,
 * so for most of a landmark's life everything above the frontier is unbuilt
 * ghost — a viewpoint level with the true tip spends the run staring at empty
 * sky. `frontier` covers it for free: its height clamps to just under the top,
 * so on a finished monument it IS the standing-next-to-the-spire view.
 */
export type VrStationName = "plaza" | "overlook" | "frontier" | "yard";

export const ALL_STATIONS: readonly VrStationName[] = [
  "plaza",
  "overlook",
  "frontier",
  "yard",
];

/** How long each viewpoint is held before cutting to the next one. */
export const DWELL_S = 16;
const FADE_OUT_S = 0.5;
const FADE_IN_S = 0.75;

/** A standing position for the rig, in world meters. */
export interface VrStationPose {
  x: number;
  /** Floor height of the viewpoint; the headset adds real eye height on top. */
  y: number;
  z: number;
  /** Rig rotation about Y so that camera-forward (−Z) points at the monument. */
  yaw: number;
  /**
   * Radius of the visible standing platform, 0 = real ground. A viewpoint in
   * mid-air with nothing underfoot triggers height vertigo in most people; a
   * railed disc reads as a balcony and the same view becomes comfortable.
   */
  platformR: number;
}

export interface VrDirectorContext {
  /** Monument height in meters. */
  heightM: number;
  /** Monument planar bounding radius in meters — the widest slice, i.e. the base. */
  radiusM: number;
  /** Height the build has currently reached, in meters. */
  frontierY: number;
  /**
   * Planar radius of the structure AT a given height (see `radiusProfile`).
   * Elevated stations need this, not `radiusM`: these landmarks range from a
   * squat ring (Colosseum, h/r ≈ 0.5) to a slender spire (Big Ben, h/r ≈ 8.7),
   * so clearing the *base* footprint at the tip of a 331 m tower parks you 130 m
   * from a needle and there is nothing left to look at. Optional, and falling
   * back to `radiusM` is the conservative choice.
   */
  radiusAt?: (y: number) => number;
}

/**
 * Bucket a blueprint into height bands and record the widest block in each, so
 * `radiusAt(y)` answers "how far out does the structure reach at this height".
 * Blueprint coordinates are in voxels; world meters are `voxel * voxelSizeM`.
 * O(blocks), so call it once per landmark and cache it.
 */
export function radiusProfile(
  blocks: readonly { x: number; y: number; z: number }[],
  voxelSizeM: number,
  heightM: number,
  bands = 32,
): (y: number) => number {
  const bandH = Math.max(1e-6, heightM / bands);
  const widest = new Float64Array(bands);
  for (const b of blocks) {
    const wy = b.y * voxelSizeM + voxelSizeM / 2;
    const i = clamp(Math.floor(wy / bandH), 0, bands - 1);
    // + one voxel so the radius covers the block's far face, not its center
    const r = Math.hypot(b.x * voxelSizeM, b.z * voxelSizeM) + voxelSizeM;
    if (r > widest[i]!) widest[i] = r;
  }
  // an empty band (a gap, or above the tip) inherits the band below it, so the
  // profile is never 0 and never lets a station drift inside the structure
  for (let i = 1; i < bands; i++) {
    if (widest[i] === 0) widest[i] = widest[i - 1]!;
  }
  return (y: number): number => {
    const i = clamp(Math.floor(y / bandH), 0, bands - 1);
    // widen by a band either side: a station level with a narrow gap in the
    // structure must not be told the whole floor is that narrow
    const lo = Math.max(0, i - 1);
    const hi = Math.min(bands - 1, i + 1);
    return Math.max(widest[lo]!, widest[i]!, widest[hi]!);
  };
}

export interface VrFrame {
  station: VrStationName;
  pose: VrStationPose;
  /** Blinder opacity, 0 = clear, 1 = fully black. */
  blind: number;
  /** True only on the frame the viewpoint actually changed. */
  cut: boolean;
}

/** Assume a conservative 90° vertical FOV: PC headsets run 90–110°. */
const HALF_FOV_TAN = 1.0; // tan(45°)

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Where to stand for `station`, given the monument. `azimuth` is the compass
 * direction the viewer stands in; yaw always ends up facing the origin, which
 * for a Y-rotation means yaw === azimuth exactly.
 */
export function stationPose(
  station: VrStationName,
  ctx: VrDirectorContext,
  azimuth: number,
): VrStationPose {
  // radius of the sphere that encloses the monument, aimed at its middle
  const sphereR = Math.hypot(ctx.heightM * 0.55, ctx.radiusM);
  const fitDist = (sphereR / HALF_FOV_TAN) * 1.08;

  // Because pitch is forbidden (see the header), a station's HEIGHT is the only
  // tool for deciding what lands at eye level. Placing an interesting part of the
  // monument on the horizon is what makes each viewpoint worth standing in — a
  // ground-level station aimed at a 330 m tower spends most of the view on sky.
  let dist: number;
  let y = 0;
  let platformR = 0;
  switch (station) {
    case "overlook":
      // Level with the monument's middle, and close enough that it LOOMS — the
      // structure spans roughly 85° vertically, symmetric about the horizon, at
      // every landmark scale. Deliberately not a fit-the-whole-thing-in-frame
      // shot: in a headset you turn your head, so presence beats framing, and a
      // fit distance on a 330 m tower puts it far enough back to sit in the haze.
      y = ctx.heightM * 0.42;
      dist = Math.max(ctx.radiusM * 1.5, ctx.heightM * 0.55);
      platformR = 4;
      break;
    case "plaza":
      // deliberately INSIDE the fit distance, and the one station that keeps its
      // feet on the grass: real scale only lands when the thing overflows your
      // view and you have to crane your neck to find the top
      dist = Math.max(ctx.radiusM * 1.3, fitDist * 0.55);
      break;
    case "frontier": {
      // The construction deck: it CLIMBS with the build, so this viewpoint tells
      // the story of progress over a run.
      //
      // It sits at half the build height and well back, rather than level with
      // the frontier and close to it. Standing at the build edge seems obvious
      // and is wrong twice over: every block placed so far is then straight down
      // beneath the deck (which occludes anything steeper than ~58°), and the
      // only thing left above the horizon is the unbuilt ghost. Half-height and
      // far enough back puts the whole built mass between −30° and the horizon,
      // with the ghost of what is still to come rising above it.
      y = clamp(ctx.frontierY * 0.5, 6, Math.max(6, ctx.heightM * 0.6));
      const localR = ctx.radiusAt?.(y) ?? ctx.radiusM;
      dist = Math.max(localR * 1.5, y * 1.6) + 25;
      platformR = 4;
      break;
    }
    case "yard":
      // down among the brick pile and the workers' path, where the action is
      // already at eye level
      dist = ctx.radiusM + 9;
      break;
  }

  return {
    x: Math.sin(azimuth) * dist,
    z: Math.cos(azimuth) * dist,
    y,
    yaw: azimuth,
    platformR,
  };
}

export class VrDirector {
  private station: VrStationName = "plaza";
  private pose: VrStationPose | null = null;
  private deck: VrStationName[] = [];
  private phase: "in" | "dwell" | "out" = "in";
  private elapsed = 0;

  /** rng injected so the station order is deterministic under test. */
  constructor(private readonly rng: () => number = Math.random) {}

  get currentStation(): VrStationName {
    return this.station;
  }

  /**
   * Advance the fade/dwell state machine. Returns the pose to place the rig at
   * and how black the blinder should be.
   */
  update(dt: number, ctx: VrDirectorContext): VrFrame {
    if (!this.pose) {
      // first frame: pick the opening viewpoint and show pure black. Spending
      // this frame's dt on the fade-in would let a sliver of the world through
      // before the pose is settled — every cut starts fully blind, including
      // the first one.
      this.pose = stationPose(this.station, ctx, this.azimuthFor(this.station));
      return { station: this.station, pose: this.pose, blind: 1, cut: true };
    }

    let cut = false;
    this.elapsed += dt;
    let blind: number;
    switch (this.phase) {
      case "in":
        blind = 1 - clamp(this.elapsed / FADE_IN_S, 0, 1);
        if (this.elapsed >= FADE_IN_S) {
          this.phase = "dwell";
          this.elapsed = 0;
          blind = 0;
        }
        break;
      case "dwell":
        blind = 0;
        if (this.elapsed >= DWELL_S) {
          this.phase = "out";
          this.elapsed = 0;
        }
        break;
      case "out":
        blind = clamp(this.elapsed / FADE_OUT_S, 0, 1);
        if (this.elapsed >= FADE_OUT_S) {
          // fully black: safe to move the world out from under them
          this.station = this.drawStation();
          this.pose = stationPose(this.station, ctx, this.azimuthFor(this.station));
          this.phase = "in";
          this.elapsed = 0;
          blind = 1;
          cut = true;
        }
        break;
    }

    return { station: this.station, pose: this.pose, blind, cut };
  }

  /** Force the next cut now (debug / "next view" input). */
  skip(): void {
    if (this.phase === "dwell") {
      this.phase = "out";
      this.elapsed = 0;
    }
  }

  /** The brick pile sits on the +X side, so the yard view has a fixed bearing. */
  private azimuthFor(station: VrStationName): number {
    return station === "yard" ? 1.05 : this.rng() * Math.PI * 2;
  }

  /** Shuffled deck of all stations, never the same one twice in a row. */
  private drawStation(): VrStationName {
    if (this.deck.length === 0) {
      this.deck = [...ALL_STATIONS];
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j]!, this.deck[i]!];
      }
      if (this.deck[this.deck.length - 1] === this.station && this.deck.length > 1) {
        [this.deck[0], this.deck[this.deck.length - 1]] = [
          this.deck[this.deck.length - 1]!,
          this.deck[0]!,
        ];
      }
    }
    return this.deck.pop()!;
  }
}
