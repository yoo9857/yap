import { describe, expect, it } from "vitest";
import {
  blockValue,
  deliveriesPerSecond,
  buy,
  createInitialState,
  currentLandmarkTotal,
  cycleTime,
  itemCost,
} from "../src/builder/state.js";
import { settleOffline, tick } from "../src/builder/sim.js";
import { GOALS, goalAt, tryCompleteGoal } from "../src/builder/goals.js";
import { LANDMARKS, tourMultiplier } from "../src/builder/landmarks.js";
import { load, save, type KeyValueStorage } from "../src/builder/save.js";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("landmarks", () => {
  it("generates 7 deterministic, grounded, high-detail blueprints", () => {
    expect(LANDMARKS).toHaveLength(7);
    for (const lm of LANDMARKS) {
      expect(lm.blocks.length).toBeGreaterThan(6000); // near-realistic detail
      expect(lm.blocks.length).toBeLessThan(80_000); // still instancing-friendly
      // deterministic: build order sorted bottom-up
      for (let i = 1; i < lm.blocks.length; i++) {
        expect(lm.blocks[i]!.y).toBeGreaterThanOrEqual(lm.blocks[i - 1]!.y);
      }
      // grounded: construction starts at ground level
      expect(lm.blocks[0]!.y).toBe(0);
      // no duplicate positions
      const keys = new Set(lm.blocks.map((b) => `${b.x},${b.y},${b.z}`));
      expect(keys.size).toBe(lm.blocks.length);
      // REAL scale: the built height must be within 12% of the real monument
      expect(Math.abs(lm.heightM - lm.realHeightM) / lm.realHeightM).toBeLessThan(0.12);
    }
    // world tour difficulty rises overall (bonus strictly ascending)
    for (let i = 1; i < LANDMARKS.length; i++) {
      expect(LANDMARKS[i]!.bonus).toBeGreaterThan(LANDMARKS[i - 1]!.bonus);
    }
    // signature real dimensions
    const byId = Object.fromEntries(LANDMARKS.map((l) => [l.id, l]));
    expect(byId["eiffel"]!.heightM).toBeGreaterThan(300);
    expect(byId["pyramid"]!.radiusM).toBeGreaterThan(140); // 230 m base diagonal
    expect(byId["liberty"]!.heightM).toBeGreaterThan(85);
  });
});

describe("builder economy", () => {
  it("upgrades change the economy in the right direction", () => {
    const s = createInitialState();
    const baseCycle = cycleTime(s);
    s.speedLevel = 3;
    expect(cycleTime(s)).toBeLessThan(baseCycle);
    s.crane = true;
    const withCrane = cycleTime(s);
    s.crane = false;
    expect(withCrane).toBeLessThan(cycleTime(s));
    s.valueLevel = 2;
    expect(blockValue(s)).toBeCloseTo(1.4 ** 2, 10);
  });

  it("world-tour multiplier raises block value on repeat tours", () => {
    const s = createInitialState();
    const base = blockValue(s);
    s.landmarkIndex = LANDMARKS.length; // tour 2 begins
    expect(blockValue(s)).toBeCloseTo(base * tourMultiplier(1), 10);
  });

  it("costs grow exponentially and buying spends gold", () => {
    const s = createInitialState();
    const c1 = itemCost(s, "worker");
    s.gold = c1;
    expect(buy(s, "worker")).toBe(true);
    expect(s.workers).toBe(2);
    expect(s.gold).toBe(0);
    expect(itemCost(s, "worker")).toBeGreaterThan(c1);
    expect(buy(s, "worker")).toBe(false); // broke
  });
});

