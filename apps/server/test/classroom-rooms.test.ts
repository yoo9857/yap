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
  it("requires the streaming protocol so old clients cannot discard live edits while loading", () => {
    const { connect } = setup(), old = connect();
    old.say({ t: "k-host", v: v - 1, room: "Old", teacher: "Teacher", password: "1234" });
    expect(old.last("s-k-error")?.code).toBe("bad-version");
  });

  it("rolls rate-limited edits back to the server value rather than dropping them silently", () => {
    vi.useFakeTimers(); const { connect } = setup(), teacher = connect();
    teacher.say({ t: "k-host", v, room: "RateTest", teacher: "Teacher", password: "1234" });
    for (let i = 0; i < 80; i++) teacher.say({ t: "k-edit", edits: [[0, 4, 0, 3, 0]] });
    teacher.say({ t: "k-edit", edits: [[0, 4, 0, 17, 0]] });
    expect(teacher.last("s-k-reject")).toEqual({ t: "s-k-reject", edits: [[0, 4, 0, 3, 0]], authoritative: true });
  });

  it("streams a large field through a slow transport and preserves concurrent edits", () => {
    vi.useFakeTimers();
    const auth = hashPassword("1234"), store = new MemoryClassStore();
    const saved: SavedClass = { teacherName: "Teacher", roomName: "Large", teacherKey: "host-key", passHash: auth.hash,
      salt: auth.salt, students: [], settings: { buildLocked: false, chatLocked: false },
      edits: Array.from({ length: 100000 }, (_, x) => [x, 4, 0, 3, 0]) };
    store.save("large", saved);
    const { manager, connect } = setup(store), slow = new FakeWs();
    const original = slow.send.bind(slow);
    slow.send = (raw: string) => { original(raw); slow.bufferedAmount += Buffer.byteLength(raw); };
    manager.accept(slow as never, "slow-test");
    slow.say({ t: "k-host", v, room: "Large", teacher: "Teacher", hostKey: "host-key" });
    expect(slow.last("s-k-welcome")!.editCount).toBe(100000);
    expect(slow.got.filter((m) => m.t === "s-k-world").flatMap((m) => m.edits).length).toBeLessThan(100000);
    const writer = connect(); writer.say({ t: "k-join", v, room: "Large", student: "Writer" });
    writer.say({ t: "k-edit", edits: [[99999, 4, 0, 0, 0], [200000, 4, 0, 17, 0]] });
    for (let i = 0; i < 200; i++) { slow.bufferedAmount = 0; vi.advanceTimersByTime(16); }
    const world = slow.got.filter((m) => m.t === "s-k-world").flatMap((m) => m.edits);
    expect(slow.closedWith).toBeNull(); expect(world).toHaveLength(100000);
    expect(world.find(([x]) => x === 99999)?.[3]).toBe(0);
    expect(world.some(([x]) => x === 200000)).toBe(false);
    expect(slow.got.some((m) => m.t === "s-k-edit" && m.edits.some(([x]) => x === 200000))).toBe(true);
    manager.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the water time budget fairly between busy classrooms", () => {
    vi.useFakeTimers(); let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const visited: string[] = [];
    vi.spyOn(ClassRoom.prototype, "stepFluids").mockImplementation(function (this: ClassRoom) {
      visited.push(this.roomName); time += 5; return 1;
    });
    const { connect } = setup();
    for (let i = 0; i < 4; i++) connect().say({ t: "k-host", v, room: `Busy${i}`, teacher: `Teacher${i}`, password: "1234" });
    vi.advanceTimersByTime(250);
    expect(visited).toEqual(["Busy0", "Busy1", "Busy2"]);
    vi.advanceTimersByTime(250);
    expect(visited.slice(3)).toEqual(["Busy3", "Busy0", "Busy1"]);
  });

  it("saves water-only changes on a slower clock than player edits", () => {
    vi.useFakeTimers();
    const { connect, store } = setup(), teacher = connect();
    teacher.say({ t: "k-host", v, room: "Pond", teacher: "Teacher", password: "1234" });
    const write = vi.spyOn(store, "save");
    teacher.say({ t: "k-edit", edits: [[0, 4, 0, 3, 0]] });
    vi.advanceTimersByTime(15_000);
    expect(write).toHaveBeenCalledTimes(1); // a player's brick saves within 15 s
    vi.spyOn(ClassRoom.prototype, "stepFluids").mockImplementation(function (this: ClassRoom) {
      this.waterDirty = true; return 1;
    });
    vi.advanceTimersByTime(105_000);
    expect(write).toHaveBeenCalledTimes(1); // flowing water alone: no rewrite every 15 s
    vi.advanceTimersByTime(15_000);
    expect(write).toHaveBeenCalledTimes(2); // ...but within two minutes
  });

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

