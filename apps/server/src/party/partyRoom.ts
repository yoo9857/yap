import { randomBytes } from "node:crypto";
import { PARTY_GAME_MAX, type PartyGame, type PartyMember, type PartyRoomInfo, type PartyServerMessage, type PartyState, type PartySummary } from "@robo/shared";

/** Whoever is on the other end of a room seat. Socket-free, so the rules are unit-tested. */
export interface PartyPeer {
  send(msg: PartyServerMessage): void;
}

interface Member {
  id: string;
  name: string;
  key: string;
  ready: boolean;
  peer: PartyPeer | null;
  /** When the member last had no connection (null = connected). */
  awaySince: number | null;
}

/** A seat whose owner has gone (into the game, or closed the tab) is kept this long. */
export const PARTY_SEAT_TTL_MS = 15 * 60_000;

/** Same name in a room = same person: matched like class names, case- and space-insensitively. */
const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

export type JoinResult = { ok: true; member: string } | { ok: false; code: "full" | "name-taken" | "kicked" };

/**
 * One room: who sits in it, who hosts, which game, waiting or playing.
 * Seats survive their socket — everybody's socket closes when the game starts
 * (the page moves into the game) — and are re-taken with the seat key.
 */
export class PartyRoom {
  private readonly members = new Map<string, Member>();
  private hostId = "";
  private nextId = 1;
  state: PartyState = "waiting";
  /** name key → ms until which a kicked name is refused. */
  private readonly banned = new Map<string, number>();
  /** Bumped on every visible change, so the manager knows the list moved. */
  version = 0;

  constructor(
    readonly code: string,
    public title: string,
    public game: PartyGame,
    public max: number,
    public isPublic: boolean,
  ) {
    this.title = tidy(title);
    this.max = Math.min(max, PARTY_GAME_MAX[game]);
  }

  /** Is `name` seated here (connected or in the game)? The game servers admit only these. */
  hasMember(name: string): boolean {
    const key = nameKey(name);
    for (const m of this.members.values()) if (nameKey(m.name) === key) return true;
    return false;
  }

  get size(): number {
    return this.members.size;
  }

