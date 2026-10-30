import { describe, expect, it } from "vitest";
import { measureRoom, occlusion, occlusionFor, roomEcho } from "../src/audio/acoustics.js";

describe("walls between you and a sound", () => {
  const wallAtX5 = (x: number) => (x === 5 ? 1 : 0);
  it("hears a clear line unchanged", () => {
    expect(occlusion([0.5, 1.5, 0.5], [9.5, 1.5, 0.5], () => 0)).toEqual({ amount: 0, gain: 1, cutoff: 20000 });
  });
  it("muffles and quietens through one wall, more through two", () => {
    const one = occlusion([0.5, 1.5, 0.5], [9.5, 1.5, 0.5], (x) => wallAtX5(x));
    expect(one.amount).toBe(1);
    expect(one.gain).toBeCloseTo(0.5, 5);
    expect(one.cutoff).toBeLessThan(2500);
    const two = occlusion([0.5, 1.5, 0.5], [9.5, 1.5, 0.5], (x) => (x === 5 || x === 6 ? 1 : 0));
    expect(two.gain).toBeLessThan(one.gain);
    expect(two.cutoff).toBeLessThan(one.cutoff);
  });
  it("lets glass and leaves through more than stone", () => {
    const glass = occlusion([0.5, 1.5, 0.5], [9.5, 1.5, 0.5], (x) => (x === 5 ? 0.35 : 0));
    expect(glass.gain).toBeGreaterThan(0.7);
  });
  it("never muffles a sound by the block it comes from or the cell you stand in", () => {
    const broken = occlusion([0.5, 1.5, 0.5], [5.5, 1.5, 0.5], (x) => (x === 5 || x === 0 ? 1 : 0));
    expect(broken.amount).toBe(0);
  });
  it("keeps a sound behind many walls faint, not gone", () => {
    expect(occlusionFor(10).gain).toBeGreaterThan(0.1);
    expect(occlusionFor(10).cutoff).toBeGreaterThanOrEqual(350);
  });
});

describe("how enclosed the listener is", () => {
  it("is open on a flat field and shut in a stone box", () => {
    const field = measureRoom([0.5, 1.5, 0.5], (_x, y) => y < 0);
    expect(field.enclosure).toBe(0);
    const box = measureRoom([0.5, 1.5, 0.5], (x, y, z) => Math.abs(x) >= 4 || y >= 5 || y < 0 || Math.abs(z) >= 4);
    expect(box.enclosure).toBeGreaterThan(0.85);
    expect(box.size).toBeLessThan(6);
  });
  it("rings longer and wetter in a big hall than in the open", () => {
    const hall = roomEcho({ enclosure: 1, size: 12 });
    const open = roomEcho({ enclosure: 0, size: 14 });
    expect(hall.wet).toBeGreaterThan(0.25);
    expect(open.wet).toBe(0);
    expect(hall.decay).toBeGreaterThan(roomEcho({ enclosure: 1, size: 2 }).decay);
  });
});
