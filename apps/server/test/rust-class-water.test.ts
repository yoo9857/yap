// A class's water on the Rust core (FLUID_ENGINE=rust) must send EXACTLY the messages the
// TypeScript rules send — same s-k-edit and s-k-wet, same order, every step — and leave the same
// saved field. Two rooms get identical traffic: shaped blocks, sources, a chair (solid furniture),
// mining a block that holds water, a field reset, a restored class and a full store.
import { describe, expect, it, vi } from "vitest";
import { ROUND, WATER, cornerShape, kitSlopeShape, slabShape, stairsShape, type ClassEdit, type ClassFurniture, type ClassServerMessage } from "@robo/shared";
import { loadRustEngineSync } from "@robo/engine/node";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { hashPassword } from "../src/classroom/classStore.js";

const AUTH = (() => { const { hash, salt } = hashPassword("1234"); return { passHash: hash, salt }; })();
const rust = loadRustEngineSync();
const Y = 4;
const SHAPES = [slabShape(0, 0), slabShape(0, 2), kitSlopeShape(0, 0), kitSlopeShape(3, 0), stairsShape(1, 0), cornerShape(0, 0), ROUND];

class Peer implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  send(msg: ClassServerMessage): void { this.inbox.push(msg); }
  close(): void {}
  /** The water traffic: the server's own edits and the water inside shaped blocks. */
  water(): string[] {
    return this.inbox.filter((m) => (m.t === "s-k-edit" && m.by === "") || m.t === "s-k-wet").map((m) => JSON.stringify(m));
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function pair(saved?: ReturnType<ClassRoom["toSaved"]>) {
  const make = (engine: typeof rust | null) => {
    const room = new ClassRoom("Ms Kim", AUTH, saved ? structuredClone(saved) : undefined, "Water", { rust: engine });
    const teacher = new Peer(), student = new Peer();
    room.hostTeacher(teacher, saved ? { password: "1234" } : undefined);
    room.joinStudent(student, "Minji");
    return { room, teacher, student };
  };
  return { ts: make(null), rs: make(rust) };
}

/** Same message to both rooms, then compare everything the student heard. */
function both(p: ReturnType<typeof pair>, fn: (side: ReturnType<typeof pair>["ts"]) => void) {
  fn(p.ts); fn(p.rs);
}

function stepBoth(p: ReturnType<typeof pair>, steps: number, label: string) {
  for (let i = 0; i < steps; i++) {
    const a = p.ts.room.stepFluids(Infinity), b = p.rs.room.stepFluids(Infinity);
    expect(b, `${label}: changes at step ${i}`).toBe(a);
  }
  expect(p.rs.student.water(), label).toEqual(p.ts.student.water());
}

describe("class water: Rust core = TypeScript (FLUID_ENGINE=rust)", () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}: same messages, same saved field`, () => {
      const r = rng(seed), p = pair();
      expect(p.ts.room.fluidEngine).toBe("ts");
      expect(p.rs.room.fluidEngine).toBe("rust");
      // a pit with shaped blocks in and around it, a chair, and sources
      const edits: ClassEdit[] = [];
      for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) edits.push([x, Y - 1, z, 0, 0]);
      for (let i = 0; i < 30; i++) edits.push([-8 + Math.floor(r() * 17), Y - 1 + Math.floor(r() * 2), -8 + Math.floor(r() * 17), 3, r() < 0.7 ? SHAPES[Math.floor(r() * SHAPES.length)]! : 0]);
      both(p, (s) => { for (let i = 0; i < edits.length; i += 8) s.room.handle(s.teacher, { t: "k-edit", edits: edits.slice(i, i + 8) }); });
      const chair: ClassFurniture = ["chair", 2, Y - 1, 2, 0, 0];
      both(p, (s) => s.room.handle(s.teacher, { t: "k-furniture", placed: [chair], removed: [] }));
      both(p, (s) => s.room.handle(s.teacher, { t: "k-edit", edits: [[-3, Y - 1, -3, WATER, 0], [6, Y, 6, WATER, 0]] }));
      stepBoth(p, 60, "fill");
      // mine a shaped block that holds water (its water stays), drop the source, place a stairs
      const wetCell = p.ts.student.inbox.flatMap((m) => (m.t === "s-k-wet" ? m.cells : [])).find((c) => c[3] !== 0);
      both(p, (s) => {
        if (wetCell) s.room.handle(s.teacher, { t: "k-edit", edits: [[wetCell[0], wetCell[1], wetCell[2], 0, 0]] });
        s.room.handle(s.teacher, { t: "k-edit", edits: [[-3, Y - 1, -3, 0, 0], [0, Y - 1, 1, 3, stairsShape(2, 0)]] });
      });
      stepBoth(p, 60, "after edits");
      expect(p.rs.room.toSaved().edits).toEqual(p.ts.room.toSaved().edits);
      // the teacher wipes the field and pours again
      both(p, (s) => { s.room.handle(s.teacher, { t: "k-reset-world" }); s.room.handle(s.teacher, { t: "k-edit", edits: [[0, Y, 0, WATER, 0]] }); });
      stepBoth(p, 30, "after reset");
      expect(p.rs.room.toSaved().edits).toEqual(p.ts.room.toSaved().edits);
      expect(p.ts.student.water().length, "the scenario must move water").toBeGreaterThan(10);
      expect(p.ts.student.inbox.some((m) => m.t === "s-k-wet"), "and fill shaped blocks").toBe(true);
    });
  }

  it("a restored class re-flows the same on both", () => {
    const first = pair();
    both(first, (s) => s.room.handle(s.teacher, { t: "k-edit", edits: [[1, Y, 0, 3, ROUND], [0, Y, 0, WATER, 0]] }));
    const saved = first.ts.room.toSaved(); // saved before the first flow step
    const p = pair(saved);
    stepBoth(p, 40, "restored");
    expect(p.ts.student.water().length).toBeGreaterThan(5);
  });

  it("a full store refuses new water on both, and both resume once space frees", () => {
    const base = new ClassRoom("Ms Kim", AUTH, undefined, "Water");
    base.hostTeacher(new Peer());
    const saved = base.toSaved();
    saved.edits = [[0, Y, 0, WATER, 0]];
    for (let i = 0; i < 299_998; i++) saved.edits.push([1000 + i, Y, 1000, 3, 0]);
    const p = pair(saved);
    stepBoth(p, 3, "full");
    expect(p.rs.room.editCount).toBe(300_000);
    both(p, (s) => s.room.handle(s.teacher, { t: "k-edit", edits: [[1000, Y, 1000, 0, 0]] }));
    stepBoth(p, 3, "space freed");
    expect(p.rs.room.editCount).toBe(p.ts.room.editCount);
  });

  it("a Rust failure drops that class back to TypeScript and the water carries on", () => {
    const p = pair();
    const failed = vi.fn();
    p.rs.room.onRustFailure = failed;
    p.rs.room.handle(p.rs.teacher, { t: "k-edit", edits: [[0, Y, 0, WATER, 0]] });
    for (let i = 0; i < 3; i++) p.rs.room.stepFluids(Infinity);
    (p.rs.room as unknown as { rust: { water: { step(): Int32Array } } }).rust.water.step = () => { throw new Error("unreachable (a wasm trap)"); };
    expect(() => p.rs.room.stepFluids(Infinity)).not.toThrow();
    expect(failed).toHaveBeenCalled();
    expect(p.rs.room.fluidEngine).toBe("ts");
    for (let i = 0; i < 40; i++) p.rs.room.stepFluids(Infinity);
    expect(p.rs.room.toSaved().edits.some(([x, y, z, b]) => x === 7 && y === Y && z === 0 && b !== 0)).toBe(true);
  });

  it("an unloaded class frees its Rust water (wasm memory is outside the JS heap)", () => {
    const p = pair();
    const water = (p.rs.room as unknown as { rust: { water: { free(): void } } }).rust.water;
    const free = vi.spyOn(water, "free");
    p.rs.room.dispose();
    expect(free).toHaveBeenCalledTimes(1);
    expect(p.rs.room.fluidEngine).toBe("ts");
    expect(() => p.rs.room.stepFluids(Infinity)).not.toThrow();
  });
});
