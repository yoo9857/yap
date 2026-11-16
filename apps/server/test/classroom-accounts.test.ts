import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { CLASS_PROTOCOL_VERSION, decodeClassServer, type ClassClientMessage, type ClassServerMessage } from "@robo/shared";
import { ClassManager } from "../src/classroom/classManager.js";
import { MemoryClassStore } from "../src/classroom/classStore.js";
import { makeTicket, readTicket, ticketKey } from "../src/site/ticket.js";

/**
 * A class and the teacher's ACCOUNT (docs/ACCOUNTS.md). The account ADDS a way in — the owner
 * opens their class from any computer without its password — and takes none away: the host key
 * and the class password work as they always did, so no lesson is locked out by the accounts.
 */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly got: ClassServerMessage[] = [];
  send(raw: string): void { const msg = decodeClassServer(raw); if (msg) this.got.push(msg); }
  close(): void { this.readyState = 3; this.emit("close"); }
  terminate(): void { this.close(); }
  ping(): void {}
  say(msg: ClassClientMessage): void { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
  last<T extends ClassServerMessage["t"]>(t: T): Extract<ClassServerMessage, { t: T }> | undefined {
    return [...this.got].reverse().find((m): m is Extract<ClassServerMessage, { t: T }> => m.t === t);
  }
}

const v = CLASS_PROTOCOL_VERSION, key = ticketKey("k".repeat(40), 4)!;
let managers: ClassManager[] = [];
afterEach(() => { for (const m of managers) m.shutdown(); managers = []; });

/** A store that outlives the manager using it, as the database does (the memory store empties itself when closed). */
class LastingStore extends MemoryClassStore { override close(): void {} }

function setup(store = new LastingStore()) {
  const manager = new ClassManager(store);
  manager.ticketOwner = (ticket) => readTicket(key, ticket, Date.now());
  managers.push(manager);
  const connect = () => { const ws = new FakeWs(); manager.accept(ws as never, "test"); return ws; };
  /** A class is put away (as when its lesson ends and the server restarts) and can be restored from the store. */
  const restart = () => { manager.shutdown(); return setup(store); };
  return { manager, store, connect, restart };
}
const ticket = (account: number) => makeTicket(key, account, Date.now());
const ok = (ws: FakeWs) => ws.last("s-k-welcome") !== undefined;
const refused = (ws: FakeWs) => ws.last("s-k-error")?.code;

describe("host tickets", () => {
  it("name the account they were made for, until they expire", () => {
    const now = 1_700_000_000_000, t = makeTicket(key, 42, now);
    expect(readTicket(key, t, now + 60_000)).toBe(42);
    expect(readTicket(key, t, now + 3 * 60_000)).toBeNull();
  });
  it("cannot be forged, altered or made under another key", () => {
    const now = 1_700_000_000_000, t = makeTicket(key, 42, now), [, exp, sig] = t.split(".");
    expect(readTicket(key, `43.${exp}.${sig}`, now)).toBeNull();                       // another account
    expect(readTicket(key, `42.${Number(exp) + 86_400_000}.${sig}`, now)).toBeNull();  // a longer life
    expect(readTicket(ticketKey("x".repeat(40), 4), t, now)).toBeNull();               // another server's key
    for (const junk of ["", "42", "a.b.c", `42.${exp}`, "9".repeat(300)]) expect(readTicket(key, junk, now)).toBeNull();
  });
  it("need the shared secret when several processes run, and work alone without it", () => {
    expect(ticketKey(undefined, 4)).toBeNull();
    expect(ticketKey("short", 4)).toBeNull();
    expect(ticketKey(undefined, 1)).not.toBeNull();
  });
});

