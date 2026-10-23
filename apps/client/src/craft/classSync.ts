import type { FurnitureLayout } from "./furniture/layout.js";
import * as THREE from "three";
import type { ClassEdit, ClassMember, ClassSettings } from "@robo/shared";
import { CharacterRig, disposeRig } from "../player/rig.js";
import type { ClassClient, ClassSession } from "../net/classClient.js";
import { ClassHud } from "./classHud.js";
import type { FieldWindow } from "./fieldWorld.js";
import type { VoxelView } from "./voxelView.js";

const MOVE_HZ = 10;
/** Sent edits are remembered this long, so a refusal can be undone locally. */
const PENDING_MS = 10_000;

interface Remote {
  rig: CharacterRig;
  /** Latest reported position, absolute field coordinates. */
  target: THREE.Vector3;
  /** Smoothed render position, absolute. */
  pos: THREE.Vector3;
  yaw: number;
  anim: "idle" | "run" | "jump";
  speed: number;
  seenAt: number;
}

export interface ClassSyncHooks {
  /** Move the local player to grid coordinates (gather). */
  teleport(x: number, y: number, z: number): void;
  toast(text: string): void;
  clearKeys(): void;
}

function nameTag(name: string, teacher: boolean): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 30px system-ui, sans-serif";
  const label = (teacher ? "👩‍🏫 " : "") + name;
  const w = Math.min(248, ctx.measureText(label).width + 28);
  ctx.fillStyle = teacher ? "rgba(214,136,0,0.92)" : "rgba(20,22,28,0.72)";
  ctx.beginPath();
  ctx.roundRect((256 - w) / 2, 8, w, 48, 16);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 128, 33, 236);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, fog: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 2.35;
  sprite.renderOrder = 10;
  return sprite;
}

/**
 * The classroom inside the game: everyone else's robot with a name tag, our
 * position and block edits out, theirs in, plus the teacher's gather/locks.
 * All network coordinates are ABSOLUTE field coordinates; this class is the
 * only place that converts to and from the local scrolling grid.
 */
export class ClassSync {
  readonly hud: ClassHud;
  private readonly remotes = new Map<string, Remote>();
  private members: ClassMember[];
  private settings: ClassSettings;
  private readonly outbox: ClassEdit[] = [];
  private readonly pending = new Map<string, { prev: [number, number]; at: number }>();
  private moveTimer = 0;
  private online = true;
  private readonly tmp = new THREE.Vector3();

