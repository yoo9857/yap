import { beforeAll, describe, expect, it } from "vitest";
import { Vector3 } from "three";
import * as RAPIER from "@dimforge/rapier3d-compat";
import { VoxelWorld, WORLD_X, WORLD_Z } from "../src/craft/voxelWorld.js";
import {
  addPart,
  blueprintError,
  machineStats,
  parseBlueprint,
  preset,
  type Blueprint,
} from "../src/craft/machines/blueprint.js";
import {
  IDLE_INPUT,
  MachinePhysics,
} from "../src/craft/machines/machinePhysics.js";
import {
  controlAxis,
  MachineFault,
  PHYSICS_RULES,
} from "../src/craft/machines/physicsRules.js";
import {
  AIR,
  angleOfAttack,
  panelForce,
} from "../src/craft/machines/aero.js";

beforeAll(async () => {
  await RAPIER.init();
});

function flatWorld(): VoxelWorld {
  const w = new VoxelWorld();
  for (let x = 0; x < WORLD_X; x++)
    for (let z = 0; z < WORLD_Z; z++) w.set(x, 0, z, 3);
  return w;
}
const origin = { x: 80, y: 5, z: 80 };
function simulate(
  b: Blueprint,
  action: (sim: MachinePhysics) => void,
  world = flatWorld(),
) {
  const sim = new MachinePhysics(RAPIER, world, b, origin);
  try {
    action(sim);
  } finally {
    sim.dispose();
  }
}

describe("machine blueprints", () => {
  it("presets are connected, have one cockpit and round-trip without changing", () => {
    for (const kind of ["rover", "ship"] as const) {
      const b = preset(kind);
      expect(blueprintError(b)).toBeNull();
      expect(parseBlueprint(JSON.stringify(b))).toEqual(b);
    }
    expect(machineStats(preset("ship")).liftRatio).toBeGreaterThan(1);
  });
  it("rejects corrupt storage, non-finite or oversized coordinates and unknown parts", () => {
    for (const raw of [
      "null",
      "{}",
      "{broken",
      JSON.stringify({
        ...preset("rover"),
        parts: [{ kind: "constructor", cell: [0, 0, 0], direction: 0 }],
      }),
      JSON.stringify({
        ...preset("rover"),
        parts: [{ kind: "cockpit", cell: [999, 0, 0], direction: 0 }],
      }),
    ])
      expect(parseBlueprint(raw)).toBeNull();
  });
  it("allows incomplete drafts to save, but refuses disconnected machines at launch", () => {
    const b = preset("rover");
    addPart(b, { kind: "frame", cell: [10, 0, 0], direction: 0 });
    expect(parseBlueprint(JSON.stringify(b))).not.toBeNull();
    expect(blueprintError(b)).toContain("떨어진");
    expect(() => new MachinePhysics(RAPIER, flatWorld(), b, origin)).toThrow(
      MachineFault,
    );
  });
  it("requires one cockpit and rejects overlapping cells", () => {
    const b = preset("rover");
    b.parts.push({ ...b.parts[0]! });
    expect(blueprintError(b)).toContain("겹쳐");
    b.parts = b.parts.filter((p) => p.kind !== "cockpit");
    expect(blueprintError(b)).toContain("조종석");
  });
  it("adding weight shifts the center of mass and reduces available lift", () => {
    const b = preset("ship"),
      before = machineStats(b);
    addPart(b, { kind: "frame", cell: [2, 0, 0], direction: 0 });
    const after = machineStats(b);
    expect(after.mass).toBe(before.mass + 8);
    expect(after.center[0]).toBeGreaterThan(before.center[0]);
    expect(after.liftRatio).toBeLessThan(before.liftRatio);
  });
});

