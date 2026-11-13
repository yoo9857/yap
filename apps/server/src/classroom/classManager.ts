import type { WebSocket } from "ws";
import { PARTY_MAX_PLAYERS, partyCodeSchema } from "@robo/shared";
import {
  CLASS_PASSWORD_MIN,
  FLUID_STEP,
  CLASS_PROTOCOL_VERSION,
  classKey,
  claimedClassVersion,
  decodeClassClient,
  playerNameSchema,
  type ClassClientMessage,
  type ClassEdit,
  type ClassServerMessage,
} from "@robo/shared";
import { log } from "../log.js";
import { ClassRoom, type ClassPeer } from "./classRoom.js";
import { loadRustEngineSync, type RustModule } from "@robo/engine/node";

/** FLUID_ENGINE=rust runs every class's water on the Rust core (docs/ENGINE.md); anything else, or
 *  an engine that fails to load, keeps the TypeScript rules — the same water. Decided once. */
let classWater: RustModule | null | undefined;
export function classWaterEngine(): RustModule | null {
  if (classWater !== undefined) return classWater;
  classWater = null;
  if (process.env.FLUID_ENGINE === "rust") {
    try {
      classWater = loadRustEngineSync();
      log.info("class water runs on the Rust engine");
    } catch (err) {
      log.warn({ err }, "FLUID_ENGINE=rust but the Rust engine did not load: class water stays on TypeScript");
    }
  }
  return classWater;
}

/** A failing Rust core drops that class back to TypeScript; say so in the log. */
function withWater(room: ClassRoom): ClassRoom {
  room.onRustFailure = (err) => log.error({ err, room: room.roomName }, "class water: Rust engine failed, this class continues on TypeScript");
  return room;
}
import { checkPassword, hashPassword, sameKey, type ClassStore } from "./classStore.js";

const SNAPSHOT_MS = 100; // 10 Hz is plenty for walking robots
const SNAPSHOT_SLICE_MS = 4;
const HEARTBEAT_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
/** A class nobody is connected to survives this long (teacher's coffee break). */
const EMPTY_CLASS_TTL_MS = 30 * 60_000;
/** Party fields are named \`party:CODE\` (see protocol/party.ts partyFieldName). */
const PARTY_PREFIX = "party:";
/** The party field's "teacher": nobody sits in it; a name no player can type. */
const PARTY_HOST_NAME = "🎮";
const MAX_PARTY_FIELDS = 300;
/** An empty party field goes after 5 minutes (it is never saved, so there is nothing to keep). */
const EMPTY_PARTY_TTL_MS = 5 * 60_000;
const MAX_BUFFERED = 1024 * 1024;
const STREAM_BUFFERED = 256 * 1024;
const streamQueue = new Set<ClassSocket>();
let streamTimer: NodeJS.Timeout | null = null;
/** All initial field transfers share the same CPU budget, including different
 *  classrooms. Requeued transports go behind those not visited this round. */
function scheduleStreams(): void {
  if (streamTimer || streamQueue.size === 0) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    const start = performance.now();
    for (const socket of [...streamQueue]) {
      streamQueue.delete(socket); socket.pump();
      if (performance.now() - start >= 8) break;
    }
    scheduleStreams();
  }, 16);
}
/** Wrong class passwords: after this many, the class refuses every attempt for a while (doubling, capped). */
const PASSWORD_TRIES = 5;
const PASSWORD_LOCK_MS = 60_000;
const PASSWORD_LOCK_MAX_MS = 15 * 60_000;
/** Changed classes are written to the store this often (and on end/exit). */
const SAVE_MS = 15_000;
/** Water-only changes (see ClassRoom.waterDirty) are saved at most this often. */
const WATER_SAVE_MS = 120_000;

/** Strikes forgiven per second: a flood (hundreds a second) still closes the socket within a
 *  second or two, steady play that sometimes trips a bucket never does. */
const STRIKE_DECAY_PER_S = 2;

