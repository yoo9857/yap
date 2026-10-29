import { describe, expect, it, vi } from "vitest";
import { BONK_COOLDOWN_MS, BONK_HOP, BONK_SPEED, MAX_SOLID_ID, classSettingsSchema, decodeClassClient, decodeClassServer, type ClassFurniture, type ClassServerMessage } from "@robo/shared";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { MemoryClassStore, hashPassword } from "../src/classroom/classStore.js";

const AUTH = (() => {
  const { hash, salt } = hashPassword("1234");
  return { passHash: hash, salt };
})();

class Peer implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  closed: string | null = null;
  send(msg: ClassServerMessage): void {
    this.inbox.push(msg);
  }
  close(reason: string): void {
    this.closed = reason;
  }
  last<T extends ClassServerMessage["t"]>(t: T): Extract<ClassServerMessage, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ClassServerMessage, { t: T }> | undefined;
  }
  welcome() {
    return this.last("s-k-welcome")!;
  }
}

function classWithTeacher() {
  const room = new ClassRoom("Ms Kim", AUTH);
  const teacher = new Peer();
  expect(room.hostTeacher(teacher)).toBe("ok");
  return { room, teacher };
}

describe("ClassRoom", () => {
  it("relays and restores the new kit shapes for late joiners", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Builder");
    const edits: [number, number, number, number, number][] = [[10, 4, 10, 3, 18], [11, 4, 10, 3, 34], [12, 4, 10, 3, 50]];
    const message = decodeClassClient(JSON.stringify({ t: "k-edit", edits }));
    expect(message).not.toBeNull();
    room.handle(student, message!);
    expect(teacher.last("s-k-edit")!.edits).toEqual(edits);
    const saved = room.toSaved();
    const restored = new ClassRoom("Ms Kim", AUTH, saved), late = new Peer();
    restored.joinStudent(late, "Late");
    expect(late.last("s-k-world")!.edits).toEqual(edits);
  });

  it("rejects a repeated write with the last accepted authoritative cell", () => {
    const { room, teacher } = classWithTeacher(), student = new Peer(); room.joinStudent(student, "Writer");
    room.handle(student, { t: "k-edit", edits: [[0, 4, 0, 3, 0]] });
    room.handle(teacher, { t: "k-settings", buildLocked: true, chatLocked: false });
    room.handle(student, { t: "k-edit", edits: [[0, 4, 0, 17, 0]] });
    expect(student.last("s-k-reject")).toEqual({ t: "s-k-reject", edits: [[0, 4, 0, 3, 0]], authoritative: true });
  });

  it("accepts later solid blocks and still refuses fluid states and unknown ids", () => {
    const { room, teacher } = classWithTeacher();
    // 29 white wool, 58 ruby ore and the newest solid are catalog blocks. 20 is flowing water.
    const unknown = MAX_SOLID_ID + 1;
    room.handle(teacher, { t: "k-edit", edits: [[3, 4, 3, 29, 0], [5, 4, 5, 58, 0], [8, 4, 8, MAX_SOLID_ID, 0], [6, 4, 6, unknown, 0], [7, 4, 7, 20, 0]] });
    const placed = room.toSaved().edits.map((edit) => edit[3]);
    expect(placed).toContain(29);
    expect(placed).toContain(58);
    expect(placed).toContain(MAX_SOLID_ID);
    expect(placed).not.toContain(unknown);
    expect(placed).not.toContain(20);
  });

  it("seats a teacher and students, everyone sees the roster", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    const b = new Peer();
    expect(room.joinStudent(a, "Minji")).toBe("ok");
    expect(room.joinStudent(b, "Jun")).toBe("ok");
    const roster = teacher.last("s-k-members")!.members;
    expect(roster.map((m) => [m.name, m.role, m.online])).toEqual([
      ["Ms Kim", "teacher", true],
      ["Minji", "student", true],
      ["Jun", "student", true],
    ]);
    expect(a.welcome().role).toBe("student");
    expect(a.welcome().teacher).toBe("Ms Kim");
  });

  it("refuses a duplicate online student name (case-insensitive) and posing as the teacher", () => {
    const { room } = classWithTeacher();
    room.joinStudent(new Peer(), "Minji");
    expect(room.joinStudent(new Peer(), "  minji ")).toBe("name-taken");
    expect(room.joinStudent(new Peer(), "ms kim")).toBe("name-taken");
  });

  it("gives a dropped student their seat back", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    const id = a.welcome().you;
    room.leave(a);
    expect(teacher.last("s-k-members")!.members.find((m) => m.id === id)!.online).toBe(false);
    const again = new Peer();
    expect(room.joinStudent(again, "Minji")).toBe("ok");
    expect(again.welcome().you).toBe(id);
  });

  it("lets the same kid take over a live seat only with its key", () => {
    const { room } = classWithTeacher();
    const tab1 = new Peer();
    room.joinStudent(tab1, "Minji");
    const key = tab1.welcome().key;
    expect(room.joinStudent(new Peer(), "Minji", "wrong")).toBe("name-taken");
    const tab2 = new Peer();
    expect(room.joinStudent(tab2, "Minji", key)).toBe("ok");
    expect(tab1.closed).toBe("replaced");
  });

  it("re-seats the teacher only with the host key or the class password", () => {
    const { room, teacher } = classWithTeacher();
    const key = teacher.welcome().key;
    expect(room.hostTeacher(new Peer(), { hostKey: key })).toBe("teacher-taken"); // still online
    room.leave(teacher);
    expect(room.hostTeacher(new Peer())).toBe("bad-password");
    expect(room.hostTeacher(new Peer(), { hostKey: "nope" })).toBe("bad-password");
    expect(room.hostTeacher(new Peer(), { password: "0000" })).toBe("bad-password");
    const sameBrowser = new Peer();
    expect(room.hostTeacher(sameBrowser, { hostKey: key })).toBe("ok");
    room.leave(sameBrowser);
    expect(room.hostTeacher(new Peer(), { password: "1234" })).toBe("ok"); // another PC
  });

  it("relays edits to others and hands late joiners the whole field", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(a, { t: "k-edit", edits: [[100, 4, -20, 17, 0], [101, 4, -20, 17, 0]] });
    expect(teacher.last("s-k-edit")!.edits).toHaveLength(2);
    expect(a.last("s-k-edit")).toBeUndefined(); // not echoed to the author
    // restoring a pristine cell drops it from the store
    room.handle(a, { t: "k-edit", edits: [[101, 4, -20, 0, 0]] });
    expect(room.editCount).toBe(1);
    const late = new Peer();
    room.joinStudent(late, "Jun");
    expect(late.welcome().editCount).toBe(1);
    expect(late.last("s-k-world")!.edits).toEqual([[100, 4, -20, 17, 0]]);
  });

  it("never lets anyone break bedrock", () => {
    const { room, teacher } = classWithTeacher();
    room.handle(teacher, { t: "k-edit", edits: [[0, 0, 0, 0, 0]] });
    expect(room.editCount).toBe(0);
    expect(teacher.last("s-k-reject")!.edits).toEqual([[0, 0, 0, 11, 0]]);
    expect(teacher.last("s-k-reject")!.authoritative).toBe(true);
  });

  it("build and chat locks bind students, not the teacher", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(teacher, { t: "k-settings", chatLocked: true, buildLocked: true });
    expect(a.last("s-k-settings")!.settings).toEqual({ chatLocked: true, buildLocked: true, tapsLocked: false });
    room.handle(a, { t: "k-edit", edits: [[5, 4, 5, 3, 0]] });
    expect(a.last("s-k-reject")).toBeDefined();
    expect(room.editCount).toBe(0);
    const chats = () => teacher.inbox.filter((m) => m.t === "s-k-chat" && !m.system).length;
    room.handle(a, { t: "k-chat", text: "hi" });
    expect(chats()).toBe(0);
    room.handle(teacher, { t: "k-chat", text: "quiet please" });
    expect(chats()).toBe(1);
    room.handle(teacher, { t: "k-edit", edits: [[5, 4, 5, 3, 0]] });
    expect(room.editCount).toBe(1);
  });

  it("teacher-only actions are ignored from students", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    const b = new Peer();
    room.joinStudent(a, "Minji");
    room.joinStudent(b, "Jun");
    room.handle(a, { t: "k-kick", playerId: b.welcome().you });
    expect(b.closed).toBeNull();
    room.handle(a, { t: "k-end" });
    expect(room.closed).toBe(false);
    room.handle(teacher, { t: "k-kick", playerId: b.welcome().you });
    expect(b.last("s-k-kicked")).toBeDefined();
    expect(b.closed).toBe("kicked");
    expect(teacher.last("s-k-members")!.members.map((m) => m.name)).toEqual(["Ms Kim", "Minji"]);
  });

  it("gathers students at the teacher and ends the class for everyone", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(teacher, { t: "k-move", pos: [500, 4, -30], yaw: 0, anim: "idle" });
    room.handle(teacher, { t: "k-gather" });
    expect(a.last("s-k-gather")!.pos).toEqual([500, 4, -30]);
    room.handle(teacher, { t: "k-end" });
    expect(room.closed).toBe(true);
    expect(a.last("s-k-closed")).toBeDefined();
    expect(a.closed).toBe("class ended");
  });

  it("snapshots carry every connected player's position", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(teacher, { t: "k-move", pos: [1, 4, 1], yaw: 0, anim: "idle" });
    room.handle(a, { t: "k-move", pos: [3, 4, 3], yaw: 1, anim: "run" });
    room.snapshot();
    expect(a.last("s-k-snap")!.players).toHaveLength(2);
  });
});

