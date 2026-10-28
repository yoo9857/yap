/**
 * Filters pointer-lock mouse movement before it turns the camera. Pure, so it
 * is unit-tested.
 *
 * Browsers report garbage around a capture: the first events after
 * requestPointerLock can carry the whole jump from where the cursor was to the
 * centre of the screen, and the OS occasionally emits a single huge delta.
 * Clamping such an event still turned the view ~27° at once, and two or three
 * in a row slammed the pitch to its limit — the view "stuck" level or looking
 * straight down, most often in furniture mode, which re-captures the mouse on
 * every pick. So they are dropped, not clamped.
 */

/** Movement in the first moments after a capture is the cursor's jump, not the hand's. */
export const LOCK_SETTLE_MS = 150;
/** No real hand moves this far between two mouse reports. */
export const SPIKE_PX = 200;

/** The delta to apply, or null to ignore this event. */
export function lookDelta(dx: number, dy: number, msSinceLock: number): [number, number] | null {
  if (msSinceLock < LOCK_SETTLE_MS) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) > SPIKE_PX || Math.abs(dy) > SPIKE_PX) return null;
  return [dx, dy];
}
