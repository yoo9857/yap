import { describe, expect, it } from "vitest";
import { CUT_DISTANCE, angleDelta, easeAngle, interpolate, turnToward } from "../src/craft/smoothing.js";

const SIM_DT = 1 / 60;

/**
 * Run a body moving at a constant speed through the same fixed-step
 * accumulator `GameLoop` uses, on a given frame schedule, and return where it
 * was DRAWN each frame — raw (the old behaviour) and interpolated.
 */
function drive(frameDts: number[], speed = 4) {
  let x = 0;
  let prev = 0;
  let acc = 0;
  let t = 0;
  const raw: { t: number; x: number }[] = [];
  const smooth: { t: number; x: number }[] = [];
  const out = { x: 0, y: 0, z: 0 };
  for (const dt of frameDts) {
    t += dt;
    acc += dt;
    while (acc >= SIM_DT) {
      prev = x;
      x += speed * SIM_DT;
      acc -= SIM_DT;
    }
    raw.push({ t, x });
    interpolate({ x: prev, y: 0, z: 0 }, { x, y: 0, z: 0 }, acc / SIM_DT, out);
    smooth.push({ t, x: out.x });
  }
  return { raw, smooth };
}

/** Worst deviation of drawn positions from steady motion (one tick behind). */
function worstError(samples: { t: number; x: number }[], speed = 4): number {
  let worst = 0;
  for (const s of samples.slice(10)) worst = Math.max(worst, Math.abs(s.x - (s.t - SIM_DT) * speed));
  return worst;
}

describe("drawing between physics ticks", () => {
  // a 144 Hz screen, and a 60 Hz one whose frames arrive unevenly — the two
  // schedules players actually have
  const hz144 = Array.from({ length: 600 }, () => 1 / 144);
  const jittery60 = Array.from({ length: 600 }, (_, i) => (i % 3 === 0 ? 0.021 : i % 3 === 1 ? 0.012 : 0.017));

  for (const [name, schedule] of [
    ["144 Hz", hz144],
    ["uneven 60 Hz", jittery60],
  ] as const) {
    it(`moves at a steady pace on a ${name} screen`, () => {
      const { raw, smooth } = drive(schedule);
      // raw positions lag steady motion by up to a whole tick and jump in steps
      expect(worstError(raw)).toBeGreaterThan(0.05);
      // interpolated ones stay on the line, to float precision
      expect(worstError(smooth)).toBeLessThan(1e-9);
    });

    it(`never draws anything moving backwards on a ${name} screen`, () => {
      const { smooth } = drive(schedule);
      for (let i = 1; i < smooth.length; i++) expect(smooth[i]!.x).toBeGreaterThanOrEqual(smooth[i - 1]!.x - 1e-12);
    });
  }

  it("treats a teleport as a cut, not a streak across the map", () => {
    const out = { x: 0, y: 0, z: 0 };
    interpolate({ x: 0, y: 0, z: 0 }, { x: CUT_DISTANCE + 1, y: 0, z: 0 }, 0.5, out);
    expect(out.x).toBe(CUT_DISTANCE + 1);
  });
});

describe("easing the view angles", () => {
  it("wraps across ±π the short way", () => {
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(angleDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2);
  });

  it("spreads a mouse that reports in bursts evenly over the frames", () => {
    // a 125 Hz mouse against a 144 Hz screen: some frames get a move, some
    // none. The raw angle stalls and jumps; the drawn one should turn steadily.
    const frame = 1 / 144;
    let target = 0;
    let drawn = 0;
    let nextMouse = 0;
    const rawSteps: number[] = [];
    const drawnSteps: number[] = [];
    let t = 0;
    let lastRaw = 0;
    let lastDrawn = 0;
    for (let i = 0; i < 400; i++) {
      t += frame;
      while (nextMouse <= t) {
        target += 0.008; // one mouse report's worth of turn
        nextMouse += 1 / 125;
      }
      drawn = easeAngle(drawn, target, frame);
      if (i > 50) {
        rawSteps.push(target - lastRaw);
        drawnSteps.push(drawn - lastDrawn);
      }
      lastRaw = target;
      lastDrawn = drawn;
    }
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(Math.min(...rawSteps)).toBe(0); // the stall the player sees
    expect(spread(drawnSteps)).toBeLessThan(spread(rawSteps) * 0.5);
    expect(Math.min(...drawnSteps)).toBeGreaterThan(0); // never stops dead
  });

  it("takes a big jump at once instead of swinging the camera round", () => {
    expect(easeAngle(0, 2, 1 / 60)).toBe(2);
  });
});

describe("turnToward (the body's heading)", () => {
  it("swings round through a visible turn, never a one-frame flip", () => {
    let facing = 0;
    const target = Math.PI * 0.99; // S: face the camera
    const frames: number[] = [];
    for (let i = 0; i < 60; i++) {
      facing = turnToward(facing, target, 1 / 60);
      frames.push(facing);
    }
    // capped at 13 rad/s: no frame turns more than ~0.22 rad
    for (let i = 1; i < frames.length; i++) expect(Math.abs(frames[i]! - frames[i - 1]!)).toBeLessThanOrEqual(13 / 60 + 1e-9);
    // and it gets there within half a second
    expect(Math.abs(angleDelta(frames[29]!, target))).toBeLessThan(0.05);
  });

  it("takes the short way round across ±π", () => {
    const next = turnToward(Math.PI - 0.1, -Math.PI + 0.1, 1 / 60);
    expect(next).toBeGreaterThan(Math.PI - 0.1); // kept increasing, through π
  });

  it("is frame-rate independent", () => {
    const run = (fps: number) => {
      let f = 0;
      for (let i = 0; i < fps / 4; i++) f = turnToward(f, 1, 1 / fps);
      return f;
    };
    expect(Math.abs(run(60) - run(144))).toBeLessThan(0.03);
  });
});