describe("ClassRoom kick ban", () => {
  it("keeps a removed student out under the same name for a while", () => {
    const room = new ClassRoom("Mr Lee", AUTH);
    const teacher = new Peer();
    room.hostTeacher(teacher);
    const a = new Peer();
    room.joinStudent(a, "Hana");
    room.handle(teacher, { t: "k-kick", playerId: a.welcome().you });
    expect(room.joinStudent(new Peer(), "hana")).toBe("banned");
    expect(room.joinStudent(new Peer(), "hana", undefined, Date.now() + 11 * 60_000)).toBe("ok");
  });
});

describe("ClassRoom persistence", () => {
  it("restores the field, settings and every student's seat from the store", () => {
    const store = new MemoryClassStore();
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(a, { t: "k-edit", edits: [[7, 5, -3, 17, 2]] });
    room.handle(teacher, { t: "k-settings", chatLocked: true, buildLocked: false });
    expect(room.dirty).toBe(true);
    store.save(room.key, room.toSaved());
    expect(room.dirty).toBe(false);

    const saved = store.load(room.key)!;
    expect(saved).not.toHaveProperty("password");
    const back = new ClassRoom(saved.teacherName, { passHash: saved.passHash, salt: saved.salt }, saved);
    const t2 = new Peer();
    expect(back.hostTeacher(t2, { password: "1234" })).toBe("ok");
    expect(t2.welcome().settings.chatLocked).toBe(true);
    expect(t2.last("s-k-world")!.edits).toEqual([[7, 5, -3, 17, 2]]);
    expect(t2.welcome().members.find((m) => m.name === "Minji")?.online).toBe(false);
    // Minji's old seat key still identifies her after the restart
    const again = new Peer();
    expect(back.joinStudent(again, "Minji", a.welcome().key)).toBe("ok");
  });

  it("the teacher can wipe the field for a new lesson", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(a, { t: "k-edit", edits: [[1, 4, 1, 3, 0]] });
    room.handle(a, { t: "k-reset-world" }); // students can't
    expect(room.editCount).toBe(1);
    room.handle(teacher, { t: "k-reset-world" });
    expect(room.editCount).toBe(0);
    expect(a.last("s-k-world-reset")).toBeDefined();
  });
});


