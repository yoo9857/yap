import { describe, expect, it } from "vitest";
import {
  CHASE_IN,
  CHASE_OUT,
  RUN_GAIN,
  SPRINT_IN,
  SPRINT_OUT,
  TELEPORT_DIST,
  TELEPORT_DROP,
  WALK_GAIN,
  createPetBrain,
  thinkPet,
  togglePetMode,
  type PetSelf,
} from "../src/player/pet.js";
import { WORLD_X, WORLD_Z, VoxelWorld } from "../src/craft/voxelWorld.js";
import { blockByKey } from "../src/craft/blocks.js";
import { BODY_HEIGHT, BODY_WIDTH, overlapsVoxel, stepBody, type Body } from "../src/craft/voxelBody.js";

const DT = 1 / 60;

const self = (x: number, z: number, grounded = true, y = 0): PetSelf => ({ x, y, z, grounded });
const owner = (x: number, z: number, y = 0) => ({ x, y, z });

/** Run n ticks with the pet pinned in place (the "wall in the way" case). */
function tickStuck(brain: ReturnType<typeof createPetBrain>, n: number, at = self(0, 0)) {
  let last = thinkPet(brain, at, owner(0, 10), DT);
  for (let i = 1; i < n; i++) last = thinkPet(brain, at, owner(0, 10), DT);
  return last;
}

