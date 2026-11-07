import { randomInt } from "node:crypto";
import type { WebSocket } from "ws";
import {
  PARTY_CODE_ALPHABET,
  PARTY_CODE_LENGTH,
  PARTY_PROTOCOL_VERSION,
  decodePartyClient,
  playerNameSchema,
  type PartyClientMessage,
  type PartyErrorCode,
  type PartyGame,
  type PartyServerMessage,
} from "@robo/shared";
import { log } from "../log.js";
import { PartyRoom, type PartyPeer } from "./partyRoom.js";

/** What the games tell the rooms: who is playing a room's game right now. */
export interface PartyGames {
  /** A room's game is starting: make sure its server-side world exists. False: it could not be made. */
  prepare(room: PartyRoom): boolean;
  /** Players currently inside a room's game. */
  players(room: PartyRoom): number;
}

const HELLO_TIMEOUT_MS = 10_000;
const LIST_THROTTLE_MS = 400;
const GC_MS = 10_000;
/** A playing room whose game emptied goes back to waiting after this. */
const IDLE_GAME_MS = 60_000;
export const PARTY_MAX_ROOMS = 300;
/** Rooms one address may hold at once. A school shares one public IP, so this is generous. */
export const PARTY_ROOMS_PER_ADDRESS = 40;
const LIST_MAX = 120;

/** The bits of a socket a seat uses (a plain object in the tests). */
export interface PartyTransport {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
}

/** One connection: a token bucket keeps a flood from costing more than its own socket. */
export class PartySocket implements PartyPeer {
  name = "";
  memberId = "";
  room: PartyRoom | null = null;
  listing = false;
  alive = true;
  private tokens = 20;
  private lastRefill = Date.now();
  private lastChat = 0;
  private strikes = 0;

  constructor(private readonly ws: PartyTransport, readonly from: string) {}

  send(msg: PartyServerMessage): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(reason: string): void {
    try { this.ws.close(1000, reason.slice(0, 60)); } catch { /* already closing */ }
  }

  ping(): void {
    this.alive = false;
    try { this.ws.ping(); } catch { /* closing */ }
  }

  /** 20 messages a second sustained; chat at most every 0.7 s. */
  allow(msg: PartyClientMessage, now = Date.now()): boolean {
    this.tokens = Math.min(20, this.tokens + ((now - this.lastRefill) / 1000) * 20);
    this.lastRefill = now;
    if (this.tokens < 1) return this.strike();
    this.tokens--;
    if (msg.t === "p-chat") {
      if (now - this.lastChat < 700) return false;
      this.lastChat = now;
    }
    return true;
  }

  /** Garbage or flooding: a few are forgiven, then the socket goes. */
  strike(): false {
    if (++this.strikes > 30) this.close("misbehaving");
    return false;
  }
}

/**
 * The hub's rooms: who is listening to the list, the rooms themselves, codes,
 * quick match, the hand-off into a game, and cleanup when a room empties.
 */
export class PartyManager {
  private readonly rooms = new Map<string, PartyRoom>();
  private readonly sockets = new Set<PartySocket>();
  private readonly roomOwner = new Map<string, string>();
  private readonly idleSince = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private listTimer: NodeJS.Timeout | null = null;
  private listedVersion = -1;

  constructor(private readonly games: PartyGames) {
    this.timers.push(setInterval(() => this.gc(), GC_MS));
    this.timers.push(setInterval(() => this.heartbeat(), 15_000));
  }

  accept(ws: WebSocket, from: string): void {
    const socket = new PartySocket(ws, from);
    this.sockets.add(socket);
    const helloTimer = setTimeout(() => { if (!socket.name) socket.close("hello timeout"); }, HELLO_TIMEOUT_MS);
    ws.on("pong", () => (socket.alive = true));
    ws.on("message", (data, isBinary) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const msg = isBinary ? null : decodePartyClient(data.toString());
      if (!msg) {
        socket.strike();
        return;
      }
      if (!socket.allow(msg)) return;
      try {
        if (msg.t === "p-hello") {
          clearTimeout(helloTimer);
          this.hello(socket, msg);
        } else if (socket.name) {
          this.handle(socket, msg);
        }
      } catch (err) {
        log.error({ from, t: msg.t, err }, "party message failed");
        this.error(socket, "internal");
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.sockets.delete(socket);
      if (socket.room) socket.room.disconnect(socket.memberId, Date.now(), socket);
      socket.room = null;
      this.listChanged();
    });
    ws.on("error", (err) => log.warn({ from, err: err.message }, "party socket error"));
  }

  // ------------------------------------------------------------ messages