describe("multiplayer robustness", () => {
  it("a deploy (shutdown) drops sockets without telling anyone the class ended, and keeps it saved", () => {
    const store = new MemoryClassStore();
    const manager = new ClassManager(store);
    const connect = () => { const ws = new FakeWs(); manager.accept(ws as never, "test"); return ws; };
    const teacher = connect(), student = connect();
    teacher.say({ t: "k-host", v, room: "Deploy", teacher: "Teacher", password: "1234" });
    student.say({ t: "k-join", v, room: "Deploy", student: "Kid" });
    const save = vi.spyOn(store, "save");
    manager.shutdown();
    expect(teacher.last("s-k-closed")).toBeUndefined();
    expect(student.last("s-k-closed")).toBeUndefined();
    expect(student.readyState).toBe(3); // dropped: the client reconnects by itself
    expect(save.mock.calls.at(-1)?.[1].students.map((x) => x.name)).toEqual(["Kid"]);
  });

  it("closes a replaced tab with the reason that stops it reconnecting", () => {
    const { connect } = setup(), teacher = connect(), tabA = connect(), tabB = connect();
    teacher.say({ t: "k-host", v, room: "Tabs", teacher: "Teacher", password: "1234" });
    tabA.say({ t: "k-join", v, room: "Tabs", student: "Kid" });
    const key = tabA.last("s-k-welcome")!.key;
    tabB.say({ t: "k-join", v, room: "Tabs", student: "Kid", seatKey: key });
    expect(tabB.last("s-k-welcome")).toBeDefined();
    expect(tabA.closedWith).toBe("replaced");
  });

  it("locks a class after repeated wrong passwords, but never against its own host key", () => {
    const { connect } = setup(), first = connect();
    first.say({ t: "k-host", v, room: "Locked", teacher: "Teacher", password: "1234" });
    const hostKey = first.last("s-k-welcome")!.key;
    first.close();
    for (let i = 0; i < 5; i++) {
      const guess = connect();
      guess.say({ t: "k-host", v, room: "Locked", teacher: "Teacher", password: `wrong${i}` });
      expect(guess.last("s-k-error")?.code).toBe("bad-password");
    }
    const right = connect();
    right.say({ t: "k-host", v, room: "Locked", teacher: "Teacher", password: "1234" });
    expect(right.last("s-k-error")?.code).toBe("bad-password"); // locked: even the right password waits
    const owner = connect();
    owner.say({ t: "k-host", v, room: "Locked", teacher: "Teacher", hostKey });
    expect(owner.last("s-k-welcome")).toBeDefined();
  });

  it("keeps counting wrong passwords across the minute clean-up", () => {
    vi.useFakeTimers();
    const { connect } = setup(), first = connect();
    first.say({ t: "k-host", v, room: "Patient", teacher: "Teacher", password: "1234" });
    first.close();
    vi.advanceTimersByTime(31 * 60_000); // empty class collected and saved
    const guess = (p: string) => { const g = connect(); g.say({ t: "k-host", v, room: "Patient", teacher: "Teacher", password: p }); return g; };
    for (let i = 0; i < 4; i++) guess(`nope${i}`);
    vi.advanceTimersByTime(61_000); // a gc pass must not reset the count
    guess("nope4");
    expect(guess("1234").last("s-k-error")?.code).toBe("bad-password"); // the 5th miss locked it
  });

  it("never attaches anyone to a closed class whose last save failed", () => {
    vi.useFakeTimers();
    const { connect, store } = setup(), teacher = connect();
    teacher.say({ t: "k-host", v, room: "Stuck", teacher: "Teacher", password: "1234" });
    const save = vi.spyOn(store, "save").mockImplementation(() => { throw new Error("disk full"); });
    teacher.say({ t: "k-end" });
    const kid = connect();
    kid.say({ t: "k-join", v, room: "Stuck", student: "Kid" });
    expect(kid.last("s-k-error")?.code).toBe("no-class");
    const back = connect();
    back.say({ t: "k-host", v, room: "Stuck", teacher: "Teacher", password: "1234" });
    expect(back.last("s-k-error")?.code).toBe("internal");
    save.mockRestore();
    const again = connect();
    again.say({ t: "k-host", v, room: "Stuck", teacher: "Teacher", password: "1234" });
    expect(again.last("s-k-welcome")).toBeDefined(); // saved now: restored like any saved class
  });

  it("answers a peek from the saved names without needing the class loaded", () => {
    const store = new MemoryClassStore();
    const saved: SavedClass = { roomName: "Saved", teacherName: "Teacher", ...(() => { const a = hashPassword("1234"); return { passHash: a.hash, salt: a.salt }; })(),
      teacherKey: "k", students: [], settings: { chatLocked: false, buildLocked: false }, edits: [[1, 4, 1, 3, 0]] };
    store.save("saved", saved);
    const meta = vi.spyOn(store, "meta");
    const { connect } = setup(store), peek = connect();
    peek.say({ t: "k-peek", v, room: "Saved" });
    expect(peek.last("s-k-room")).toMatchObject({ exists: true, open: false, teacher: "Teacher", room: "Saved" });
    expect(meta).toHaveBeenCalledWith("saved"); // names only (SQLite reads them with json_extract)
  });

  it("refuses a damaged saved class instead of crashing the server", () => {
    const store = new MemoryClassStore();
    (store as unknown as { classes: Map<string, string> }).classes.set("broken", JSON.stringify({ teacherName: "Teacher", passHash: "x", salt: "y", teacherKey: "k" }));
    expect(store.load("broken")).toBeNull();
    const { connect } = setup(store), teacher = connect();
    teacher.say({ t: "k-host", v, room: "Broken", teacher: "Teacher", password: "1234" });
    expect(teacher.last("s-k-welcome")).toBeDefined(); // treated as missing: a fresh class opens
  });
});

