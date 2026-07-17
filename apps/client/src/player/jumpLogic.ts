import { COYOTE_TICKS, JUMP_BUFFER_TICKS } from "@robo/shared";

/**
 * Pure, tick-based jump decision — coyote time + jump buffering, exactly as
 * tuned in the prototype. No physics types so it is trivially unit-testable.
 */
export interface JumpState {
  lastGroundedTick: number;
  lastPressTick: number;
  consumedPressTick: number;
}

export function createJumpState(): JumpState {
  return {
    lastGroundedTick: Number.MIN_SAFE_INTEGER,
    lastPressTick: Number.MIN_SAFE_INTEGER,
    consumedPressTick: Number.MIN_SAFE_INTEGER,
  };
}

export function resetJumpState(s: JumpState): void {
  s.lastGroundedTick = Number.MIN_SAFE_INTEGER;
  s.lastPressTick = Number.MIN_SAFE_INTEGER;
  s.consumedPressTick = Number.MIN_SAFE_INTEGER;
}

/**
 * Advance one tick; returns true when a jump should fire this tick.
 * - coyote: still jumpable up to COYOTE_TICKS after leaving the ground
 * - buffer: a press up to JUMP_BUFFER_TICKS before landing still jumps
 * - each press fires at most one jump; a jump ends the coyote window
 */
export function updateJump(
  s: JumpState,
  tick: number,
  grounded: boolean,
  jumpPressed: boolean,
): boolean {
  if (grounded) s.lastGroundedTick = tick;
  if (jumpPressed) s.lastPressTick = tick;

  const coyoteOk = tick - s.lastGroundedTick <= COYOTE_TICKS;
  const buffered =
    tick - s.lastPressTick <= JUMP_BUFFER_TICKS && s.lastPressTick > s.consumedPressTick;

  if (coyoteOk && buffered) {
    s.consumedPressTick = s.lastPressTick;
    s.lastGroundedTick = Number.MIN_SAFE_INTEGER; // no double coyote jump
    return true;
  }
  return false;
}