describe("physics acceptance scenarios (SI units, rules revision 1)", () => {
  it("matches authored total mass and lands on terrain without sinking", () =>
    simulate(preset("rover"), (sim) => {
      for (let i = 0; i < 240; i++) sim.step(IDLE_INPUT);
      const s = sim.snapshot();
      expect(s.mass).toBeCloseTo(machineStats(preset("rover")).mass, 3);
      expect(s.position.y).toBeGreaterThan(1.5);
      expect(s.position.y).toBeLessThan(2.5);
      expect(s.contacts).toBe(4);
    }));
  it("wheel motor drives, steering changes heading and brakes slow it down", () =>
    simulate(preset("rover"), (sim) => {
      for (let i = 0; i < 180; i++) sim.step(IDLE_INPUT);
      const start = sim.snapshot();
      for (let i = 0; i < 120; i++) sim.step({ ...IDLE_INPUT, throttle: 1 });
      const driven = sim.snapshot();
      expect(Math.abs(driven.position.z - start.position.z)).toBeGreaterThan(2);
      expect(driven.speed).toBeGreaterThan(2);
      for (let i = 0; i < 30; i++)
        sim.step({ ...IDLE_INPUT, throttle: 1, steer: 0.5 });
      expect(Math.abs(sim.snapshot().rotation.y)).toBeGreaterThan(0.01);
      for (let i = 0; i < 120; i++) sim.step({ ...IDLE_INPUT, brake: true });
      expect(sim.snapshot().speed).toBeLessThan(driven.speed * 0.5);
    }));
  it("symmetric lift overcomes weight and releasing thrust allows gravity to act", () =>
    simulate(preset("ship"), (sim) => {
      for (let i = 0; i < 90; i++) sim.step({ ...IDLE_INPUT, lift: 1 });
      expect(sim.snapshot().position.y).toBeGreaterThan(origin.y + 1);
      for (let i = 0; i < 180; i++) sim.step(IDLE_INPUT);
      expect(sim.snapshot().position.y).toBeLessThan(origin.y);
    }));
  it("an offset thruster generates torque rather than translating the whole machine artificially", () => {
    const b: Blueprint = {
      version: 1,
      name: "torque rig",
      parts: [
        { kind: "cockpit", cell: [0, 0, 0], direction: 0 },
        { kind: "thruster", cell: [1, 0, 0], direction: 0 },
      ],
    };
    simulate(
      b,
      (sim) => {
        for (let i = 0; i < 12; i++) sim.step({ ...IDLE_INPUT, lift: 1 });
        expect(Math.abs(sim.body.angvel().z)).toBeGreaterThan(0.1);
      },
      new VoxelWorld(),
    );
  });
  it("collides with a voxel wall, including at speed", () => {
    const w = flatWorld();
    for (let x = 65; x <= 95; x++)
      for (let y = 1; y < 12; y++) {
        w.set(x, y, 90, 3);
        w.set(x, y, 70, 3);
      }
    simulate(
      preset("rover"),
      (sim) => {
        for (let i = 0; i < 180; i++) sim.step(IDLE_INPUT);
        for (let i = 0; i < 240; i++) sim.step({ ...IDLE_INPUT, throttle: 1 });
        expect(sim.snapshot().position.z).toBeGreaterThan(72);
        expect(sim.snapshot().position.z).toBeLessThan(88);
      },
      w,
    );
  });
  it("replays a fixed input sequence consistently in the same engine build", () => {
    const run = () => {
      let result;
      simulate(preset("rover"), (sim) => {
        for (let i = 0; i < 180; i++)
          sim.step({ ...IDLE_INPUT, throttle: i > 80 ? 1 : 0 });
        result = sim.snapshot();
      });
      return result;
    };
    expect(run()).toEqual(run());
  });
  it("rejects invalid input before corrupting physics state", () =>
    simulate(preset("rover"), (sim) => {
      expect(() => sim.step({ ...IDLE_INPUT, lift: NaN })).toThrow(
        MachineFault,
      );
      sim.step(IDLE_INPUT);
      expect(Number.isFinite(sim.snapshot().speed)).toBe(true);
      expect(controlAxis(999)).toBe(1);
      expect(controlAxis(-2, true)).toBe(0);
      expect(sim.snapshot().rulesRevision).toBe(PHYSICS_RULES.revision);
    }));
});

