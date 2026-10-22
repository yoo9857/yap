/**
 * The pet's follow brain — pure, DOM-free, deterministic, unit-tested.
 *
 * It owns no physics and no three.js: given where the pet is and where its
 * owner is, it returns a wish vector for `stepBody` plus the animation the rig
 * should play. That split is deliberate — the dog collides with the voxel grid
 * through exactly the same sweep the player does, so it can never walk through
 * a wall the player cannot.
 *
 * The behaviour it encodes, in the order it matters:
 *
 * - **Bands with hysteresis.** A single "run if far" threshold makes a pet
 *   oscillate on the spot at exactly that distance, which reads as a twitch.
 *   So the dog starts moving at `CHASE_IN` and only stops once it is inside
 *   the tighter `CHASE_OUT`, and the sprint band works the same way.
 * - **It hops at a step BEFORE walking into it.** There is no auto-step in
 *   `voxelBody` — full-block ledges need a deliberate jump — and on bumpy
 *   ground a dog that only reacts after being stopped spends most of its time
 *   nosing into walls waiting out a timer (measured: a fifth of its sprint
 *   speed across the island). The caller senses the cell ahead and passes it
 *   in; the no-progress timer stays as the backstop for whatever that misses.
 * - **Blocked means go round, then give up.** Some walls are two blocks tall;
 *   the player cannot climb those either, and a pet with no path pushes its
 *   nose into the same cell forever. So a stuck dog starts sliding ALONG the
 *   obstacle, swapping sides if that one is no better, and after `LOST_TIME`
 *   of getting nowhere it asks to be recalled. A companion that can be lost
 *   permanently behind a wall is worse than one that occasionally reappears.
 * - **Teleport is a last resort, never a shortcut.** Beyond that give-up case,
 *   only when the owner is past `TELEPORT_DIST` or a long way above (the dog
 *   fell off the island and the player did not). Everything closer has to be
 *   walked, or the pet stops reading as a creature.
 * - **Stay is absolute.** Told to sit, the dog sits — no distance override, or
 *   "stay" means nothing.
 */

export type PetAnim = "idle" | "walk" | "run" | "jump" | "fall" | "sit";

export type PetMode = "follow" | "stay";

/** Just the fields the brain reads — `Body` from voxelBody satisfies this. */
export interface PetSelf {
  x: number;
  y: number;
  z: number;
  grounded: boolean;
}

export interface PetOwner {
  x: number;
  y: number;
  z: number;
}

/** What the caller can see of the world that the brain cannot. */
export interface PetSense {
  /** A solid cell directly ahead at foot height with clear air above it — a
   *  step the pet could hop onto. The caller owns the voxel grid, so it owns
   *  this probe; the brain stays pure. */
  stepAhead: boolean;
}

/** Carried between ticks. Mutated in place, matching `stepBody`'s idiom. */
export interface PetBrain {
  mode: PetMode;
  /** Latched by the hysteresis bands so they survive across ticks. */
  chasing: boolean;
  sprinting: boolean;
  /** Seconds of near-zero DISPLACEMENT while wanting to move: something solid
   *  is in the way right now. Drives the hop and then the sidestep. */
  blocked: number;
  /** Seconds since the pet last got meaningfully closer to the owner than it
   *  has ever been on this attempt. Drives the give-up recall.
   *
   *  These two are deliberately separate signals. Displacement alone says a
   *  dog skating along a wall is "making progress" and it slides forever;
   *  closing-distance alone says a dog hopping a ledge is stuck. Each timer
   *  answers only the question it is good at. */
  noGain: number;
  /** Best (smallest) distance achieved on this attempt; Infinity = no history,
   *  which reads as progress so a fresh spawn never starts out stuck. */
  bestDist: number;
  /** Seconds until another hop is allowed (a held jump just vibrates). */
  hopCooldown: number;
  /** Which way round an obstacle we are currently trying: +1 or -1. */
  sideSign: 1 | -1;
  /** Previous position, for the displacement half of the progress check. */
  lastX: number;
  lastZ: number;
  /** Where the rig should face (radians, +z forward like the character rig). */
  yaw: number;
  anim: PetAnim;
}

