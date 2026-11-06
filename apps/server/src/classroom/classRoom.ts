import { FurnitureLayout, type PlacementWorld } from "@robo/shared/furniture/layout";
import type { PlacedFurniture } from "@robo/shared/furniture/types";
import { holdsFurniture, holdsWaterlog, seatLayout, shapeSeal, type ClassWet, type FluidChange } from "@robo/shared";
import type { RustModule } from "@robo/engine/node";
import { randomBytes, randomUUID } from "node:crypto";
import {
  BONK_COOLDOWN_MS,
  BONK_REACH,
  BONK_SERVER_SLACK,
  CLASS_MAX_STUDENTS,
  CLASS_MAX_COORD,
  CLASS_MAX_Y,
  bonkBlocked,
  BONK_TARGET_REST_MS,
  bonkEye,
  pickBonk,
  FluidSim,
  classKey,
  isPlayerBlock,
  isWater,
  voxelCoordinates,
  voxelKey,
  type VoxelKey,
  type FluidWorld,
  type ClassClientMessage,
  type ClassEdit,
  type ClassFurniture,
  type ClassMember,
  type ClassRole,
  type ClassServerMessage,
  type ClassSettings,
  type ClassAnim,
  type CharacterId,
  type EmoteId,
} from "@robo/shared";
import { checkPassword, sameKey, type SavedClass } from "./classStore.js";