  /** Exposed for the unit tests, which drive the manager without real sockets. */
  hello(socket: PartySocket, msg: Extract<PartyClientMessage, { t: "p-hello" }>): void {
    if (msg.v !== PARTY_PROTOCOL_VERSION) {
      this.error(socket, "bad-version");
      socket.close("bad version");
      return;
    }
    if (!playerNameSchema.safeParse(msg.name).success) return this.error(socket, "bad-name");
    socket.name = msg.name.trim();
    socket.send({ t: "s-p-welcome", you: socket.name });
    if (msg.seat) {
      const room = this.rooms.get(msg.seat.code);
      const seat = room?.rejoin(socket, msg.seat.key, socket.name);
      if (room && seat) {
        // an older tab of this seat stops acting for it (its p-leave / p-start / close)
        for (const s of this.sockets) if (s === seat.previous) { s.room = null; s.memberId = ""; }
        this.enter(socket, room, seat.id);
      }
      // the room is gone (emptied, or a deploy): the page forgets the seat and shows the list
      else socket.send({ t: "s-p-left", reason: "closed" });
    }
  }

  handle(socket: PartySocket, msg: PartyClientMessage): void {
    const room = socket.room;
    const me = socket.memberId;
    switch (msg.t) {
      case "p-list":
        socket.listing = true;
        socket.send(this.listMessage());
        return;
      case "p-create":
        return this.create(socket, msg.title, msg.game, msg.max, msg.public);
      case "p-join": {
        const target = this.rooms.get(msg.code);
        if (!target) return this.error(socket, "not-found");
        return this.join(socket, target);
      }
      case "p-quick": {
        const open = [...this.rooms.values()]
          .filter((r) => r.isPublic && !r.isFull && (!msg.game || r.game === msg.game))
          .sort((a, b) => b.size - a.size)[0];
        if (open) return this.join(socket, open);
        return this.create(socket, `${socket.name}의 방`, msg.game ?? "build", 8, true);
      }
      case "p-leave":
        if (!room) return;
        this.leaveRoom(socket, "left");
        return;
      default:
        break;
    }
    if (!room) return;
    switch (msg.t) {
      case "p-ready":
        room.setReady(me, msg.ready);
        break;
      case "p-chat":
        room.chat(me, msg.text);
        return;
      case "p-set":
        if (!room.configure(me, msg)) return this.error(socket, room.isHost(me) ? "game-limit" : "not-host");
        break;
      case "p-start": {
        if (room.isHost(me) && !this.games.prepare(room)) return this.error(socket, "too-many-rooms");
        const result = room.start(me);
        if (result !== "ok") return this.error(socket, result);
        this.idleSince.delete(room.code);
        log.info({ room: room.code, game: room.game, players: room.size }, "party started");
        break;
      }
      case "p-stop":
        if (!room.isHost(me)) return this.error(socket, "not-host");
        room.stop();
        room.system("방장이 게임을 끝냈어요. 대기실로 돌아왔어요.");
        break;
      case "p-kick":
        if (!room.kick(me, msg.id)) return this.error(socket, "not-host");
        for (const s of this.sockets) if (s.room === room && s.memberId === msg.id) { s.room = null; s.memberId = ""; }
        break;
      default:
        return;
    }
    room.sync();
    this.listChanged();
  }

  private create(socket: PartySocket, title: string, game: PartyGame, max: number, isPublic: boolean): void {
    if (this.rooms.size >= PARTY_MAX_ROOMS) return this.error(socket, "too-many-rooms");
    let owned = 0;
    for (const owner of this.roomOwner.values()) if (owner === socket.from) owned++;
    if (owned >= PARTY_ROOMS_PER_ADDRESS) return this.error(socket, "too-many-rooms");
    if (socket.room) this.leaveRoom(socket, "left");
    const room = new PartyRoom(this.newCode(), title, game, max, isPublic);
    this.rooms.set(room.code, room);
    this.roomOwner.set(room.code, socket.from);
    log.info({ room: room.code, game, from: socket.from }, "party room created");
    this.join(socket, room);
  }

  private join(socket: PartySocket, room: PartyRoom): void {
    if (socket.room === room) return room.syncTo(socket.memberId);
    if (socket.room) this.leaveRoom(socket, "left");
    const result = room.join(socket, socket.name);
    if (!result.ok) return this.error(socket, result.code);
    room.system(`${socket.name} 님이 들어왔어요.`);
    this.enter(socket, room, result.member);
    // a room already in its game: straight in (mid-game join)
    if (room.state === "playing" && this.games.prepare(room)) {
      socket.send({ t: "s-p-start", game: room.game, code: room.code });
    }
  }

  private enter(socket: PartySocket, room: PartyRoom, member: string): void {
    socket.room = room;
    socket.memberId = member;
    socket.listing = false;
    room.sync();
    this.listChanged();
  }

