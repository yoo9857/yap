import { describe, expect, it } from "vitest";
import { DynamicResolution, effectiveFov, pixelRatioFor, qualityProfile } from "../src/render/display.js";

const horizontal = (vfov: number, aspect: number) => (2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect) * 180) / Math.PI;

describe("field of view across screen shapes", () => {
  it("keeps the vertical view from 4:3 to ultrawide (wider screens see more to the sides)", () => {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9, 32 / 9]) expect(effectiveFov(70, aspect)).toBe(70);
    expect(horizontal(70, 21 / 9)).toBeGreaterThan(horizontal(70, 16 / 9));
  });

  it("holds the 4:3 horizontal view on narrower screens (a phone held upright)", () => {
    const want = horizontal(70, 4 / 3);
    for (const aspect of [1, 9 / 16, 9 / 19.5]) {
      const v = effectiveFov(70, aspect);
      expect(v).toBeGreaterThan(70);
      expect(Math.abs(horizontal(v, aspect) - want) < 0.01 || v === 110, `${aspect}: ${horizontal(v, aspect)}`).toBe(true);
    }
    // never a fisheye: capped
    expect(effectiveFov(100, 9 / 21)).toBeLessThanOrEqual(110);
  });

  it("a broken aspect (zero-size window while minimised) leaves the setting alone", () => {
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(effectiveFov(70, aspect)).toBe(70);
  });
});

describe("graphics presets", () => {
  it("spend more on higher presets", () => {
    const [low, med, high] = (["low", "medium", "high"] as const).map(qualityProfile);
    expect(low!.shadows).toBe(false);
    expect(low!.maxPixelRatio).toBeLessThan(med!.maxPixelRatio);
    expect(med!.maxPixelRatio).toBeLessThan(high!.maxPixelRatio);
    expect(high!.shadowMapSize).toBeGreaterThanOrEqual(med!.shadowMapSize);
    expect(qualityProfile("auto").minScale).toBeLessThan(1);
  });

  it("never renders past the screen's own density, never below half a pixel", () => {
    expect(pixelRatioFor(1, qualityProfile("high"), 1)).toBe(1);
    expect(pixelRatioFor(3, qualityProfile("high"), 1)).toBe(2);
    expect(pixelRatioFor(Number.NaN, qualityProfile("auto"), 1)).toBe(1);
    expect(pixelRatioFor(1, qualityProfile("low"), 0.1)).toBe(0.5);
  });
});

describe("dynamic resolution (auto)", () => {
  const run = (d: DynamicResolution, ms: number, frames: number) => {
    let changes = 0;
    for (let i = 0; i < frames; i++) if (d.frame(ms)) changes++;
    return changes;
  };

  it("steps down when slow, back up when fast, within its floor", () => {
    const d = new DynamicResolution(0.6);
    run(d, 30, 90 * 10);
    expect(d.scale).toBe(0.6);
    run(d, 8, 90 * 20);
    expect(d.scale).toBe(1);
  });

  it("holds steady in the comfortable band (no flapping)", () => {
    const d = new DynamicResolution(0.6);
    expect(run(d, 16.6, 90 * 10)).toBe(0);
    expect(d.scale).toBe(1);
  });

  it("ignores hitches and nonsense frame times", () => {
    const d = new DynamicResolution(0.6);
    for (let i = 0; i < 1000; i++) d.frame(i % 10 === 0 ? 5000 : 16);
    for (const ms of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) d.frame(ms);
    expect(d.scale).toBe(1);
  });
});
