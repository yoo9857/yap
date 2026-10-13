import { describe, expect, it } from "vitest";
import {
  ascentSequence,
  DustExperiment,
  energyFlow,
  ENERGY_PATHS,
  inclineSample,
  REFERENCE_INCLINE,
  type EnergySource,
} from "../src/craft/machines/experimentModels.js";

describe("PDF page 4: controlled gear-ratio comparison", () => {
  it("reproduces 41.25/82.50 N and 0.00/6.00 m from disclosed reference inputs", () => {
    const a = inclineSample(REFERENCE_INCLINE, 1.5, 5),
      b = inclineSample(REFERENCE_INCLINE, 3, 5);
    expect(a.wheelForce).toBe(41.25);
    expect(b.wheelForce).toBe(82.5);
    expect(a.distance.toFixed(2)).toBe("0.00");
    expect(b.distance.toFixed(2)).toBe("6.00");
    expect(REFERENCE_INCLINE).toMatchObject({
      mass: 30,
      radius: 0.8,
      slopeDegrees: 12,
      torque: 22,
      seconds: 5,
      resistance: 6.9,
    });
  });
  it("derives the outcome: doubling time quadruples travel and extra mass reduces it", () => {
    const before = inclineSample(REFERENCE_INCLINE, 3, 2),
      after = inclineSample(REFERENCE_INCLINE, 3, 4);
    expect(after.distance).toBeCloseTo(before.distance * 4, 10);
    expect(
      inclineSample({ ...REFERENCE_INCLINE, mass: 40 }, 3, 5).distance,
    ).toBeLessThan(after.distance);
    expect(
      inclineSample({ ...REFERENCE_INCLINE, radius: 1.2 }, 3, 5).wheelForce,
    ).toBe(55);
  });
  it("accounts for input work as kinetic, gravitational potential and dissipated energy", () => {
    const s = inclineSample(REFERENCE_INCLINE, 3, 5);
    expect(s.driveWork).toBeCloseTo(
      s.kineticEnergy + s.potentialEnergy + s.lostEnergy,
      8,
    );
  });
  it("caps traction, clamps the trial duration and rejects invalid numerical inputs", () => {
    const s = inclineSample({ ...REFERENCE_INCLINE, torque: 200 }, 8, 5);
    expect(s.slipping).toBe(true);
    expect(s.appliedForce).toBe(s.tractionLimit);
    expect(inclineSample(REFERENCE_INCLINE, 3, 8).distance).toBe(
      inclineSample(REFERENCE_INCLINE, 3, 5).distance,
    );
    expect(() =>
      inclineSample({ ...REFERENCE_INCLINE, mass: 0 }, 3, 5),
    ).toThrow();
    expect(() => inclineSample(REFERENCE_INCLINE, NaN, 5)).toThrow();
  });
});
describe("PDF page 6: fan movement versus filtration", () => {
  const run = (fan: number, filter: boolean) => {
    const sim = new DustExperiment(fan, filter);
    for (let i = 0; i < 600; i++) sim.step(1 / 60);
    return sim;
  };
  it("a disabled fan does not move dust horizontally or capture particles", () => {
    const initial = new DustExperiment(0, true),
      final = run(0, true);
    expect(final.particles.map((p) => p.x)).toEqual(
      initial.particles.map((p) => p.x),
    );
    expect(final.counts().captured).toBe(0);
  });
  it("filter collects particles; removing it lets the same particles escape", () => {
    const filtered = run(1.5, true),
      unfiltered = run(1.5, false);
    expect(filtered.counts().captured).toBeGreaterThan(150);
    expect(unfiltered.counts().captured).toBe(0);
    expect(unfiltered.counts().escaped).toBeGreaterThan(
      filtered.counts().escaped,
    );
    for (const c of [filtered.counts(), unfiltered.counts()])
      expect(c.moving + c.captured + c.escaped + c.settled).toBe(c.total);
    expect(run(1.5, true).counts()).toEqual(filtered.counts());
  });
  it("higher fan strength transports particles farther at the same time", () => {
    const weak = new DustExperiment(0.5, false),
      strong = new DustExperiment(2, false);
    for (let i = 0; i < 60; i++) {
      weak.step(1 / 60);
      strong.step(1 / 60);
    }
    expect(strong.particles[0]!.x).toBeGreaterThan(weak.particles[0]!.x);
  });
});
describe("PDF page 9: energy paths", () => {
  it("selects appropriate carrier types and conserves the power accounting", () => {
    for (const source of Object.keys(ENERGY_PATHS) as EnergySource[]) {
      const flow = energyFlow(source, 100);
      expect(flow.outputWatts + flow.lossWatts).toBeCloseTo(100, 10);
      expect(flow.links.reduce((n, l) => n + l.loss, 0)).toBeCloseTo(
        flow.lossWatts,
        10,
      );
      expect(flow.outputWatts).toBeGreaterThan(0);
      expect(flow.outputWatts).toBeLessThan(100);
    }
    expect(energyFlow("hydrogen", 100).links.map((l) => l.kind)).toEqual([
      "gas",
      "electrical",
      "mechanical",
    ]);
    expect(energyFlow("battery", 0).outputWatts).toBe(0);
  });
});
describe("PDF page 11: boarding and ascent presentation", () => {
  it("boards before ascending, then transitions the background gradually", () => {
    expect(ascentSequence(0)).toMatchObject({
      phase: "boarding",
      altitude: 0,
      boarding: 0,
    });
    expect(ascentSequence(1)).toMatchObject({
      phase: "boarding",
      altitude: 0,
      boarding: 0.5,
    });
    expect(ascentSequence(5).altitude).toBeGreaterThan(
      ascentSequence(3).altitude,
    );
    expect(ascentSequence(10)).toMatchObject({
      phase: "ascent",
      boarding: 1,
      spaceBlend: 1,
    });
  });
});
