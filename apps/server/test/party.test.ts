import { afterEach, describe, expect, it } from "vitest";
import { PARTY_PROTOCOL_VERSION, decodePartyClient, type PartyServerMessage } from "@robo/shared";
import { PARTY_SEAT_TTL_MS, PartyRoom, type PartyPeer } from "../src/party/partyRoom.js";
import { PartyManager, PartySocket } from "../src/party/partyManager.js";

class Peer implements PartyPeer {
  readonly got: PartyServerMessage[] = [];
  send(msg: PartyServerMessage): void {
    this.got.push(msg);
  }
  last<T extends PartyServerMessage["t"]>(t: T): Extract<PartyServerMessage, { t: T }> | undefined {
    return [...this.got].reverse().find((m) => m.t === t) as Extract<PartyServerMessage, { t: T }> | undefined;
  }
}

const joined = (room: PartyRoom, peer: Peer, name: string): string => {
  const r = room.join(peer, name);
  if (!r.ok) throw new Error(r.code);
  return r.member;
};

describe("PartyRoom", () => {
  it("the first to join hosts; the host passes on when they leave", () => {
    const room = new PartyRoom("ABCDEF", "우리 방", "build", 4, true);
    const a = joined(room, new Peer(), "민지");
    const b = joined(room, new Peer(), "준호");
    expect(room.isHost(a)).toBe(true);
    room.remove(a);
    expect(room.isHost(b)).toBe(true);
    expect(room.hostName()).toBe("준호");
  });

  it("refuses a full room and a seated name — even one away in the game (names are public, keys are not)", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 2, true);
    const a = joined(room, new Peer(), "민지");
    joined(room, new Peer(), "준호");
    expect(room.join(new Peer(), "서연")).toEqual({ ok: false, code: "full" });
    expect(room.join(new Peer(), "  민지 ")).toEqual({ ok: false, code: "name-taken" });
    room.disconnect(a);
    expect(room.join(new Peer(), "민지")).toEqual({ ok: false, code: "name-taken" });
  });

  it("starting needs the host and every connected guest ready; it tells everyone the game", () => {
    const room = new PartyRoom("ABCDEF", "방", "tower", 8, true);
    const hostPeer = new Peer(), guestPeer = new Peer();
    const host = joined(room, hostPeer, "민지");
    const guest = joined(room, guestPeer, "준호");
    expect(room.start(guest)).toBe("not-host");
    expect(room.start(host)).toBe("not-ready");
    room.setReady(guest, true);
    expect(room.start(host)).toBe("ok");
    expect(room.state).toBe("playing");
    expect(guestPeer.last("s-p-start")).toEqual({ t: "s-p-start", game: "tower", code: "ABCDEF" });
    // a guest who went into the game (socket closed) does not block the next start
    room.stop();
    room.disconnect(guest);
    expect(room.start(host)).toBe("ok");
  });

  it("seats survive their socket for the TTL, then expire", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const a = joined(room, new Peer(), "민지");
    room.disconnect(a, 1000);
    expect(room.expire(1000 + PARTY_SEAT_TTL_MS - 1)).toBe(0);
    expect(room.size).toBe(1);
    expect(room.expire(1000 + PARTY_SEAT_TTL_MS + 1)).toBe(1);
    expect(room.size).toBe(0);
  });

  it("a seat key re-takes the same seat (back from the game)", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const peer = new Peer();
    const a = joined(room, peer, "민지");
    room.sync();
    const key = peer.last("s-p-room")!.key;
    expect(peer.last("s-p-room")!.you).toBe(a);
    room.disconnect(a);
    expect(room.rejoin(new Peer(), key)?.id).toBe(a);
    expect(room.rejoin(new Peer(), "not-a-key")).toBeNull();
  });

  it("only the host kicks, and a kicked name stays out for a while", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const host = joined(room, new Peer(), "민지");
    const guestPeer = new Peer();
    const guest = joined(room, guestPeer, "준호");
    expect(room.kick(guest, host)).toBe(false);
    expect(room.kick(host, guest, 0)).toBe(true);
    expect(guestPeer.last("s-p-left")).toEqual({ t: "s-p-left", reason: "kicked" });
    expect(room.join(new Peer(), "준호", 1000)).toEqual({ ok: false, code: "kicked" });
  });

  it("changing the game clears ready; max cannot drop below the people seated", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const host = joined(room, new Peer(), "민지");
    const guest = joined(room, new Peer(), "준호");
    joined(room, new Peer(), "서연");
    room.setReady(guest, true);
    expect(room.configure(guest, { game: "tower" })).toBe(false);
    expect(room.configure(host, { game: "tower" })).toBe(true);
    expect(room.info().members.find((m) => m.id === guest)!.ready).toBe(false);
    expect(room.configure(host, { max: 2 })).toBe(false);
    expect(room.configure(host, { max: 3 })).toBe(true);
  });

  it("chat drops control characters", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const peer = new Peer();
    const a = joined(room, peer, "민지");
    room.chat(a, "안녕\u0007\u001b하세요");
    expect(peer.last("s-p-chat")!.text).toBe("안녕하세요");
  });
});

