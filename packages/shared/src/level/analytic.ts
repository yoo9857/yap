import type { Vec3 } from "../math/index.js";
import type { MovingPlatformDef } from "./types.js";

/**
 * Moving platform positions are ALWAYS computed analytically from absolute
 * sim time — never integrated incrementally — so there is zero drift and the
 * server can reproduce the exact client-side platform position for validation.
 */
export function movingPlatformCenter(p: MovingPlatformDef, tSeconds: number): Vec3 {
  const offset = Math.sin(p.omega * tSeconds + p.phase) * p.amplitude;
  return p.axis === "x"
    ? [p.center[0] + offset, p.center[1], p.center[2]]
    : [p.center[0], p.center[1], p.center[2] + offset];
}

/** Instantaneous platform velocity along its axis (m/s). */
export function movingPlatformVelocity(p: MovingPlatformDef, tSeconds: number): Vec3 {
  const v = Math.cos(p.omega * tSeconds + p.phase) * p.amplitude * p.omega;
  return p.axis === "x" ? [v, 0, 0] : [0, 0, v];
}
