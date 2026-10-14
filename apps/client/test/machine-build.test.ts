import { describe, expect, it } from "vitest";
import {
  blueprintError,
  machineStats,
  mirrorDirection,
  PARTS,
  PART_ORDER,
  preset,
  validateBlueprint,
  type Blueprint,
} from "../src/craft/machines/blueprint.js";
import {
  decodeShare,
  encodeShare,
  LIBRARY_SLOTS,
  MachineStore,
} from "../src/craft/machines/library.js";
import {
  MISSIONS,
  MissionRun,
  type MachineTelemetry,
} from "../src/craft/machines/missions.js";

// The library module is the only machine code that touches storage; the suite
// runs on node, so give it a minimal spec-shaped stand-in.
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}
globalThis.localStorage ??= new MemoryStorage() as unknown as Storage;

const at = (
  x: number,
  y: number,
  z: number,
  speed = 0,
  altitude = 0,
  contacts = 4,
): MachineTelemetry => ({ position: { x, y, z }, speed, altitude, contacts });
const origin = { x: 0, y: 0, z: 0 };

describe("part catalogue", () => {
  it("every part is orderable, hotkeyable and grouped", () => {
    expect(PART_ORDER.length).toBe(Object.keys(PARTS).length);
    expect(PART_ORDER.length).toBeLessThanOrEqual(9); // one digit each
    for (const kind of PART_ORDER) {
      const part = PARTS[kind];
      expect(part.mass).toBeGreaterThan(0);
      expect(part.icon).toContain("<");
      expect(["구조", "구동", "비행"]).toContain(part.group);
    }
    expect(PARTS.thruster.directional).toBe(true);
    expect(PARTS.wing.directional).toBe(true);
    expect(PARTS.frame.directional).toBe(false);
  });

  it("mirroring swaps only the sideways directions", () => {
    expect(mirrorDirection(3)).toBe(4);
    expect(mirrorDirection(4)).toBe(3);
    for (const direction of [0, 1, 2, 5])
      expect(mirrorDirection(direction)).toBe(direction);
  });

  it("stats describe lift, wing area and how far the mass sits inside the wheels", () => {
    const rover = machineStats(preset("rover"));
    expect(rover.counts.wheel).toBe(4);
    expect(rover.stanceMargin).toBeGreaterThan(0);
    const plane = machineStats(preset("plane"));
    expect(plane.wingArea).toBeGreaterThan(5);
    expect(plane.counts.wing).toBeGreaterThanOrEqual(4);
    expect(plane.liftRatio).toBeGreaterThan(1); // it can leave the ground
    // Balloons count toward the lift budget the same way vertical thrusters do.
    const balloons: Blueprint = {
      version: 1,
      name: "b",
      parts: [
        { kind: "cockpit", cell: [0, 0, 0], direction: 0 },
        { kind: "balloon", cell: [0, 1, 0], direction: 0 },
      ],
    };
    expect(machineStats(balloons).liftRatio).toBeGreaterThan(1);
  });
});

describe("presets", () => {
  it("every preset is a legal, launchable machine", () => {
    for (const kind of ["rover", "ship", "plane"] as const) {
      const blueprint = preset(kind);
      expect(validateBlueprint(blueprint)).toEqual(blueprint);
      expect(blueprintError(blueprint)).toBeNull();
    }
  });
});

describe("share codes", () => {
  it("round-trip every preset, including the name", () => {
    for (const kind of ["rover", "ship", "plane"] as const) {
      const blueprint = preset(kind);
      const decoded = decodeShare(encodeShare(blueprint));
      expect(decoded).toEqual(blueprint);
    }
  });

  it("stays short enough to paste in a chat line", () => {
    expect(encodeShare(preset("rover")).length).toBeLessThan(200);
  });

  it("rejects truncated, foreign or structurally impossible codes", () => {
    const good = encodeShare(preset("rover"));
    for (const bad of [
      "",
      "hello",
      "CYM1.",
      good.slice(0, good.indexOf(".") - 2) + good.slice(good.indexOf(".")),
      `CYM1.zzzzz.${encodeURIComponent("나쁜 코드")}`, // part index out of range
      `CYM1.00000 00000.x`,
    ])
      expect(decodeShare(bad)).toBeNull();
  });

  it("refuses a code whose parts overlap in one cell", () => {
    expect(decodeShare("CYM1.1cccc1cccc.dup")).toBeNull();
  });
});

describe("blueprint validation", () => {
  it("accepts unknown-but-valid shapes only after a full structural check", () => {
    expect(validateBlueprint(null)).toBeNull();
    expect(validateBlueprint({ version: 2, name: "x", parts: [] })).toBeNull();
    expect(
      validateBlueprint({
        version: 1,
        name: "x",
        parts: [{ kind: "nope", cell: [0, 0, 0], direction: 0 }],
      }),
    ).toBeNull();
    expect(
      validateBlueprint({
        version: 1,
        name: "x",
        parts: [{ kind: "frame", cell: [0, 0, 0], direction: 9 }],
      }),
    ).toBeNull();
    expect(validateBlueprint(preset("ship"))).toEqual(preset("ship"));
  });
});