describe("pet follow brain", () => {
  it("holds still inside the heel distance", () => {
    const brain = createPetBrain();
    const cmd = thinkPet(brain, self(0, 0), owner(0, CHASE_IN - 0.4), DT);
    expect(cmd.wishX).toBe(0);
    expect(cmd.wishZ).toBe(0);
    expect(cmd.anim).toBe("idle");
  });

  it("walks toward the owner past the chase threshold", () => {
    const brain = createPetBrain();
    const cmd = thinkPet(brain, self(0, 0), owner(0, CHASE_IN + 0.5), DT);
    expect(cmd.anim).toBe("walk");
    expect(cmd.wishZ).toBeCloseTo(WALK_GAIN, 5);
    expect(cmd.wishX).toBeCloseTo(0, 5);
  });

  it("breaks into a run past the sprint threshold, at a higher gain", () => {
    const brain = createPetBrain();
    const cmd = thinkPet(brain, self(0, 0), owner(0, SPRINT_IN + 1), DT);
    expect(cmd.anim).toBe("run");
    expect(cmd.wishZ).toBeCloseTo(RUN_GAIN, 5);
    expect(RUN_GAIN).toBeGreaterThan(WALK_GAIN);
  });

  it("keeps chasing between CHASE_OUT and CHASE_IN once it has started", () => {
    const brain = createPetBrain();
    thinkPet(brain, self(0, 0), owner(0, CHASE_IN + 0.2), DT); // start moving
    const mid = (CHASE_IN + CHASE_OUT) / 2;
    const cmd = thinkPet(brain, self(0, 0), owner(0, mid), DT);
    expect(cmd.anim).toBe("walk"); // the band latched — no stop-start twitch
    const close = thinkPet(brain, self(0, 0), owner(0, CHASE_OUT - 0.1), DT);
    expect(close.anim).toBe("idle");
  });

  it("keeps running between SPRINT_OUT and SPRINT_IN once it has started", () => {
    const brain = createPetBrain();
    thinkPet(brain, self(0, 0), owner(0, SPRINT_IN + 1), DT);
    const mid = (SPRINT_IN + SPRINT_OUT) / 2;
    expect(thinkPet(brain, self(0, 0), owner(0, mid), DT).anim).toBe("run");
    expect(thinkPet(brain, self(0, 0), owner(0, SPRINT_OUT - 0.2), DT).anim).toBe("walk");
  });

  it("hops once it has spent long enough making no progress", () => {
    const brain = createPetBrain();
    // One tick to establish lastX/lastZ, then hold the pet still.
    expect(tickStuck(brain, 2).jump).toBe(false);
    let jumped = false;
    for (let i = 0; i < 60 && !jumped; i++) jumped = thinkPet(brain, self(0, 0), owner(0, 10), DT).jump;
    expect(jumped).toBe(true);
  });

  it("does not hop again on the very next tick (cooldown)", () => {
    const brain = createPetBrain();
    let jumped = false;
    for (let i = 0; i < 60 && !jumped; i++) jumped = thinkPet(brain, self(0, 0), owner(0, 10), DT).jump;
    expect(jumped).toBe(true);
    expect(thinkPet(brain, self(0, 0), owner(0, 10), DT).jump).toBe(false);
  });

  it("never hops while airborne", () => {
    const brain = createPetBrain();
    for (let i = 0; i < 120; i++) {
      expect(thinkPet(brain, self(0, 0, false), owner(0, 10), DT).jump).toBe(false);
    }
  });

  it("hops straight away for a step up the owner is standing on", () => {
    const brain = createPetBrain();
    // No stuck-time needed: the ledge is visible in the height difference.
    expect(thinkPet(brain, self(0, 0), owner(0, 3, 1.5), DT).jump).toBe(true);
    // ...and the cooldown still applies, so it is one hop, not a vibration.
    expect(thinkPet(brain, self(0, 0), owner(0, 3, 1.5), DT).jump).toBe(false);
  });

  it("asks to teleport only once truly lost", () => {
    const brain = createPetBrain();
    expect(thinkPet(brain, self(0, 0), owner(0, TELEPORT_DIST - 1), DT).teleport).toBe(false);
    expect(thinkPet(brain, self(0, 0), owner(0, TELEPORT_DIST + 1), DT).teleport).toBe(true);
  });

  it("asks to teleport when the owner is far overhead (it fell, they did not)", () => {
    const brain = createPetBrain();
    const cmd = thinkPet(brain, self(0, 1, true, -TELEPORT_DROP - 2), owner(0, 1, 0), DT);
    expect(cmd.teleport).toBe(true);
  });

  it("stay means stay — no distance overrides it", () => {
    const brain = createPetBrain();
    expect(togglePetMode(brain)).toBe("stay");
    const cmd = thinkPet(brain, self(0, 0), owner(0, SPRINT_IN + 10), DT);
    expect(cmd.wishX).toBe(0);
    expect(cmd.wishZ).toBe(0);
    expect(cmd.jump).toBe(false);
    expect(cmd.teleport).toBe(false);
    expect(cmd.anim).toBe("sit");
    expect(togglePetMode(brain)).toBe("follow");
  });

  it("slides sideways once pushing straight has stopped working", () => {
    const brain = createPetBrain();
    // Owner due +z, pet pinned: the chase direction is pure +z, so any lateral
    // component in the wish can only have come from the sidestep.
    let cmd = thinkPet(brain, self(0, 0), owner(0, 10), DT);
    expect(Math.abs(cmd.wishX)).toBeLessThan(1e-6);
    for (let i = 0; i < 60; i++) cmd = thinkPet(brain, self(0, 0), owner(0, 10), DT); // 1 s pinned
    expect(Math.abs(cmd.wishX)).toBeGreaterThan(0.5);
  });

  it("tries the other side if the first one gets nowhere", () => {
    const brain = createPetBrain();
    const sideAt = (seconds: number): number => {
      const b = createPetBrain();
      for (let i = 0; i < Math.round(seconds / DT); i++) thinkPet(b, self(0, 0), owner(0, 10), DT);
      return Math.sign(thinkPet(b, self(0, 0), owner(0, 10), DT).wishX);
    };
    expect(brain.sideSign).toBe(1);
    expect(sideAt(1)).not.toBe(sideAt(3)); // flipped within the first two slots
  });

  it("gives up and asks for a recall after long enough getting nowhere", () => {
    const brain = createPetBrain();
    let cmd = thinkPet(brain, self(0, 0), owner(0, 10), DT);
    for (let i = 0; i < Math.round(5 / DT); i++) cmd = thinkPet(brain, self(0, 0), owner(0, 10), DT);
    expect(cmd.teleport).toBe(false); // 5 s in: still trying
    for (let i = 0; i < Math.round(2 / DT) && !cmd.teleport; i++) {
      cmd = thinkPet(brain, self(0, 0), owner(0, 10), DT);
    }
    expect(cmd.teleport).toBe(true);
  });

  it("does not count the owner walking away as its own failure", () => {
    const brain = createPetBrain();
    // The pet is pinned but the owner keeps going: distance grows steadily.
    // That must not trip the give-up recall — TELEPORT_DIST is what covers it.
    let dist = 8;
    for (let i = 0; i < Math.round(12 / DT); i++) {
      dist = Math.min(TELEPORT_DIST - 2, dist + 0.8 * DT);
      const cmd = thinkPet(brain, self(0, 0), owner(0, dist), DT);
      expect(cmd.teleport).toBe(false);
    }
  });

  it("faces the owner even when standing at heel", () => {
    const brain = createPetBrain();
    // Owner due -x: +z-forward convention means yaw = atan2(dx, dz) = -90°.
    const cmd = thinkPet(brain, self(0, 0), owner(-1, 0), DT);
    expect(cmd.yaw).toBeCloseTo(-Math.PI / 2, 5);
  });
});