/** Token buckets per message family. */
const LIMITS: Record<string, { rate: number; burst: number }> = {
  move: { rate: 30, burst: 60 },
  edit: { rate: 40, burst: 80 }, // dragging a tower of bricks is bursty
  chat: { rate: 1, burst: 4 },
  bonk: { rate: 4, burst: 6 }, // a tap is a click, not a stream
  // each accepted change sends the whole layout to the class, so furniture gets its own, slower
  // bucket than bricks (a held-click pickup is a few per second)
  furniture: { rate: 8, burst: 20 },
  // power plants: a held right button fits about three pieces a second
  plant: { rate: 6, burst: 12 },
  other: { rate: 5, burst: 10 },
};
const familyOf = (t: ClassClientMessage["t"]) =>
  t === "k-move" ? "move" : t === "k-edit" ? "edit" : t === "k-furniture" ? "furniture" : t === "k-chat" ? "chat" : t === "k-bonk" ? "bonk" : t === "k-plant" ? "plant" : "other";

/** A WebSocket speaking the classroom protocol. */
class ClassSocket implements ClassPeer {
  alive = true;
  private closed = false;
  private strikes = 0;
  private strikeAt = Date.now();
  private stream: Generator<ClassEdit[], void, unknown> | null = null;
  private readonly outbound: string[] = [];
  private queuedBytes = 0;
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly ws: WebSocket,
    readonly from: string,
  ) {}

  /** A pre-encoded snapshot: dropped (not queued) while the link is busy, like any snapshot. */
  sendSnap(raw: string): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.stream || this.outbound.length || this.ws.bufferedAmount >= STREAM_BUFFERED) return;
    this.ws.send(raw);
  }

  send(msg: ClassServerMessage): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (msg.t === "s-k-closed" || msg.t === "s-k-kicked" || msg.t === "s-k-error") {
      this.release(); this.ws.send(JSON.stringify(msg)); return;
    }
    if (msg.t === "s-k-snap" && (this.stream || this.outbound.length || this.ws.bufferedAmount >= STREAM_BUFFERED)) return;
    const raw = JSON.stringify(msg);
    if (!this.outbound.length && this.ws.bufferedAmount < STREAM_BUFFERED) { this.ws.send(raw); return; }
    const bytes = Buffer.byteLength(raw);
    if (this.queuedBytes + bytes > MAX_BUFFERED) { this.close("backpressure"); return; }
    this.outbound.push(raw); this.queuedBytes += bytes; this.schedulePump();
  }

  streamWorld(batches: Generator<ClassEdit[], void, unknown>, count: number): void {
    this.stream?.return(); this.stream = batches;
    if (count > 2000) this.schedulePump();
    else this.pump();
  }

  private schedulePump(): void {
    if (!this.closed) { streamQueue.add(this); scheduleStreams(); }
  }

  pump(): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) { this.release(); return; }
    const start = performance.now();
    while (this.ws.bufferedAmount < STREAM_BUFFERED) {
      const queued = this.outbound.shift();
      if (queued !== undefined) { this.queuedBytes -= Buffer.byteLength(queued); this.ws.send(queued); }
      else if (this.stream) {
        const next = this.stream.next();
        if (next.done) { this.stream = null; break; }
        this.ws.send(JSON.stringify({ t: "s-k-world", edits: next.value } satisfies ClassServerMessage));
      } else break;
      if (performance.now() - start >= 2) break;
    }
    if (this.stream || this.outbound.length) this.schedulePump();
  }

  private release(): void {
    streamQueue.delete(this);
    if (streamQueue.size === 0 && streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    this.stream?.return(); this.stream = null;
    this.outbound.length = 0; this.queuedBytes = 0;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    try {
      if (reason === "heartbeat" || reason === "backpressure" || reason === "join timeout" || reason === "server shutdown") this.ws.terminate();
      else this.ws.close(1000, reason);
    } catch {
      this.ws.terminate();
    }
  }

  /** Rate-limit by family; true if the message may be processed. */
  allow(msg: ClassClientMessage): boolean {
    const family = familyOf(msg.t);
    const cfg = LIMITS[family]!;
    const now = Date.now();
    const b = this.buckets.get(family) ?? { tokens: cfg.burst, last: now };
    b.tokens = Math.min(cfg.burst, b.tokens + ((now - b.last) / 1000) * cfg.rate);
    b.last = now;
    this.buckets.set(family, b);
    if (b.tokens < 1) return this.strike();
    b.tokens -= 1;
    return true;
  }

  /** Over-limit and malformed messages. They wear off (STRIKE_DECAY_PER_S): counted for a whole
   *  session they added up over a long lesson of busy clicking and dropped the student mid-class. */
  strike(): false {
    const now = Date.now();
    this.strikes = Math.max(0, this.strikes - ((now - this.strikeAt) / 1000) * STRIKE_DECAY_PER_S);
    this.strikeAt = now;
    if (++this.strikes > 200) this.close("protocol violations");
    return false;
  }

  ping(): void {
    if (this.closed) return;
    this.alive = false;
    this.ws.ping();
  }
}

