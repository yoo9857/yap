import type { WebSocket } from "ws";
import {
  CLASS_PASSWORD_MIN,
  FLUID_STEP,
  CLASS_PROTOCOL_VERSION,
  classKey,
  claimedClassVersion,
  decodeClassClient,
  playerNameSchema,
  type ClassClientMessage,
  type ClassServerMessage,
} from "@robo/shared";
import { log } from "../log.js";
import { ClassRoom, type ClassPeer } from "./classRoom.js";
import { checkPassword, hashPassword, type ClassStore } from "./classStore.js";

const SNAPSHOT_MS = 100; // 10 Hz is plenty for walking robots
const HEARTBEAT_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
/** A class nobody is connected to survives this long (teacher's coffee break). */
const EMPTY_CLASS_TTL_MS = 30 * 60_000;
const MAX_BUFFERED = 1024 * 1024;
/** Changed classes are written to the store this often (and on end/exit). */
const SAVE_MS = 15_000;

/** Token buckets per message family. */
const LIMITS: Record<string, { rate: number; burst: number }> = {
  move: { rate: 30, burst: 60 },
  edit: { rate: 40, burst: 80 }, // dragging a tower of bricks is bursty
  chat: { rate: 1, burst: 4 },
  other: { rate: 5, burst: 10 },
};
const familyOf = (t: ClassClientMessage["t"]) =>
  t === "k-move" ? "move" : t === "k-edit" || t === "k-furniture" ? "edit" : t === "k-chat" ? "chat" : "other";

/** A WebSocket speaking the classroom protocol. */
class ClassSocket implements ClassPeer {
  alive = true;
  private closed = false;
  private strikes = 0;
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly ws: WebSocket,
    readonly from: string,
  ) {}

  send(msg: ClassServerMessage): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    // a snapshot can be skipped; anything else to a hopeless client ends it
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      if (msg.t === "s-k-snap") return;
      this.close("backpressure");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(1000, reason);
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

  strike(): false {
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
  private readonly sockets = new Set<ClassSocket>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(private readonly store: ClassStore) {
    this.timers.push(setInterval(() => this.snapshot(), SNAPSHOT_MS));
    this.timers.push(setInterval(() => this.saveDirty(), SAVE_MS));
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.gc(), 60_000));
    // water flows on the server, so a class's students all see the same stream
    this.timers.push(setInterval(() => {
      for (const room of this.classes.values()) room.stepFluids();
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
        // A furniture edit is optimistic: reconnect to restore the authoritative
        // layout rather than silently leaving a placement only this client sees.
        if (msg.t === "k-furniture") socket.close("furniture rate limit");
        return;
      }
      if (room) {
        room.handle(socket, msg);
        if (room.closed) this.retire(room);
        return;
      }
      if (msg.t === "k-peek") {
        if (msg.v !== CLASS_PROTOCOL_VERSION) return this.refuse(socket, "bad-version");
        clearTimeout(joinTimer);
        socket.send(this.peek(msg.room));
        socket.close("peeked");
        return;
      }
      if (msg.t !== "k-host" && msg.t !== "k-join") return;
      if (msg.v !== CLASS_PROTOCOL_VERSION) return this.refuse(socket, "bad-version");
      room = msg.t === "k-host" ? this.host(socket, msg) : this.join(socket, msg);
      if (room) clearTimeout(joinTimer);
    });
    ws.on("close", () => {
      clearTimeout(joinTimer);
      this.sockets.delete(socket);
      room?.leave(socket);
    });
    ws.on("error", (err) => log.warn({ from, err: err.message }, "class socket error"));
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
    const live = this.classes.get(key);
    // `open` must match what k-join will do: a loaded class takes students
    if (live) return { t: "s-k-room", room: live.roomName, exists: true, open: true, teacher: live.teacherName };
    const saved = this.store.load(key);
    if (saved) return { t: "s-k-room", room: saved.roomName ?? saved.teacherName, exists: true, open: false, teacher: saved.teacherName };
    return { t: "s-k-room", room: roomName.trim(), exists: false, open: false };
  }

  private host(socket: ClassSocket, msg: Extract<ClassClientMessage, { t: "k-host" }>): ClassRoom | null {
    const key = classKey(msg.room);
    const sameTeacher = (name: string) => classKey(name) === classKey(msg.teacher);
    let room = this.classes.get(key);
    if (room && !sameTeacher(room.teacherName)) return this.refuse(socket, "room-taken");
    if (!room) {
      const saved = this.store.load(key);
      if (saved) {
        // the class name is someone else's: say so, rather than "wrong password"
        if (!sameTeacher(saved.teacherName)) return this.refuse(socket, "room-taken");
        const keyOk = !!msg.hostKey && msg.hostKey === saved.teacherKey;
        const passOk = !!msg.password && checkPassword(msg.password, saved);
        if (!keyOk && !passOk) return this.refuse(socket, "bad-password");
        room = new ClassRoom(saved.teacherName, { passHash: saved.passHash, salt: saved.salt }, saved);
        log.info({ room: room.roomName, teacher: room.teacherName, edits: saved.edits.length, from: socket.from }, "class restored");
      } else {
        if (!msg.password || msg.password.length < CLASS_PASSWORD_MIN) return this.refuse(socket, "bad-password");
        const { hash, salt } = hashPassword(msg.password);
        const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
        room = new ClassRoom(tidy(msg.teacher), { passHash: hash, salt }, undefined, tidy(msg.room));
        log.info({ room: room.roomName, teacher: room.teacherName, from: socket.from }, "class opened");
      }
      this.classes.set(key, room);
    }
    const result = room.hostTeacher(socket, { hostKey: msg.hostKey, password: msg.password });
    if (result !== "ok") return this.refuse(socket, result);
    this.persist(room); // a new class exists in the store from its first second
    return room;
  }

  private join(socket: ClassSocket, msg: Extract<ClassClientMessage, { t: "k-join" }>): ClassRoom | null {
    if (!playerNameSchema.safeParse(msg.student).success) return this.refuse(socket, "bad-name");
    const room = this.classes.get(classKey(msg.room));
    if (!room) return this.refuse(socket, "no-class");
    const result = room.joinStudent(socket, msg.student, msg.seatKey);
    if (result !== "ok") return this.refuse(socket, result);
    return room;
  }

  private refuse(socket: ClassSocket, code: Extract<ClassServerMessage, { t: "s-k-error" }>["code"]): null {
    socket.send({ t: "s-k-error", code });
    socket.close(code);
    return null;
  }

  private snapshot(): void {
    for (const room of this.classes.values()) room.snapshot();
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
    for (const room of this.classes.values()) {
      if (room.closed || (room.emptySince !== null && now - room.emptySince > EMPTY_CLASS_TTL_MS)) {
        room.close();
        this.retire(room);
        log.info({ teacher: room.teacherName }, "class collected");
      }
    }
  }

  /** Save and unload a class; it can be re-opened from the store later. */
  private retire(room: ClassRoom): void {
    this.persist(room);
    this.classes.delete(room.key);
  }

  private persist(room: ClassRoom): void {
    try {
      this.store.save(room.key, room.toSaved());
    } catch (err) {
      room.dirty = true; // toSaved cleared it; retry a failed write next interval
      log.error({ teacher: room.teacherName, err }, "class save failed");
    }
  }

  private saveDirty(): void {
    for (const room of this.classes.values()) if (room.dirty) this.persist(room);
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    for (const room of this.classes.values()) {
      this.persist(room);
      room.close();
    }
    this.classes.clear();
    this.store.close();
  }
}