/** A manager driven through its message handlers with fake sockets (no network). */
function harness(players: (code: string) => number = () => 0) {
  const prepared: string[] = [];
  const mgr = new PartyManager({ prepare: (r) => { prepared.push(r.code); return true; }, players: (r) => players(r.code) });
  const connect = (name: string, from = "1.2.3.4") => {
    const sent: PartyServerMessage[] = [];
    const ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s) as PartyServerMessage), close: () => {}, ping: () => {} };
    const socket = new PartySocket(ws, from);
    mgr.hello(socket, { t: "p-hello", v: PARTY_PROTOCOL_VERSION, name });
    const last = <T extends PartyServerMessage["t"]>(t: T) =>
      [...sent].reverse().find((m) => m.t === t) as Extract<PartyServerMessage, { t: T }> | undefined;
    return { socket, sent, last, say: (msg: unknown) => mgr.handle(socket, decodePartyClient(JSON.stringify(msg))!) };
  };
  return { mgr, connect, prepared };
}

describe("PartyManager", () => {
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; });

  it("creates a room with a readable 6-letter code, and a friend joins it by code", () => {
    const h = harness();
    stop = () => h.mgr.shutdown();
    const a = h.connect("민지");
    a.say({ t: "p-create", title: "같이 놀자", game: "build", max: 4, public: false });
    const code = a.last("s-p-room")!.room.code;
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    const b = h.connect("준호");
    b.say({ t: "p-join", code: code.toLowerCase() });
    expect(b.last("s-p-room")!.room.members.map((m) => m.name)).toEqual(["민지", "준호"]);
    b.say({ t: "p-join", code: "ZZZZZZ" });
    expect(b.last("s-p-error")).toEqual({ t: "s-p-error", code: "not-found" });
  });

  it("joining a room that is already playing goes straight into its game", () => {
    const h = harness();
    stop = () => h.mgr.shutdown();
    const a = h.connect("민지");
    a.say({ t: "p-create", title: "방", game: "tower", max: 8, public: true });
    a.say({ t: "p-start" });
    const code = a.last("s-p-room")!.room.code;
    expect(h.prepared).toContain(code);
    const b = h.connect("준호");
    b.say({ t: "p-join", code });
    expect(b.last("s-p-start")).toEqual({ t: "s-p-start", game: "tower", code });
  });

  it("quick join picks the fullest public room with space, or makes one", () => {
    const h = harness();
    stop = () => h.mgr.shutdown();
    const a = h.connect("민지");
    a.say({ t: "p-create", title: "비밀", game: "build", max: 8, public: false });
    const c = h.connect("서연");
    c.say({ t: "p-quick" });
    const made = c.last("s-p-room")!.room;
    expect(made.public).toBe(true);
    expect(made.code).not.toBe(a.last("s-p-room")!.room.code); // the private room is never matched
    const d = h.connect("하준");
    d.say({ t: "p-quick" });
    expect(d.last("s-p-room")!.room.code).toBe(made.code);
  });

  it("only public rooms are listed", () => {
    const h = harness();
    stop = () => h.mgr.shutdown();
    h.connect("민지").say({ t: "p-create", title: "공개", game: "build", max: 8, public: true });
    h.connect("준호").say({ t: "p-create", title: "비공개", game: "build", max: 8, public: false });
    const viewer = h.connect("서연");
    viewer.say({ t: "p-list" });
    expect(viewer.last("s-p-rooms")!.rooms.map((r) => r.title)).toEqual(["공개"]);
  });

  it("a playing room whose game has emptied returns to waiting; an empty room goes away", () => {
    let inGame = 1;
    const h = harness(() => inGame);
    stop = () => h.mgr.shutdown();
    const a = h.connect("민지");
    a.say({ t: "p-create", title: "방", game: "build", max: 8, public: true });
    a.say({ t: "p-start" });
    const code = a.last("s-p-room")!.room.code;
    h.mgr.gc(0);
    expect(h.mgr.room(code)!.state).toBe("playing");
    inGame = 0;
    h.mgr.gc(1000);
    h.mgr.gc(1000 + 60_000);
    expect(h.mgr.room(code)!.state).toBe("waiting");
    a.say({ t: "p-leave" });
    expect(h.mgr.room(code)).toBeUndefined();
  });

  it("refuses an old client", () => {
    const h = harness();
    stop = () => h.mgr.shutdown();
    const sent: PartyServerMessage[] = [];
    const socket = new PartySocket({ readyState: 1, send: (s: string) => sent.push(JSON.parse(s) as PartyServerMessage), close: () => {}, ping: () => {} }, "x");
    h.mgr.hello(socket, { t: "p-hello", v: PARTY_PROTOCOL_VERSION + 99, name: "민지" });
    expect(sent).toEqual([{ t: "s-p-error", code: "bad-version" }]);
  });
});

