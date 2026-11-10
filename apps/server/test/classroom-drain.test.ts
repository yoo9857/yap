import { describe, expect, it } from "vitest";
import { ROUND, WATER, WATER_FALLING, WATER_SETTLED, decodeClassClient, decodeClassServer, isWater, type ClassEdit, type ClassServerMessage } from "@robo/shared";
import { loadRustEngineSync } from "@robo/engine/node";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { hashPassword } from "../src/classroom/classStore.js";

const { hash, salt } = hashPassword("1234");
const AUTH = { passHash: hash, salt };
class Peer implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  send(msg: ClassServerMessage): void { this.inbox.push(msg); }
  close(): void {}
}
const settle = (room: ClassRoom) => { for (let i = 0; i < 60; i++) room.stepFluids(Infinity); };

describe("teacher water cleanup", () => {
  for (const engine of ["ts", "rust"] as const) it(`${engine}: teacher drains all water and keeps builds, furniture and lesson state`, () => {
    const room = new ClassRoom("Teacher", AUTH, undefined, "Drain", { rust: engine === "rust" ? loadRustEngineSync() : null });
    const teacher = new Peer(), student = new Peer();
    room.hostTeacher(teacher); room.joinStudent(student, "Student");
    room.handle(student, { t: "k-edit", edits: [[0, 4, 0, WATER, 0], [1, 4, 0, 3, ROUND], [50, 3, 50, WATER, 0], [20000, 4, 0, WATER, 0]] });
    room.handle(teacher, { t: "k-furniture", placed: [["chair", 30, 4, 30, 0, 0]], removed: [] });
    room.handle(teacher, { t: "k-settings", buildLocked: true, chatLocked: true, tapsLocked: true });
    room.handle(teacher, { t: "k-lesson", freeze: true, timer: 300 });
    settle(room);
    expect(student.inbox.some((m) => m.t === "s-k-wet" && m.cells.some((c) => c[3] > 0))).toBe(true);
    const before = room.toSaved();
    expect(before.furniture).toHaveLength(1);
    const drain = decodeClassClient(JSON.stringify({ t: "k-drain-water" }))!;
    expect(drain).not.toBeNull();
    room.handle(student, drain);
    expect(room.toSaved().edits).toEqual(before.edits); // students cannot invoke it
    teacher.inbox = []; student.inbox = [];
    room.handle(teacher, drain);
    expect(room.dirty).toBe(true);
    expect(student.inbox.map((m) => m.t)).toEqual(["s-k-water-drained", "s-k-chat"]);
    for (const m of student.inbox) expect(decodeClassServer(JSON.stringify(m))).not.toBeNull();
    settle(room);
    const after = room.toSaved();
    expect(after.edits.some((e) => isWater(e[3]))).toBe(false);
    expect(after.edits).toContainEqual([1, 4, 0, 3, ROUND]);
    expect(after.edits).toContainEqual([50, 3, 50, 0, 0]); // a flooded hole stays dug
    expect(after.furniture).toEqual(before.furniture);
    expect(after.settings).toEqual(before.settings); expect(after.lesson).toEqual(before.lesson);
    const late = new Peer(); room.joinStudent(late, "Late");
    expect(late.inbox.some((m) => m.t === "s-k-wet")).toBe(false);
    const restored = new ClassRoom("Teacher", AUTH, after, "Drain", { rust: engine === "rust" ? loadRustEngineSync() : null });
    settle(restored);
    expect(restored.toSaved().edits).toEqual(after.edits);
    // A new pour still works: this is cleanup, not a permanent water lock.
    room.handle(teacher, { t: "k-edit", edits: [[0, 4, 0, WATER, 0]] });
    settle(room);
    expect(room.toSaved().edits.some((e) => e[0] === 2 && e[1] === 4 && e[2] === 0 && isWater(e[3]))).toBe(true);
    room.dispose(); restored.dispose();
  });

  it("clears a full field in one small message and keeps a joining stream valid", () => {
    const first = new ClassRoom("Teacher", AUTH), teacher = new Peer(); first.hostTeacher(teacher);
    const saved = first.toSaved();
    saved.edits = Array.from({ length: 299999 }, (_, i): ClassEdit => [i, 4, 100, [WATER, WATER_FALLING, WATER_SETTLED][i % 3]!, 0]);
    saved.edits.push([0, 5, 0, 3, ROUND]);
    const room = new ClassRoom("Teacher", AUTH, saved), host = new Peer();
    room.hostTeacher(host, { password: "1234" });
    class StreamingPeer extends Peer {
      stream!: Generator<ClassEdit[], void, unknown>;
      count = 0;
      streamWorld(stream: Generator<ClassEdit[], void, unknown>, count: number): void { this.stream = stream; this.count = count; }
    }
    const joining = new StreamingPeer(); room.joinStudent(joining, "Joining");
    const initial = joining.stream.next().value as ClassEdit[];
    expect(initial).toHaveLength(2000);
    host.inbox = [];
    room.handle(host, { t: "k-drain-water" });
    expect(JSON.stringify(host.inbox).length).toBeLessThan(300);
    let streamed = initial.length;
    for (const batch of joining.stream) {
      streamed += batch.length;
      expect(batch.some((e) => isWater(e[3]))).toBe(false);
    }
    expect(streamed).toBe(joining.count);
    expect(joining.inbox.some((m) => m.t === "s-k-water-drained")).toBe(true);
    expect(room.toSaved().edits).toEqual([[0, 5, 0, 3, ROUND]]);
    expect(room.stepFluids()).toBe(0);
    room.handle(host, { t: "k-drain-water" }); // safe to repeat on an already dry field
    expect(room.toSaved().edits).toEqual([[0, 5, 0, 3, ROUND]]);
    room.dispose(); first.dispose();
  }, 20_000); // includes constructing and streaming a full 300k-cell class under the whole-suite load
});