describe("classroom furniture", () => {
  const chair: ClassFurniture = ["chair", -20, 4, 10, 0, 0];
  const door: ClassFurniture = ["door", 20, 4, 10, 0, 0];
  const place = (room: ClassRoom, peer: Peer, item: ClassFurniture) =>
    room.handle(peer, { t: "k-furniture", placed: [item], removed: [] });

  it("shares teacher and student placements, colours and late-join snapshots", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Minji");
    place(room, teacher, chair);
    expect(student.last("s-k-furniture")!.furniture).toEqual([chair]);
    const other: ClassFurniture = ["chair", 25, 4, 10, 1, 1];
    place(room, student, other);
    expect(teacher.last("s-k-furniture")!.furniture).toEqual([chair, other]);
    const late = new Peer();
    room.joinStudent(late, "Jun");
    expect(late.welcome().furniture).toEqual([chair, other]);
    expect(decodeClassServer(JSON.stringify(late.welcome()))).not.toBeNull();
  });

  it("persists open doors across a store round trip and clears them on reset", () => {
    const { room, teacher } = classWithTeacher();
    place(room, teacher, door);
    const opened: ClassFurniture = [...door, 1];
    room.handle(teacher, { t: "k-furniture", removed: [door], placed: [opened] });
    expect(teacher.last("s-k-furniture")!.furniture).toEqual([opened]);
    const store = new MemoryClassStore();
    store.save(room.key, room.toSaved());
    const restored = new ClassRoom("Ms Kim", AUTH, store.load(room.key)!);
    const again = new Peer();
    restored.hostTeacher(again, { password: "1234" });
    expect(again.welcome().furniture).toEqual([opened]);
    restored.handle(again, { t: "k-reset-world" });
    expect(restored.toSaved().furniture).toEqual([]);
  });

  it("locks every student mutation while teachers can still build", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Minji");
    place(room, teacher, door);
    room.handle(teacher, { t: "k-settings", chatLocked: false, buildLocked: true });
    place(room, student, chair);
    expect(student.last("s-k-furniture")!.rejected).toBe(true);
    room.handle(student, { t: "k-furniture", removed: [door], placed: [] });
    expect(room.toSaved().furniture).toEqual([door]);
    room.handle(student, { t: "k-furniture", removed: [door], placed: [[...door, 1]] });
    expect(room.toSaved().furniture).toEqual([door]);
    place(room, teacher, chair);
    expect(room.toSaved().furniture).toEqual([door, chair]);
  });

  it("rejects overlap, floating pieces, invalid catalog data and occupied bodies atomically", () => {
    const { room, teacher } = classWithTeacher();
    place(room, teacher, chair);
    place(room, teacher, chair);
    expect(teacher.last("s-k-furniture")!.rejected).toBe(true);
    for (const item of [
      ["chair", 20, 8, 10, 0, 0], ["no-such-piece", 20, 4, 10, 0, 0],
      ["chair", 20, 4, 10, 0, 30],
    ] as ClassFurniture[]) {
      room.handle(teacher, { t: "k-furniture", removed: [chair], placed: [item] });
      expect(teacher.last("s-k-furniture")!.rejected).toBe(true);
      expect(room.toSaved().furniture).toEqual([chair]);
    }
    room.handle(teacher, { t: "k-move", pos: [20.5, 4, 10.5], yaw: 0, anim: "idle" });
    place(room, teacher, door);
    expect(teacher.last("s-k-furniture")!.rejected).toBe(true);
  });

  it("doesn't close a door through another participant", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Minji");
    const opened: ClassFurniture = [...door, 1];
    place(room, teacher, opened);
    room.handle(student, { t: "k-move", pos: [20.5, 4, 10.5], yaw: 0, anim: "idle" });
    room.handle(teacher, { t: "k-furniture", removed: [opened], placed: [door] });
    expect(teacher.last("s-k-furniture")!.rejected).toBe(true);
    expect(room.toSaved().furniture).toEqual([opened]);
  });

  it("prevents blocks through furniture and cascades removed supports for everyone", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Minji");
    place(room, teacher, chair);
    room.handle(student, { t: "k-edit", edits: [[-20, 4, 10, 3, 0]] });
    expect(student.last("s-k-reject")!.edits).toEqual([[-20, 4, 10, 0, 0]]);
    room.handle(teacher, { t: "k-edit", edits: [[-20, 3, 10, 0, 0]] });
    expect(student.last("s-k-furniture")!.furniture).toEqual([]);
    expect(room.toSaved().furniture).toEqual([]);
  });

  it("removing a table also removes its vase and accepts an atomic undo", () => {
    const { room, teacher } = classWithTeacher();
    const table: ClassFurniture = ["side-table", 20, 4, 10, 0, 0];
    const vase: ClassFurniture = ["vase", 20, 4, 10, 0, 0];
    place(room, teacher, table);
    place(room, teacher, vase);
    expect(room.toSaved().furniture).toHaveLength(2);
    room.handle(teacher, { t: "k-furniture", removed: [table, vase], placed: [] });
    expect(room.toSaved().furniture).toEqual([]);
    room.handle(teacher, { t: "k-furniture", removed: [], placed: [table, vase] });
    expect(room.toSaved().furniture).toEqual([table, vase]);
  });

  it("rejects stale deletion without overwriting a concurrent placement", () => {
    const { room, teacher } = classWithTeacher();
    place(room, teacher, chair);
    room.handle(teacher, { t: "k-furniture", removed: [chair], placed: [] });
    const replacement: ClassFurniture = ["chair", -20, 4, 10, 1, 0];
    place(room, teacher, replacement);
    room.handle(teacher, { t: "k-furniture", removed: [chair], placed: [] });
    expect(teacher.last("s-k-furniture")!.rejected).toBe(true);
    expect(room.toSaved().furniture).toEqual([replacement]);
  });

  it("bounds and validates furniture messages", () => {
    const msg = { t: "k-furniture", placed: [chair], removed: [] };
    expect(decodeClassClient(JSON.stringify(msg))).toEqual(msg);
    expect(decodeClassClient(JSON.stringify({ ...msg, placed: [["chair", 0, 4, 0, 4, 0]] }))).toBeNull();
    expect(decodeClassClient(JSON.stringify({ ...msg, placed: Array(33).fill(chair) }))).toBeNull();
  });
});

