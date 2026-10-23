import { FurnitureLayout, type PlacementWorld } from "@robo/shared/furniture/layout";
import type { PlacedFurniture } from "@robo/shared/furniture/types";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CLASS_MAX_STUDENTS,
  CLASS_MAX_COORD,
  CLASS_MAX_Y,
  FluidSim,
  WATER,
  classKey,
  isWater,
  type FluidWorld,
  type ClassClientMessage,
  type ClassEdit,
  type ClassFurniture,
  type ClassMember,
  type ClassRole,
  type ClassServerMessage,
  type ClassSettings,
} from "@robo/shared";
import { checkPassword, type SavedClass } from "./classStore.js";

/** Anything that can receive messages — a socket in production, a stub in tests. */
export interface ClassPeer {
  send(msg: ClassServerMessage): void;
  close(reason: string): void;
}

/** Block ids of the untouched field (craft/blocks.ts ids are persisted and
 *  never reordered, so they are safe to pin here): bedrock, dirt ×2, grass. */
const FIELD_COLUMN = [11, 2, 2, 1];
const pristine = (y: number) => FIELD_COLUMN[y] ?? 0;
/** Edits stored per class; past this the field refuses new cells. */
const MAX_EDITS = 300_000;
const WORLD_BATCH = 2000;
/** A removed student can't walk straight back in under the same name. */
const KICK_BAN_MS = 10 * 60_000;

interface Member {
  id: string;
  name: string;
  role: ClassRole;
  /** Teacher: ownership proof. Student: seat re-claim after a dropped link. */
  key: string;
  peer: ClassPeer | null;
  pos: [number, number, number] | null;
  yaw: number;
  anim: "idle" | "run" | "jump";
}

/**
 * One live class: a teacher, their students and the field they share.
 * Socket-free so the rules are unit-testable: callers hand in a ClassPeer and
 * route that peer's decoded messages to `handle`.
 */
export class ClassRoom {
  readonly key: string;
  private readonly members = new Map<string, Member>();
  private readonly byPeer = new Map<ClassPeer, Member>();
  /** "x,y,z" → [block, shape]; only cells that differ from the flat field. */
  private readonly edits = new Map<string, [number, number]>();
  private furniture = new FurnitureLayout();
  private settings: ClassSettings = { chatLocked: false, buildLocked: false };
  /** Wall-clock ms when the room last had nobody connected (null = occupied). */
  emptySince: number | null = null;
  closed = false;
  /** classKey(name) → ms until which that student name is refused. */
  private readonly banned = new Map<string, number>();
  /** Something worth saving changed since the last toSaved(). */
  dirty = false;

  /**
   * A brand-new class (`saved` omitted) or one restored from the store: the
   * field, the settings and every student's seat come back, all offline.
   */
  /** The class's name — what students type; `key` is its normalised form. */
  readonly roomName: string;

  constructor(
    readonly teacherName: string,
    private readonly auth: { passHash: string; salt: string },
    saved?: SavedClass,
    roomName?: string,
  ) {
    // a class saved before named classes was keyed by its teacher's name
    this.roomName = roomName ?? saved?.roomName ?? teacherName;
    this.key = classKey(this.roomName);
    if (!saved) return;
    this.settings = saved.settings;
    this.furniture.load(saved.furniture);
    this.addMember(saved.teacherName, "teacher", saved.teacherKey);
    for (const s of saved.students) this.addMember(s.name, "student", s.key);
    for (const [x, y, z, block, shape] of saved.edits) {
      this.edits.set(`${x},${y},${z}`, [block, shape]);
      // a stream saved mid-flow carries on (sources alone are always stable)
      if (isWater(block)) this.fluid.touch(x, y, z);
    }
  }

  /**
   * The class's water. The SERVER runs the flow — the shared FluidSim over
   * this field — and sends what changed as ordinary edits, so every student
   * sees the same water and a late joiner gets it with the rest of the field.
   */
  private readonly fluid = new FluidSim();
  private readonly fluidWorld: FluidWorld = {
    get: (x, y, z) => this.edits.get(`${x},${y},${z}`)?.[0] ?? pristine(y),
    open: (x, y, z) =>
      Math.abs(x) <= CLASS_MAX_COORD && Math.abs(z) <= CLASS_MAX_COORD &&
      y >= 1 && y <= CLASS_MAX_Y && !this.furniture.occupied(x, y, z) &&
      // a full store takes no new cells — water included
      (this.edits.has(`${x},${y},${z}`) || this.edits.size < MAX_EDITS),
    set: (x, y, z, block) => {
      const cell = `${x},${y},${z}`;
      if (block === pristine(y)) this.edits.delete(cell);
      else this.edits.set(cell, [block, 0]);
    },
  };