  get online(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.peer) n++;
    return n;
  }

  get isFull(): boolean {
    return this.members.size >= this.max;
  }

  isHost(id: string): boolean {
    return id === this.hostId;
  }

  hostName(): string {
    return this.members.get(this.hostId)?.name ?? "";
  }

  nameOf(id: string): string {
    return this.members.get(id)?.name ?? "";
  }

  join(peer: PartyPeer, name: string, now = Date.now()): JoinResult {
    const key = nameKey(name);
    if ((this.banned.get(key) ?? 0) > now) return { ok: false, code: "kicked" };
    for (const m of this.members.values()) {
      // a seat (even one whose owner is in the game) is re-taken with its key only:
      // the list shows names, so a name must never hand over somebody's seat
      if (nameKey(m.name) === key) return { ok: false, code: "name-taken" };
    }
    if (this.isFull) return { ok: false, code: "full" };
    const member: Member = { id: `m${this.nextId++}`, name: tidy(name), key: randomBytes(12).toString("hex"), ready: false, peer, awaySince: null };
    this.members.set(member.id, member);
    if (!this.hostId) this.hostId = member.id;
    this.changed();
    return { ok: true, member: member.id };
  }

  /**
   * Re-take a seat with its key, under the name the page uses now (a rename
   * keeps the seat, unless another member already has that name). Returns the
   * seat and the peer it took over from (an older tab, which the caller unbinds).
   */
  rejoin(peer: PartyPeer, seatKey: string, name?: string): { id: string; previous: PartyPeer | null } | null {
    for (const m of this.members.values()) {
      if (m.key !== seatKey) continue;
      const previous = m.peer && m.peer !== peer ? m.peer : null;
      previous?.send({ t: "s-p-left", reason: "left" });
      m.peer = peer;
      m.awaySince = null;
      if (name && nameKey(name) !== nameKey(m.name) && ![...this.members.values()].some((o) => o !== m && nameKey(o.name) === nameKey(name))) {
        m.name = tidy(name);
      }
      this.changed();
      return { id: m.id, previous };
    }
    return null;
  }

  /** The socket went (page change into the game, or a dropped link): keep the seat for a while. */
  disconnect(id: string, now = Date.now(), peer?: PartyPeer): void {
    const m = this.members.get(id);
    if (!m || (peer && m.peer !== peer)) return; // an older tab closing must not unseat the new one
    m.peer = null;
    m.awaySince = now;
    this.changed();
  }

  /** Leave for good (the 나가기 button, a kick, or a seat that timed out). */
  remove(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (this.hostId === id) this.passHost();
    this.changed();
  }

  /** Drop seats away longer than the TTL. Returns how many went. */
  expire(now = Date.now(), ttl = PARTY_SEAT_TTL_MS): number {
    let n = 0;
    for (const m of [...this.members.values()]) {
      if (!m.peer && m.awaySince !== null && now - m.awaySince > ttl) {
        this.remove(m.id);
        n++;
      }
    }
    return n;
  }

  /** Seats of people inside the game count as present: their away clock starts when the game empties. */
  touchAway(now = Date.now()): void {
    for (const m of this.members.values()) if (!m.peer) m.awaySince = now;
  }

  /**
   * A host who has left the waiting room (closed the tab) for `graceMs` hands
   * the role to someone connected, or nobody could start, stop or kick.
   */
  reassignAbsentHost(now = Date.now(), graceMs = 20_000): boolean {
    if (this.state !== "waiting") return false;
    const host = this.members.get(this.hostId);
    if (!host || host.peer || host.awaySince === null || now - host.awaySince < graceMs) return false;
    const next = [...this.members.values()].find((m) => m.peer);
    if (!next) return false;
    this.hostId = next.id;
    next.ready = false;
    this.changed();
    return true;
  }

  /** The host role goes to the longest-seated member who is still here, connected first. */
  private passHost(): void {
    const all = [...this.members.values()];
    this.hostId = (all.find((m) => m.peer) ?? all[0])?.id ?? "";
    for (const m of all) if (m.id === this.hostId) m.ready = false;
  }

  setReady(id: string, ready: boolean): void {
    const m = this.members.get(id);
    if (!m || m.ready === ready) return;
    m.ready = ready;
    this.changed();
  }

  /** Host settings. Shrinking `max` below the people already seated is refused. */
  configure(id: string, set: { game?: PartyGame; title?: string; max?: number; public?: boolean }): boolean {
    if (!this.isHost(id)) return false;
    const game = set.game ?? this.game;
    // the game cannot change under people who are playing it (newcomers would land in another game)
    if (set.game !== undefined && set.game !== this.game && this.state === "playing") return false;
    // a game that holds fewer than are seated is refused; a smaller max is clamped to the game's cap
    if (this.members.size > PARTY_GAME_MAX[game]) return false;
    if (set.max !== undefined && set.max < this.members.size) return false;
    if (set.game !== undefined && set.game !== this.game) {
      this.game = set.game;
      // a different game: everybody says ready again
      for (const m of this.members.values()) m.ready = false;
    }
    if (set.title !== undefined) this.title = tidy(set.title);
    if (set.max !== undefined) this.max = set.max;
    this.max = Math.min(this.max, PARTY_GAME_MAX[this.game]);
    if (set.public !== undefined) this.isPublic = set.public;
    this.changed();
    return true;
  }

  /** Everyone connected except the host has said ready (the host starts alone if alone). */
  get allReady(): boolean {
    for (const m of this.members.values()) if (m.id !== this.hostId && m.peer && !m.ready) return false;
    return true;
  }

  start(id: string): "ok" | "not-host" | "not-ready" {
    if (!this.isHost(id)) return "not-host";
    // a second start (double click, two host tabs) must not send everyone into the game again
    if (this.state === "playing") return "ok";
    if (!this.allReady) return "not-ready";
    this.state = "playing";
    for (const m of this.members.values()) m.ready = false;
    this.changed();
    this.broadcast({ t: "s-p-start", game: this.game, code: this.code });
    return "ok";
  }

  /** Back to the waiting room (the host's 게임 끝내기, or the game emptied). */
  stop(): void {
    if (this.state === "waiting") return;
    this.state = "waiting";
    this.changed();
  }

  kick(by: string, target: string, now = Date.now()): boolean {
    if (!this.isHost(by) || by === target) return false;
    const m = this.members.get(target);
    if (!m) return false;
    this.banned.set(nameKey(m.name), now + 5 * 60_000);
    m.peer?.send({ t: "s-p-left", reason: "kicked" });
    this.remove(target);
    return true;
  }

  chat(id: string, text: string): void {
    const m = this.members.get(id);
    // drop control characters: a chat line is one line of plain text
    const clean = text.replace(/\p{Cc}/gu, "").trim();
    if (!m || !clean) return;
    this.broadcast({ t: "s-p-chat", from: id, name: m.name, text: clean });
  }

  system(text: string): void {
    this.broadcast({ t: "s-p-chat", from: "", name: "", text, system: true });
  }

  /** Send every connected member their own view of the room. */
  sync(): void {
    const info = this.info();
    for (const m of this.members.values()) m.peer?.send({ t: "s-p-room", room: info, key: m.key, you: m.id });
  }

  /** One member's view, right now (after a join). */
  syncTo(id: string): void {
    const m = this.members.get(id);
    m?.peer?.send({ t: "s-p-room", room: this.info(), key: m.key, you: m.id });
  }

  info(): PartyRoomInfo {
    const members: PartyMember[] = [...this.members.values()].map((m) => ({ id: m.id, name: m.name, ready: m.ready, online: !!m.peer }));
    return { code: this.code, title: this.title, game: this.game, max: this.max, public: this.isPublic, state: this.state, host: this.hostId, members };
  }

  summary(): PartySummary {
    return { code: this.code, title: this.title, game: this.game, host: this.hostName(), players: this.members.size, max: this.max, state: this.state };
  }

  broadcast(msg: PartyServerMessage): void {
    for (const m of this.members.values()) m.peer?.send(msg);
  }

  /** Forget the room: tell whoever is still connected. */
  close(): void {
    this.broadcast({ t: "s-p-left", reason: "closed" });
    for (const m of this.members.values()) m.peer = null;
  }

  private changed(): void {
    this.version++;
  }
}
