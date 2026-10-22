import { describe, expect, it } from "vitest";
import type { ClassServerMessage } from "@robo/shared";
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
    expect(teacher.last("s-k-reject")!.edits).toEqual([[0, 0, 0, 0, 0]]);
  });

  it("build and chat locks bind students, not the teacher", () => {
    const { room, teacher } = classWithTeacher();
    const a = new Peer();
    room.joinStudent(a, "Minji");
    room.handle(teacher, { t: "k-settings", chatLocked: true, buildLocked: true });
    expect(a.last("s-k-settings")!.settings).toEqual({ chatLocked: true, buildLocked: true });
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