  /** One flow step (ClassManager calls this every FLUID_STEP). Returns the
   *  number of cells that changed. */
  stepFluids(): number {
    if (!this.fluid.busy) return 0;
    const changes = this.fluid.step(this.fluidWorld);
    if (changes.length === 0) return 0;
    this.dirty = true;
    const edits: ClassEdit[] = changes.map(([x, y, z, block]) => [x, y, z, block, 0]);
    for (let i = 0; i < edits.length; i += 500) {
      this.broadcast({ t: "s-k-edit", by: "", edits: edits.slice(i, i + 500) });
    }
    return changes.length;
  }

  /** Snapshot for the store; clears the dirty flag. */
  toSaved(): SavedClass {
    this.dirty = false;
    const teacher = [...this.members.values()].find((m) => m.role === "teacher");
    const edits: ClassEdit[] = [];
    for (const [cell, [block, shape]] of this.edits) {
      const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
      edits.push([x, y, z, block, shape]);
    }
    return {
      roomName: this.roomName,
      teacherName: this.teacherName,
      passHash: this.auth.passHash,
      salt: this.auth.salt,
      teacherKey: teacher?.key ?? "",
      students: [...this.members.values()].filter((m) => m.role === "student").map((m) => ({ name: m.name, key: m.key })),
      settings: this.settings,
      edits,
      furniture: this.furniture.toJSON(),
    };
  }

  get onlineCount(): number {
    return this.byPeer.size;
  }

