import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASS_PROTOCOL_VERSION, decodeClassServer, type ClassClientMessage, type ClassServerMessage } from "@robo/shared";
import { ClassManager } from "../src/classroom/classManager.js";
import { ClassRoom } from "../src/classroom/classRoom.js";
import { MemoryClassStore, hashPassword, type SavedClass } from "../src/classroom/classStore.js";

/**
 * Classes are NAMED rooms: a teacher opens "햇살반" as 김선생; a student types
 * "햇살반" and their own name, is shown whose class it is, and joins. These
 * drive the real ClassManager through a fake socket.
 */

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly got: ClassServerMessage[] = [];
  closedWith: string | null = null;
  send(raw: string): void {
    const msg = decodeClassServer(raw);
    if (msg) this.got.push(msg);
  }
  close(_code?: number, reason?: string): void {
    this.closedWith = reason ?? "closed";
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
  ping(): void {}
  say(msg: ClassClientMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
  last<T extends ClassServerMessage["t"]>(t: T): Extract<ClassServerMessage, { t: T }> | undefined {
    return [...this.got].reverse().find((m): m is Extract<ClassServerMessage, { t: T }> => m.t === t);
  }
}

const v = CLASS_PROTOCOL_VERSION;
let managers: ClassManager[] = [];
afterEach(() => {
  for (const m of managers) m.shutdown();
  managers = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(store = new MemoryClassStore()) {
  const manager = new ClassManager(store);
  managers.push(manager);
  const connect = () => {
    const ws = new FakeWs();
    manager.accept(ws as never, "test");
    return ws;
  };
  return { manager, store, connect };
}

describe("named classes", () => {
  it("retries a failed classroom save without requiring another player edit", () => {
    vi.useFakeTimers();
    const { connect, store } = setup(), teacher = connect();
    teacher.say({ t: "k-host", v, room: "Recovery", teacher: "Teacher", password: "1234" });
    teacher.say({ t: "k-edit", edits: [[0, 4, 0, 3, 0]] });
    const write = vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("disk temporarily unavailable"); });
    vi.advanceTimersByTime(15_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.load("recovery")!.edits).toEqual([]);
    vi.advanceTimersByTime(15_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.load("recovery")!.edits).toEqual([[0, 4, 0, 3, 0]]);
  });

  it("opens a class under a class name, and a student joins by that name", () => {
    const { connect } = setup();
    const teacher = connect();
    teacher.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "1234" });
    const welcome = teacher.last("s-k-welcome");
    expect(welcome).toMatchObject({ role: "teacher", room: "햇살반", teacher: "김선생" });

    const kid = connect();
    kid.say({ t: "k-join", v, room: "  햇살반 ", student: "민지" });
    expect(kid.last("s-k-welcome")).toMatchObject({ role: "student", room: "햇살반", teacher: "김선생" });
  });

  it("tells a student whose class a class name is before they join", () => {
    const { connect } = setup();
    connect().say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "1234" });
    const peek = connect();
    peek.say({ t: "k-peek", v, room: "햇살반" });
    expect(peek.last("s-k-room")).toEqual({ t: "s-k-room", room: "햇살반", exists: true, open: true, teacher: "김선생" });
    expect(peek.closedWith).toBe("peeked");

    const nothing = connect();
    nothing.say({ t: "k-peek", v, room: "없는반" });
    expect(nothing.last("s-k-room")).toMatchObject({ exists: false, open: false });
  });

  it("knows a saved class that is not open yet, and keeps students out of it", () => {
    const { connect, store } = setup();
    const { hash, salt } = hashPassword("1234");
    const saved = new ClassRoom("이선생", { passHash: hash, salt }, undefined, "별빛반").toSaved();
    store.save("별빛반", saved);
    const peek = connect();
    peek.say({ t: "k-peek", v, room: "별빛반" });
    expect(peek.last("s-k-room")).toMatchObject({ exists: true, open: false, teacher: "이선생" });
    const kid = connect();
    kid.say({ t: "k-join", v, room: "별빛반", student: "준" });
    expect(kid.last("s-k-error")?.code).toBe("no-class");
  });

  it("lets two teachers with the SAME name run differently named classes", () => {
    const { connect } = setup();
    const a = connect();
    a.say({ t: "k-host", v, room: "1반", teacher: "김선생", password: "1234" });
    const b = connect();
    b.say({ t: "k-host", v, room: "2반", teacher: "김선생", password: "5678" });
    expect(a.last("s-k-welcome")?.room).toBe("1반");
    expect(b.last("s-k-welcome")?.room).toBe("2반");
  });

  it("refuses a class name that belongs to another teacher, live or saved", () => {
    const { connect, store } = setup();
    connect().say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "1234" });
    const rival = connect();
    rival.say({ t: "k-host", v, room: "햇살반", teacher: "박선생", password: "1234" });
    expect(rival.last("s-k-error")?.code).toBe("room-taken");

    const { hash, salt } = hashPassword("1234");
    store.save("달빛반", new ClassRoom("이선생", { passHash: hash, salt }, undefined, "달빛반").toSaved());
    const other = connect();
    other.say({ t: "k-host", v, room: "달빛반", teacher: "박선생", password: "1234" });
    expect(other.last("s-k-error")?.code).toBe("room-taken");
  });

  it("re-opens a saved class with its teacher name and password", () => {
    const { connect, store } = setup();
    const { hash, salt } = hashPassword("1234");
    store.save("달빛반", new ClassRoom("이선생", { passHash: hash, salt }, undefined, "달빛반").toSaved());
    const wrong = connect();
    wrong.say({ t: "k-host", v, room: "달빛반", teacher: "이선생", password: "0000" });
    expect(wrong.last("s-k-error")?.code).toBe("bad-password");
    const right = connect();
    right.say({ t: "k-host", v, room: "달빛반", teacher: "이선생", password: "1234" });
    expect(right.last("s-k-welcome")).toMatchObject({ room: "달빛반", teacher: "이선생" });
  });

  it("keeps classes saved before named classes: their class name is the teacher's", () => {
    // what the store held before: keyed by the teacher name, no roomName
    const { connect, store } = setup();
    const { hash, salt } = hashPassword("1234");
    const old = new ClassRoom("임진아", { passHash: hash, salt }).toSaved();
    delete (old as Partial<SavedClass>).roomName;
    old.edits = [[1, 4, 1, 2, 0]];
    store.save("임진아", old);

    const peek = connect();
    peek.say({ t: "k-peek", v, room: "임진아" });
    expect(peek.last("s-k-room")).toMatchObject({ exists: true, room: "임진아", teacher: "임진아" });
    const teacher = connect();
    teacher.say({ t: "k-host", v, room: "임진아", teacher: "임진아", password: "1234" });
    expect(teacher.last("s-k-welcome")).toMatchObject({ room: "임진아", teacher: "임진아", editCount: 1 });
  });

  it("still won't let a student take the teacher's name", () => {
    const { connect } = setup();
    connect().say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "1234" });
    const fake = connect();
    fake.say({ t: "k-join", v, room: "햇살반", student: "김선생" });
    expect(fake.last("s-k-error")?.code).toBe("name-taken");
    // the class name itself is a fine student name
    const ok = connect();
    ok.say({ t: "k-join", v, room: "햇살반", student: "햇살반" });
    expect(ok.last("s-k-welcome")?.role).toBe("student");
  });

  it("asks an old client to refresh instead of guessing", () => {
    const { connect } = setup();
    const old = connect();
    old.say({ t: "k-peek", v: 2, room: "햇살반" });
    expect(old.last("s-k-error")?.code).toBe("bad-version");
  });

  it("tells a page from before named classes to refresh, though its message no longer parses", () => {
    // last version's k-host has no `room`: it fails the schema, and used to be
    // dropped silently — the page sat on "connecting…" and then blamed the network
    const { connect } = setup();
    const old = connect();
    old.emit("message", Buffer.from(JSON.stringify({ t: "k-host", v: 2, teacher: "임진아", password: "1234" })), false);
    expect(old.last("s-k-error")?.code).toBe("bad-version");
    const oldKid = connect();
    oldKid.emit("message", Buffer.from(JSON.stringify({ t: "k-join", v: 2, teacher: "임진아", student: "민지" })), false);
    expect(oldKid.last("s-k-error")?.code).toBe("bad-version");
  });
});