export interface PetCommand {
  /** Feed straight to `stepBody`; magnitude scales speed (1 = walk pace). */
  wishX: number;
  wishZ: number;
  jump: boolean;
  /** The brain gave up on walking — the caller should place the pet near the
   *  owner (it owns the world, so it owns finding safe ground). */
  teleport: boolean;
  anim: PetAnim;
  yaw: number;
}

/** Start moving beyond this, stop once inside CHASE_OUT. */
export const CHASE_IN = 2.6;
export const CHASE_OUT = 1.5;
/** Break into a run beyond this, drop back to a walk inside SPRINT_OUT. */
export const SPRINT_IN = 6.5;
export const SPRINT_OUT = 4.0;
/** Wish magnitudes — `stepBody` multiplies these by MOVE_SPEED (4.6 m/s). */
export const WALK_GAIN = 0.52;
export const RUN_GAIN = 1.08;
/** Beyond this the dog has lost the player for good (through a wall, across
 *  the island) and reappears instead of jogging forever. */
export const TELEPORT_DIST = 28;
/** Owner this far above the pet means the pet is down a hole or off the edge. */
export const TELEPORT_DROP = 14;
/** Blocked this long and we hop. */
const STUCK_TIME = 0.25;
/** Blocked this long and we stop pushing straight and start sliding sideways. */
const SIDESTEP_AFTER = 0.5;
/** ...and this long on one side before trying the other. */
const SIDESTEP_FLIP = 1.8;
/** No gain on the owner for this long: no route exists, ask to be put down. */
const LOST_TIME = 6;
/** Displacement speed below which we call the pet physically blocked (m/s). */
const STUCK_SPEED = 0.55;
/** A new personal best has to beat the old one by this much to count. */
const GAIN_MARGIN = 0.35;
/** ...and if the owner has pulled this far beyond our best, they simply walked
 *  off — forget the best rather than counting their stride against us. */
const OWNER_RAN_OFF = 4;
const HOP_COOLDOWN = 0.4;
/** Owner a clear step up and close by: hop rather than nose into the wall. */
const STEP_UP = 0.9;

export function createPetBrain(yaw = 0): PetBrain {
  return {
    mode: "follow",
    chasing: false,
    sprinting: false,
    hopCooldown: 0,
    blocked: 0,
    noGain: 0,
    bestDist: Number.POSITIVE_INFINITY,
    sideSign: 1,
    lastX: 0,
    lastZ: 0,
    yaw,
    anim: "idle",
  };
}

/** Toggle sit/follow. Returns the new mode so callers can voice it in the HUD. */
export function togglePetMode(brain: PetBrain): PetMode {
  brain.mode = brain.mode === "follow" ? "stay" : "follow";
  if (brain.mode === "stay") {
    brain.chasing = false;
    brain.sprinting = false;
    resetProgress(brain);
  }
  return brain.mode;
}

