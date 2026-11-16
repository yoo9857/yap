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
