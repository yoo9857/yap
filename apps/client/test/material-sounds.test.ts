import { describe, expect, it } from "vitest";
import { collectSound, materialSound, soundMaterial, stepBank } from "../src/audio/materialSounds.js";
import { placeSound } from "../src/audio/sfx.js";

const seeded = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return (seed >>> 0) / 4294967296;
};
const FAMILIES = ["stone", "coat", "ore", "wood", "dirt", "grass", "sand", "snow", "wool", "glass", "gem", "metal"];

describe("block sounds", () => {
  it("gives each surface family its own recipe, and anything new sounds like stone", () => {
    expect(soundMaterial("snow")).toBe("soft");
    expect(soundMaterial("wool")).toBe("soft");
    expect(soundMaterial("coat")).toBe("stone");
    expect(soundMaterial("something-new")).toBe("stone");
    const signature = (family: string) => JSON.stringify(materialSound("break", family, () => 0.5).map((l) => [l.t, Math.round(l.f0)]));
    const distinct = new Set(["stone", "wood", "dirt", "sand", "soft", "glass", "gem", "metal"].map((m) => signature(m === "soft" ? "snow" : m)));
    expect(distinct.size).toBe(8);
  });

  it("keeps every layer short, quiet and audible", () => {
    for (const family of FAMILIES) {
      for (const kind of ["break", "hit", "place"] as const) {
        const layers = materialSound(kind, family, seeded(7));
        expect(layers.length).toBeGreaterThan(0);
        for (const l of layers) {
          expect(l.vol).toBeGreaterThan(0);
          expect(l.vol).toBeLessThanOrEqual(0.25);
          expect(l.f0).toBeGreaterThan(20);
          expect(l.f1).toBeGreaterThan(20);
          expect(l.f0).toBeLessThan(12000);
          expect(l.delay + l.dur).toBeLessThan(kind === "hit" ? 0.25 : 0.8);
        }
        // hits repeat every ~0.24 s while digging: they must be much lighter than a break
        if (kind === "hit") expect(layers.length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("varies each play a little instead of repeating one stamped sound", () => {
    const a = materialSound("break", "stone", seeded(1));
    const b = materialSound("break", "stone", seeded(99));
    expect(a.map((l) => l.f0)).not.toEqual(b.map((l) => l.f0));
    expect(a.length).toBe(b.length);
  });

  it("ends a break with the little collect pop", () => {
    const pop = collectSound(() => 0.5);
    expect(pop.every((l) => l.t === "tone" && l.f1 > l.f0)).toBe(true);
    expect(Math.min(...pop.map((l) => l.delay))).toBeGreaterThan(0.1);
  });

  it("keeps footsteps well under the block sounds", () => {
    for (const family of FAMILIES) expect(stepBank(family).vol).toBeLessThanOrEqual(0.07);
  });

  it("places a classmate's sound by distance and side", () => {
    const ears = { x: 0, y: 0, z: 0, yaw: 0 }; // looking down +z
    expect(placeSound(ears, 0, 0, 1.5).gain).toBe(1);
    expect(placeSound(ears, 0, 0, 12).gain).toBeLessThan(0.5);
    expect(placeSound(ears, 0, 0, 30).gain).toBe(0);
    expect(placeSound(ears, -5, 0, 1).pan).toBeGreaterThan(0.3); // -x is the right hand when facing +z
    expect(placeSound(ears, 5, 0, 1).pan).toBeLessThan(-0.3);
    expect(Math.abs(placeSound({ ...ears, yaw: Math.PI / 2 }, 0, 0, -5).pan)).toBeGreaterThan(0.3);
  });
});