describe("classroom taps", () => {
  const place = (room: ClassRoom, peer: Peer, pos: [number, number, number]) => {
    room.handle(peer, { t: "k-move", pos, yaw: 0, anim: "idle" });
  };

  it("connects a tap in front and refuses the next one until the cooldown", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { room, teacher } = classWithTeacher();
      const student = new Peer();
      room.joinStudent(student, "Minji");
      place(room, teacher, [0, 4, 0.5]);
      place(room, student, [0, 4, 1.9]);
      const tap = { t: "k-bonk" as const, yaw: 0, pitch: 0, seq: 4 };
      expect(decodeClassClient(JSON.stringify(tap))).toEqual(tap);
      room.handle(teacher, tap);
      const hit = teacher.last("s-k-bonk")!;
      expect(hit).toMatchObject({ t: "s-k-bonk", by: teacher.welcome().you, target: student.welcome().you, seq: 4, vy: BONK_HOP });
      expect(hit.vz).toBeCloseTo(BONK_SPEED, 5);
      expect(hit.vx).toBeCloseTo(0, 5);
      expect(student.last("s-k-bonk")).toEqual(hit);
      room.handle(teacher, tap);
      expect(teacher.inbox.filter((m) => m.t === "s-k-bonk")).toHaveLength(1);
      vi.setSystemTime(1_000_000 + BONK_COOLDOWN_MS);
      room.handle(teacher, { ...tap, seq: 5 });
      expect(teacher.inbox.filter((m) => m.t === "s-k-bonk")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a tap behind you, out of reach, through a wall, or before anyone has moved", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Minji");
    room.handle(teacher, { t: "k-bonk", yaw: 0, pitch: 0, seq: 1 });
    expect(teacher.last("s-k-bonk")).toBeUndefined();
    place(room, teacher, [0, 4, 0.5]);
    place(room, student, [0, 4, -1]);
    room.handle(teacher, { t: "k-bonk", yaw: 0, pitch: 0, seq: 1 });
    expect(teacher.last("s-k-bonk")).toBeUndefined();
    place(room, student, [0, 4, 6]);
    room.handle(teacher, { t: "k-bonk", yaw: 0, pitch: 0, seq: 1 });
    expect(teacher.last("s-k-bonk")).toBeUndefined();
    place(room, student, [0, 4, 1.9]);
    room.handle(teacher, { t: "k-edit", edits: [[0, 5, 1, 3, 0]] });
    room.handle(teacher, { t: "k-bonk", yaw: 0, pitch: 0, seq: 1 });
    expect(teacher.last("s-k-bonk")).toBeUndefined();
    expect(decodeClassClient(JSON.stringify({ t: "k-bonk", yaw: 0, pitch: 2, seq: 1 }))).toBeNull();
  });

  it("only judges the classmate the client aimed at", () => {
    const { room, teacher } = classWithTeacher();
    const near = new Peer();
    const far = new Peer();
    room.joinStudent(near, "Minji");
    room.joinStudent(far, "Jun");
    place(room, teacher, [0, 4, 0.5]);
    place(room, near, [0, 4, 1.5]);
    place(room, far, [0.3, 4, 2.2]);
    const tap = { t: "k-bonk" as const, target: far.welcome().you, yaw: 0, pitch: 0, seq: 1 };
    expect(decodeClassClient(JSON.stringify(tap))).toEqual(tap);
    room.handle(teacher, tap);
    expect(teacher.last("s-k-bonk")?.target).toBe(far.welcome().you);
  });

  it("lets the teacher switch taps off, and a saved class without the switch reads as on", () => {
    const { room, teacher } = classWithTeacher();
    const student = new Peer();
    room.joinStudent(student, "Minji");
    place(room, teacher, [0, 4, 0.5]);
    place(room, student, [0, 4, 1.9]);
    room.handle(teacher, { t: "k-settings", chatLocked: false, buildLocked: false, tapsLocked: true });
    expect(student.last("s-k-settings")?.settings.tapsLocked).toBe(true);
    room.handle(student, { t: "k-bonk", target: teacher.welcome().you, yaw: Math.PI, pitch: 0, seq: 1 });
    room.handle(teacher, { t: "k-bonk", target: student.welcome().you, yaw: 0, pitch: 0, seq: 1 });
    expect(teacher.last("s-k-bonk")).toBeUndefined();
    // an older teacher page sends settings without the field: the switch stays where it was
    room.handle(teacher, { t: "k-settings", chatLocked: true, buildLocked: false });
    expect(teacher.last("s-k-settings")?.settings).toMatchObject({ chatLocked: true, tapsLocked: true });
    // a student cannot flip it
    room.handle(student, { t: "k-settings", chatLocked: false, buildLocked: false, tapsLocked: false });
    expect(teacher.last("s-k-settings")?.settings.tapsLocked).toBe(true);
    expect(classSettingsSchema.parse({ chatLocked: false, buildLocked: false }).tapsLocked).toBeUndefined();
  });
});

describe("character work presentation",()=>{
  it("relays character, work token and swimming without dropping old-client moves",()=>{
    const {room,teacher}=classWithTeacher(),student=new Peer();room.joinStudent(student,"Minji");
    const move={t:"k-move" as const,pos:[3,4,3] as [number,number,number],yaw:1,anim:"crawl" as const,character:"tt" as const,emote:"wave" as const,emoteSeq:8,action:"interact" as const,actionSeq:42,actionLoop:true,swimming:false};
    expect(decodeClassClient(JSON.stringify(move))).toEqual(move);
    room.handle(student,move);room.handle(teacher,{t:"k-move",pos:[1,4,1],yaw:0,anim:"idle"});room.snapshot();
    const snapshot=teacher.last("s-k-snap")!;
    expect(snapshot.players.find(p=>p.actionSeq===42)).toMatchObject({character:"tt",emote:"wave",emoteSeq:8,action:"interact",actionSeq:42,actionLoop:true,swimming:false});
    expect(decodeClassServer(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(decodeClassClient(JSON.stringify({...move,action:"invalid"}))).toBeNull();
    expect(decodeClassClient(JSON.stringify({...move,actionSeq:-1}))).toBeNull();
  });
});