describe("classes and accounts", () => {
  it("a signed-in teacher opens a new class without a class password, and it is theirs", () => {
    const s = setup(), t = s.connect();
    t.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    expect(ok(t)).toBe(true);
    expect(s.store.load("햇살반")?.owner).toBe(7);
  });

  it("an account's class list holds its classes and nobody else's", () => {
    const s = setup();
    s.connect().say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7), theme: "fire" });
    s.connect().say({ t: "k-host", v, room: "달빛반", teacher: "김선생", ticket: ticket(7) });
    s.connect().say({ t: "k-host", v, room: "남의 반", teacher: "박선생", ticket: ticket(8) });
    s.connect().say({ t: "k-host", v, room: "계정 없는 반", teacher: "이선생", password: "1234" });
    s.manager.shutdown();
    expect(s.store.owned(7).map((c) => [c.name, c.teacher, c.theme, c.students]).sort()).toEqual([["달빛반", "김선생", "craft", 0], ["햇살반", "김선생", "fire", 0]]);
    expect(s.store.owned(8).map((c) => c.name)).toEqual(["남의 반"]);
    expect(s.store.owned(9)).toEqual([]);
  });

  it("without an account a new class still needs its password", () => {
    const s = setup(), t = s.connect();
    t.say({ t: "k-host", v, room: "햇살반", teacher: "김선생" });
    expect(refused(t)).toBe("bad-password");
    const forged = s.connect();
    forged.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: "7.9999999999999.forged" });
    expect(refused(forged)).toBe("bad-password");
  });

  it("the owner re-opens the class from another computer with the account alone", () => {
    let s = setup();
    s.connect().say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    s = s.restart();
    const elsewhere = s.connect();
    elsewhere.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) }); // no host key, no password
    expect(ok(elsewhere)).toBe(true);
  });

  it("another account does not get in by its ticket", () => {
    let s = setup();
    s.connect().say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    s = s.restart();
    const other = s.connect();
    other.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(8) });
    expect(refused(other)).toBe("bad-password");
    expect(s.store.load("햇살반")?.owner).toBe(7);
  });

  it("a class from before accounts keeps working by its password, and becomes the account's that opens it", () => {
    let s = setup();
    s.connect().say({ t: "k-host", v, room: "달빛반", teacher: "이선생", password: "1234" });
    expect(s.store.load("달빛반")?.owner).toBeUndefined();
    s = s.restart();
    const noAccount = s.connect();
    noAccount.say({ t: "k-host", v, room: "달빛반", teacher: "이선생", password: "1234" });
    expect(ok(noAccount)).toBe(true); // nothing was taken away
    s = s.restart();
    const wrong = s.connect();
    wrong.say({ t: "k-host", v, room: "달빛반", teacher: "이선생", ticket: ticket(9) }); // an account, but not the password: not theirs to take
    expect(refused(wrong)).toBe("bad-password");
    const claiming = s.connect();
    claiming.say({ t: "k-host", v, room: "달빛반", teacher: "이선생", password: "1234", ticket: ticket(9) });
    expect(ok(claiming)).toBe(true);
    expect(s.store.load("달빛반")?.owner).toBe(9);
  });

  it("an owned class is not re-assigned to whoever knows its password", () => {
    let s = setup();
    s.connect().say({ t: "k-host", v, room: "별빛반", teacher: "박선생", password: "1234", ticket: ticket(7) });
    s = s.restart();
    const other = s.connect();
    other.say({ t: "k-host", v, room: "별빛반", teacher: "박선생", password: "1234", ticket: ticket(8) });
    expect(ok(other)).toBe(true); // the password still opens it (accounts are optional for now)
    expect(s.store.load("별빛반")?.owner).toBe(7);
  });

  it("the owner comes back into their LIVE class by the account (a refresh on another computer)", () => {
    const s = setup(), first = s.connect();
    first.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    first.close();
    const again = s.connect();
    again.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    expect(ok(again)).toBe(true);
    const stranger = s.connect();
    stranger.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(8) });
    expect(ok(stranger)).toBe(false);
  });
});

