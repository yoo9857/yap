/**
 * The display side of graphics quality, pure and unit-tested (test/display.test.ts):
 *
 * - `effectiveFov`: the settings' field of view is VERTICAL and holds from 4:3 out to ultrawide
 *   (wider screens see more to the sides: Hor+). Narrower than 4:3 (a phone held upright, a
 *   split-screen window) the HORIZONTAL view of 4:3 is kept instead, or a 9:19.5 portrait screen
 *   would see the world through a ~35 degree slot.
 * - `qualityProfile`: what each graphics preset spends: the render resolution cap (device pixels
 *   per CSS pixel) and the sun's shadows.
 * - `DynamicResolution`: the "auto" preset's governor. It watches frame times and steps the render
 *   scale down 10% when the average falls under 50 fps, back up 5% when it is comfortably over
 *   ~75 fps; a step needs a full window of frames on the same side (no flapping), and a long hitch
 *   (a tab switch, a GC pause) is ignored rather than read as slowness.
 */

/** Below this aspect the horizontal view of 4:3 is held. */
export const MIN_ASPECT_FOR_VERTICAL_FOV = 4 / 3;
const MAX_VERTICAL_FOV = 110;

const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/** The vertical field of view to draw with, given the setting (vertical, degrees) and aspect. */
export function effectiveFov(verticalFov: number, aspect: number): number {
  if (!(aspect > 0) || !Number.isFinite(aspect) || aspect >= MIN_ASPECT_FOR_VERTICAL_FOV) return verticalFov;
  const horizontal = 2 * Math.atan(Math.tan(rad(verticalFov) / 2) * MIN_ASPECT_FOR_VERTICAL_FOV);
  return Math.min(MAX_VERTICAL_FOV, deg(2 * Math.atan(Math.tan(horizontal / 2) / aspect)));
}

export type GraphicsPreset = "auto" | "low" | "medium" | "high";

export interface QualityProfile {
  /** Cap on device pixels per CSS pixel. */
  maxPixelRatio: number;
  /** Lowest render scale the auto governor may go to (1 = the cap). */
  minScale: number;
  shadows: boolean;
  shadowMapSize: number;
  /**
   * Draw imported scenery (the fire drill's school) with the cheapest lit material: no gloss, no
   * clear coat — a phone's GPU pays for every one of those on every pixel of every wall. True on
   * the low preset and on touch devices.
   */
  lite: boolean;
}

export function qualityProfile(preset: GraphicsPreset, touch = false): QualityProfile {
  switch (preset) {
    case "low":
      return { maxPixelRatio: 0.85, minScale: 1, shadows: false, shadowMapSize: 1024, lite: true };
    case "medium":
      return { maxPixelRatio: 1.25, minScale: 1, shadows: true, shadowMapSize: 1024, lite: false };
    case "high":
      return { maxPixelRatio: 2, minScale: 1, shadows: true, shadowMapSize: 2048, lite: false };
    case "auto":
    default:
      // a phone or tablet: a 3x screen at 1.5 with 2048 shadows ran hot and slow before the
      // governor caught up, so a touch device starts at 1.25 with 1024 shadows
      if (touch) return { maxPixelRatio: 1.25, minScale: 0.6, shadows: true, shadowMapSize: 1024, lite: true };
      // the long-standing default (1.5x, soft 2048 shadows), with the governor allowed to trade
      // resolution down to 60% before anything stutters
      return { maxPixelRatio: 1.5, minScale: 0.6, shadows: true, shadowMapSize: 2048, lite: false };
  }
}

/** The device pixel ratio to render at. */
export function pixelRatioFor(devicePixelRatio: number, profile: QualityProfile, scale: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(0.5, Math.min(dpr, profile.maxPixelRatio) * scale);
}

const WINDOW = 90;
const SLOW_MS = 20; // under 50 fps
const FAST_MS = 13.3; // over ~75 fps
const HITCH_MS = 250;

export class DynamicResolution {
  scale = 1;
  private sum = 0;
  private count = 0;

  constructor(private readonly minScale: number) {}

  /** Feed one frame's duration; returns true when the scale changed. */
  frame(ms: number): boolean {
    if (!Number.isFinite(ms) || ms <= 0 || ms > HITCH_MS) return false;
    this.sum += ms;
    this.count++;
    if (this.count < WINDOW) return false;
    const avg = this.sum / this.count;
    this.sum = 0;
    this.count = 0;
    const before = this.scale;
    if (avg > SLOW_MS) this.scale = Math.max(this.minScale, Math.round((this.scale - 0.1) * 100) / 100);
    else if (avg < FAST_MS) this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
    return this.scale !== before;
  }
}