describe("builder sim", () => {
  it("live tick matches the closed-form rate (offline settlement basis)", () => {
    const s = createInitialState();
    s.workers = 3;
    s.workerProgress = [0, 1 / 3, 2 / 3];
    const seconds = 200;
    let blocks = 0;
    for (let t = 0; t < seconds * 10; t++) {
      blocks += tick(s, 0.1).filter((e) => e.type === "block").length;
    }
    const expected = deliveriesPerSecond(s) * seconds;
    expect(Math.abs(blocks - expected)).toBeLessThanOrEqual(3); // start offsets
  });

  it("completes a landmark: bonus paid, next blueprint begins", () => {
    const s = createInitialState();
    const total = currentLandmarkTotal(s);
    s.placedBlocks = total - 1;
    s.workerProgress = [0.999999];
    const events = tick(s, cycleTime(s) * 0.001 + 0.001);
    const done = events.find((e) => e.type === "landmark");
    expect(done).toBeDefined();
    expect(s.landmarkIndex).toBe(1);
    expect(s.placedBlocks).toBe(0);
    expect(s.gold).toBeCloseTo(blockValue(s) + LANDMARKS[0]!.bonus, 6);
  });

  it("emits 10% milestones while building", () => {
    const s = createInitialState();
    const total = currentLandmarkTotal(s);
    const events = [];
    for (let i = 0; i < Math.ceil(total * 0.31); i++) {
      s.workerProgress = [0.999999];
      events.push(...tick(s, cycleTime(s) * 0.001 + 0.001));
    }
    const milestones = events.filter((e) => e.type === "milestone");
    expect(milestones.length).toBeGreaterThanOrEqual(3);
  });

  it("offline settlement is deterministic, capped, and crosses landmarks", () => {
    const a = createInitialState();
    a.workers = 10;
    a.speedLevel = 5;
    const b = structuredClone(a);
    const gainsA = settleOffline(a, 3_600_000, 8 * 3_600_000);
    const gainsB = settleOffline(b, 3_600_000, 8 * 3_600_000);
    expect(gainsA).toEqual(gainsB);
    expect(a).toEqual(b);
    expect(gainsA.landmarks).toBeGreaterThanOrEqual(1); // fast crew clears blueprints

    const capped = createInitialState();
    const gainsCapped = settleOffline(structuredClone(capped), 100 * 3_600_000, 8 * 3_600_000);
    const atCap = settleOffline(structuredClone(capped), 8 * 3_600_000, 8 * 3_600_000);
    expect(gainsCapped.blocks).toBe(atCap.blocks);
  });

  it("offline landmark bonuses match the live-tick economy", () => {
    // walk exactly one full blueprint both ways and compare gold
    const live = createInitialState();
    const total = currentLandmarkTotal(live);
    const deliveries = Math.ceil(total / LANDMARKS[0]!.deliverySize);
    for (let i = 0; i < deliveries; i++) {
      live.workerProgress = [0.999999];
      tick(live, cycleTime(live) * 0.001 + 0.001);
    }
    const offline = createInitialState();
    // rate: 1 delivery per cycle → elapsed = deliveries × cycle
    settleOffline(offline, cycleTime(offline) * deliveries * 1000 + 1, 99 * 3_600_000);
    expect(offline.gold).toBeCloseTo(live.gold, 6);
    expect(offline.landmarkIndex).toBe(live.landmarkIndex);
    expect(live.landmarkIndex).toBe(1); // exactly one monument completed
  });
});

describe("builder goals", () => {
  it("chain advances with rewards", () => {
    const s = createInitialState();
    expect(tryCompleteGoal(s)).toBeNull();
    s.totalBlocks = 15;
    const done = tryCompleteGoal(s);
    expect(done?.title).toContain("15");
    expect(s.gold).toBe(done?.reward);
    expect(s.goalIndex).toBe(1);
  });

  it("landmark goals reference the world tour", () => {
    const pyramidGoal = GOALS[2]!;
    expect(pyramidGoal.kind).toBe("landmark");
    expect(pyramidGoal.title).toContain("Pyramid");
    const endless = goalAt(GOALS.length + 2);
    expect(endless.kind).toBe("landmark");
    expect(endless.reward).toBeGreaterThan(1000);
  });
});

describe("builder save", () => {
  it("round-trips through storage (v2)", () => {
    const storage = memoryStorage();
    const s = createInitialState();
    s.gold = 123.45;
    s.landmarkIndex = 3;
    s.placedBlocks = 42;
    s.workers = 3;
    s.crane = true;
    save(s, storage, 1_000_000);
    const { state, offline } = load(storage, 1_002_000); // 2 s later
    expect(offline).toBeNull();
    expect(state.gold).toBe(123.45);
    expect(state.landmarkIndex).toBe(3);
    expect(state.placedBlocks).toBe(42);
    expect(state.crane).toBe(true);
  });

  it("migrates a v1 (floor-tower era) save: economy kept, tour restarted", () => {
    const storage = memoryStorage();
    storage.setItem(
      "robo-builder-save-v1",
      JSON.stringify({
        v: 1,
        gold: 500,
        floors: 192,
        floorBlocks: 3,
        workers: 6,
        speedLevel: 2,
        valueLevel: 1,
        crane: true,
        goalIndex: 9,
        bestFloors: 192,
        totalBlocks: 1920,
        savedAtMs: 4_999_000,
      }),
    );
    const { state } = load(storage, 5_000_000);
    expect(state.gold).toBe(500);
    expect(state.workers).toBe(6);
    expect(state.crane).toBe(true);
    expect(state.landmarkIndex).toBe(0); // tour starts fresh
    expect(state.goalIndex).toBe(0);
  });

  it("settles offline time on load", () => {
    const storage = memoryStorage();
    const s = createInitialState();
    s.workers = 2;
    save(s, storage, 1_000_000);
    const hourLater = load(storage, 1_000_000 + 3_600_000);
    expect(hourLater.offline).not.toBeNull();
    expect(hourLater.offline!.blocks).toBeGreaterThan(100);
    expect(hourLater.state.gold).toBeGreaterThan(0);
  });

  it("falls back to a fresh game on corrupt or hostile saves", () => {
    const storage = memoryStorage();
    storage.setItem("robo-builder-save-v1", "{corrupt json!!");
    expect(load(storage, 5_000_000).state.workers).toBe(1);
    storage.setItem(
      "robo-builder-save-v1",
      JSON.stringify({ v: 2, gold: "Infinity", workers: -5 }),
    );
    expect(load(storage, 5_000_000).state.gold).toBe(0);
  });
});
