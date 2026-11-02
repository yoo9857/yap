import {
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MAX_PLATFORM_SPEED,
  MOVE_SPEED,
  vec3Dist,
  vec3DistXZ,
  type ClientMove,
  type LevelDef,
  type Vec3,
} from "@robo/shared";

/**
 * Pure movement/progress sanity rules for client-authoritative play.
 * Never exact physics — generous tolerances so lag never punishes honest
 * players, while teleport/speed/fly cheats and impossible finishes are caught.
 */

export interface ValidationState {
  lastPos: Vec3 | null;
  lastAcceptedAtMs: number;
  checkpoint: number;
  runStartedAtMs: number | null;
  /**
   * Where the next position report is REQUIRED to appear (within a small
   * radius): the spawn on join/restart, the reached checkpoint after a death.
   * This is what makes respawn teleports legit while keeping "respawn-spam
   * flight" impossible — a teleport is only ever accepted back to an anchor,
   * never forward.
   */
  anchor: Vec3 | null;
}

export function createValidationState(spawn: Vec3): ValidationState {
  return {
    lastPos: null,
    lastAcceptedAtMs: 0,
    checkpoint: -1,
    runStartedAtMs: null,
    anchor: [...spawn],
  };
}

const ANCHOR_RADIUS = 8;

export type MoveVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "out-of-world" | "too-fast-planar" | "too-fast-vertical" | "far-from-respawn";
    };

const TOLERANCE = 1.6;
/** |x|,|z| bound: wider tower column (±14) + platform swing + slack. */
const WORLD_XZ_BOUND = 18;

/** The most movement a gap between accepted moves can bank (s). See validateMove. */
const MAX_BANKED_SECONDS = 4;

export function validateMove(
  state: ValidationState,
  move: ClientMove,
  nowMs: number,
  level: LevelDef,
): MoveVerdict {
  const [x, y, z] = move.pos;

  if (
    Math.abs(x) > WORLD_XZ_BOUND ||
    Math.abs(z) > WORLD_XZ_BOUND ||
    y < -25 ||
    y > level.summitHeight + 20
  ) {
    return { ok: false, reason: "out-of-world" };
  }

  if (state.anchor !== null) {
    // first state after join/respawn/restart must appear AT the anchor
    if (vec3Dist(move.pos, state.anchor) > ANCHOR_RADIUS) {
      return { ok: false, reason: "far-from-respawn" };
    }
    accept(state, move.pos, nowMs, level);
    return { ok: true };
  }
  if (state.lastPos === null) {
    // unreachable in practice (anchor is set on creation) — accept in-world
    accept(state, move.pos, nowMs, level);
    return { ok: true };
  }

  // measured against wall-clock elapsed between ACCEPTED states, never per
  // message — a lag burst delivers stale positions, not teleports
  const elapsed = Math.max((nowMs - state.lastAcceptedAtMs) / 1000, 1 / 60);
  // Silence must not bank movement: an honest client that stops sending (hidden tab, paused
  // rAF) also stops moving, while a cheater would spend 10 s of budget on one 300 m teleport.
  // A real network stall longer than this costs one soft correction, not a kick.
  const budget = Math.min(elapsed, MAX_BANKED_SECONDS);
  const maxPlanar = (MOVE_SPEED * TOLERANCE + MAX_PLATFORM_SPEED) * budget + 0.75;
  if (vec3DistXZ(state.lastPos, move.pos) > maxPlanar) {
    return { ok: false, reason: "too-fast-planar" };
  }

  const dy = y - state.lastPos[1];
  const maxUp = JUMP_VELOCITY * TOLERANCE * budget + 0.75; // falling is never capped: a long fall is honest
  const maxDown = MAX_FALL_SPEED * TOLERANCE * elapsed + 1.5;
  if (dy > maxUp || dy < -maxDown) {
    return { ok: false, reason: "too-fast-vertical" };
  }

  accept(state, move.pos, nowMs, level);
  return { ok: true };
}

function accept(state: ValidationState, pos: Vec3, nowMs: number, level: LevelDef): void {
  state.anchor = null;
  state.lastPos = [...pos];
  state.lastAcceptedAtMs = nowMs;
  // the run clock starts when the player first leaves the spawn area — measured across the
  // ground like the client's (game.ts), so a hop on the spawn pad starts neither clock
  if (state.runStartedAtMs === null && vec3DistXZ(pos, level.spawn) > 1.5) {
    state.runStartedAtMs = nowMs;
  }
}

export function validateCheckpoint(
  state: ValidationState,
  index: number,
  level: LevelDef,
): boolean {
  if (index !== state.checkpoint + 1) return false;
  const cp = level.checkpoints[index];
  if (!cp) return false;
  if (state.lastPos === null || vec3Dist(state.lastPos, cp.center) > 4) return false;
  state.checkpoint = index;
  return true;
}

export type FinishVerdict = { ok: true; timeMs: number } | { ok: false; reason: string };

export function validateFinish(
  state: ValidationState,
  nowMs: number,
  level: LevelDef,
): FinishVerdict {
  if (state.checkpoint !== level.checkpoints.length - 1) {
    return { ok: false, reason: "checkpoints-skipped" };
  }
  if (state.lastPos === null || vec3Dist(state.lastPos, level.goal.center) > 5) {
    return { ok: false, reason: "not-at-goal" };
  }
  if (state.runStartedAtMs === null) {
    return { ok: false, reason: "run-never-started" };
  }
  const timeMs = nowMs - state.runStartedAtMs;
  if (timeMs < level.minFinishSeconds * 1000) {
    return { ok: false, reason: "impossibly-fast" };
  }
  return { ok: true, timeMs };
}

/**
 * death → anchor at the player's reached checkpoint (or spawn);
 * restart → anchor at spawn and reset the run.
 */
export function applyRespawn(
  state: ValidationState,
  reason: "death" | "restart",
  level: LevelDef,
): void {
  if (reason === "restart") {
    state.checkpoint = -1;
    state.runStartedAtMs = null;
    state.lastPos = null;
    state.anchor = [...level.spawn];
    return;
  }
  const cp = level.checkpoints[state.checkpoint];
  state.anchor = cp ? [...cp.center] : [...level.spawn];
}

/**
 * Where a soft correction sends the player. While an anchor is pending (just
 * joined / respawned) the ONLY position the server accepts is near the anchor,
 * so that is the target: correcting to the pre-death lastPos made every
 * following move fail as well, and kicked an honest player within a second.
 */
export function correctionTarget(state: ValidationState, level: LevelDef): Vec3 {
  return [...(state.anchor ?? state.lastPos ?? level.spawn)] as Vec3;
}