export function thinkPet(
  brain: PetBrain,
  self: PetSelf,
  owner: PetOwner,
  dt: number,
  sense: PetSense = { stepAhead: false },
): PetCommand {
  const dx = owner.x - self.x;
  const dz = owner.z - self.z;
  const dist = Math.hypot(dx, dz);

  brain.hopCooldown = Math.max(0, brain.hopCooldown - dt);

  const moved = Math.hypot(self.x - brain.lastX, self.z - brain.lastZ);
  brain.lastX = self.x;
  brain.lastZ = self.z;

  if (brain.mode === "stay") {
    resetProgress(brain);
    return command(brain, 0, 0, false, false, self.grounded ? "sit" : "fall");
  }

  // Lost: too far, or the owner is far overhead (we fell, they did not).
  if (dist > TELEPORT_DIST || owner.y - self.y > TELEPORT_DROP) {
    brain.chasing = false;
    brain.sprinting = false;
    resetProgress(brain);
    return command(brain, 0, 0, false, true, "idle");
  }

  // Hysteresis bands — latched, so the edges never chatter.
  brain.chasing = brain.chasing ? dist > CHASE_OUT : dist >= CHASE_IN;
  brain.sprinting = brain.sprinting ? dist > SPRINT_OUT : dist >= SPRINT_IN;

  if (!brain.chasing) {
    resetProgress(brain);
    // Idling at heel: keep watching the owner rather than staring at a wall.
    if (dist > 0.05) brain.yaw = Math.atan2(dx, dz);
    return command(brain, 0, 0, false, false, self.grounded ? "idle" : "fall");
  }

  // Signal 1: are we physically moving? Neither timer may be reset by the hop
  // itself — the first version zeroed it on every jump, so the dog hopped,
  // reset, crept, hopped, and never climbed past the first rung of the ladder.
  if (moved < STUCK_SPEED * dt) brain.blocked += dt;
  else brain.blocked = 0;

  // Signal 2: are we actually getting anywhere NEAR the owner? Measured against
  // the best distance of this attempt, not the last tick, so the wall-hugging
  // weave of a sidestep cannot keep re-arming it.
  if (dist > brain.bestDist + OWNER_RAN_OFF) {
    resetProgress(brain); // they walked off; that is not our failure
    brain.bestDist = dist;
  } else if (dist < brain.bestDist - GAIN_MARGIN) {
    brain.bestDist = dist;
    brain.noGain = 0;
  } else {
    brain.noGain += dt;
  }

  // No route at all. Hand it back to the caller rather than push forever.
  if (brain.noGain >= LOST_TIME) {
    resetProgress(brain);
    return command(brain, 0, 0, false, true, "idle");
  }

  const gain = brain.sprinting ? RUN_GAIN : WALK_GAIN;
  const inv = 1 / (dist || 1);
  let ux = dx * inv;
  let uz = dz * inv;

  if (brain.blocked >= SIDESTEP_AFTER) {
    // Alternate sides so a dog that picked the wrong way round a wide obstacle
    // isn't committed to it; (-uz, ux) is the left-hand perpendicular.
    const slot = Math.floor((brain.blocked - SIDESTEP_AFTER) / SIDESTEP_FLIP);
    brain.sideSign = slot % 2 === 0 ? 1 : -1;
    const sx = -uz * brain.sideSign;
    const sz = ux * brain.sideSign;
    // Mostly sideways, a little forward, so it hugs the wall instead of
    // orbiting the player.
    const bx = ux * 0.45 + sx;
    const bz = uz * 0.45 + sz;
    const blen = Math.hypot(bx, bz) || 1;
    ux = bx / blen;
    uz = bz / blen;
  }

  const wishX = ux * gain;
  const wishZ = uz * gain;
  brain.yaw = Math.atan2(ux, uz);

  const wantsStepUp = owner.y - self.y > STEP_UP && dist < CHASE_IN * 2;
  const jump =
    self.grounded &&
    brain.hopCooldown <= 0 &&
    (sense.stepAhead || brain.blocked >= STUCK_TIME || wantsStepUp);
  if (jump) brain.hopCooldown = HOP_COOLDOWN; // cooldown spaces the hops; `stuck` keeps climbing

  const anim: PetAnim = !self.grounded ? "jump" : brain.sprinting ? "run" : "walk";
  return command(brain, wishX, wishZ, jump, false, anim);
}

/** Forget the attempt so far — used whenever the chase stops or restarts. */
function resetProgress(brain: PetBrain): void {
  brain.blocked = 0;
  brain.noGain = 0;
  brain.bestDist = Number.POSITIVE_INFINITY;
}

function command(
  brain: PetBrain,
  wishX: number,
  wishZ: number,
  jump: boolean,
  teleport: boolean,
  anim: PetAnim,
): PetCommand {
  brain.anim = anim;
  return { wishX, wishZ, jump, teleport, anim, yaw: brain.yaw };
}
