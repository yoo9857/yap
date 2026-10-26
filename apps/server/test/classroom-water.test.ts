import { describe, expect, it } from "vitest";
import { WATER, WATER_SETTLED, CLASS_MAX_COORD, decodeClassServer, flowingWater, type ClassServerMessage } from "@robo/shared";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { hashPassword } from "../src/classroom/classStore.js";

const AUTH = (() => {
  const { hash, salt } = hashPassword("1234");
  return { passHash: hash, salt };
})();

class Peer implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  send(msg: ClassServerMessage): void {
    this.inbox.push(msg);
  }
  close(): void {}
  /** Every cell the server's water changed, last write wins. */
  water(): Map<string, number> {
    const cells = new Map<string, number>();
    for (const m of this.inbox) {
      if (m.t !== "s-k-edit" || m.by !== "") continue;
      for (const [x, y, z, block] of m.edits) cells.set(`${x},${y},${z}`, block);
    }
    return cells;
  }
}

/** The flat field's first open layer (bedrock, dirt, dirt, grass below). */
const Y = 4;

function settle(room: ClassRoom): void {
  for (let i = 0; i < 100 && room.stepFluids() > 0; i++);
}

describe("classroom water", () => {
  it("never exceeds the saved-cell limit when one step fills several new cells", () => {
    const initial = new ClassRoom("Capacity", AUTH), teacher = new Peer();
    initial.hostTeacher(teacher);
    const saved = initial.toSaved();
    saved.edits = [[0, Y, 0, WATER, 0]];
    for (let i = 0; i < 299_998; i++) saved.edits.push([1000 + i, Y, 1000, 3, 0]);
    const room = new ClassRoom("Capacity", AUTH, saved), again = new Peer();
    room.hostTeacher(again, { password: "1234" }); again.inbox = [];
    room.stepFluids();
    expect(room.editCount).toBe(300_000);
    expect(again.water().size).toBe(1);
    // Free a distant stored cell: a stopped frontier must resume without
    // needing the player to pour the source again.
    room.handle(again, { t: "k-edit", edits: [[1000, Y, 1000, 0, 0]] });
    const changes = room.stepFluids();
    expect(changes).toBeGreaterThan(0);
    expect(room.editCount).toBe(300_000);
    expect(again.water().size).toBe(2);
  });

  it("restores a source saved before its first simulation step", () => {
    const room = new ClassRoom("Restore", AUTH), teacher = new Peer();
    room.hostTeacher(teacher);
    room.handle(teacher, { t: "k-edit", edits: [[10, Y, 10, WATER, 0]] });
    const saved = room.toSaved(), restored = new ClassRoom("Restore", AUTH, saved), again = new Peer();
    restored.hostTeacher(again, { password: "1234" }); settle(restored);
    expect(again.water().get(`11,${Y},10`)).toBe(flowingWater(1));
  });

  it("bounds flows at the wire coordinate limit and refuses invented fluid states", () => {
    const room = new ClassRoom("Bounds", AUTH), teacher = new Peer();
    room.hostTeacher(teacher);
    room.handle(teacher, { t: "k-edit", edits: [[CLASS_MAX_COORD, Y, 0, WATER, 0], [0, Y, 0, WATER_SETTLED, 0]] });
    settle(room);
    for (const msg of teacher.inbox) expect(decodeClassServer(JSON.stringify(msg))).not.toBeNull();
    expect(room.toSaved().edits.some(([x, , , block]) => x === 0 && block === WATER_SETTLED)).toBe(false);
  });
  it("the server flows a student's water and everyone gets the same stream", () => {
    const room = new ClassRoom("Ms Kim", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    const minji = new Peer();
    room.joinStudent(minji, "Minji");
    room.handle(minji, { t: "k-edit", edits: [[10, Y, 10, WATER, 0]] });
    settle(room);
    // both the pourer and the others get the flow, from the server (by "")
    for (const peer of [teacher, minji]) {
      const water = peer.water();
      expect(water.get(`11,${Y},10`)).toBe(flowingWater(1));
      expect(water.get(`17,${Y},10`)).toBe(flowingWater(7));
      expect(water.has(`18,${Y},10`)).toBe(false);
    }
  });

  it("scooping the source drains the stream for everyone", () => {
    const room = new ClassRoom("Ms Kim", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    room.handle(teacher, { t: "k-edit", edits: [[0, Y, 0, WATER, 0]] });
    settle(room);
    room.handle(teacher, { t: "k-edit", edits: [[0, Y, 0, 0, 0]] });
    settle(room);
    expect([...teacher.water().values()].every((b) => b === 0)).toBe(true);
    expect(room.toSaved().edits).toEqual([]); // nothing left in the saved field either
  });

  it("a late joiner receives the water with the field, and a reload carries on mid-flow", () => {
    const room = new ClassRoom("Ms Kim", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    room.handle(teacher, { t: "k-edit", edits: [[0, Y, 0, WATER, 0]] });
    room.stepFluids(); // only one step: mid-flow
    const saved = room.toSaved();
    const restored = new ClassRoom("Ms Kim", AUTH, saved);
    settle(restored);
    const field = new Map(restored.toSaved().edits.map(([x, y, z, b]) => [`${x},${y},${z}`, b]));
    expect(field.get(`7,${Y},0`)).toBe(flowingWater(7));
    const late = new Peer();
    expect(restored.hostTeacher(late, { password: "1234" })).toBe("ok");
    const world = late.inbox.filter((m) => m.t === "s-k-world").flatMap((m) => (m.t === "s-k-world" ? m.edits : []));
    expect(world.some(([x, y, z, b]) => x === 7 && y === Y && z === 0 && b === flowingWater(7))).toBe(true);
  });

  it("water is not a floor for furniture", () => {
    const room = new ClassRoom("Ms Kim", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    room.handle(teacher, { t: "k-edit", edits: [[0, Y, 0, WATER, 0]] });
    room.handle(teacher, { t: "k-furniture", placed: [["chair", 0, Y + 1, 0, 0, 0]], removed: [] });
    const last = [...teacher.inbox].reverse().find((m) => m.t === "s-k-furniture");
    expect(last && last.t === "s-k-furniture" && last.rejected).toBe(true);
  });
});