describe("seat and host fixes", () => {
  it("an older tab closing does not unseat the tab that re-took the seat", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const oldTab = new Peer(), newTab = new Peer();
    const a = joined(room, oldTab, "민지");
    room.sync();
    const taken = room.rejoin(newTab, oldTab.last("s-p-room")!.key);
    expect(taken?.previous).toBe(oldTab);
    expect(oldTab.last("s-p-left")).toEqual({ t: "s-p-left", reason: "left" });
    room.disconnect(a, 0, oldTab); // the old tab's socket closes later
    expect(room.info().members[0]!.online).toBe(true);
  });

  it("a rename keeps the seat and takes the new name, unless someone else has it", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const p = new Peer();
    joined(room, p, "민지");
    joined(room, new Peer(), "준호");
    room.sync();
    const key = p.last("s-p-room")!.key;
    room.rejoin(new Peer(), key, "민지2");
    expect(room.info().members[0]!.name).toBe("민지2");
    room.rejoin(new Peer(), key, "준호");
    expect(room.info().members[0]!.name).toBe("민지2");
  });

  it("an absent host hands over after the grace period, only while waiting", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const host = joined(room, new Peer(), "민지");
    const guest = joined(room, new Peer(), "준호");
    room.disconnect(host, 1000);
    expect(room.reassignAbsentHost(1000 + 5_000)).toBe(false);
    expect(room.reassignAbsentHost(1000 + 25_000)).toBe(true);
    expect(room.isHost(guest)).toBe(true);
  });

  it("seats of people in a long game are not expired the moment it empties", () => {
    let inGame = 1;
    const h = harness(() => inGame);
    const a = h.connect("민지");
    a.say({ t: "p-create", title: "방", game: "build", max: 8, public: true });
    a.say({ t: "p-start" });
    const code = a.last("s-p-room")!.room.code;
    h.mgr.room(code)!.disconnect(a.socket.memberId, 0, a.socket); // into the game
    h.mgr.gc(30 * 60_000); // a 30-minute game: still playing
    inGame = 0;
    h.mgr.gc(30 * 60_000 + 10_000);
    expect(h.mgr.room(code)?.size).toBe(1);
    h.mgr.shutdown();
  });
});

describe("system conflicts at 50 seats", () => {
  it("a room holds 50, but a tower room only what the tower holds", () => {
    const big = new PartyRoom("ABCDEF", "방", "build", 50, true);
    for (let i = 0; i < 50; i++) joined(big, new Peer(), `p${i}`);
    expect(big.join(new Peer(), "p50")).toEqual({ ok: false, code: "full" });
    const host = big.info().host;
    expect(big.configure(host, { game: "tower" })).toBe(false); // 50 people cannot fit a tower room
    expect(new PartyRoom("ABCDEF", "방", "tower", 50, true).max).toBe(8);
  });

  it("a second start does not send everyone into the game again", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const p = new Peer();
    const host = joined(room, p, "민지");
    expect(room.start(host)).toBe("ok");
    expect(room.start(host)).toBe("ok");
    expect(p.got.filter((m) => m.t === "s-p-start")).toHaveLength(1);
  });

  it("the game cannot change while it is being played", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    const host = joined(room, new Peer(), "민지");
    room.start(host);
    expect(room.configure(host, { game: "tower" })).toBe(false);
    expect(room.game).toBe("build");
  });

  it("only seated names count as members (the party field admits these)", () => {
    const room = new PartyRoom("ABCDEF", "방", "build", 8, true);
    joined(room, new Peer(), "민지");
    expect(room.hasMember(" 민지 ")).toBe(true);
    expect(room.hasMember("남남")).toBe(false);
  });
});