describe("반 설정: the owner's account and its class between lessons", () => {
  /** A class of account 7 with two students who have left, and the teacher gone too. */
  const made = () => {
    const s = setup(), t = s.connect();
    t.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    const kids = ["민지", "준호"].map((name) => { const k = s.connect(); k.say({ t: "k-join", v, room: "햇살반", student: name }); return k; });
    return { ...s, t, kids, leave: () => { for (const ws of [...kids, t]) ws.close(); } };
  };
  const view = (a: ReturnType<ClassManager["admin"]>) => { if (!a.ok || !("class" in a)) throw new Error(JSON.stringify(a)); return a.class; };

  it("shows a running lesson (who is here) and changes nothing in it", () => {
    const s = made();
    const now = view(s.manager.admin("햇살반", 7, { op: "get" }));
    expect(now).toMatchObject({ name: "햇살반", teacher: "김선생", online: 3 });
    expect(now.students).toEqual([{ name: "민지", online: true }, { name: "준호", online: true }]);
    s.kids[1]!.close();
    expect(view(s.manager.admin("햇살반", 7, { op: "get" })).students).toEqual([{ name: "민지", online: true }, { name: "준호", online: false }]);
    for (const op of [{ op: "remove-student", name: "민지" }, { op: "reset-field" }, { op: "delete" }, { op: "settings", buildLocked: true }] as const)
      expect(s.manager.admin("햇살반", 7, op)).toEqual({ ok: false, error: "busy" });
    s.leave();
    expect(view(s.manager.admin("햇살반", 7, { op: "get" }))).toMatchObject({ online: 0, students: [{ name: "민지", online: false }, { name: "준호", online: false }] });
  });

  it("is one answer for another account's class, a party field and no class at all", () => {
    const s = made(); s.leave();
    for (const [room, account] of [["햇살반", 8], ["햇살반", 0], ["없는 반", 7], ["party:ABCDEF", 7]] as const)
      for (const op of [{ op: "get" }, { op: "delete" }, { op: "password", password: "mine-now" }] as const)
        expect(s.manager.admin(room, account, op)).toEqual({ ok: false, error: "not-found" });
    expect(s.store.load("햇살반")?.owner).toBe(7);
  });

  it("the roster: names are put in before the lesson and taken out, and a listed student gets that seat", () => {
    const s = made(); s.leave();
    const added = view(s.manager.admin("햇살반", 7, { op: "add-students", names: [" 서연 ", "민지", "김선생", "", "도윤", "서연"] }));
    expect(added.students.map((x) => x.name)).toEqual(["민지", "준호", "서연", "도윤"]); // already there, the teacher's name, empty and repeated ones are skipped
    expect(s.manager.admin("햇살반", 7, { op: "add-students", names: ["민지"] })).toEqual({ ok: false, error: "fields" });
    expect(view(s.manager.admin("햇살반", 7, { op: "remove-student", name: "준호" })).students.map((x) => x.name)).toEqual(["민지", "서연", "도윤"]);
    expect(s.manager.admin("햇살반", 7, { op: "remove-student", name: "준호" })).toEqual({ ok: false, error: "fields" });
    // the next lesson: the listed student walks in under the name, the class has the same three seats
    const t = s.connect(); t.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    const k = s.connect(); k.say({ t: "k-join", v, room: "햇살반", student: "서연" });
    expect(ok(k)).toBe(true);
    expect(view(s.manager.admin("햇살반", 7, { op: "get" })).students).toEqual([{ name: "민지", online: false }, { name: "서연", online: true }, { name: "도윤", online: false }]);
  });

  it("the locks a lesson starts with are the ones set here, all five, and survive a restart", () => {
    const s = made(); s.leave();
    view(s.manager.admin("햇살반", 7, { op: "settings", buildLocked: true, plantsLocked: true, petsOff: true }));
    expect(view(s.manager.admin("햇살반", 7, { op: "settings", petsOff: false, chatLocked: true })).settings)
      .toEqual({ chatLocked: true, buildLocked: true, tapsLocked: false, plantsLocked: true, petsOff: false });
    const again = s.restart(), t = again.connect();
    t.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", ticket: ticket(7) });
    expect(t.last("s-k-welcome")?.settings).toMatchObject({ chatLocked: true, buildLocked: true, plantsLocked: true });
    expect(t.last("s-k-welcome")?.settings.petsOff).toBeUndefined();
  });

  it("a new class password opens the class without the account; the old one no longer does", () => {
    const s = setup(), t = s.connect();
    t.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "first-pass", ticket: ticket(7) });
    t.close();
    expect(s.manager.admin("햇살반", 7, { op: "password", password: "second-pass" }).ok).toBe(true);
    const old = s.connect(); old.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "first-pass" });
    expect(refused(old)).toBe("bad-password");
    const fresh = s.connect(); fresh.say({ t: "k-host", v, room: "햇살반", teacher: "김선생", password: "second-pass" });
    expect(ok(fresh)).toBe(true);
  });

  it("empties the field, clears the seating, and deletes the class for good", () => {
    const s = made();
    s.t.say({ t: "k-edit", edits: [[3, 1, 3, 1, 0]] });
    s.leave();
    view(s.manager.admin("햇살반", 7, { op: "get" })); // (puts the class away: the store has it whole)
    s.store.save("햇살반", { ...s.store.load("햇살반")!, seating: { seats: [{ name: "민지", pos: [0, 1, 0], yaw: 0 }, { name: "준호", pos: [15, 1, 0], yaw: 0 }], origin: { pos: [0, 1, -3], yaw: 0 }, roam: false } });
    const before = view(s.manager.admin("햇살반", 7, { op: "get" }));
    expect(before.field.blocks).toBe(1);
    expect(before.seats).toBe(2);
    expect(view(s.manager.admin("햇살반", 7, { op: "reset-field" }))).toMatchObject({ field: { blocks: 0, furniture: 0, plants: 0 }, seats: 2 });
    expect(view(s.manager.admin("햇살반", 7, { op: "clear-seats" })).seats).toBe(0);
    expect(s.manager.admin("햇살반", 7, { op: "delete" })).toEqual({ ok: true, deleted: true });
    expect(s.store.load("햇살반")).toBeNull();
    expect(s.store.owned(7)).toEqual([]);
    // the name is free again: anyone may make a class of it
    const other = s.connect(); other.say({ t: "k-host", v, room: "햇살반", teacher: "박선생", ticket: ticket(8) });
    expect(ok(other)).toBe(true);
  });
});
