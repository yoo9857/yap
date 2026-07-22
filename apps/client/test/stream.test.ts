import { describe, expect, it } from "vitest";
import { MAX_STREAM_MULT, streamBoost } from "@robo/shared";
import { StreamBoosts } from "../src/builder/streamBoosts.js";

describe("streamBoost tiers", () => {
  it("gives chat/zero-amount a small courtesy nudge", () => {
    expect(streamBoost(0, "chat").extraMult).toBeGreaterThan(0);
    expect(streamBoost(0, "donation").extraMult).toBeGreaterThan(0);
  });
  it("is monotonic in amount", () => {
    const amounts = [500, 1000, 5000, 10000, 50000, 100000];
    let prev = -1;
    for (const a of amounts) {
      const m = streamBoost(a, "donation").extraMult;
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });
  it("bigger tips last longer", () => {
    expect(streamBoost(50000, "donation").durationMs).toBeGreaterThan(
      streamBoost(1000, "donation").durationMs,
    );
  });
});

describe("StreamBoosts", () => {
  it("is 1x with no boosts", () => {
    expect(new StreamBoosts().multiplier(0)).toBe(1);
  });
  it("stacks additively", () => {
    const b = new StreamBoosts();
    b.add(1, 1000, 0); // +1
    b.add(2, 1000, 0); // +2
    expect(b.multiplier(500)).toBe(4); // 1 + 1 + 2
  });
  it("expires boosts by time", () => {
    const b = new StreamBoosts();
    b.add(2, 1000, 0);
    expect(b.multiplier(500)).toBe(3);
    expect(b.multiplier(1001)).toBe(1);
    expect(b.count).toBe(0);
  });
  it("caps the combined multiplier", () => {
    const b = new StreamBoosts();
    for (let i = 0; i < 20; i++) b.add(5, 10_000, 0);
    expect(b.multiplier(0)).toBe(MAX_STREAM_MULT);
  });
  it("reports remaining time of the longest boost", () => {
    const b = new StreamBoosts();
    b.add(1, 1000, 0);
    b.add(1, 5000, 0);
    expect(b.remainingMs(0)).toBe(5000);
    expect(b.remainingMs(4000)).toBe(1000);
  });
  it("ignores non-positive boosts", () => {
    const b = new StreamBoosts();
    b.add(0, 1000, 0);
    b.add(1, 0, 0);
    expect(b.count).toBe(0);
  });
});