describe("aerodynamic parts (flat-plate wings, constant-lift balloons)", () => {
  const glider = (wings: number): Blueprint => {
    const parts: Blueprint["parts"] = [
      { kind: "cockpit", cell: [0, 0, 0], direction: 0 },
    ];
    for (let x = 1; x <= wings; x++) {
      parts.push({ kind: "wing", cell: [x, 0, 0], direction: 0 });
      parts.push({ kind: "wing", cell: [-x, 0, 0], direction: 0 });
    }
    return { version: 1, name: `glider ${wings}`, parts };
  };

  /** Drop from altitude with forward airspeed; report how far it sank. */
  const sink = (b: Blueprint): number => {
    let drop = 0;
    simulate(
      b,
      (sim) => {
        sim.body.setTranslation({ x: 80, y: 60, z: 80 }, true);
        sim.body.setLinvel({ x: 0, y: 0, z: 26 }, true);
        const start = sim.snapshot().position.y;
        for (let i = 0; i < 120; i++) sim.step(IDLE_INPUT);
        drop = start - sim.snapshot().position.y;
      },
      new VoxelWorld(),
    );
    return drop;
  };

  it("wings trade airspeed for lift, so a winged body sinks far slower", () => {
    const bare = sink(glider(0));
    const winged = sink(glider(3));
    expect(bare).toBeGreaterThan(1.5);
    expect(winged).toBeLessThan(bare * 0.6);
  });

  it("a level wing sliding edge-on produces no normal force", () => {
    const flow = new Vector3(0, 0, 20);
    const force = panelForce(
      flow,
      new Vector3(0, 1, 0),
      AIR.wingArea,
      AIR.wingNormalCoefficient,
      new Vector3(),
    );
    expect(force.length()).toBeCloseTo(0, 6);
    expect(angleOfAttack(flow, new Vector3(0, 1, 0))).toBeCloseTo(0, 6);
    // Air arriving from below the panel pushes it up, and four times the
    // airspeed is sixteen times the force.
    const slow = panelForce(
      new Vector3(0, -5, 5),
      new Vector3(0, 1, 0),
      AIR.wingArea,
      AIR.wingNormalCoefficient,
      new Vector3(),
    );
    const fast = panelForce(
      new Vector3(0, -20, 20),
      new Vector3(0, 1, 0),
      AIR.wingArea,
      AIR.wingNormalCoefficient,
      new Vector3(),
    );
    expect(slow.y).toBeGreaterThan(0);
    expect(fast.y / slow.y).toBeCloseTo(16, 1);
  });

  it("a balloon lifts its own weight and then some", () =>
    simulate(
      {
        version: 1,
        name: "balloon",
        parts: [
          { kind: "cockpit", cell: [0, 0, 0], direction: 0 },
          { kind: "balloon", cell: [0, 1, 0], direction: 0 },
        ],
      },
      (sim) => {
        sim.body.setTranslation({ x: 80, y: 40, z: 80 }, true);
        const start = sim.snapshot().position.y;
        for (let i = 0; i < 180; i++) sim.step(IDLE_INPUT);
        expect(sim.snapshot().position.y).toBeGreaterThan(start + 1);
      },
      new VoxelWorld(),
    ));

  it("respawn returns the machine to the start, stopped and upright", () =>
    simulate(preset("rover"), (sim) => {
      for (let i = 0; i < 120; i++) sim.step({ ...IDLE_INPUT, throttle: 1 });
      expect(sim.snapshot().speed).toBeGreaterThan(1);
      sim.respawn(origin);
      const s = sim.snapshot();
      expect(s.speed).toBeCloseTo(0, 5);
      expect(s.position.z).toBeCloseTo(origin.z, 5);
      expect(s.rotation.w).toBeCloseTo(1, 5);
      expect(() => sim.respawn({ x: NaN, y: 0, z: 0 })).toThrow(MachineFault);
    }));

  it("reports altitude above the terrain column, not absolute height", () => {
    const plateau = new VoxelWorld();
    for (let x = 0; x < WORLD_X; x++)
      for (let z = 0; z < WORLD_Z; z++)
        for (let y = 0; y < 4; y++) plateau.set(x, y, z, 3);
    simulate(
      preset("rover"),
      (sim) => {
        for (let i = 0; i < 180; i++) sim.step(IDLE_INPUT);
        const s = sim.snapshot();
        expect(s.position.y).toBeGreaterThan(4);
        expect(s.altitude).toBeGreaterThan(0);
        expect(s.altitude).toBeCloseTo(s.position.y - 4, 5);
        expect(s.wheels).toBe(4);
      },
      plateau,
    );
  });
});
