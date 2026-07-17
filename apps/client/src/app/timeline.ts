import { SIM_DT } from "@robo/shared";

/**
 * Monotonic, slew-limited game timeline for moving platforms.
 *
 * The target is "seconds since the tower day started, in SERVER time", so all
 * clients evaluate the analytic platform positions on the same axis. The
 * server-clock estimate drifts a little as ping samples refine it — feeding
 * that raw into physics would teleport platforms backwards. This wrapper
 * always advances between 0.25× and 4× real tick speed toward the target, so
 * corrections converge quickly but the physics timeline never jumps or
 * reverses under the player's feet.
 */
export class SharedTimeline {
  private current: number | null = null;

  /** Called once per fixed tick with the estimated target time. */
  sample(targetSeconds: number): number {
    if (this.current === null) {
      this.current = targetSeconds;
      return this.current;
    }
    const min = this.current + SIM_DT * 0.25;
    const max = this.current + SIM_DT * 4;
    this.current = Math.min(Math.max(targetSeconds, min), max);
    return this.current;
  }

  /** Hard reset (level rebuild — platforms are recreated anyway). */
  reset(): void {
    this.current = null;
  }
}
