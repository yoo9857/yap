/**
 * The small pieces of maths that make the voxel modes LOOK smooth: drawing
 * between physics ticks, and easing the camera's angles. Pure, so
 * `test/smoothing.test.ts` can drive them with an irregular frame schedule —
 * the thing a headless browser cannot measure reliably and a player's screen
 * always has.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Beyond this one-tick jump (m) it is a cut — respawn, teleport — not motion. */
export const CUT_DISTANCE = 2.5;

/**
 * Where to DRAW a body this frame: `alpha` (0‒1, from the fixed-step loop) of
 * the way from where it was at the start of the last tick to where it is now.
 * Drawing the raw tick position moves things in 60 Hz steps — some frames two
 * ticks' worth, some none — which reads as stutter, worst on 120/144 Hz screens.
 */
export function interpolate(prev: Vec3Like, curr: Vec3Like, alpha: number, out: Vec3Like): Vec3Like {
  const dx = curr.x - prev.x;
  const dy = curr.y - prev.y;
  const dz = curr.z - prev.z;
  if (dx * dx + dy * dy + dz * dz > CUT_DISTANCE * CUT_DISTANCE) {
    out.x = curr.x;
    out.y = curr.y;
    out.z = curr.z;
  } else {
    out.x = prev.x + dx * alpha;
    out.y = prev.y + dy * alpha;
    out.z = prev.z + dz * alpha;
  }
  return out;
}

/** Wrap an angle difference into (−π, π]. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Frame-rate independent exponential approach: the fraction to close in `dt`
 *  seconds with time constant `tau`. */
export const approach = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

/**
 * Ease a drawn view angle toward the input angle. Mice report at their own
 * rate (often 125 Hz) against a 60–144 Hz screen, so raw angles turn in a
 * stop–jump rhythm; a ~25 ms ease spreads each move over the frames. Anything
 * past `snap` radians is taken at once (a teleport's look, a respawn).
 */
/**
 * Turn a character's body toward a heading: eased (quick at first, settling
 * gently) and capped at `maxRate` rad/s, so pressing S swings the robot
 * round through a visible half-turn instead of flipping in one frame. Never
 * snaps — unlike the camera, a body that teleports its facing reads as a glitch.
 */
export function turnToward(facing: number, target: number, dt: number, tau = 0.08, maxRate = 13): number {
  const d = angleDelta(facing, target);
  const step = d * approach(dt, tau);
  const cap = maxRate * dt;
  return facing + Math.max(-cap, Math.min(cap, step));
}

export function easeAngle(drawn: number, target: number, dt: number, tau = 0.025, snap = 1.2): number {
  const d = angleDelta(drawn, target);
  if (Math.abs(d) > snap) return target;
  return drawn + d * approach(dt, tau);
}