  get studentCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === "student") n++;
    return n;
  }

  get editCount(): number {
    return this.edits.size;
  }

  get teacherOnline(): boolean {
    for (const m of this.members.values()) if (m.role === "teacher") return m.peer !== null;
    return false;
  }

  // ------------------------------------------------------------ entry

  /**
   * Seat the teacher. A class that already has a teacher seat is re-taken
   * with that seat's key (same browser) or the class password (any device).
   */
  hostTeacher(peer: ClassPeer, cred: { hostKey?: string; password?: string } = {}): "ok" | "teacher-taken" | "bad-password" {
    const existing = [...this.members.values()].find((m) => m.role === "teacher");
    if (existing) {
      if (existing.peer) return "teacher-taken";
      const keyOk = !!cred.hostKey && cred.hostKey === existing.key;
      const passOk = !!cred.password && checkPassword(cred.password, this.auth);
      if (!keyOk && !passOk) return "bad-password";
      this.attach(existing, peer);
      return "ok";
    }
    const teacher = this.addMember(this.teacherName, "teacher");
    this.attach(teacher, peer);
    return "ok";
  }

  joinStudent(peer: ClassPeer, name: string, seatKey?: string, now = Date.now()): "ok" | "name-taken" | "class-full" | "banned" {
    const wanted = classKey(name);
    if (wanted === classKey(this.teacherName)) return "name-taken"; // can't pose as the teacher
    if ((this.banned.get(wanted) ?? 0) > now) return "banned";
    const existing = [...this.members.values()].find((m) => m.role === "student" && classKey(m.name) === wanted);
    if (existing) {
      // a live seat is only taken over by its own key (same kid, new tab)
      if (existing.peer && seatKey !== existing.key) return "name-taken";
      if (existing.peer) {
        const old = existing.peer;
        this.byPeer.delete(old);
        existing.peer = null;
        old.close("replaced");
      }
      this.attach(existing, peer);
      return "ok";
    }
    if (this.studentCount >= CLASS_MAX_STUDENTS) return "class-full";
    const student = this.addMember(name.trim(), "student");
    this.attach(student, peer);
    this.system(`${student.name} 학생이 들어왔어요`);
    return "ok";
  }

  private addMember(name: string, role: ClassRole, key = randomBytes(16).toString("hex")): Member {
    this.dirty = true;
    const member: Member = {
      id: randomUUID().slice(0, 8),
      name,
      role,
      key,
      peer: null,
      pos: null,
      yaw: 0,
      anim: "idle",
    };
    this.members.set(member.id, member);
    return member;
  }

  private attach(member: Member, peer: ClassPeer): void {
    member.peer = peer;
    this.byPeer.set(peer, member);
    this.emptySince = null;
    peer.send({
      t: "s-k-welcome",
      you: member.id,
      role: member.role,
      room: this.roomName,
      teacher: this.teacherName,
      key: member.key,
      members: this.memberList(),
      settings: this.settings,
      editCount: this.edits.size,
      furniture: this.furniture.toJSON(),
    });
    // the shared field, in batches so no single frame is huge
    let batch: ClassEdit[] = [];
    for (const [cell, [block, shape]] of this.edits) {
      const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
      batch.push([x, y, z, block, shape]);
      if (batch.length === WORLD_BATCH) {
        peer.send({ t: "s-k-world", edits: batch });
        batch = [];
      }
    }
    if (batch.length > 0) peer.send({ t: "s-k-world", edits: batch });
    this.broadcastMembers();
  }

  /** The peer's connection closed. Its seat stays for a reconnect. */
  leave(peer: ClassPeer): void {
    const member = this.byPeer.get(peer);
    if (!member) return;
    this.byPeer.delete(peer);
    member.peer = null;
    if (this.byPeer.size === 0) this.emptySince = Date.now();
    this.broadcastMembers();
  }

  // ------------------------------------------------------------ messages

  handle(peer: ClassPeer, msg: ClassClientMessage): void {
    const me = this.byPeer.get(peer);
    if (!me || this.closed) return;
    switch (msg.t) {
      case "k-move":
        me.pos = msg.pos;
        me.yaw = msg.yaw;
        me.anim = msg.anim;
        return;
      case "k-edit":
        this.applyEdits(me, peer, msg.edits);
        return;
      case "k-furniture":
        this.applyFurniture(me, peer, msg);
        return;
      case "k-chat":
        if (me.role === "student" && this.settings.chatLocked) return;
        this.broadcast({ t: "s-k-chat", from: me.id, name: me.name, role: me.role, text: msg.text });
        return;
    }
    if (me.role !== "teacher") return; // everything below is the teacher's
    switch (msg.t) {
      case "k-kick": {
        const target = this.members.get(msg.playerId);
        if (!target || target.role !== "student") return;
        this.members.delete(target.id);
        this.dirty = true;
        this.banned.set(classKey(target.name), Date.now() + KICK_BAN_MS);
        if (target.peer) {
          this.byPeer.delete(target.peer);
          target.peer.send({ t: "s-k-kicked" });
          target.peer.close("kicked");
        }
        this.system(`${target.name} 학생이 수업에서 나갔어요`);
        this.broadcastMembers();
        return;
      }
      case "k-gather":
        if (me.pos) {
          for (const m of this.byPeer.values()) {
            if (m.role === "student") m.peer?.send({ t: "s-k-gather", pos: me.pos });
          }
        }
        return;
      case "k-settings":
        this.settings = { chatLocked: msg.chatLocked, buildLocked: msg.buildLocked };
        this.dirty = true;
        this.broadcast({ t: "s-k-settings", settings: this.settings });
        return;
      case "k-end":
        this.close();
        return;
      case "k-reset-world":
        this.edits.clear();
        this.fluid.clear();
        this.furniture.clear();
        this.dirty = true;
        this.broadcast({ t: "s-k-world-reset" });
        this.system("선생님이 들판을 새로 비웠어요");
        return;
    }
  }

  private applyEdits(me: Member, peer: ClassPeer, edits: ClassEdit[]): void {
    if (me.role === "student" && this.settings.buildLocked) {
      peer.send({ t: "s-k-reject", edits });
      peer.send({ t: "s-k-furniture", furniture: this.furniture.toJSON() });
      return;
    }
    const furnitureVersion = this.furniture.version;
    const accepted: ClassEdit[] = [];
    const refused: ClassEdit[] = [];
    for (const edit of edits) {
      const [x, y, z, block, shape] = edit;
      const cell = `${x},${y},${z}`;
      // bedrock is unbreakable, and a full store takes no NEW cells
      if (y === 0 || block > WATER || (isWater(block) && shape !== 0) || (block !== 0 && this.furniture.blocksBlock(x, y, z)) || (!this.edits.has(cell) && this.edits.size >= MAX_EDITS)) {
        refused.push(edit);
        continue;
      }
      if (block === pristine(y) && shape === 0) this.edits.delete(cell);
      else this.edits.set(cell, [block, shape]);
      accepted.push(edit);
      this.fluid.touch(x, y, z); // water around it may flow in, or drain
      if (block === 0) this.furniture.afterBlockRemoved(x, y, z, this.placementWorld);
    }
    if (refused.length > 0) peer.send({ t: "s-k-reject", edits: refused });
    if (refused.length > 0 || this.furniture.version !== furnitureVersion)
      this.broadcast({ t: "s-k-furniture", furniture: this.furniture.toJSON() });
    if (accepted.length === 0) return;
    this.dirty = true;
    for (const [other, member] of this.byPeer) {
      if (member !== me) other.send({ t: "s-k-edit", by: me.id, edits: accepted });
    }
  }

  private readonly placementWorld: PlacementWorld = {
    // water holds nothing up: only a real block supports furniture
    isBlock: (x, y, z) => {
      const block = this.edits.get(`${x},${y},${z}`)?.[0] ?? pristine(y);
      return block !== 0 && !isWater(block);
    },
    hasBody: (x, y, z) => [...this.byPeer.values()].some(({ pos }) => pos !== null &&
      pos[0] + 0.3 > x && pos[0] - 0.3 < x + 1 &&
      pos[1] + 1.8 > y && pos[1] < y + 1 && pos[2] + 0.3 > z && pos[2] - 0.3 < z + 1),
  };

  /** Validate a complete transaction on a copy: conflicting edits never half-apply. */
  private applyFurniture(me: Member, peer: ClassPeer, msg: Extract<ClassClientMessage, { t: "k-furniture" }>): void {
    const reject = () => peer.send({ t: "s-k-furniture", furniture: this.furniture.toJSON(), rejected: true });
    if (me.role === "student" && this.settings.buildLocked) return reject();
    if (msg.placed.length + msg.removed.length === 0) return;
    const next = new FurnitureLayout();
    next.load(this.furniture.toJSON());
    const same = (p: PlacedFurniture, t: ClassFurniture) => p.kind === t[0] && p.x === t[1] &&
      p.y === t[2] && p.z === t[3] && p.rot === t[4] && p.variant === t[5] && (p.state ?? 0) === (t[6] ?? 0);
    // Check every removal against the original before cascades remove table-top pieces.
    if (msg.removed.some((t) => !this.furniture.all().some((p) => same(p, t)))) return reject();
    for (const t of msg.removed) {
      const live = next.all().find((p) => same(p, t));
      if (live) next.remove(live);
    }
    // A door state change keeps its existing support (one surviving leg is enough).
    for (const t of msg.placed) {
      const [kind, x, y, z, rot, variant, state] = t;
      const item: PlacedFurniture = { kind, x, y, z, rot, variant };
      if (state === 1) item.state = 1;
      const previous = msg.removed.find((r) => r.slice(0, 6).every((v, i) => v === t[i]));
      if (previous && (previous[6] ?? 0) !== (state ?? 0)) {
        const original = this.furniture.all().find((p) => same(p, previous))!;
        const toggleCheck = new FurnitureLayout();
        toggleCheck.add(original);
        if (toggleCheck.toggle(toggleCheck.all()[0]!, this.placementWorld) !== "ok" || !next.add(item)) return reject();
      } else if (!next.canPlace(item, this.placementWorld) || !next.add(item)) return reject();
    }
    this.furniture = next;
    for (const [kind, x, y, z, rot] of [...msg.placed, ...msg.removed])
      for (const [cx, cy, cz] of next.cellsOf({ kind, x, y, z, rot })) this.fluid.touch(cx, cy, cz);
    this.dirty = true;
    this.broadcast({ t: "s-k-furniture", furniture: next.toJSON() });
  }

  /** Positions of everyone connected; sent at the snapshot rate. */
  snapshot(): void {
    const players = [];
    for (const m of this.byPeer.values()) {
      if (m.pos) players.push({ id: m.id, pos: m.pos, yaw: m.yaw, anim: m.anim });
    }
    if (players.length < 2) return; // nobody to show anybody
    this.broadcast({ t: "s-k-snap", players });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of this.byPeer.keys()) {
      peer.send({ t: "s-k-closed" });
      peer.close("class ended");
    }
    this.byPeer.clear();
    this.emptySince = Date.now();
  }

  // ------------------------------------------------------------ helpers

  private memberList(): ClassMember[] {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, role: m.role, online: m.peer !== null }));
  }

  private broadcastMembers(): void {
    this.broadcast({ t: "s-k-members", members: this.memberList() });
  }

  private system(text: string): void {
    this.broadcast({ t: "s-k-chat", from: "", name: this.teacherName, role: "teacher", text, system: true });
  }

  private broadcast(msg: ClassServerMessage): void {
    for (const peer of this.byPeer.keys()) peer.send(msg);
  }
}
