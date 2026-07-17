/**
 * Estimates the server clock from timestamped server messages. Remote-player
 * interpolation only needs a STABLE offset, not an exact one — never compare
 * raw wall clocks across machines.
 */
export class ServerClock {
  private offsetMs: number | null = null;

  /** Feed every server message that carries serverTimeMs. */
  sample(serverTimeMs: number): void {
    const sampleOffset = serverTimeMs - performance.now();
    if (this.offsetMs === null) {
      this.offsetMs = sampleOffset;
      return;
    }
    // EWMA with outlier clamp: a burst of delayed packets shifts the estimate
    // slowly instead of yanking the whole remote timeline around
    const diff = sampleOffset - this.offsetMs;
    const clamped = Math.max(-50, Math.min(50, diff));
    this.offsetMs += clamped * 0.1;
  }

  /** Estimated "now" on the server; null until the first sample. */
  now(): number | null {
    return this.offsetMs === null ? null : performance.now() + this.offsetMs;
  }

  reset(): void {
    this.offsetMs = null;
  }
}