  private leaveRoom(socket: PartySocket, reason: "left" | "kicked"): void {
    const room = socket.room;
    if (!room) return;
    const name = room.nameOf(socket.memberId);
    room.remove(socket.memberId);
    socket.room = null;
    socket.memberId = "";
    socket.send({ t: "s-p-left", reason });
    if (room.size === 0) this.drop(room);
    else {
      room.system(`${name} 님이 나갔어요.`);
      room.sync();
    }
    this.listChanged();
  }

  private error(socket: PartySocket, code: PartyErrorCode): void {
    socket.send({ t: "s-p-error", code });
  }

  private newCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < PARTY_CODE_LENGTH; i++) code += PARTY_CODE_ALPHABET[randomInt(PARTY_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  // ------------------------------------------------------------ list

  private listMessage(): PartyServerMessage {
    const rooms = [...this.rooms.values()]
      .filter((r) => r.isPublic && r.size > 0)
      // waiting rooms with space first, then playing ones you can still drop into, fullest first
      .sort((a, b) => Number(a.isFull) - Number(b.isFull) || Number(a.state === "playing") - Number(b.state === "playing") || b.size - a.size)
      .slice(0, LIST_MAX)
      .map((r) => r.summary());
    return { t: "s-p-rooms", rooms };
  }

  /** Coalesce list updates: a burst of joins sends one list. */
  private listChanged(): void {
    // every seat change passes through here: the cluster mirrors the roster to the game shards
    this.onRosterChange?.();
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const version = [...this.rooms.values()].reduce((sum, r) => sum + r.version, this.rooms.size);
      if (version === this.listedVersion) return;
      this.listedVersion = version;
      const msg = this.listMessage();
      for (const s of this.sockets) if (s.listing && !s.room) s.send(msg);
    }, LIST_THROTTLE_MS);
  }

  // ------------------------------------------------------------ upkeep

  /** Rooms and seats nobody uses go; a playing room whose game emptied returns to waiting. */
  gc(now = Date.now()): void {
    for (const room of [...this.rooms.values()]) {
      try {
        this.collect(room, now);
      } catch (err) {
        // one room's bad state stays in that room: this runs on the primary, where an uncaught
        // throw ends every connection on the server
        log.error({ room: room.code, err }, "party gc failed");
      }
    }
    this.listChanged();
  }

  private collect(room: PartyRoom, now: number): void {
    const inGame = room.state === "playing" ? this.games.players(room) : 0;
    // seats of people inside the game are kept for as long as the game runs,
    // and their away clock starts only once it has emptied
    if (inGame > 0) room.touchAway(now);
    else room.expire(now);
    if (room.reassignAbsentHost(now)) room.sync();
    if (room.size === 0) {
      this.drop(room);
      return;
    }
    if (room.state === "playing" && inGame === 0) {
      const since = this.idleSince.get(room.code) ?? now;
      this.idleSince.set(room.code, since);
      if (now - since >= IDLE_GAME_MS) {
        room.stop();
        this.idleSince.delete(room.code);
        room.sync();
      }
    } else {
      this.idleSince.delete(room.code);
    }
  }

  private drop(room: PartyRoom): void {
    room.close();
    this.rooms.delete(room.code);
    this.roomOwner.delete(room.code);
    this.idleSince.delete(room.code);
    log.info({ room: room.code }, "party room closed");
  }

  private heartbeat(): void {
    for (const s of this.sockets) {
      if (!s.alive) {
        s.close("heartbeat");
        continue;
      }
      s.ping();
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** Is there a room under this code? (The games open a party world only for a real room.) */
  has(code: string): boolean {
    return this.rooms.has(code);
  }

  /** Is `name` seated in room `code`? A party world admits only its own members, so nobody
   *  can take a member's name in the game first, and a kicked player cannot walk back in. */
  isMember(code: string, name: string): boolean {
    return this.rooms.get(code)?.hasMember(name) ?? false;
  }

  /** Called (synchronously) whenever rooms or seats may have changed. Set by the cluster primary. */
  onRosterChange: (() => void) | null = null;

  /** Every room and its seated names, for the game shards' `has`/`isMember` mirror. */
  roster(): [code: string, names: string[]][] {
    return [...this.rooms.values()].map((r) => [r.code, r.memberNames()]);
  }

  room(code: string): PartyRoom | undefined {
    return this.rooms.get(code);
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    if (this.listTimer) clearTimeout(this.listTimer);
    // rooms live in memory only: a deploy ends them. Say so instead of leaving pages hanging.
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
    for (const s of this.sockets) s.close("server shutdown");
    this.sockets.clear();
  }
}
