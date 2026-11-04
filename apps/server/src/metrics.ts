import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/**
 * Process health, sampled for `/metrics` and the load tests. Everything here is
 * cheap enough to leave on in production: one histogram the event loop already
 * feeds, and counters read on demand.
 *
 * - `elu` (event-loop utilisation, 0..1) is the number that says "this process is
 *   full": past ~0.7 every message waits behind someone else's work.
 * - `lagMs` is how late timers fire (p50/p99/max over the window). The classroom
 *   snapshots are timers, so p99 lag is exactly how late classmates move.
 */
export interface ProcessSample {
  pid: number;
  /** CPU time used over the window, as a fraction of ONE core. */
  cpu: number;
  elu: number;
  lagMs: { p50: number; p99: number; max: number };
  rssMiB: number;
  heapMiB: number;
  windowS: number;
}

export class ProcessMeter {
  private readonly lag = monitorEventLoopDelay({ resolution: 10 });
  private cpuAt = process.cpuUsage();
  private eluAt = performance.eventLoopUtilization();
  private at = performance.now();

  constructor() {
    this.lag.enable();
  }

  /** Stats since the previous call (the window), then start a new window. */
  sample(): ProcessSample {
    const now = performance.now();
    const windowMs = Math.max(1, now - this.at);
    const cpu = process.cpuUsage(this.cpuAt);
    const elu = performance.eventLoopUtilization(this.eluAt);
    const mem = process.memoryUsage();
    const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
    const out: ProcessSample = {
      pid: process.pid,
      cpu: round((cpu.user + cpu.system) / 1000 / windowMs),
      elu: round(elu.utilization),
      lagMs: { p50: ms(this.lag.percentile(50)), p99: ms(this.lag.percentile(99)), max: ms(this.lag.max) },
      rssMiB: Math.round(mem.rss / 1048576),
      heapMiB: Math.round(mem.heapUsed / 1048576),
      windowS: round(windowMs / 1000),
    };
    this.cpuAt = process.cpuUsage();
    this.eluAt = performance.eventLoopUtilization();
    this.at = now;
    this.lag.reset();
    return out;
  }

  stop(): void {
    this.lag.disable();
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** `/metrics` is for the operator on the box, never the internet: nginx adds X-Real-IP, so a
 *  request that came through it is refused even though its peer is local. */
export function metricsAllowed(peer: string | undefined, headers: Record<string, unknown>): boolean {
  if (headers["x-real-ip"] !== undefined || headers["x-forwarded-for"] !== undefined) return false;
  return peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
}