/**
 * Every live class, found by its CLASS name. A socket first says k-host
 * (teacher) or k-join (student); after that its messages go to its class.
 */
export class ClassManager {
  private readonly classes = new Map<string, ClassRoom>();
  /** When each loaded class was last written (water-only changes wait for WATER_SAVE_MS). */
  private readonly savedAt = new WeakMap<ClassRoom, number>();
  private readonly sockets = new Set<ClassSocket>();
  private readonly timers: NodeJS.Timeout[] = [];
  private snapshotContinuation: NodeJS.Immediate | null = null;
  private fluidCursor = 0;
  /** classKey → failed password attempts and the lock they earned. A 4-character password must not be guessable at socket speed. */
  /** Is `code` a live hub room? Set by the server; unset (tests) means any code. */
  partyGate: ((code: string) => boolean) | null = null;
  /** Is `name` seated in party room `code`? Set by the server; unset (tests) admits anyone. */
  partyMember: ((code: string, name: string) => boolean) | null = null;
  /** Does this process own the class under `key`? Set on a cluster shard; unset = owns everything. */
  owns: ((key: string) => boolean) | null = null;
  /** When each (class, timer kind) last logged a failure — a broken class every 100 ms is one line a minute. */
  private readonly faultLoggedAt = new Map<string, number>();
  private readonly passwordFails = new Map<string, { fails: number; lockedUntil: number; lockMs: number; lastFailAt: number }>();