describe("test-drive missions", () => {
  it("clears a mission once and reports it only on the step that earned it", () => {
    const run = new MissionRun(origin);
    expect(run.update(at(0, 0, 10), 1 / 60)).toEqual([]);
    expect(run.update(at(0, 0, 41), 1 / 60)).toEqual(["first-roll"]);
    expect(run.update(at(0, 0, 60), 1 / 60)).toEqual([]);
    expect(run.cleared).toEqual(["first-roll"]);
  });

  it("counts speed, climb and a sustained hover", () => {
    const run = new MissionRun(origin);
    run.update(at(0, 0, 1, 20), 1 / 60);
    expect(run.cleared).toContain("speed-run");
    run.update(at(0, 11, 1, 0, 0.4, 4), 1 / 60);
    expect(run.cleared).toContain("hill-climb");
    const hover = new MissionRun(origin);
    for (let i = 0; i < 120; i++) hover.update(at(0, 25, 0, 1, 25, 0), 1 / 60);
    expect(hover.cleared).not.toContain("hover");
    for (let i = 0; i < 120; i++) hover.update(at(0, 25, 0, 1, 25, 0), 1 / 60);
    expect(hover.cleared).toContain("hover");
  });

  it("rewards a soft landing but not a crash", () => {
    const crash = new MissionRun(origin);
    for (let i = 0; i < 10; i++) crash.update(at(0, 30, 0, 9, 30, 0), 1 / 60);
    crash.update(at(0, 1, 0, 18, 0.5, 2), 1 / 60);
    expect(crash.cleared).not.toContain("soft-landing");
    const gentle = new MissionRun(origin);
    for (let i = 0; i < 10; i++) gentle.update(at(0, 30, 0, 2, 30, 0), 1 / 60);
    gentle.update(at(0, 1, 0, 1.2, 0.5, 2), 1 / 60);
    expect(gentle.cleared).toContain("soft-landing");
  });

  it("ignores teleport-sized jumps so a respawn cannot pay out the distance goal", () => {
    const run = new MissionRun(origin);
    for (let i = 0; i < 50; i++) run.update(at(0, 0, i * 40), 1 / 60);
    expect(run.progress().distance).toBeLessThan(5);
    expect(run.cleared).not.toContain("long-haul");
  });

  it("ignores non-finite or zero time steps", () => {
    const run = new MissionRun(origin);
    expect(run.update(at(0, 0, 100), NaN)).toEqual([]);
    expect(run.update(at(0, 0, 100), 0)).toEqual([]);
    expect(run.progress().seconds).toBe(0);
  });

  it("exposes a 0‒1 ratio for every mission so the checklist can show progress", () => {
    const run = new MissionRun(origin);
    run.update(at(0, 0, 20, 7), 1 / 60);
    const { ratio } = run.progress();
    for (const mission of MISSIONS) {
      expect(ratio[mission.id]).toBeGreaterThanOrEqual(0);
      expect(ratio[mission.id]).toBeLessThanOrEqual(1);
    }
    expect(ratio["first-roll"]).toBeCloseTo(0.5, 2);
  });

  it("carries already-cleared missions in without re-announcing them", () => {
    const run = new MissionRun(origin, ["first-roll"]);
    expect(run.update(at(0, 0, 90), 1 / 60)).toEqual([]);
    expect(run.cleared).toEqual(["first-roll"]);
  });
});

describe("blueprint library storage", () => {
  it("keeps the newest designs, replaces by name and survives hostile entries", () => {
    const store = new MachineStore();
    localStorage.clear();
    for (let i = 0; i < LIBRARY_SLOTS + 4; i++)
      store.put(`machine ${i}`, preset("rover"), i);
    const entries = store.entries();
    expect(entries.length).toBe(LIBRARY_SLOTS);
    expect(entries[0]!.id).toBe(`machine ${LIBRARY_SLOTS + 3}`);
    store.put("machine 0", preset("ship"), 99);
    expect(store.entries()[0]!.blueprint.parts.length).toBe(
      preset("ship").parts.length,
    );
    localStorage.setItem(
      "craftyap-machine-library-v1",
      JSON.stringify([{ id: "x", blueprint: { version: 9 } }, 7, null]),
    );
    expect(store.entries()).toEqual([]);
  });

  it("merges records by maximum and counts runs", () => {
    localStorage.clear();
    const store = new MachineStore();
    store.mergeRecord({ cleared: ["hover"], topSpeed: 12, runs: 1 });
    const merged = store.mergeRecord({
      cleared: ["hover", "speed-run"],
      topSpeed: 4,
      peakAltitude: 30,
      runs: 1,
    });
    expect(merged.topSpeed).toBe(12);
    expect(merged.peakAltitude).toBe(30);
    expect(merged.cleared.sort()).toEqual(["hover", "speed-run"]);
    expect(merged.runs).toBe(2);
    localStorage.setItem("craftyap-machine-missions-v1", '{"topSpeed":"nope"}');
    expect(store.record().topSpeed).toBe(0);
  });
});
