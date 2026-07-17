import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  DEFAULT_DAY_UTC_OFFSET_MIN,
  dailySeed,
  dayInfoAt,
  generateLevel,
  timelineSeconds,
} from "../src/index.js";

describe("daily tower", () => {
  it("derives a deterministic seed from the date", () => {
    expect(dailySeed("2026-07-17")).toBe(dailySeed("2026-07-17"));
    expect(dailySeed("2026-07-17")).not.toBe(dailySeed("2026-07-18"));
  });

  it("same moment → same day info regardless of who computes it", () => {
    const now = Date.UTC(2026, 6, 17, 12, 0, 0); // 2026-07-17 21:00 KST
    const a = dayInfoAt(now);
    const b = dayInfoAt(now, DEFAULT_DAY_UTC_OFFSET_MIN);
    expect(a).toEqual(b);
    expect(a.dateStr).toBe("2026-07-17");
    expect(a.dayNumber).toBe(1); // launch day
    expect(generateLevel(a.seed)).toEqual(generateLevel(b.seed));
  });

  it("rolls over exactly at midnight in the tower timezone (KST)", () => {
    // 2026-07-17 23:59:59.999 KST = 14:59:59.999 UTC
    const justBefore = Date.UTC(2026, 6, 17, 14, 59, 59, 999);
    const justAfter = justBefore + 1;
    expect(dayInfoAt(justBefore).dateStr).toBe("2026-07-17");
    expect(dayInfoAt(justAfter).dateStr).toBe("2026-07-18");
    expect(dayInfoAt(justAfter).dayNumber).toBe(dayInfoAt(justBefore).dayNumber + 1);
    expect(dayInfoAt(justBefore).nextDayStartMs).toBe(justAfter);
  });

  it("day boundaries tile the timeline exactly", () => {
    const d = dayInfoAt(Date.UTC(2026, 6, 17, 3, 0, 0));
    expect(d.nextDayStartMs - d.dayStartMs).toBe(DAY_MS);
    expect(timelineSeconds(d.dayStartMs, d.dayStartMs)).toBe(0);
    expect(timelineSeconds(d.dayStartMs + 1500, d.dayStartMs)).toBeCloseTo(1.5, 10);
  });
});