  constructor(private readonly store: ClassStore) {
    classWaterEngine(); // decide (and log) the water engine at boot, not at the first lesson
    this.timers.push(setInterval(() => this.snapshot(), SNAPSHOT_MS));
    this.timers.push(setInterval(() => this.saveDirty(), SAVE_MS));
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.gc(), 60_000));
    // water flows on the server, so a class's students all see the same stream
    this.timers.push(setInterval(() => {
      const rooms = [...this.classes.values()], start = performance.now();
      let visited = 0;
      for (; visited < rooms.length; visited++) {
        const room = rooms[(this.fluidCursor + visited) % rooms.length]!;
        this.guard(room, "water", () => room.stepFluids(4));
        if (performance.now() - start >= 12) { visited++; break; }
      }
      // Busy rooms share the budget in turn; an early classroom cannot starve
      // later ones or monopolise the socket event loop every 250 ms.
      this.fluidCursor = rooms.length ? (this.fluidCursor + visited) % rooms.length : 0;
    }, FLUID_STEP * 1000));
  }

  accept(ws: WebSocket, from: string): void {
    const socket = new ClassSocket(ws, from);
    this.sockets.add(socket);
    let room: ClassRoom | null = null;
    const joinTimer = setTimeout(() => {
      if (!room) socket.close("join timeout");
    }, JOIN_TIMEOUT_MS);

    ws.on("pong", () => (socket.alive = true));
    ws.on("message", (data, isBinary) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const raw = isBinary ? null : data.toString();
      const msg = raw === null ? null : decodeClassClient(raw);
      if (!msg) {
        // an un-refreshed page speaking last version's entry message
        const claimed = room ? null : claimedClassVersion(raw);
        if (claimed !== null && claimed !== CLASS_PROTOCOL_VERSION) return void this.refuse(socket, "bad-version");
        socket.strike();
        return;
      }
      if (!socket.allow(msg)) {
        if (msg.t === "k-edit") room?.rejectEdits(socket, msg.edits);
        // A furniture edit is optimistic: send the sender the authoritative layout back
        // rather than silently leaving a placement only this client sees.
        if (msg.t === "k-furniture") room?.rejectFurniture(socket);
        if (msg.t === "k-plant") room?.rejectPlant(socket, msg.id);
        return;
      }
      // One bad message (or a store error) must cost one socket, never the whole server: an
      // uncaught throw here reaches process "uncaughtException", which shuts everything down.
      try {
        const activeRoom = room;
        if (activeRoom) {
          activeRoom.handle(socket, msg);
          if (activeRoom.closed) this.retire(activeRoom);
          return;
        }
        room = this.enter(socket, msg, joinTimer);
      } catch (err) {
        log.error({ from, t: msg.t, err }, "class message failed");
        if (!room) this.refuse(socket, "internal");
      }
    });
    ws.on("close", () => {
      socket.close("transport closed");
      clearTimeout(joinTimer);
      this.sockets.delete(socket);
      const prior = room; room = null;
      prior?.leave(socket);
    });
    ws.on("error", (err) => log.warn({ from, err: err.message }, "class socket error"));
  }

  /** A socket's first message: peek, host or join. Returns the class it entered. */
  private enter(socket: ClassSocket, msg: ClassClientMessage, joinTimer: NodeJS.Timeout): ClassRoom | null {
    // A class lives on exactly one shard. Only a page from before routing (no `room` in its
    // socket URL) can land elsewhere; "bad-version" makes it reload straight back into its class,
    // now routed. Answering here instead would open the class twice (two diverging fields).
    if ((msg.t === "k-peek" || msg.t === "k-host" || msg.t === "k-join") && this.owns && !this.owns(classKey(msg.room))) {
      return this.refuse(socket, "bad-version");
    }
    if (msg.t === "k-peek") {
      if (msg.v !== CLASS_PROTOCOL_VERSION) return this.refuse(socket, "bad-version");
      clearTimeout(joinTimer);
      socket.send(this.peek(msg.room));
      socket.close("peeked");
      return null;
    }
    if (msg.t !== "k-host" && msg.t !== "k-join") return null;
    if (msg.v !== CLASS_PROTOCOL_VERSION) return this.refuse(socket, "bad-version");
    const room = msg.t === "k-host" ? this.host(socket, msg) : this.join(socket, msg);
    if (room) clearTimeout(joinTimer);
    return room;
  }

  /**
   * Open a class: re-attach to a live one, restore a saved one (host key or
   * password), or create a new one (password required, stored hashed).
   */
  /**
   * Whose class is this, and can a student walk in? Live classes answer from
   * memory, saved ones from the store — a saved class exists but stays closed
   * until its teacher opens it again.
   */
  private peek(roomName: string): Extract<ClassServerMessage, { t: "s-k-room" }> {
    const key = classKey(roomName);
    const live = this.loaded(key);
    // `open` must match what k-join will do: a loaded class takes students
    if (live) return { t: "s-k-room", room: live.roomName, exists: true, open: true, teacher: live.teacherName, ...(live.theme !== "craft" ? { theme: live.theme } : {}) };
    // names only: an unauthenticated peek must not parse a whole saved field
    const saved = this.store.meta(key);
    if (saved) return { t: "s-k-room", room: saved.roomName ?? saved.teacherName, exists: true, open: false, teacher: saved.teacherName };
    return { t: "s-k-room", room: roomName.trim(), exists: false, open: false };
  }

  private host(socket: ClassSocket, msg: Extract<ClassClientMessage, { t: "k-host" }>): ClassRoom | null {
    const key = classKey(msg.room);
    // party fields are opened by the rooms, never by a teacher
    if (key.startsWith(PARTY_PREFIX)) return this.refuse(socket, "room-taken");
    const sameTeacher = (name: string) => classKey(name) === classKey(msg.teacher);
    let room = this.loaded(key);
    if (!room && this.classes.has(key)) return this.refuse(socket, "internal"); // closed, its save still failing
    if (room && !sameTeacher(room.teacherName)) return this.refuse(socket, "room-taken");
    // another lesson than the one this class is loaded for, and nobody in it: it is put away and
    // opened again from its save as the lesson picked now (the checks below are the same ones a
    // saved class always goes through). With people in it the running lesson stays.
    if (room && msg.theme && msg.theme !== room.theme && room.onlineCount === 0 && this.persist(room)) {
      this.unload(room);
      room = undefined;
    }
    if (!room) {
      const saved = this.store.load(key);
      if (saved) {
        // the class name is someone else's: say so, rather than "wrong password"
        if (!sameTeacher(saved.teacherName)) return this.refuse(socket, "room-taken");
        const keyOk = !!msg.hostKey && sameKey(msg.hostKey, saved.teacherKey);
        if (!keyOk && !this.tryPassword(key, () => !!msg.password && checkPassword(msg.password, saved))) return this.refuse(socket, "bad-password");
        room = withWater(new ClassRoom(saved.teacherName, { passHash: saved.passHash, salt: saved.salt }, saved, undefined, { rust: classWaterEngine(), theme: msg.theme }));
        log.info({ room: room.roomName, teacher: room.teacherName, theme: room.theme, edits: saved.edits.length, from: socket.from }, "class restored");
      } else {
        if (!msg.password || msg.password.length < CLASS_PASSWORD_MIN) return this.refuse(socket, "bad-password");
        const { hash, salt } = hashPassword(msg.password);
        const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
        room = withWater(new ClassRoom(tidy(msg.teacher), { passHash: hash, salt }, undefined, tidy(msg.room), { rust: classWaterEngine(), theme: msg.theme }));
        log.info({ room: room.roomName, teacher: room.teacherName, theme: room.theme, from: socket.from }, "class opened");
      }
      this.classes.set(key, room);
    }
    const live = room;
    // a locked class still takes its own host key (the teacher's browser), never a password
    const result = this.passwordLocked(key) && !(msg.hostKey && live.ownsHostKey(msg.hostKey))
      ? "bad-password"
      : live.hostTeacher(socket, { hostKey: msg.hostKey, password: msg.password });
    if (result === "bad-password") this.notePasswordFail(key);
    if (result !== "ok") return this.refuse(socket, result);
    this.passwordFails.delete(key);
    this.persist(room); // a new class exists in the store from its first second
    return room;
  }

  /** The live class under this key. A CLOSED one only stays in the map while its final save keeps
   *  failing; joining it would attach people to a dead room, so it is retried here and, once
   *  saved, unloaded (the caller then restores it from the store like any saved class). */
  private loaded(key: string): ClassRoom | undefined {
    const room = this.classes.get(key);
    if (!room?.closed) return room;
    if (this.persist(room)) this.unload(room);
    return undefined;
  }

  private passwordLocked(key: string): boolean {
    return (this.passwordFails.get(key)?.lockedUntil ?? 0) > Date.now();
  }

  /** Run a password check unless the class is locked; a wrong answer counts toward the lock. */
  private tryPassword(key: string, check: () => boolean): boolean {
    if (this.passwordLocked(key)) return false;
    if (check()) { this.passwordFails.delete(key); return true; }
    this.notePasswordFail(key);
    return false;
  }

  private notePasswordFail(key: string): void {
    const entry = this.passwordFails.get(key) ?? { fails: 0, lockedUntil: 0, lockMs: PASSWORD_LOCK_MS / 2, lastFailAt: 0 };
    entry.lastFailAt = Date.now();
    if (++entry.fails >= PASSWORD_TRIES) {
      entry.fails = 0;
      entry.lockMs = Math.min(PASSWORD_LOCK_MAX_MS, entry.lockMs * 2);
      entry.lockedUntil = Date.now() + entry.lockMs;
      log.warn({ room: key, lockMs: entry.lockMs }, "class password locked after repeated failures");
    }
    this.passwordFails.set(key, entry);
  }

  private join(socket: ClassSocket, msg: Extract<ClassClientMessage, { t: "k-join" }>): ClassRoom | null {
    if (!playerNameSchema.safeParse(msg.student).success) return this.refuse(socket, "bad-name");
    const room = this.loaded(classKey(msg.room)) ?? this.openParty(msg.room);
    if (!room) return this.refuse(socket, "no-class");
    // a party field admits the room's own members only (by the name they sit under)
    if (room.ephemeral && this.partyMember && !this.partyMember(room.roomName.slice(PARTY_PREFIX.length), msg.student)) {
      return this.refuse(socket, "no-class");
    } // a closed class waiting on its save counts as gone
    const result = room.joinStudent(socket, msg.student, msg.seatKey);
    if (result !== "ok") return this.refuse(socket, result);
    return room;
  }

  private refuse(socket: ClassSocket, code: Extract<ClassServerMessage, { t: "s-k-error" }>["code"]): null {
    socket.send({ t: "s-k-error", code });
    socket.close(code);
    return null;
  }

  /**
   * A party room's shared field (\`party:CODE\`), opened on first join: by the
   * room's start, a mid-game joiner, or a player reconnecting after a deploy
   * (the field starts empty again then — party fields live in memory only).
   * Null for anything that is not a well-formed party name, or past the cap.
   */
  openParty(name: string): ClassRoom | null {
    // exactly "party:" + a code — no spaces anywhere — and the key is rebuilt from the
    // validated code, so a look-alike name can never replace (orphan) a live field
    const trimmed = name.trim();
    if (trimmed.slice(0, PARTY_PREFIX.length).toLowerCase() !== PARTY_PREFIX) return null;
    const code = trimmed.slice(PARTY_PREFIX.length).toUpperCase();
    if (partyCodeSchema.safeParse(code).data !== code) return null;
    const key = classKey(`${PARTY_PREFIX}${code}`);
    const live = this.loaded(key);
    if (live) return live;
    // only for a room that exists: random codes cannot fill the cap
    if (this.partyGate && !this.partyGate(code)) return null;
    let parties = 0;
    for (const r of this.classes.values()) if (r.ephemeral) parties++;
    if (parties >= MAX_PARTY_FIELDS) return null;
    const room = withWater(new ClassRoom(PARTY_HOST_NAME, { passHash: "", salt: "" }, undefined, `${PARTY_PREFIX}${code}`, { rust: classWaterEngine() }));
    room.ephemeral = true;
    room.maxStudents = PARTY_MAX_PLAYERS;
    room.emptySince = Date.now(); // collected like any empty class if nobody ever arrives
    this.classes.set(room.key, room);
    log.info({ room: room.roomName }, "party field opened");
    return room;
  }

  /** People connected to a party room's field right now. */
  partyOnline(code: string): number {
    const room = this.classes.get(classKey(`${PARTY_PREFIX}${code}`));
    return room && !room.closed ? room.onlineCount : 0;
  }

  /** Is anything of the class under `key` in memory here — the class in any state (a closed one
   *  still awaiting its save counts) or its password-lock count? A cluster shard only gives a
   *  class back to the directory once this is false. */
  holds(key: string): boolean {
    // the wrong-password count lives here too: giving the route back while it is still counting
    // would let the next guess land on a shard with a clean slate and never reach the lock
    return this.classes.has(key) || this.passwordFails.has(key);
  }

  /** Live classes, party fields and the people in them (for /metrics). */
  stats(): { classes: number; partyFields: number; online: number; sockets: number } {
    let classes = 0, partyFields = 0, online = 0;
    for (const room of this.classes.values()) {
      if (room.closed) continue;
      if (room.ephemeral) partyFields++; else classes++;
      online += room.onlineCount;
    }
    return { classes, partyFields, online, sockets: this.sockets.size };
  }

  /** People online per party code in its field (the party hub's "is the game still running"). */
  partyCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const room of this.classes.values()) {
      if (!room.ephemeral || room.closed || room.onlineCount === 0) continue;
      out.set(room.roomName.slice(PARTY_PREFIX.length), room.onlineCount);
    }
    return out;
  }

  private snapshot(): void {
    if (this.snapshotContinuation) return;
    const rooms = [...this.classes.values()];
    let next = 0;
    const step = () => {
      this.snapshotContinuation = null;
      const start = performance.now();
      while (next < rooms.length) {
        const room = rooms[next++]!;
        if (!room.closed && this.classes.get(room.key) === room) {
          this.guard(room, "snapshot", () => room.snapshot());
        }
        // Give queued player input and other I/O a turn between busy rooms.
        if (next < rooms.length && performance.now() - start >= SNAPSHOT_SLICE_MS) {
          this.snapshotContinuation = setImmediate(step);
          return;
        }
      }
    };
    step();
  }

  /**
   * One class's timer work: a throw is logged (once a minute per class and kind) and stays in
   * that class. Uncaught it reached "uncaughtException", which shuts the process down and drops
   * every other class on it with the one that broke.
   */
  private guard(room: ClassRoom, what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      const key = `${room.key}|${what}`, now = Date.now();
      if (now - (this.faultLoggedAt.get(key) ?? 0) < 60_000) return;
      this.faultLoggedAt.set(key, now);
      if (this.faultLoggedAt.size > 1000) this.faultLoggedAt.clear();
      log.error({ teacher: room.teacherName, what, err }, "class timer failed");
    }
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

  private gc(): void {
    const now = Date.now();
    for (const [key, entry] of this.passwordFails) {
      // forget a class only after a quiet spell: dropping sub-threshold counts every minute let
      // 4 guesses per gc go on forever without ever reaching the lock
      if (entry.lockedUntil < now && now - entry.lastFailAt > PASSWORD_LOCK_MAX_MS) this.passwordFails.delete(key);
    }
    for (const room of [...this.classes.values()]) {
      const ttl = room.ephemeral ? EMPTY_PARTY_TTL_MS : EMPTY_CLASS_TTL_MS;
      if (room.closed || (room.emptySince !== null && now - room.emptySince > ttl)) {
        this.guard(room, "collect", () => {
          room.close();
          this.retire(room);
          log.info({ teacher: room.teacherName }, "class collected");
        });
      }
    }
  }

  /**
   * Save and unload a class; it can be re-opened from the store later. A class
   * whose save failed stays loaded (closed) so the 15 s save retries it —
   * unloading it would throw away everything since the last good write.
   */
  private retire(room: ClassRoom): void {
    if (this.persist(room)) this.unload(room);
  }

  /** Drop a saved class from memory, and free what it holds outside the JS heap (its Rust water). */
  private unload(room: ClassRoom): void {
    if (this.classes.get(room.key) === room) this.classes.delete(room.key);
    room.dispose();
  }

  private persist(room: ClassRoom): boolean {
    if (room.ephemeral) return true; // a party field is never written
    try {
      this.store.save(room.key, room.toSaved());
      this.savedAt.set(room, Date.now());
      return true;
    } catch (err) {
      room.dirty = true; // toSaved cleared it; retry a failed write next interval
      log.error({ teacher: room.teacherName, err }, "class save failed");
      return false;
    }
  }

  private saveDirty(): void {
    const now = Date.now();
    for (const room of [...this.classes.values()]) {
      if (!this.savedAt.has(room)) this.savedAt.set(room, now); // loaded/created since the last pass
      const due = room.dirty || (room.waterDirty && now - this.savedAt.get(room)! >= WATER_SAVE_MS);
      if (due && this.persist(room) && room.closed) this.unload(room); // a retire that failed earlier
    }
  }

  /**
   * Server going down (a deploy): save every class and drop the sockets WITHOUT
   * ending the classes. `room.close()` would send s-k-closed, which a client
   * takes as "the teacher ended the lesson" and never reconnects; a dropped
   * socket reconnects to the next server, where the teacher's host key re-opens
   * the class and students wait for it (see ClassClient's reconnect).
   */
  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    if (this.snapshotContinuation) clearImmediate(this.snapshotContinuation);
    this.snapshotContinuation = null;
    for (const room of this.classes.values()) this.persist(room);
    this.classes.clear();
    for (const socket of this.sockets) socket.close("server shutdown");
    this.sockets.clear();
    this.store.close();
  }
}
