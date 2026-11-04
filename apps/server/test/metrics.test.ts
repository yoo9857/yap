import { describe, expect, it } from "vitest";
import { ProcessMeter, metricsAllowed } from "../src/metrics.js";

describe("/metrics", () => {
  it("answers the box itself only, never a request that came through nginx", () => {
    expect(metricsAllowed("127.0.0.1", {})).toBe(true);
    expect(metricsAllowed("::1", {})).toBe(true);
    expect(metricsAllowed("::ffff:127.0.0.1", {})).toBe(true);
    // nginx is local too, but it always adds X-Real-IP
    expect(metricsAllowed("127.0.0.1", { "x-real-ip": "203.0.113.9" })).toBe(false);
    expect(metricsAllowed("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })).toBe(false);
    expect(metricsAllowed("203.0.113.9", {})).toBe(false);
    expect(metricsAllowed(undefined, {})).toBe(false);
  });

  it("samples a window and starts a new one", () => {
    const meter = new ProcessMeter();
    let x = 0;
    // by the clock, not an iteration count: Windows counts CPU time in ~15 ms ticks
    const until = performance.now() + 60;
    while (performance.now() < until) x += Math.sqrt(x + 1);
    const s = meter.sample();
    meter.stop();
    expect(x).toBeGreaterThan(0);
    expect(s.cpu).toBeGreaterThan(0);
    expect(s.elu).toBeGreaterThanOrEqual(0);
    expect(s.elu).toBeLessThanOrEqual(1);
    expect(s.rssMiB).toBeGreaterThan(0);
  });
});
