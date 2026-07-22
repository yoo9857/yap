import { MAX_STREAM_MULT } from "@robo/shared";

interface ActiveBoost {
  extraMult: number;
  expiresAt: number;
}

/**
 * Tracks the live-stream crew boosts. Each donation/cheer adds a timed
 * multiplier; the effective crew speed is `1 + Σ(active extras)`, capped so a
 * donation raid can't break pacing. Pure and time-injected — unit-tested,
 * never reads the clock itself. The builder feeds the result straight into the
 * sim's `dt` (see BuilderGame.fixedUpdate), so a boost speeds up the WHOLE crew
 * — more deliveries, more gold, more confetti — without touching save state.
 */
export class StreamBoosts {
  private active: ActiveBoost[] = [];

  add(extraMult: number, durationMs: number, now: number): void {
    if (extraMult <= 0 || durationMs <= 0) return;
    this.active.push({ extraMult, expiresAt: now + durationMs });
  }

  /** Effective crew multiplier at `now` (>=1); prunes expired boosts. */
  multiplier(now: number): number {
    if (this.active.length) this.active = this.active.filter((b) => b.expiresAt > now);
    let sum = 0;
    for (const b of this.active) sum += b.extraMult;
    return Math.min(MAX_STREAM_MULT, 1 + sum);
  }

  /** Ms until the last active boost ends (0 if none). */
  remainingMs(now: number): number {
    let max = 0;
    for (const b of this.active) max = Math.max(max, b.expiresAt - now);
    return Math.max(0, max);
  }

  get count(): number {
    return this.active.length;
  }
}
