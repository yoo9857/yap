/**
 * The shrinking storm — pure functions of match time, so the HUD, the world
 * ring and the damage ticks can never disagree. Matches are ARCADE-fast:
 * three phases, whole match ≈ 100 seconds.
 */

export interface ZonePhase {
  /** Seconds the radius holds before shrinking. */
  hold: number;
  /** Seconds the shrink takes. */
  shrink: number;
  /** Radius at the END of this phase. */
  to: number;
}

export const ZONE_START_RADIUS = 36;
export const ZONE_PHASES: ZonePhase[] = [
  { hold: 12, shrink: 10, to: 20 },
  { hold: 10, shrink: 10, to: 10 },
  { hold: 8, shrink: 10, to: 3 },
];

/** Seconds between 1-damage ticks while outside the zone. */
export const ZONE_TICK_SECONDS = 2;

export function zoneRadiusAt(tSec: number): number {
  let t = tSec;
  let radius = ZONE_START_RADIUS;
  for (const phase of ZONE_PHASES) {
    if (t < phase.hold) return radius;
    t -= phase.hold;
    if (t < phase.shrink) {
      return radius + (phase.to - radius) * (t / phase.shrink);
    }
    t -= phase.shrink;
    radius = phase.to;
  }
  return radius;
}

/** Seconds until the next radius change starts/ends (HUD countdown), or null
 *  when fully closed. */
export function zoneNextEventIn(tSec: number): { label: "shrinking" | "closes-in"; seconds: number } | null {
  let t = tSec;
  for (const phase of ZONE_PHASES) {
    if (t < phase.hold) return { label: "closes-in", seconds: phase.hold - t };
    t -= phase.hold;
    if (t < phase.shrink) return { label: "shrinking", seconds: phase.shrink - t };
    t -= phase.shrink;
  }
  return null;
}

/** Number of 1-damage ticks due in (prevT, t] for someone outside the zone. */
export function zoneTicksBetween(prevT: number, t: number): number {
  return Math.floor(t / ZONE_TICK_SECONDS) - Math.floor(prevT / ZONE_TICK_SECONDS);
}

export function insideZone(x: number, z: number, cx: number, cz: number, radius: number): boolean {
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz <= radius * radius;
}