/** Anything that can receive messages — a socket in production, a stub in tests. */
export interface ClassPeer {
  send(msg: ClassServerMessage): void;
  /** An already-encoded s-k-snap (the room builds one string per player, not one object per
   *  recipient). Optional: peers without it get the object form. */
  sendSnap?(raw: string): void;
  streamWorld?(batches: Generator<ClassEdit[], void, unknown>, count: number): void;
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
/** Saved seats kept per class. Past it the longest-unused OFFLINE seat goes, so a class used
 *  for a whole year (or one kid trying forty names) never locks itself "full". */
const MAX_SAVED_SEATS = 200;
/** With fewer than two players there are no snapshots; send an empty one this often so a
 *  client can still tell a live link from a dead one (announced as `keepalive`). */
const KEEPALIVE_S = 2;
/** Players within this many metres get every snapshot (10 Hz); farther ones every SNAP_FAR_EVERY-th. */
const SNAP_NEAR_M = 48;
const SNAP_FAR_EVERY = 5;
type SnapPlayer = Extract<ClassServerMessage, { t: "s-k-snap" }>["players"][number];
const cm = (v: number) => Math.round(v * 100) / 100;

/**
 * When a move was MEASURED, on the server clock. With the sender's own stamp `ct`
 * the network's delay jitter drops out: arrival − ct is (clock offset + this packet's
 * delay), and its running minimum is the offset over the fastest packet; it may creep
 * up 0.5 ms per move to follow drift. Without `ct` (older clients) the arrival time.
 * Exported for the unit tests.
 */
export function moveTime(me: { ctOffset?: number; movedAt?: number }, ct: number | undefined, arrival: number): number {
  if (ct === undefined) return Math.round(arrival);
  const sample = arrival - ct;
  const offset = me.ctOffset === undefined || Math.abs(sample - me.ctOffset) > 5000 ? sample : Math.min(me.ctOffset + 0.5, sample);
  me.ctOffset = offset;
  // never earlier than the move before it (a reordered packet), never in the future
  return Math.round(Math.min(arrival, Math.max(ct + offset, (me.movedAt ?? 0) + 1)));
}

/**
 * One player's snapshot entry, small: positions to the centimetre and yaw to a
 * milliradian (the client interpolates anyway), and every presentation field
 * left out while it is at its default — the client reads a missing field as
 * that default (?? "none", ?? 0 …), so a plain walking robot is ~60 bytes.
 */
function compactSnap(m: Member): SnapPlayer {
  const p: SnapPlayer = { id: m.id, pos: [cm(m.pos![0]), cm(m.pos![1]), cm(m.pos![2])], yaw: Math.round(m.yaw * 1000) / 1000, anim: m.anim };
  if (m.movedAt !== undefined) p.at = m.movedAt;
  if (m.character && m.character !== "mascot") p.character = m.character;
  if (m.emote && m.emote !== "none") { p.emote = m.emote; p.emoteSeq = m.emoteSeq ?? 0; }
  if (m.action && m.action !== "none") { p.action = m.action; p.actionSeq = m.actionSeq ?? 0; if (m.actionLoop) p.actionLoop = true; }
  if (m.swimming) p.swimming = true;
  if (m.heldItem) { p.heldItem = m.heldItem; p.toolOption = m.toolOption ?? "balanced"; if (m.toolPhase) p.toolPhase = m.toolPhase; }
  return p;
}
/** A k-move this far from the last one is a jump (gather, respawn — or a forged position). */
const JUMP_M = 8;
/** After such a jump, taps from that player wait this long: a modified client cannot
 *  report itself beside a classmate, tap, and report itself back. */
const JUMP_BONK_HOLD_MS = 1500;

interface Member {
  id: string;
  name: string;
  role: ClassRole;
  /** Teacher: ownership proof. Student: seat re-claim after a dropped link. */
  key: string;
  peer: ClassPeer | null;
  pos: [number, number, number] | null;
  /** When `pos` was measured, on the server clock (ms): the time every client draws it at. */
  movedAt?: number;
  /** Server clock minus this sender's clock: the running minimum of (arrival − ct). */
  ctOffset?: number;
  /** The sender's stamp on the last accepted move. */
  lastCt?: number;
  yaw: number;
  anim: ClassAnim;
  character?: CharacterId;
  emote?: EmoteId;
  emoteSeq?: number;
  action?: "none" | "interact" | "place" | "hit";
  actionSeq?: number;
  actionLoop?: boolean;
  swimming?: boolean;
  heldItem?: "pickaxe-basic" | null;
  toolOption?: "balanced" | "light-grip" | "stone-focus" | "precise-tip";
  toolPhase?: number;
  /** Wall-clock ms of the last tap that connected. */
  bonkAt?: number;
  /** Server ms when this player was last shoved (BONK_TARGET_REST_MS). */
  shovedAt?: number;
  /** Wall-clock ms of the last position jump (see JUMP_M). */
  jumpedAt?: number;
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
  /** Compact coordinate → [block, shape]; only cells differing from the field. */
  private readonly edits = new Map<VoxelKey, [number, number]>();
  /** Compact coordinate → the water a shaped block holds (waterlog.ts). Pure flow state: never
   *  saved (a restored class re-flows it from the saved water) and cleared whenever its cell is written. */
  private readonly wet = new Map<VoxelKey, number>();
  /** Shared append log: joining peers retain a prefix length, not their own
   *  copy of every key. Periodic compaction bounds historical tombstones. */
  private editKeys: VoxelKey[] = [];
  private furniture = new FurnitureLayout();
  private settings: ClassSettings = { chatLocked: false, buildLocked: false };
  /** Wall-clock ms when the room last had nobody connected (null = occupied). */
  emptySince: number | null = null;
  closed = false;
  /** A party room's field (protocol/party.ts): never saved, gone once it empties. */
  ephemeral = false;
  /** Students online at once: a class's CLASS_MAX_STUDENTS, or the whole party room. */
  maxStudents = CLASS_MAX_STUDENTS;
  /** classKey(name) → ms until which that student name is refused. */
  private readonly banned = new Map<string, number>();
  /** Something worth saving changed since the last toSaved(). */
  dirty = false;
  /** Only the server's water moved since the last save. Flowing water changes cells every step,
   *  and rewriting the whole field every 15 s for it was the class store's biggest load, so
   *  ClassManager saves water-only changes on a slower clock (a deploy/close saves them anyway). */
  waterDirty = false;

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
    /** The Rust engine to run this class's water on (docs/ENGINE.md), or null for the TypeScript
     *  rules (the reference). ClassManager decides from FLUID_ENGINE. */
    opts: { rust?: RustModule | null } = {},
  ) {
    if (opts.rust) this.rust = new RustClassWater(opts.rust);
    // a class saved before named classes was keyed by its teacher's name
    this.roomName = roomName ?? saved?.roomName ?? teacherName;
    this.key = classKey(this.roomName);
    if (!saved) return;
    this.settings = saved.settings;
    this.furniture.load(saved.furniture);
    this.addMember(saved.teacherName, "teacher", saved.teacherKey);
    for (const s of saved.students) this.addMember(s.name, "student", s.key);
    for (const [x, y, z, block, shape] of saved.edits) {
      this.edits.set(voxelKey(x, y, z), [block, shape]);
      // A source can have been saved before its first flow step too.
      if (isWater(block)) this.fluidTouch(x, y, z);
    }
    this.rust?.load(saved.edits);
    this.editKeys = [...this.edits.keys()];
  }

  /**
   * The class's water. The SERVER runs the flow — the shared FluidSim over
   * this field — and sends what changed as ordinary edits, so every student
   * sees the same water and a late joiner gets it with the rest of the field.
   */
  private readonly fluid = new FluidSim();
  /** The same rules on the Rust core, over a mirror of `edits`/`wet`/furniture; null = TypeScript. */
  private rust: RustClassWater | null = null;
  /** Rust's changes are being written into our maps: they are in its mirror already. */
  private applyingRust = false;
  private fluidAtCapacity = false;