  constructor(
    readonly client: ClassClient,
    private readonly session: ClassSession,
    private readonly field: FieldWindow,
    private readonly view: VoxelView,
    private readonly scene: THREE.Scene,
    private readonly hooks: ClassSyncHooks,
    furniture: FurnitureLayout,
  ) {
    this.members = session.members;
    this.settings = session.settings;
    field.replaceAll(session.edits);
    furniture.load(session.furniture);
    this.hud = new ClassHud(session.role, session.you, session.teacher, {
      chat: (text) => client.send({ t: "k-chat", text }),
      kick: (m) => client.send({ t: "k-kick", playerId: m.id }),
      gather: () => {
        client.send({ t: "k-gather" });
        hooks.toast("📣 학생들을 불렀어요");
      },
      settings: (next) => client.send({ t: "k-settings", ...next }),
      end: () => client.send({ t: "k-end" }),
      resetWorld: () => client.send({ t: "k-reset-world" }),
      typing: () => hooks.clearKeys(),
    });
    this.hud.setMembers(this.members);
    this.hud.setSettings(this.settings);

    client.onMembers = (members) => {
      this.members = members;
      this.hud.setMembers(members);
      for (const id of [...this.remotes.keys()]) {
        if (!members.some((m) => m.id === id && m.online)) this.dropRemote(id);
      }
    };
    client.onSnap = (players) => this.applySnap(players);
    client.onEdit = (edits) => this.applyEdits(edits);
    client.onFurniture = (items, rejected) => {
      furniture.load(items, true);
      if (rejected) hooks.toast("🛋️ 다른 변경이나 건축 잠금 때문에 가구 작업을 적용하지 못했어요");
    };
    client.onReject = (edits) => this.undo(edits);
    client.onChat = (msg) => this.hud.chat(msg.name, msg.role, msg.text, msg.system);
    client.onSettings = (settings) => {
      const was = this.settings;
      this.settings = settings;
      this.hud.setSettings(settings);
      if (session.role === "student") {
        if (settings.buildLocked !== was.buildLocked)
          hooks.toast(settings.buildLocked ? "🧱 선생님이 건축을 잠갔어요" : "🧱 다시 건축할 수 있어요");
        if (settings.chatLocked !== was.chatLocked)
          hooks.toast(settings.chatLocked ? "💬 선생님이 채팅을 잠갔어요" : "💬 다시 채팅할 수 있어요");
      }
    };
    client.onGather = ([ax, y, az]) => {
      const [x, z] = field.toGrid(ax, az);
      // fan out around the teacher instead of stacking in one cell
      const angle = Math.random() * Math.PI * 2;
      hooks.teleport(x + Math.cos(angle) * 2.5, y + 0.5, z + Math.sin(angle) * 2.5);
      hooks.toast("📣 선생님이 불렀어요!");
    };
    client.onWorldReset = () => {
      field.replaceAll([]);
      furniture.clear();
      this.pending.clear();
      this.outbox.length = 0;
      view.markDirty();
      hooks.toast("🧹 들판이 새로 비워졌어요");
    };
    client.onConnection = (online) => {
      this.online = online;
      this.hud.setOnline(online);
    };
    client.onResync = (fresh) => {
      // the server restarted and the class was opened afresh: say so instead
      // of silently swapping everyone's buildings for an empty field
      if (fresh.edits.length === 0 && field.hasEdits()) hooks.toast("⚠️ 서버가 다시 시작되어 반이 새로 열렸어요");
      // the server's field wins: anything sent while offline never landed
      field.replaceAll(fresh.edits);
      furniture.load(fresh.furniture, true);
      this.pending.clear();
      this.outbox.length = 0;
      view.markDirty();
      this.members = fresh.members;
      this.hud.setMembers(fresh.members);
      this.settings = fresh.settings;
      this.hud.setSettings(fresh.settings);
    };
    client.onEnded = (reason) => {
      this.online = false;
      hooks.clearKeys();
      this.hud.showEnded(
        reason === "kicked"
          ? "선생님이 수업에서 내보냈어요."
          : reason === "closed"
            ? session.role === "teacher"
              ? "수업을 마쳤어요. 모든 학생의 연결이 끝났어요."
              : "선생님이 수업을 마쳤어요. 수고했어요!"
            : reason === "no-class"
              ? "서버가 다시 시작되어 수업이 끝났어요. 선생님이 반을 다시 열면 참여해 주세요."
            : "연결이 끝났어요. 다시 참여해 주세요.",
      );
    };
  }

  get role(): "teacher" | "student" {
    return this.session.role;
  }

  /** Students can't touch blocks while the teacher has building locked. */
  canBuild(): boolean {
    return this.online && (this.session.role === "teacher" || !this.settings.buildLocked);
  }

  /** A local block change (grid coordinates) — queue it for the class. */
  recordEdit(x: number, y: number, z: number, prevBlock: number, prevShape: number, block: number, shape: number): void {
    const [ax, az] = this.field.toAbsolute(x, z);
    const key = `${ax},${y},${az}`;
    if (!this.pending.has(key)) this.pending.set(key, { prev: [prevBlock, prevShape], at: performance.now() });
    this.outbox.push([ax, y, az, block, shape]);
  }

  flushEdits(): void {
    while (this.outbox.length > 0) this.client.send({ t: "k-edit", edits: this.outbox.splice(0, 8) });
  }

