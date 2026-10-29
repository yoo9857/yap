/**
 * A light classroom tap. One look ray, shared by the client's crosshair and
 * the server that decides whether the tap lands: yaw 0 looks along +z, a
 * positive pitch looks up. That is the craft aim
 * (`sin(yaw) cos(pitch)`, `sin(pitch)`, `cos(yaw) cos(pitch)`).
 */

/** How far a tap reaches, eye to the other player's chest (metres). */
export const BONK_REACH = 1.9;
/** Extra reach the server allows so a 10 Hz position report still connects. */
export const BONK_SERVER_SLACK = 0.7;
/** Minimum dot of the look ray and the direction to their chest. About 50°. */
export const BONK_AIM = 0.64;
/** Horizontal shove, away from the attacker (m/s). */
export const BONK_SPEED = 5.4;
/** Little hop so the tap reads as a bump, not a slide (m/s). */
export const BONK_HOP = 3.15;
/** How fast the shove fades. Distance travelled is about SPEED / DECAY. */
export const BONK_DECAY = 8;
/** Two taps at once stay a bump. */
export const BONK_PUSH_CAP = 7;
/** Minimum time between taps that actually connect (ms). */
export const BONK_COOLDOWN_MS = 420;
/** Chest height above the feet. The impact and the aim point. */
export const BONK_CHEST = 1.05;
/**
 * The body the crosshair has to touch: a vertical capsule from shin to crown,
 * a little wider than the model so a tap at a walking classmate still lands.
 * The 50° cone alone hit whoever stood next to the block you were digging.
 */
export const BONK_BODY_LOW = 0.15;
export const BONK_BODY_HIGH = 1.6;
export const BONK_BODY_RADIUS = 0.42;

export interface BonkPoint {
  x: number;
  y: number;
  z: number;
}

export interface BonkAttacker extends BonkPoint {
  yaw: number;
  pitch: number;
  /** Eye height above the feet. Matches the attacker's posture. */
  eye: number;
}

export interface BonkCandidate extends BonkPoint {
  id: string;
}

export interface BonkHit {
  id: string;
  vx: number;
  vz: number;
  vy: number;
  /** Chest, in the same coordinates as the inputs. */
  at: [number, number, number];
  /** Eye to the body along the look ray (body aim) or to the chest (cone). */
  dist: number;
}

/**
 * How far along the look ray it first comes within BONK_BODY_RADIUS of the
 * classmate's vertical body axis, or null when it never does. Sampled every
 * 5 cm: exact enough for a 0.84 m wide target, and trivially cheap.
 */
function rayToBody(eye: BonkPoint, dir: readonly [number, number, number], other: BonkPoint): number | null {
  const lowY = other.y + BONK_BODY_LOW;
  const highY = other.y + BONK_BODY_HIGH;
  for (let t = 0; t <= BONK_REACH + BONK_SERVER_SLACK; t += 0.05) {
    const px = eye.x + dir[0] * t;
    const py = eye.y + dir[1] * t;
    const pz = eye.z + dir[2] * t;
    const cy = Math.min(highY, Math.max(lowY, py));
    if (Math.hypot(px - other.x, py - cy, pz - other.z) <= BONK_BODY_RADIUS) return t;
  }
  return null;
}

/** Craft crosshair. yaw 0, pitch 0 → (0, 0, 1). yaw π/2 → (1, 0, 0). */
export function lookDirection(yaw: number, pitch: number): [number, number, number] {
  const flat = Math.cos(pitch);
  return [Math.sin(yaw) * flat, Math.sin(pitch), Math.cos(yaw) * flat];
}

/** Eye height for a classroom pose. Stand/run/jump/fall share the standing eye. */
export function bonkEye(anim: string): number {
  if (anim === "sit") return 0.95;
  if (anim === "lie") return 0.48;
  if (anim === "crawl") return 1.02;
  return 1.55;
}

/**
 * True when a solid cell sits between the eye and the chest. The last 0.4 m
 * is the other player's own body, so a block they are touching does not
 * count as a wall in front of them.
 */
export function bonkBlocked(
  from: BonkPoint,
  to: BonkPoint,
  solid: (x: number, y: number, z: number) => boolean,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.05) return false;
  const steps = Math.ceil(dist / 0.25);
  for (let i = 1; i < steps; i++) {
    const traveled = dist * (i / steps);
    if (traveled < 0.2 || traveled > dist - 0.4) continue;
    const x = from.x + dx * (i / steps);
    const y = from.y + dy * (i / steps);
    const z = from.z + dz * (i / steps);
    if (solid(Math.floor(x), Math.floor(y), Math.floor(z))) return true;
  }
  return false;
}

/**
 * The nearest classmate in front of the look ray, inside reach, or null.
 * The shove points away from the attacker on the ground plane. Overlapping
 * bodies are pushed along the look direction instead.
 */
export function pickBonk(
  attacker: BonkAttacker,
  others: readonly BonkCandidate[],
  opts?: {
    reach?: number;
    blocked?: (from: BonkPoint, to: BonkPoint) => boolean;
    /**
     * "body" (the client): the look ray must pass through the classmate's body.
     * "cone" (the server, judging 10 Hz positions): anywhere within ~50° of the chest.
     */
    aim?: "body" | "cone";
    /** The server: only this classmate may be hit (the one the client aimed at). */
    only?: string;
  },
): BonkHit | null {
  const reach = opts?.reach ?? BONK_REACH;
  const [lx, ly, lz] = lookDirection(attacker.yaw, attacker.pitch);
  const eye = { x: attacker.x, y: attacker.y + attacker.eye, z: attacker.z };
  let best: BonkHit | null = null;
  let bestDist = Infinity;
  const body = opts?.aim === "body";
  for (const other of others) {
    if (opts?.only !== undefined && other.id !== opts.only) continue;
    const at: [number, number, number] = [other.x, other.y + BONK_CHEST, other.z];
    const dx = at[0] - eye.x;
    const dy = at[1] - eye.y;
    const dz = at[2] - eye.z;
    let dist = Math.hypot(dx, dy, dz);
    if (body) {
      const along = rayToBody(eye, [lx, ly, lz], other);
      if (along === null || along > reach) continue;
      dist = along;
    } else {
      if (dist < 1e-4 || dist > reach) continue;
      if ((dx * lx + dy * ly + dz * lz) / dist < BONK_AIM) continue;
    }
    const chest = { x: at[0], y: at[1], z: at[2] };
    if (opts?.blocked?.(eye, chest)) continue;
    if (dist > bestDist + 1e-6) continue;
    if (Math.abs(dist - bestDist) <= 1e-6 && best && other.id >= best.id) continue;
    let kx = other.x - attacker.x;
    let kz = other.z - attacker.z;
    const horiz = Math.hypot(kx, kz);
    if (horiz < 0.2) {
      const [fx, , fz] = lookDirection(attacker.yaw, 0);
      kx = fx;
      kz = fz;
    } else {
      kx /= horiz;
      kz /= horiz;
    }
    bestDist = dist;
    best = { id: other.id, vx: kx * BONK_SPEED, vz: kz * BONK_SPEED, vy: BONK_HOP, at, dist };
  }
  return best;
}