  /** Which rules run this class's water. */
  get fluidEngine(): "ts" | "rust" {
    return this.rust ? "rust" : "ts";
  }

  private fluidTouch(x: number, y: number, z: number): void {
    if (this.rust) this.rust.water.touch(x, y, z);
    else this.fluid.touch(x, y, z);
  }
  private fluidRescan: MapIterator<[VoxelKey, [number, number]]> | null = null;
  private fluidRescanLeft = 0;
  private readonly fluidWorld: FluidWorld = {
    get: (x, y, z) => {
      const key = voxelKey(x, y, z), edit = this.edits.get(key);
      if (!edit) return pristine(y);
      return holdsWaterlog(edit[0], edit[1]) ? this.wet.get(key) ?? 0 : edit[0];
    },
    seal: (x, y, z) => {
      const edit = this.edits.get(voxelKey(x, y, z));
      return edit && holdsWaterlog(edit[0], edit[1]) ? shapeSeal(edit[1]) : 0;
    },
    open: (x, y, z) =>
      Math.abs(x) <= CLASS_MAX_COORD && Math.abs(z) <= CLASS_MAX_COORD &&
      y >= 1 && y <= CLASS_MAX_Y && !this.furniture.occupied(x, y, z) &&
      // a full store takes no new cells — water included
      (this.edits.has(voxelKey(x, y, z)) || this.hasFluidCapacity()),
    set: (x, y, z, block) => {
      const cell = voxelKey(x, y, z), edit = this.edits.get(cell);
      if (edit && holdsWaterlog(edit[0], edit[1])) { // water inside a shaped block: no new cell
        if (block) this.wet.set(cell, block);
        else this.wet.delete(cell);
        return;
      }
      // A step reads all candidates before writing them. Several candidates
      // may have seen the same last slot, so enforce the cap at commit too.
      if (block !== pristine(y) && !this.edits.has(cell) && !this.hasFluidCapacity()) return false;
      this.writeEdit(cell, block === pristine(y) ? null : [block, 0]);
    },
  };

  private hasFluidCapacity(): boolean {
    if (this.edits.size < MAX_EDITS) return true;
    this.fluidAtCapacity = true;
    return false;
  }

  /** One flow step (ClassManager calls this every FLUID_STEP). Returns the
   *  number of cells that changed. */
  stepFluids(maxMs = 6): number {
    if (this.edits.size >= MAX_EDITS && this.fluidRescan) {
      // Do not retain a paused Map iterator (and old hash tables) while a
      // full classroom repeatedly replaces cells. Restart after space opens.
      this.fluidRescan = null; this.fluidAtCapacity = true;
    }
    if (this.edits.size < MAX_EDITS) {
      if (this.fluidAtCapacity && !this.fluidRescan) {
        this.fluidAtCapacity = false;
        this.fluidRescan = this.edits.entries();
        this.fluidRescanLeft = this.edits.size;
      }
      const start = performance.now(); let visited = 0, activated = 0;
      while (this.fluidRescan && visited < 4096 && activated < 256) {
        const next = this.fluidRescan.next();
        if (next.done || this.fluidRescanLeft-- <= 0) { this.fluidRescan = null; break; }
        const [cell, [block]] = next.value;
        if (isWater(block)) { this.fluidTouch(...voxelCoordinates(cell)); activated++; }
        if (++visited % 32 === 0 && performance.now() - start >= 1) break;
      }
    }
    const changes = this.rust ? this.stepRust(maxMs) : this.fluid.busy ? this.fluid.step(this.fluidWorld, maxMs) : [];
    if (changes.length === 0) return 0;
    const edits: ClassEdit[] = [], wet: ClassWet[] = [];
    for (const [x, y, z, block] of changes) {
      const edit = this.edits.get(voxelKey(x, y, z));
      if (edit && holdsWaterlog(edit[0], edit[1])) wet.push([x, y, z, block]);
      else edits.push([x, y, z, block, 0]);
    }
    // water inside shaped blocks is never saved: only real cell changes make a save worth writing
    if (edits.length > 0) this.waterDirty = true;
    for (let i = 0; i < edits.length; i += 500) {
      this.broadcast({ t: "s-k-edit", by: "", edits: edits.slice(i, i + 500) });
    }
    for (let i = 0; i < wet.length; i += 500) this.broadcast({ t: "s-k-wet", cells: wet.slice(i, i + 500) });
    return changes.length;
  }

