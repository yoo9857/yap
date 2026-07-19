import { SIM_DT } from "@robo/shared";

/** Advance stays within [1−SLEW, 1+SLEW]× a real tick, so per-tick platform
 *  speed barely changes frame-to-frame (smooth ride) yet still tracks server
 *  time. A wide window would let clock-sync jitter through as visible judder. */
const SLEW = 0.15;
/** Fraction of the remaining drift corrected each tick (gentle convergence). */
const CORRECTION_GAIN = 0.05;
/** Drift this large isn't jitter (jitter is tens of ms) — it's a paused/hidden
 *  tab or a fresh sync. Snap rather than crawl back at the slew cap. Safe: the
 *  platform's per-tick rideDelta is bounded to one nominal tick, so a snap
 *  teleports the block but never flings a rider. */
const SNAP_SECONDS = 1;

/**
 * Monotonic, rate-limited game timeline for moving platforms.
 *
 * The target is "seconds since the tower day started, in SERVER time", so all
 * clients evaluate the analytic platform positions on the same axis. But the
 * server-clock estimate JITTERS as ping samples refine it, and feeding that raw
 * into physics makes platforms speed up and stall tick-to-tick — the "stutter
 * on moving blocks" bug. So this is a phase-locked loop: each tick it advances
 * one nominal SIM_DT (both clocks run at real time, so this alone stays roughly
 * synced) plus a SMALL bounded correction toward the target. The advance never
 * leaves [0.85×, 1.15×] a tick, so platforms move smoothly; the offset/drift
 * still converges within a second or so, and the axis never reverses.
 */
export class SharedTimeline {
  private current: number | null = null;

  /** Called once per fixed tick with the estimated target time. */
  sample(targetSeconds: number): number {
    const drift = this.current === null ? 0 : targetSeconds - this.current;
    if (this.current === null || Math.abs(drift) > SNAP_SECONDS) {
      this.current = targetSeconds; // first sample / big desync — snap
      return this.current;
    }
    const maxCorrection = SIM_DT * SLEW;
    const correction = Math.max(-maxCorrection, Math.min(maxCorrection, drift * CORRECTION_GAIN));
    this.current += SIM_DT + correction;
    return this.current;
  }

  /** Hard reset (level rebuild — platforms are recreated anyway). */
  reset(): void {
    this.current = null;
  }
}