describe("sized voxel bodies", () => {
  const STONE = blockByKey("stone")!.id;
  const flatWorld = (): VoxelWorld => {
    const world = new VoxelWorld();
    for (let x = 0; x < WORLD_X; x++) for (let z = 0; z < WORLD_Z; z++) world.set(x, 3, z, STONE);
    return world;
  };

  it("defaults to the player's footprint when w/h are omitted", () => {
    // A block one cell above a 1.8 m body's feet is inside it; a 0.9 m pet's
    // head clears it. Same helper, same body position — only the size differs.
    const player: Body = { x: 4.5, y: 1, z: 4.5, vx: 0, vy: 0, vz: 0, grounded: true };
    const pet: Body = { ...player, w: 0.5, h: 0.9 };
    expect(BODY_HEIGHT).toBeGreaterThan(1.5);
    expect(overlapsVoxel(player, 4, 2, 4)).toBe(true);
    expect(overlapsVoxel(pet, 4, 2, 4)).toBe(false);
  });

  it("a narrow body fits a gap the player's width does not", () => {
    const world = flatWorld();
    world.set(3, 4, 4, STONE);
    world.set(5, 4, 4, STONE); // 1 m wide slot at x = 4
    expect(BODY_WIDTH).toBeGreaterThan(0.5);
    const run = (w: number): number => {
      const body: Body = { x: 4.5, y: 4, z: 2.5, vx: 0, vy: 0, vz: 0, grounded: true, w, h: 0.9 };
      for (let i = 0; i < 120; i++) stepBody(world, body, DT, 0, 1, false);
      return body.z;
    };
    expect(run(0.5)).toBeGreaterThan(5); // the pet walks through
    expect(run(1.4)).toBeLessThan(4); // a wide body is stopped by the posts
  });

  it("honours a per-body jump speed", () => {
    const world = flatWorld();
    const hop = (jumpSpeed?: number): number => {
      const body: Body = { x: 4.5, y: 4, z: 4.5, vx: 0, vy: 0, vz: 0, grounded: true, w: 0.5, h: 0.9, jumpSpeed };
      stepBody(world, body, DT, 0, 0, true);
      let peak = body.y;
      for (let i = 0; i < 90; i++) {
        stepBody(world, body, DT, 0, 0, false);
        peak = Math.max(peak, body.y);
      }
      return peak;
    };
    expect(hop(7.6)).toBeLessThan(hop(undefined));
  });

  it("the pet's hop clears a full block — the whole point of having one", () => {
    const world = flatWorld();
    world.set(4, 4, 6, STONE); // a 1 m step dead ahead
    const body: Body = { x: 4.5, y: 4, z: 4.5, vx: 0, vy: 0, vz: 0, grounded: true, w: 0.5, h: 1, jumpSpeed: 7.6 };
    // Walk at it, hopping whenever grounded — a real pet does this on a timer.
    for (let i = 0; i < 180; i++) stepBody(world, body, DT, 0, 1, body.grounded);
    expect(body.z).toBeGreaterThan(6); // made it onto the step
    expect(body.y).toBeGreaterThanOrEqual(5);
  });
});