  /** One step on the Rust core: its changes, written into our maps exactly as `fluidWorld.set`
   *  writes (it has already committed them, refusals included). A trapped module drops this class
   *  back onto the TypeScript rules, every water cell woken again. */
  private stepRust(maxMs: number): FluidChange[] {
    const rust = this.rust!;
    let flat: Int32Array;
    try {
      if (!rust.water.busy()) return [];
      rust.syncProps(this.furniture);
      flat = rust.water.step(maxMs); // the same soft time budget as the TypeScript step
      if (rust.water.take_at_capacity()) this.fluidAtCapacity = true;
    } catch (err) {
      this.onRustFailure?.(err);
      try { rust.water.free(); } catch { /* a trapped module may not even free */ }
      this.rust = null;
      this.fluidRescan = this.edits.entries();
      this.fluidRescanLeft = this.edits.size;
      return [];
    }
    const changes: FluidChange[] = [];
    this.applyingRust = true;
    try {
      for (let i = 0; i < flat.length; i += 4) {
        const x = flat[i]!, y = flat[i + 1]!, z = flat[i + 2]!, id = flat[i + 3]!;
        const cell = voxelKey(x, y, z), edit = this.edits.get(cell);
        if (edit && holdsWaterlog(edit[0], edit[1])) {
          if (id) this.wet.set(cell, id);
          else this.wet.delete(cell);
        } else this.writeEdit(cell, id === pristine(y) ? null : [id, 0]);
        changes.push([x, y, z, id]);
      }
    } finally {
      this.applyingRust = false;
    }
    return changes;
  }

  /** The class leaves memory: free its Rust water now (wasm memory is outside the JS heap and
   *  the finalizer runs whenever the GC gets to it). The room must not be used afterwards. */
  dispose(): void {
    const rust = this.rust;
    this.rust = null;
    this.fluid.clear();
    try { rust?.water.free(); } catch { /* already freed or trapped */ }
  }

  /** Called when the Rust core fails and the class falls back to TypeScript (ClassManager logs). */
  onRustFailure: ((err: unknown) => void) | null = null;

  /** Snapshot for the store; clears the dirty flag. */
  toSaved(): SavedClass {
    this.dirty = false;
    this.waterDirty = false;
    const teacher = [...this.members.values()].find((m) => m.role === "teacher");
    const edits: ClassEdit[] = [];
    for (const [cell, [block, shape]] of this.edits) {
      const [x, y, z] = voxelCoordinates(cell);
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

  /** Students connected right now — what the CLASS_MAX_STUDENTS cap is about (load), not the saved roster. */
  get studentCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === "student" && m.peer) n++;
    return n;
  }

