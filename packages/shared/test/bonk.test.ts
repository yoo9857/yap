import { describe, expect, it } from "vitest";
import { BONK_HOP, BONK_SPEED, bonkBlocked, bonkEye, lookDirection, pickBonk, type BonkAttacker } from "../src/bonk.js";

const me = (yaw = 0, pitch = 0): BonkAttacker => ({ x: 0, y: 4, z: 0.5, yaw, pitch, eye: bonkEye("idle") });

describe("classroom tap", () => {
  it("uses the craft crosshair: yaw 0 looks +z and yaw π/2 looks +x", () => {
    expect(lookDirection(0, 0)[2]).toBeCloseTo(1, 6);
    expect(lookDirection(0, 0)[0]).toBeCloseTo(0, 6);
    expect(lookDirection(Math.PI / 2, 0)[0]).toBeCloseTo(1, 6);
    expect(lookDirection(0, Math.PI / 2)[1]).toBeCloseTo(1, 6);
  });

  it("taps the nearest classmate in front and shoves them away", () => {
    const hit = pickBonk(me(), [
      { id: "far", x: 0, y: 4, z: 1.8 },
      { id: "near", x: 0, y: 4, z: 1.4 },
      { id: "behind", x: 0, y: 4, z: -0.6 },
    ]);
    expect(hit?.id).toBe("near");
    expect(hit?.vz).toBeCloseTo(BONK_SPEED, 5);
    expect(hit?.vx).toBeCloseTo(0, 5);
    expect(hit?.vy).toBe(BONK_HOP);
  });

  it("pushes someone on +x further along +x when that is where you look", () => {
    const hit = pickBonk(me(Math.PI / 2), [{ id: "side", x: 1.3, y: 4, z: 0.5 }]);
    expect(hit?.id).toBe("side");
    expect(hit!.vx).toBeGreaterThan(0);
    expect(Math.abs(hit!.vz)).toBeLessThan(0.01);
  });

  it("misses a friend beside the crosshair, out of reach, or behind a block", () => {
    expect(pickBonk(me(), [{ id: "aside", x: 1.4, y: 4, z: 0.6 }])).toBeNull();
    expect(pickBonk(me(), [{ id: "far", x: 0, y: 4, z: 4 }])).toBeNull();
    expect(pickBonk(me(-0.2), [{ id: "up", x: 0, y: 4, z: 1.5 }], {
      blocked: (from, to) => bonkBlocked(from, to, (x, y, z) => x === 0 && y === 5 && z === 1),
    })).toBeNull();
    expect(pickBonk(me(), [{ id: "open", x: 0, y: 4, z: 1.6 }])?.id).toBe("open");
  });

  it("still connects when the camera rests slightly below the horizon", () => {
    expect(pickBonk(me(0, -0.25), [{ id: "ahead", x: 0.2, y: 4, z: 1.7 }])?.id).toBe("ahead");
  });

  it("breaks a distance tie by id", () => {
    const hit = pickBonk(me(), [
      { id: "b", x: 0.25, y: 4, z: 1.5 },
      { id: "a", x: -0.25, y: 4, z: 1.5 },
    ]);
    expect(hit?.id).toBe("a");
  });
});

describe("classroom tap: body aim (the client)", () => {
  it("does not tap a classmate standing beside the block you are digging", () => {
    // looking straight ahead at a block; a friend stands half a metre to the side
    expect(pickBonk(me(), [{ id: "beside", x: 0.75, y: 4, z: 1.3 }], { aim: "body" })).toBeNull();
    // the wide server cone would have taken them
    expect(pickBonk(me(), [{ id: "beside", x: 0.75, y: 4, z: 1.3 }])?.id).toBe("beside");
  });

  it("taps a classmate the crosshair is on, head to shins, and reports how far", () => {
    const hit = pickBonk(me(), [{ id: "ahead", x: 0.2, y: 4, z: 1.7 }], { aim: "body" });
    expect(hit?.id).toBe("ahead");
    expect(hit!.dist).toBeGreaterThan(0.6);
    expect(hit!.dist).toBeLessThan(1.3);
    // looking down at their legs still lands
    expect(pickBonk(me(0, -0.8), [{ id: "legs", x: 0, y: 4, z: 1.4 }], { aim: "body" })?.id).toBe("legs");
    // over their head does not
    expect(pickBonk(me(0, 0.9), [{ id: "over", x: 0, y: 4, z: 1.4 }], { aim: "body" })).toBeNull();
  });

  it("lets the server judge only the classmate the client named", () => {
    const others = [
      { id: "near", x: 0, y: 4, z: 1.4 },
      { id: "named", x: 0.3, y: 4, z: 2.1 },
    ];
    expect(pickBonk(me(), others)?.id).toBe("near");
    expect(pickBonk(me(), others, { only: "named", reach: 2.6 })?.id).toBe("named");
    expect(pickBonk(me(), others, { only: "nobody" })).toBeNull();
  });
});