  /** Per fixed tick: flush edits, report position, glide remote robots. */
  tick(dt: number, body: { x: number; y: number; z: number }, yaw: number, anim: "idle" | "run" | "jump"): void {
    this.flushEdits();
    const now = performance.now();
    for (const [key, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(key);

    this.moveTimer += dt;
    if (this.moveTimer >= 1 / MOVE_HZ) {
      this.moveTimer = 0;
      const [ax, az] = this.field.toAbsolute(body.x, body.z);
      this.client.send({ t: "k-move", pos: [ax, body.y, az], yaw, anim });
    }
  }

  /** Per rendered frame: place remote robots in local grid space. */
  render(frameDt: number): void {
    const k = 1 - Math.pow(0.0005, frameDt); // ~100 ms catch-up
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (now - r.seenAt > 3000) {
        r.rig.root.visible = false;
        continue;
      }
      const before = this.tmp.copy(r.pos);
      // a teleport/gather snaps instead of sliding across the map
      if (r.pos.distanceToSquared(r.target) > 64) r.pos.copy(r.target);
      else r.pos.lerp(r.target, k);
      r.speed = frameDt > 0 ? Math.hypot(r.pos.x - before.x, r.pos.z - before.z) / frameDt : 0;
      const [x, z] = this.field.toGrid(r.pos.x, r.pos.z);
      r.rig.root.visible = true;
      r.rig.root.position.set(x, r.pos.y, z);
      r.rig.root.rotation.y = r.yaw;
      r.rig.update(r.anim, r.speed, frameDt);
    }
  }

  private applySnap(players: { id: string; pos: [number, number, number]; yaw: number; anim: "idle" | "run" | "jump" }[]): void {
    const now = performance.now();
    for (const p of players) {
      if (p.id === this.session.you) continue;
      let r = this.remotes.get(p.id);
      if (!r) {
        const member = this.members.find((m) => m.id === p.id);
        if (!member) continue;
        const rig = new CharacterRig();
        rig.root.add(nameTag(member.name, member.role === "teacher"));
        this.scene.add(rig.root);
        r = {
          rig,
          target: new THREE.Vector3(...p.pos),
          pos: new THREE.Vector3(...p.pos),
          yaw: p.yaw,
          anim: p.anim,
          speed: 0,
          seenAt: now,
        };
        this.remotes.set(p.id, r);
      }
      r.target.set(...p.pos);
      r.yaw = p.yaw;
      r.anim = p.anim;
      r.seenAt = now;
    }
  }

  private applyEdits(edits: ClassEdit[]): void {
    for (const [ax, y, az, block, shape] of edits) {
      this.pending.delete(`${ax},${y},${az}`); // someone else's write supersedes ours
      const cell = this.field.applyRemote(ax, y, az, block, shape);
      if (cell) this.view.markCellDirty(cell[0], cell[1], cell[2]);
    }
  }

  private undo(edits: ClassEdit[]): void {
    for (const [ax, y, az] of edits) {
      const key = `${ax},${y},${az}`;
      const p = this.pending.get(key);
      if (!p) continue;
      this.pending.delete(key);
      const cell = this.field.applyRemote(ax, y, az, p.prev[0], p.prev[1]);
      if (cell) this.view.markCellDirty(cell[0], cell[1], cell[2]);
    }
    if (this.session.role === "student" && this.settings.buildLocked) this.hooks.toast("🧱 지금은 건축이 잠겨 있어요");
  }

  private dropRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.rig.root);
    disposeRig(r.rig.root);
    this.remotes.delete(id);
  }

  debug() {
    return {
      role: this.session.role,
      you: this.session.you,
      online: this.online,
      settings: this.settings,
      members: this.members.map((m) => ({ name: m.name, role: m.role, online: m.online })),
      remotes: [...this.remotes.entries()].map(([id, r]) => ({
        id,
        name: this.members.find((m) => m.id === id)?.name,
        visible: r.rig.root.visible,
        abs: [r.target.x, r.target.y, r.target.z],
      })),
    };
  }

  dispose(): void {
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.hud.dispose();
    this.client.close();
  }
}