  /** Does this key own the teacher seat? (A password lock never shuts out the teacher's own browser.) */
  ownsHostKey(hostKey: string): boolean {
    for (const m of this.members.values()) if (m.role === "teacher") return sameKey(hostKey, m.key);
    return false;
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
      const keyOk = !!cred.hostKey && sameKey(cred.hostKey, existing.key);
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
      if (existing.peer && !(seatKey && sameKey(seatKey, existing.key))) return "name-taken";
      if (existing.peer) {
        const old = existing.peer;
        this.byPeer.delete(old);
        existing.peer = null;
        // The close REASON "replaced" is what tells the old tab to stop: it must not reconnect
        // with the same seat key and take the seat back, round and round (ClassClient).
        old.close("replaced");
      }
      this.attach(existing, peer);
      return "ok";
    }
    if (this.studentCount >= this.maxStudents) return "class-full";
    this.pruneSeats();
    const student = this.addMember(name.trim(), "student");
    this.attach(student, peer);
    this.system(`${student.name} 학생이 들어왔어요`);
    return "ok";
  }

  /** Make room for one more saved seat: drop the oldest offline ones past MAX_SAVED_SEATS. */
  private pruneSeats(): void {
    let seats = 0;
    for (const m of this.members.values()) if (m.role === "student") seats++;
    for (const m of this.members.values()) {
      if (seats < MAX_SAVED_SEATS) return;
      if (m.role !== "student" || m.peer) continue;
      this.members.delete(m.id); // Map order is join order: the oldest seat goes first
      this.dirty = true;
      seats--;
    }
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

  /** The teacher's plots (F2 → 자리 배치): drawn by everyone, sent again to whoever joins. Lives
   *  with the room in memory (a lesson's arrangement, not part of the saved field). */
  private seating: { name: string; pos: [number, number, number]; yaw: number }[] | null = null;

  private attach(member: Member, peer: ClassPeer): void {
    member.peer = peer;
    // a new connection is a new page: its clock (ct) starts again near 0, so the old order
    // and offset mean nothing — kept, every move from the returning page was ignored and
    // classmates saw the character vanish
    member.lastCt = undefined;
    member.ctOffset = undefined;
    member.movedAt = undefined;
    this.byPeer.set(peer, member);
    this.emptySince = null;
    if (this.editKeys.length > this.edits.size * 2 + 4096) this.editKeys = [...this.edits.keys()];
    const keys = this.editKeys, count = peer.streamWorld ? keys.length : this.edits.size;
    peer.send({
      t: "s-k-welcome",
      you: member.id,
      role: member.role,
      room: this.roomName,
      teacher: this.teacherName,
      key: member.key,
      members: this.memberList(),
      settings: this.settings,
      editCount: count,
      furniture: this.furniture.toJSON(),
      keepalive: KEEPALIVE_S,
    });
    // Freeze membership, not 300k duplicate tuples. Values may change while a
    // slow client loads; reliable edits replay after its initial world arrives.
    if (peer.streamWorld) {
      peer.streamWorld(this.worldBatches(keys, count), count);
      this.sendWet(peer); // replayed after the streamed world, like any reliable update
      // always (an empty list when none): a reconnect after a deploy must drop fences this server never set
      peer.send({ t: "s-k-seats", seats: this.seating ?? [] });
      this.broadcastMembers();
      return;
    }
    // In-memory peers/tests consume the complete field synchronously.
    let batch: ClassEdit[] = [];
    for (const [cell, [block, shape]] of this.edits) {
      const [x, y, z] = voxelCoordinates(cell);
      batch.push([x, y, z, block, shape]);
      if (batch.length === WORLD_BATCH) {
        peer.send({ t: "s-k-world", edits: batch });
        batch = [];
      }
    }
    if (batch.length > 0) peer.send({ t: "s-k-world", edits: batch });
    this.sendWet(peer);
    peer.send({ t: "s-k-seats", seats: this.seating ?? [] });
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
        // an older measurement than the last one (cannot happen on one TCP socket, but a
        // retried send could): the newer position stands
        if (msg.ct !== undefined && me.lastCt !== undefined && msg.ct <= me.lastCt) break;
        if (msg.ct !== undefined) me.lastCt = msg.ct;
        if (me.pos && Math.hypot(msg.pos[0] - me.pos[0], msg.pos[1] - me.pos[1], msg.pos[2] - me.pos[2]) > JUMP_M) me.jumpedAt = Date.now();
        me.pos = msg.pos;
        me.movedAt = moveTime(me, msg.ct, performance.now()); // on the snapshot clock (ts): clients interpolate on it
        me.yaw = msg.yaw;
        me.anim = msg.anim;
        me.character = msg.character ?? "mascot";
        me.emote = msg.emote ?? "none";
        me.emoteSeq = msg.emoteSeq ?? 0;
        me.action=msg.action??"none";me.actionSeq=msg.actionSeq??0;me.actionLoop=msg.actionLoop??false;me.swimming=msg.swimming??false;
        me.heldItem=msg.heldItem??null;me.toolOption=msg.toolOption??"balanced";me.toolPhase=msg.toolPhase??0;
        return;
      case "k-edit":
        this.applyEdits(me, peer, msg.edits);
        return;
      case "k-furniture":
        this.placer = me;
        try { this.applyFurniture(me, peer, msg); } finally { this.placer = null; }
        return;
      case "k-chat": {
        if (me.role === "student" && this.settings.chatLocked) return;
        // control characters (newlines, bidi overrides…) never reach other screens
        // eslint-disable-next-line no-control-regex
        const text = msg.text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
        if (!text) return;
        this.broadcast({ t: "s-k-chat", from: me.id, name: me.name, role: me.role, text });
        return;
      }
      case "k-bonk":
        this.bonk(me, msg);
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
      case "k-arrange": {
        if (msg.clear) {
          // broadcast even when this server holds none: fences drawn before a deploy or a restart
          // (which this process never saw) must still come down for everyone
          const had = this.seating !== null;
          this.seating = null;
          this.broadcast({ t: "s-k-seats", seats: [] });
          if (had) this.system("선생님이 자리를 치웠어요");
          return;
        }
        // every online student gets a 15 × 20 plot of their own, side by side in front of the teacher
        // in name order (a class finds its places the same way every lesson); each one stands in
        // theirs facing the teacher, and everyone sees the fences and name signs
        if (!me.pos) return;
        // (at most 400: the s-k-seats schema's cap — far above any class's online students)
        const students = [...this.byPeer.values()].filter((m) => m.role === "student").sort((a, b) => a.name.localeCompare(b.name, "ko")).slice(0, 400);
        // the way the teacher LOOKS (sent with the request), not the body's heading: after walking
        // backwards the body faces the camera, and the plots would land behind the view
        const spots = seatLayout(students.length, me.pos, msg.yaw ?? me.yaw);
        students.forEach((m, i) => m.peer?.send({ t: "s-k-gather", pos: spots[i]!.pos, yaw: spots[i]!.yaw }));
        this.seating = students.map((m, i) => ({ name: m.name, pos: spots[i]!.pos, yaw: spots[i]!.yaw }));
        this.broadcast({ t: "s-k-seats", seats: this.seating });
        this.system(`선생님이 자리를 배치했어요 (${students.length}명)`);
        return;
      }
      case "k-settings":
        this.settings = { chatLocked: msg.chatLocked, buildLocked: msg.buildLocked, tapsLocked: msg.tapsLocked ?? this.settings.tapsLocked ?? false };
        this.dirty = true;
        this.broadcast({ t: "s-k-settings", settings: this.settings });
        return;
      case "k-end":
        this.close();
        return;
      case "k-reset-world":
        this.edits.clear();
        this.wet.clear();
        this.editKeys = [];
        this.fluidAtCapacity = false; this.fluidRescan = null;
        this.fluid.clear();
        this.rust?.water.reset();
        this.furniture.clear();
        this.dirty = true;
        this.broadcast({ t: "s-k-world-reset" });
        this.system("선생님이 들판을 새로 비웠어요");
        return;
    }
  }

  private applyEdits(me: Member, peer: ClassPeer, edits: ClassEdit[]): void {
    if (me.role === "student" && this.settings.buildLocked) {
      this.rejectEdits(peer, edits);
      peer.send({ t: "s-k-furniture", furniture: this.furniture.toJSON() });
      return;
    }
    const furnitureVersion = this.furniture.version;
    const accepted: ClassEdit[] = [];
    const refused: ClassEdit[] = [];
    const keptWater: ClassEdit[] = [];
    for (const edit of edits) {
      const [x, y, z, block, shape] = edit;
      const cell = voxelKey(x, y, z);
      // bedrock is unbreakable, and a full store takes no NEW cells
      // Solids are the shared catalog (ids past the water states included).
      // Flowing, falling and settled water stay simulation-owned.
      if (y === 0 || !isPlayerBlock(block) || (isWater(block) && shape !== 0) || (block !== 0 && this.furniture.blocksBlock(x, y, z)) || (!this.edits.has(cell) && this.edits.size >= MAX_EDITS)) {
        refused.push(edit);
        continue;
      }
      // mining a shaped block that held water leaves that water in the cell (the client does the same)
      const held = block === 0 ? this.wet.get(cell) ?? 0 : 0;
      this.writeEdit(cell, held ? [held, 0] : block === pristine(y) && shape === 0 ? null : [block, shape]);
      if (held) keptWater.push([x, y, z, held, 0]);
      accepted.push(edit);
      this.fluidTouch(x, y, z); // water around it may flow in, or drain
      if (block === 0) this.furniture.afterBlockRemoved(x, y, z, this.placementWorld);
    }
    if (refused.length > 0) this.rejectEdits(peer, refused);
    // A changed layout (a cascade under a mined block) goes to everyone. A refusal changed
    // nothing on the server: only the sender, whose optimistic cascade may need undoing,
    // gets the layout back — broadcasting ~100 KB to the class per refused brick was a flood.
    if (this.furniture.version !== furnitureVersion) this.broadcast({ t: "s-k-furniture", furniture: this.furniture.toJSON() });
    else if (refused.length > 0) peer.send({ t: "s-k-furniture", furniture: this.furniture.toJSON() });
    if (accepted.length === 0) return;
    this.dirty = true;
    for (const [other, member] of this.byPeer) {
      if (member !== me) other.send({ t: "s-k-edit", by: me.id, edits: accepted });
    }
    if (keptWater.length > 0) this.broadcast({ t: "s-k-edit", by: "", edits: keptWater });
  }

  /** Refusals carry the current cell, so a repeated write rolls back to the
   *  last accepted edit instead of the client's first ten-second-old value. */
  rejectEdits(peer: ClassPeer, edits: ClassEdit[]): void {
    if (!this.byPeer.has(peer)) return;
    peer.send({ t: "s-k-reject", authoritative: true, edits: edits.map<ClassEdit>(([x, y, z]) => {
      const [block, shape] = this.edits.get(voxelKey(x, y, z)) ?? [pristine(y), 0];
      return [x, y, z, block, shape];
    }) });
    // restoring a block clears its water on the client: give back what it holds
    const wet = edits.flatMap<ClassWet>(([x, y, z]) => {
      const water = this.wet.get(voxelKey(x, y, z));
      return water ? [[x, y, z, water]] : [];
    });
    if (wet.length > 0) peer.send({ t: "s-k-wet", cells: wet });
  }

  /** Every shaped block holding water, to a peer that just loaded the field. */
  private sendWet(peer: ClassPeer): void {
    let cells: ClassWet[] = [];
    for (const [key, water] of this.wet) {
      cells.push([...voxelCoordinates(key), water]);
      if (cells.length === WORLD_BATCH) { peer.send({ t: "s-k-wet", cells }); cells = []; }
    }
    if (cells.length > 0) peer.send({ t: "s-k-wet", cells });
  }

  /** Refused furniture (rate limit): the sender alone gets the layout back. */
  rejectFurniture(peer: ClassPeer): void {
    if (this.byPeer.has(peer)) peer.send({ t: "s-k-furniture", furniture: this.furniture.toJSON(), rejected: true });
  }

  /** Whose furniture change is being judged: their own body is checked by their client against
   *  their exact position, while ours is up to 100 ms old (a step out of the cell was refused). */
  private placer: Member | null = null;

  private readonly placementWorld: PlacementWorld = {
    // water holds nothing up: only a real block supports furniture
    isBlock: (x, y, z) => {
      const block = this.edits.get(voxelKey(x, y, z))?.[0] ?? pristine(y);
      return block !== 0 && !isWater(block);
    },
    isFloor: (x, y, z) => {
      const edit = this.edits.get(voxelKey(x, y, z)), block = edit?.[0] ?? pristine(y);
      return block !== 0 && !isWater(block) && holdsFurniture(edit?.[1] ?? 0);
    },
    hasBody: (x, y, z) => [...this.byPeer.values()].some((m) => m !== this.placer && m.pos !== null && ((pos) =>
      pos[0] + 0.3 > x && pos[0] - 0.3 < x + 1 &&
      pos[1] + 1.8 > y && pos[1] < y + 1 && pos[2] + 0.3 > z && pos[2] - 0.3 < z + 1)(m.pos)),
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
      for (const [cx, cy, cz] of next.cellsOf({ kind, x, y, z, rot })) this.fluidTouch(cx, cy, cz);
    this.dirty = true;
    this.broadcast({ t: "s-k-furniture", furniture: next.toJSON() });
  }

  /** A light tap. Positions already on the wire are the only ones trusted. */
  private bonk(me: Member, msg: Extract<ClassClientMessage, { t: "k-bonk" }>): void {
    if (!me.pos || this.settings.tapsLocked) return;
    const now = Date.now();
    if (now - (me.bonkAt ?? 0) < BONK_COOLDOWN_MS) return;
    if (now - (me.jumpedAt ?? 0) < JUMP_BONK_HOLD_MS) return; // just teleported: not trusted to be there yet
    const others = [];
    for (const other of this.byPeer.values()) {
      if (other === me || !other.pos) continue;
      others.push({ id: other.id, x: other.pos[0], y: other.pos[1], z: other.pos[2] });
    }
    const hit = pickBonk(
      { x: me.pos[0], y: me.pos[1], z: me.pos[2], yaw: msg.yaw, pitch: msg.pitch, eye: bonkEye(me.anim) },
      others,
      {
        reach: BONK_REACH + BONK_SERVER_SLACK,
        only: msg.target,
        blocked: (from, to) => bonkBlocked(from, to, (x, y, z) => this.bonkSolid(x, y, z)),
      },
    );
    if (!hit) return;
    me.bonkAt = now;
    // a player just shoved rests: the tap still lands (flash, sound), it pushes nothing
    const target = [...this.byPeer.values()].find((m) => m.id === hit.id);
    const resting = target !== undefined && now - (target.shovedAt ?? 0) < BONK_TARGET_REST_MS;
    if (target && !resting) target.shovedAt = now;
    this.broadcast({
      t: "s-k-bonk",
      by: me.id,
      target: hit.id,
      seq: msg.seq,
      vx: resting ? 0 : hit.vx,
      vz: resting ? 0 : hit.vz,
      vy: resting ? 0 : hit.vy,
      at: hit.at,
    });
  }

  /** Blocks and solid furniture stop a tap. Water does not. */
  private bonkSolid(x: number, y: number, z: number): boolean {
    if (y < 0 || y > CLASS_MAX_Y) return true;
    if (this.furniture.blocksBlock(x, y, z)) return true;
    const block = this.edits.get(voxelKey(x, y, z))?.[0] ?? pristine(y);
    return block !== 0 && !isWater(block);
  }

  private quietSnaps = 0;
  private snapTick = 0;

  /**
   * Positions of everyone connected; sent at the snapshot rate (and as a keepalive when alone).
   *
   * Scales to a 50-player party: each player is encoded ONCE per snapshot and each
   * recipient's message is a join of those strings (no per-recipient stringify of the
   * whole room); a recipient gets nobody's echo of itself; and players farther than
   * SNAP_NEAR_M arrive every SNAP_FAR_EVERY-th snapshot only — still far inside the
   * client's 3 s "gone" timeout, and invisible at that distance anyway.
   */
  snapshot(): void {
    const tick = ++this.snapTick;
    const entries: { m: Member; obj: SnapPlayer; json: string }[] = [];
    for (const m of this.byPeer.values()) {
      if (!m.pos) continue;
      const obj = compactSnap(m);
      entries.push({ m, obj, json: JSON.stringify(obj) });
    }
    if (entries.length < 2) {
      // nobody to show anybody — but a lone teacher still needs proof the link is alive
      if (++this.quietSnaps * 0.1 < KEEPALIVE_S) return;
    }
    this.quietSnaps = 0;
    const farTick = tick % SNAP_FAR_EVERY === 0;
    // the real moment, not tick × 100 ms: timers drift, and clients interpolate on this clock
    const ts = Math.round(performance.now());
    for (const [peer, me] of this.byPeer) {
      const picked = entries.filter(({ m }) => {
        if (m === me) return false;
        if (farTick || !me.pos || !m.pos) return true;
        const dx = m.pos[0] - me.pos[0], dz = m.pos[2] - me.pos[2];
        return dx * dx + dz * dz <= SNAP_NEAR_M * SNAP_NEAR_M;
      });
      if (peer.sendSnap) peer.sendSnap(`{"t":"s-k-snap","ts":${ts},"players":[${picked.map((e) => e.json).join(",")}]}`);
      else peer.send({ t: "s-k-snap", ts, players: picked.map((e) => e.obj) });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of this.byPeer.keys()) {
      peer.send({ t: "s-k-closed" });
      peer.close("class ended");
    }
    this.byPeer.clear();
    for (const member of this.members.values()) member.peer = null;
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

  private writeEdit(key: VoxelKey, value: [number, number] | null): void {
    this.wet.delete(key); // a written cell holds no water until the flow fills it again
    if (this.rust && !this.applyingRust) this.rust.wrote(key, value);
    if (value === null) { this.edits.delete(key); return; }
    if (!this.edits.has(key)) {
      if (this.editKeys.length >= MAX_EDITS * 2) this.editKeys = [...this.edits.keys()];
      this.editKeys.push(key);
    }
    this.edits.set(key, value);
  }

  private *worldBatches(keys: readonly VoxelKey[], count: number): Generator<ClassEdit[], void, unknown> {
    let batch: ClassEdit[] = [];
    for (let i = 0; i < count; i++) {
      const key = keys[i]!;
      const [x, y, z] = voxelCoordinates(key), [block, shape] = this.edits.get(key) ?? [pristine(y), 0];
      batch.push([x, y, z, block, shape]);
      if (batch.length === WORLD_BATCH) { yield batch; batch = []; }
    }
    if (batch.length) yield batch;
  }
}