describe("party fields (party:CODE)", () => {
  it("open on the first k-join, share edits between members, and are never saved", () => {
    const { connect, store, manager } = setup();
    const save = vi.spyOn(store, "save");
    const a = connect(), b = connect();
    a.say({ t: "k-join", v, room: "party:ABCDEF", student: "민지" });
    b.say({ t: "k-join", v, room: "party:abcdef", student: "준호" });
    expect(a.last("s-k-welcome")?.room).toBe("party:ABCDEF");
    expect(b.last("s-k-welcome")?.room).toBe("party:ABCDEF");
    expect(manager.partyOnline("ABCDEF")).toBe(2);
    a.say({ t: "k-edit", edits: [[3, 4, 3, 5, 0]] });
    expect(b.last("s-k-edit")?.edits).toEqual([[3, 4, 3, 5, 0]]);
    manager.shutdown();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuse malformed codes and teachers who try to open one", () => {
    const { connect } = setup();
    const bad = connect();
    bad.say({ t: "k-join", v, room: "party:OO0000", student: "민지" });
    expect(bad.last("s-k-error")?.code).toBe("no-class");
    const teacher = connect();
    teacher.say({ t: "k-host", v, room: "party:ABCDEF", teacher: "김선생", password: "1234" });
    expect(teacher.last("s-k-error")?.code).toBe("room-taken");
  });
});

describe("party field hardening", () => {
  it("a look-alike name (spaces) is refused and never replaces the live field", () => {
    const { connect, manager } = setup();
    const a = connect();
    a.say({ t: "k-join", v, room: "party:ABCDEF", student: "민지" });
    const evil = connect();
    evil.say({ t: "k-join", v, room: "party: ABCDEF", student: "악당" });
    expect(evil.last("s-k-error")?.code).toBe("no-class");
    expect(manager.partyOnline("ABCDEF")).toBe(1);
  });

  it("opens only for codes the hub says exist", () => {
    const { connect, manager } = setup();
    manager.partyGate = (code) => code === "ABCDEF";
    const stranger = connect();
    stranger.say({ t: "k-join", v, room: "party:ZZZZZZ", student: "민지" });
    expect(stranger.last("s-k-error")?.code).toBe("no-class");
    const member = connect();
    member.say({ t: "k-join", v, room: "party:ABCDEF", student: "민지" });
    expect(member.last("s-k-welcome")?.room).toBe("party:ABCDEF");
  });
});