/** Faces sealed per shape for Rust, or 255 for a shape that holds no water (waterlog.ts). */
function sealTable(): Uint8Array {
  const table = new Uint8Array(256).fill(255);
  for (let s = 0; s < 256; s++) if (holdsWaterlog(1, s)) table[s] = shapeSeal(s);
  return table;
}

/** A class's water on the Rust core: the wasm object and how its mirror is fed. */
class RustClassWater {
  readonly water: InstanceType<RustModule["WasmClassWater"]>;
  private propsVersion = -1;
  /** The layout last mirrored: ClassRoom REPLACES its layout on a furniture change, and a new
   *  object can carry the same version number as the old one. */
  private propsLayout: FurnitureLayout | null = null;

  constructor(engine: RustModule) {
    this.water = new engine.WasmClassWater(Uint8Array.from(FIELD_COLUMN), CLASS_MAX_COORD, CLASS_MAX_Y, MAX_EDITS, sealTable(), 4096);
  }

  load(edits: readonly ClassEdit[]): void {
    const flat = new Int32Array(edits.length * 5);
    for (let i = 0, o = 0; i < edits.length; i++, o += 5) {
      const e = edits[i]!;
      flat[o] = e[0]; flat[o + 1] = e[1]; flat[o + 2] = e[2]; flat[o + 3] = e[3]; flat[o + 4] = e[4];
    }
    this.water.write_many(flat);
  }

  wrote(key: VoxelKey, value: [number, number] | null): void {
    const [x, y, z] = voxelCoordinates(key);
    if (value) this.water.write(x, y, z, value[0], value[1]);
    else this.water.erase(x, y, z);
  }

  syncProps(furniture: FurnitureLayout): void {
    if (furniture === this.propsLayout && furniture.version === this.propsVersion) return;
    this.propsLayout = furniture;
    this.propsVersion = furniture.version;
    this.water.props(Int32Array.from(furniture.solidCells()));
  }
}
